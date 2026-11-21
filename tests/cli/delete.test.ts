import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.ts';
import { loadState, saveState } from '../../src/engine/state.ts';
import type { RunState } from '../../src/engine/state.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

type Env = RunEnv & {
  dir(m: RunMeta): string;
  prepare(o?: { status?: RunState['status']; title?: string }): Promise<RunMeta>;
  perc(argv: string[], deps?: Partial<DriverDeps>): Promise<{ code: number; out: string; err: string }>;
};

async function setup(): Promise<Env> {
  const base = await setupRunEnv();
  let clock = NOW.getTime();
  const dir = (m: RunMeta) => path.join(base.home, '.percolator', 'runs', m.runId);
  return {
    ...base,
    dir,
    prepare: async (o = {}) => {
      // distinct createdAt (and run ids), so listRuns order is the order of creation, newest first
      clock += 1000;
      base.deps.now = () => new Date(clock);
      const m = await prepareRun({ ticket: '#5', repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps);
      await fs.writeFile(path.join(dir(m), 'issue.json'), JSON.stringify({ title: o.title ?? 'Fix the thing' }));
      if (o.status !== undefined) {
        const s = await loadState(dir(m));
        s.status = o.status;
        await saveState(dir(m), s);
      }
      return m;
    },
    perc: async (argv, deps = base.deps) => {
      let out = '';
      let err = '';
      const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, deps);
      return { code, out, err };
    },
  };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const line = (m: RunMeta) => `deleted run ${m.runId}: 0 terminal(s), worktree ${m.worktree}; kept branch ${m.branch}`;
const summary = (m: RunMeta, status: string, state: string) =>
  [
    `perc delete will remove run ${m.runId}`,
    `  ticket ${m.ticket} Fix the thing`,
    `  status ${status}`,
    `  worktree ${m.worktree} (${state})`,
    `  keeps branch ${m.branch}`,
  ].join('\n');

/** An `ask` that answers `answer` and records each question. */
function asker(answer: string): { asked: string[]; ask: (q: string) => Promise<string> } {
  const asked: string[] = [];
  return { asked, ask: async (q) => (asked.push(q), answer) };
}

test('delete --yes removes a completed run and prints one line', async () => {
  const e = await setup();
  try {
    const m = await e.prepare({ status: 'completed' });
    const r = await e.perc(['delete', m.runId, '--yes']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `${line(m)}\n`);
    assert.equal(JSON.parse((await e.perc(['status', '--json'])).out).runs.length, 0);
  } finally {
    await e.cleanup();
  }
});

test('delete asks once and deletes on yes', async () => {
  const e = await setup();
  try {
    const m = await e.prepare({ status: 'completed' });
    const a = asker('y');
    const r = await e.perc(['delete', m.runId], { ...e.deps, ask: a.ask });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${summary(m, 'completed', 'clean')}\n${line(m)}\n`);
    assert.deepEqual(a.asked, [`delete run ${m.runId}? [y/N] `]);
    assert.equal(await exists(e.dir(m)), false);
  } finally {
    await e.cleanup();
  }
});

test('delete confirmation accepts y/yes in any case and aborts otherwise', async () => {
  const e = await setup();
  try {
    for (const answer of [' Y ', 'YES']) {
      const m = await e.prepare({ status: 'completed' });
      const r = await e.perc(['delete', m.runId], { ...e.deps, ask: asker(answer).ask });
      assert.equal(r.code, 0, `${answer}: ${r.err}`);
      assert.equal(await exists(e.dir(m)), false);
    }
    const m = await e.prepare({ status: 'completed' });
    for (const answer of ['', 'n', 'nope']) {
      const r = await e.perc(['delete', m.runId], { ...e.deps, ask: asker(answer).ask });
      assert.equal(r.code, 1);
      assert.equal(r.err, 'aborted; nothing deleted\n');
      assert.equal(await exists(e.dir(m)), true);
      assert.equal(await exists(m.worktree), true);
    }
  } finally {
    await e.cleanup();
  }
});

test('delete shows uncommitted changes in the summary', async () => {
  const e = await setup();
  try {
    const m = await e.prepare({ status: 'failed' });
    await fs.writeFile(path.join(m.worktree, 'x.txt'), 'x');
    const r = await e.perc(['delete', m.runId], { ...e.deps, ask: asker('n').ask });
    assert.equal(r.code, 1);
    assert.equal(r.out, `${summary(m, 'failed', 'uncommitted changes will be lost')}\n`);
  } finally {
    await e.cleanup();
  }
});

test('delete without --yes and no terminal is a usage error', async () => {
  const e = await setup();
  try {
    const m = await e.prepare({ status: 'completed' });
    const r = await e.perc(['delete', m.runId], { ...e.deps, ask: null });
    assert.equal(r.code, 2);
    assert.match(r.err, /^delete needs --yes when stdin is not a terminal\n\nusage: perc/);
    assert.equal(r.out, '');
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('delete usage errors', async () => {
  const e = await setup();
  try {
    const cases: [string[], string][] = [
      [['delete'], 'delete needs <run-id> or --finished'],
      [['delete', 'a', 'b'], 'delete takes one <run-id>'],
      [['delete', 'a', '--finished'], 'delete takes <run-id> or --finished, not both'],
      [['delete', '../x'], 'invalid run id "../x"'],
    ];
    for (const [argv, message] of cases) {
      const r = await e.perc(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.ok(r.err.startsWith(`${message}\n\nusage: perc`), r.err);
    }
  } finally {
    await e.cleanup();
  }
});

test('delete of an unknown id', async () => {
  const e = await setup();
  try {
    const r = await e.perc(['delete', 'nope', '--yes']);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'no run nope; perc status lists runs\n');
  } finally {
    await e.cleanup();
  }
});

test('delete refuses a foreground driver', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.writeFile(
      path.join(e.dir(m), 'driver.json'),
      JSON.stringify({ pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() }),
    );
    const r = await e.perc(['delete', m.runId, '--yes'], { ...e.deps, pidAlive: () => true });
    assert.equal(r.code, 1);
    assert.equal(r.err, `run ${m.runId} is being driven by process 4242; stop it (Ctrl-C) and run perc delete ${m.runId} again\n`);
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

const fline = (m: RunMeta) => `  ${m.runId}  ${m.ticket}  `;

test('delete --finished deletes only completed and failed runs', async () => {
  const e = await setup();
  try {
    const completed = await e.prepare({ status: 'completed' });
    const failed = await e.prepare({ status: 'failed' });
    const paused = await e.prepare({ status: 'paused' });
    const stalled = await e.prepare();
    const broken = path.join(e.home, '.percolator', 'runs', 'broken');
    await fs.mkdir(broken);
    const r = await e.perc(['delete', '--finished', '--yes']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `${line(failed)}\n${line(completed)}\n`);
    for (const m of [paused, stalled]) assert.equal(await exists(e.dir(m)), true);
    assert.equal(await exists(broken), true);
  } finally {
    await e.cleanup();
  }
});

test('delete --finished lists runs and asks once', async () => {
  const e = await setup();
  try {
    const completed = await e.prepare({ status: 'completed' });
    const failed = await e.prepare({ status: 'failed' });
    await e.prepare({ status: 'paused' });
    await fs.writeFile(path.join(failed.worktree, 'x.txt'), 'x');
    const a = asker('yes');
    const r = await e.perc(['delete', '--finished'], { ...e.deps, ask: a.ask });
    assert.equal(r.code, 0, r.err);
    assert.equal(
      r.out,
      [
        'perc delete will remove 2 finished run(s)',
        `${fline(failed)}failed  worktree dirty`,
        `${fline(completed)}completed  worktree clean`,
        '  keeps their branches',
        line(failed),
        line(completed),
        '',
      ].join('\n'),
    );
    assert.deepEqual(a.asked, ['delete 2 run(s)? [y/N] ']);
  } finally {
    await e.cleanup();
  }
});

test('delete --finished with none prints no finished runs', async () => {
  const e = await setup();
  try {
    await e.prepare({ status: 'paused' });
    const a = asker('y');
    const r = await e.perc(['delete', '--finished'], { ...e.deps, ask: a.ask });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'no finished runs\n');
    assert.deepEqual(a.asked, []);
  } finally {
    await e.cleanup();
  }
});

test('delete --finished aborts on no', async () => {
  const e = await setup();
  try {
    const m = await e.prepare({ status: 'completed' });
    const r = await e.perc(['delete', '--finished'], { ...e.deps, ask: asker('n').ask });
    assert.equal(r.code, 1);
    assert.equal(r.err, 'aborted; nothing deleted\n');
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('delete --finished carries on past a failure and exits 1', async () => {
  const e = await setup();
  try {
    const held = await e.prepare({ status: 'completed' });
    const other = await e.prepare({ status: 'failed' });
    await fs.writeFile(
      path.join(e.dir(held), 'driver.json'),
      JSON.stringify({ pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() }),
    );
    const r = await e.perc(['delete', '--finished', '--yes'], { ...e.deps, pidAlive: () => true });
    assert.equal(r.code, 1);
    assert.equal(r.out, `${line(other)}\n`);
    assert.equal(r.err, `run ${held.runId} is being driven by process 4242; stop it (Ctrl-C) and run perc delete ${held.runId} again\n`);
    assert.equal(await exists(e.dir(held)), true);
    assert.equal(await exists(e.dir(other)), false);
  } finally {
    await e.cleanup();
  }
});
