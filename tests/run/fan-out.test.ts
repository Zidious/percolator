import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import { loadState, saveState } from '../../src/engine/state.ts';
import type { RunState } from '../../src/engine/state.ts';
import { startLinkedRun } from '../../src/run/child.ts';
import { fanOut, percolatorSeed, readFanOut } from '../../src/run/fan-out.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { validate } from '../../src/validate.ts';
import type { ValidateResult } from '../../src/validate.ts';
import { runDir, stepDir } from '../../src/workspace/run-dir.ts';
import { setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const epic = (maxParallel?: number) =>
  [
    '    pipelines:',
    '      epic:',
    '        stages: [intake, plan, implement, deliver]',
    '        exit: pr',
    '        bindings:',
    '          plan: { command: [echo, plan] }',
    '          implement: { command: [echo, implement] }',
    `        fan_out: { stage: implement, slices: { from: plan, output: slices }${maxParallel !== undefined ? `, max_parallel: ${maxParallel}` : ''} }`,
  ].join('\n');

const THREE = '## One\n\nFirst part.\n\n## Two\n\nSecond part.\n\n## Three\n\nThird part.\n';
const SLICES_REL = 'steps/plan/1/outputs/slices.md';

type Fx = {
  e: RunEnv;
  parent: RunMeta;
  dir: string;
  v: ValidateResult;
  ctx: RunContext;
  io: { stepDir: string; outputsDir: string };
  /** the slice drivers started, in order */
  drivers(): string[];
  /** set a child's state status (it must exist) */
  setStatus(id: string, status: RunState['status']): Promise<void>;
  /** scripted sleeps: each call runs the next function; the poll intervals seen */
  sleeps: (() => Promise<void>)[];
  slept: number[];
};

async function setup(slices = THREE, maxParallel?: number): Promise<Fx> {
  const e = await setupRunEnv({ extra: epic(maxParallel) });
  const parent = await prepareRun({ ticket: '#5', pipeline: 'epic', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
  const dir = runDir(e.home, parent.runId);
  await fs.mkdir(path.join(dir, path.dirname(SLICES_REL)), { recursive: true });
  await fs.writeFile(path.join(dir, SLICES_REL), slices);
  const v = await validate({ configFile: e.configFile, cwd: e.root, home: e.home, profile: 'work', pipeline: 'epic' });
  const ctx: RunContext = { state: await loadState(dir), graph: v.graph, round: 1, maxRounds: 1, previousOutputs: { plan: { slices: SLICES_REL } } };
  const sd = stepDir(dir, 'implement', 1);
  const fx: Fx = {
    e,
    parent,
    dir,
    v,
    ctx,
    io: { stepDir: sd, outputsDir: path.join(sd, 'outputs') },
    drivers: () =>
      e.deps.hc.calls
        .filter((c) => c[0] === 'run' && (c[1] as { labels: Record<string, string> }).labels['percolator.role'] === 'driver')
        .map((c) => (c[1] as { argv: string[] }).argv.at(-1)!),
    setStatus: async (id, status) => {
      const d = runDir(e.home, id);
      await saveState(d, { ...(await loadState(d)), status });
    },
    sleeps: [],
    slept: [],
  };
  return fx;
}

const handler = (fx: Fx) =>
  fanOut({
    deps: fx.e.deps,
    meta: fx.parent,
    spec: fx.v.pipeline,
    pollMs: 10,
    sleep: async (ms) => {
      fx.slept.push(ms);
      const next = fx.sleeps.shift();
      if (next === undefined) throw new Error('unexpected poll');
      await next();
    },
  });

const run = (fx: Fx) => handler(fx)(fx.v.graph.steps.at(-1)!, fx.ctx, fx.io);
const sid = (fx: Fx, i: number) => `${fx.parent.runId}-s${i}`;

test('fan-out starts at most max_parallel slices at once', async () => {
  const fx = await setup(THREE, 2);
  try {
    const seen: string[][] = [];
    fx.sleeps.push(
      async () => {
        seen.push(fx.drivers());
        await fx.setStatus(sid(fx, 1), 'completed');
        await fx.setStatus(sid(fx, 2), 'completed');
      },
      async () => {
        seen.push(fx.drivers());
        await fx.setStatus(sid(fx, 3), 'completed');
      },
    );
    const outcome = await run(fx);
    assert.equal(outcome.status, 'pass', outcome.reason);
    assert.deepEqual(seen, [[sid(fx, 1), sid(fx, 2)], [sid(fx, 1), sid(fx, 2), sid(fx, 3)]]);
    assert.deepEqual(fx.slept, [10, 10]);
    assert.deepEqual(await readFanOut(fx.dir), {
      children: [
        { index: 1, id: sid(fx, 1), title: 'One' },
        { index: 2, id: sid(fx, 2), title: 'Two' },
        { index: 3, id: sid(fx, 3), title: 'Three' },
      ],
    });
    const s2 = await readRunMeta(runDir(fx.e.home, sid(fx, 2)));
    assert.deepEqual(
      { parent: s2.parent, fanOut: s2.fanOut, branch: s2.branch, base: s2.base, ticket: s2.ticket, pipeline: s2.pipeline },
      {
        parent: fx.parent.runId,
        fanOut: { parent: fx.parent.runId, slice: 2, from: 'implement', title: 'Two' },
        branch: `percolator/${sid(fx, 2)}`,
        base: fx.parent.base,
        ticket: fx.parent.ticket,
        pipeline: 'epic',
      },
    );
  } finally {
    await fx.e.cleanup();
  }
});

test('fan-out starts the next slice when one finishes', async () => {
  const fx = await setup(THREE, 2);
  try {
    const seen: string[][] = [];
    fx.sleeps.push(
      async () => {
        await fx.setStatus(sid(fx, 1), 'completed');
      },
      async () => {
        seen.push(fx.drivers());
        await fx.setStatus(sid(fx, 2), 'completed');
        await fx.setStatus(sid(fx, 3), 'completed');
      },
    );
    assert.equal((await run(fx)).status, 'pass');
    assert.deepEqual(seen, [[sid(fx, 1), sid(fx, 2), sid(fx, 3)]]);
  } finally {
    await fx.e.cleanup();
  }
});

test('fan-out passes when every slice completed', async () => {
  const fx = await setup('## One\n\na\n\n## Two\n\nb\n');
  try {
    fx.sleeps.push(async () => {
      // slice 1 opened a PR; slice 2 completed without one
      const d1 = runDir(fx.e.home, sid(fx, 1));
      const rel = 'steps/deliver/1/outputs/pr_url.md';
      await fs.mkdir(path.join(d1, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(d1, rel), 'https://github.com/o/r/pull/11\n');
      const s1 = await loadState(d1);
      const record = { stepId: 'deliver', attempt: 1, startedAt: 'x', endedAt: 'x', status: 'pass' as const, outputs: { pr_url: rel } };
      await saveState(d1, { ...s1, status: 'completed', history: [...s1.history, record] });
      await fx.setStatus(sid(fx, 2), 'completed');
    });
    const outcome = await run(fx);
    assert.deepEqual(outcome, { status: 'pass', outputs: { slices_done: 'steps/implement/1/outputs/slices_done.md' } });
    assert.equal(
      await fs.readFile(path.join(fx.io.outputsDir, 'slices_done.md'), 'utf8'),
      '1. One → https://github.com/o/r/pull/11\n2. Two → completed\n',
    );
  } finally {
    await fx.e.cleanup();
  }
});

test('a failed slice escalates with its id', async () => {
  const fx = await setup('## One\n\na\n\n## Two\n\nb\n');
  try {
    fx.sleeps.push(async () => {
      await fx.setStatus(sid(fx, 1), 'completed');
      await fx.setStatus(sid(fx, 2), 'failed');
    });
    assert.deepEqual(await run(fx), {
      status: 'escalate',
      outputs: {},
      reason: `percolator.fan_out: slice(s) ${sid(fx, 2)} failed; perc delete each (its branch stays), then perc resume ${fx.parent.runId} to run it again`,
    });
  } finally {
    await fx.e.cleanup();
  }
});

test('a resume continues only the unfinished slices', async () => {
  const fx = await setup(THREE);
  try {
    // an earlier drive split three slices, started s1 (now completed) and s2 (its driver since gone)
    await fs.writeFile(
      path.join(fx.dir, 'fanout.json'),
      JSON.stringify({
        children: [
          { index: 1, id: sid(fx, 1), title: 'One' },
          { index: 2, id: sid(fx, 2), title: 'Two' },
          { index: 3, id: sid(fx, 3), title: 'Three' },
        ],
      }),
    );
    for (const i of [1, 2]) {
      await startLinkedRun(
        { parent: fx.parent, pipeline: 'epic', ticket: fx.parent.ticket!, runId: sid(fx, i), fanOut: { parent: fx.parent.runId, slice: i, from: 'implement', title: 'x' } },
        fx.e.deps,
      );
    }
    await fx.setStatus(sid(fx, 1), 'completed');
    for (const t of fx.e.deps.hc.terminals.values()) t.state = 'finished';
    // never re-split: the slices output now has one section
    await fs.writeFile(path.join(fx.dir, SLICES_REL), '## Only\n\nz\n');
    fx.e.deps.hc.calls.length = 0;
    fx.sleeps.push(async () => {
      await fx.setStatus(sid(fx, 2), 'completed');
      await fx.setStatus(sid(fx, 3), 'completed');
    });
    assert.equal((await run(fx)).status, 'pass');
    assert.deepEqual(fx.drivers(), [sid(fx, 2), sid(fx, 3)]);
    assert.equal((await readFanOut(fx.dir))!.children.length, 3);
  } finally {
    await fx.e.cleanup();
  }
});

test('a failed slice whose run was deleted starts again on a resume', async () => {
  const fx = await setup('## One\n\na\n\n## Two\n\nb\n');
  try {
    fx.sleeps.push(async () => {
      await fx.setStatus(sid(fx, 1), 'completed');
      await fx.setStatus(sid(fx, 2), 'failed');
    });
    assert.equal((await run(fx)).status, 'escalate');
    // what `perc delete <slice-id>` leaves: no run dir for the slice
    await fs.rm(runDir(fx.e.home, sid(fx, 2)), { recursive: true, force: true });
    for (const t of fx.e.deps.hc.terminals.values()) t.state = 'finished';
    fx.sleeps.push(async () => {
      await fx.setStatus(sid(fx, 2), 'completed');
    });
    assert.equal((await run(fx)).status, 'pass');
    assert.equal(fx.drivers().filter((id) => id === sid(fx, 2)).length, 2, 'slice 2 is driven again');
  } finally {
    await fx.e.cleanup();
  }
});

test('a slice with a bare "## " heading escalates before anything is split or started', async () => {
  const fx = await setup('## One\n\na\n\n## \n\nb\n');
  try {
    assert.deepEqual(await run(fx), {
      status: 'escalate',
      outputs: {},
      reason: 'percolator.fan_out: slice 2 in slices.md has no title (a bare "## " heading); give it a title and resume',
    });
    assert.equal(await readFanOut(fx.dir), undefined);
    assert.deepEqual(fx.drivers(), []);
  } finally {
    await fx.e.cleanup();
  }
});

test('a slice deleted while the fan-out waits is not started again; the fan-out escalates once the others finish', async () => {
  const fx = await setup('## One\n\na\n\n## Two\n\nb\n');
  try {
    fx.sleeps.push(
      async () => {
        // `perc delete <slice-id>` while slice 2 runs
        await fs.rm(runDir(fx.e.home, sid(fx, 2)), { recursive: true, force: true });
        for (const t of fx.e.deps.hc.terminals.values()) if (t.argv.at(-1) === sid(fx, 2)) t.state = 'finished';
      },
      async () => {
        await fx.setStatus(sid(fx, 1), 'completed');
      },
    );
    assert.deepEqual(await run(fx), {
      status: 'escalate',
      outputs: {},
      reason: `percolator.fan_out: slice(s) ${sid(fx, 2)} deleted while running; perc resume ${fx.parent.runId} to start it again`,
    });
    assert.deepEqual(fx.drivers(), [sid(fx, 1), sid(fx, 2)]);
  } finally {
    await fx.e.cleanup();
  }
});

test('no slices escalates', async () => {
  const fx = await setup('Nothing to split.\n');
  try {
    assert.deepEqual(await run(fx), {
      status: 'escalate',
      outputs: {},
      reason: 'percolator.fan_out: plan wrote no slices (## <title> sections in slices.md); fix the output and resume',
    });
    assert.equal(await readFanOut(fx.dir), undefined);
    assert.deepEqual(fx.drivers(), []);
  } finally {
    await fx.e.cleanup();
  }
});

test("seed copies the parent's outputs and writes slice.md", async () => {
  const fx = await setup('## One\n\nfirst body\n\n## Two\n\nsecond body\nmore\n');
  try {
    // the parent's history: intake, two plan rounds (the later one wins)
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.join(fx.dir, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(fx.dir, rel), text);
    };
    await write('steps/intake/1/outputs/ticket.md', 'The ticket.\n');
    await write('steps/plan/1/outputs/plan.md', 'old plan\n');
    await write('steps/plan/2/outputs/plan.md', 'new plan\n');
    await write('steps/plan/2/outputs/slices.md', '## One\n\nfirst body\n\n## Two\n\nsecond body\nmore\n');
    await fs.writeFile(path.join(fx.dir, 'issue.json'), '{"repo":"github.com/o/r","number":5}\n');
    const rec = (stepId: string, attempt: number, outputs: Record<string, string>) => ({
      stepId,
      attempt,
      startedAt: 'x',
      endedAt: 'x',
      status: 'pass' as const,
      outputs,
    });
    const ps = await loadState(fx.dir);
    await saveState(fx.dir, {
      ...ps,
      history: [
        rec('intake', 1, { ticket: 'steps/intake/1/outputs/ticket.md' }),
        rec('plan', 1, { plan: 'steps/plan/1/outputs/plan.md', slices: SLICES_REL }),
        rec('plan', 2, { plan: 'steps/plan/2/outputs/plan.md', slices: 'steps/plan/2/outputs/slices.md' }),
      ],
    });
    const child = await startLinkedRun(
      { parent: fx.parent, pipeline: 'epic', ticket: fx.parent.ticket!, runId: sid(fx, 2), fanOut: { parent: fx.parent.runId, slice: 2, from: 'implement', title: 'Two' } },
      fx.e.deps,
    );
    const cdir = runDir(fx.e.home, child.runId);
    const sd = stepDir(cdir, 'intake', 1);
    const cv = await validate({ configFile: fx.e.configFile, cwd: fx.e.root, home: fx.e.home, profile: 'work', pipeline: 'epic', sliceFrom: 'implement' });
    const seed = percolatorSeed({ runDir: cdir, meta: child, home: fx.e.home, output: 'slices' });
    const ctx: RunContext = { state: await loadState(cdir), graph: cv.graph, round: 1, maxRounds: 1, previousOutputs: {} };
    const outcome = await seed(cv.graph.steps[0]!, ctx, { stepDir: sd, outputsDir: path.join(sd, 'outputs') });
    assert.deepEqual(outcome, {
      status: 'pass',
      outputs: {
        plan: 'steps/intake/1/outputs/plan.md',
        slice: 'steps/intake/1/outputs/slice.md',
        slices: 'steps/intake/1/outputs/slices.md',
        ticket: 'steps/intake/1/outputs/ticket.md',
      },
    });
    const read = (rel: string) => fs.readFile(path.join(cdir, rel), 'utf8');
    assert.equal(await read('steps/intake/1/outputs/slice.md'), '# Two\n\nsecond body\nmore\n');
    assert.equal(await read('steps/intake/1/outputs/plan.md'), 'new plan\n');
    assert.equal(await read('steps/intake/1/outputs/ticket.md'), 'The ticket.\n');
    // the slice's PR and comments find the parent's issue
    assert.equal(await read('issue.json'), '{"repo":"github.com/o/r","number":5}\n');
  } finally {
    await fx.e.cleanup();
  }
});
