import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GraphFragment } from '../../src/config/schema.ts';
import { runGraph } from '../../src/engine/engine.ts';
import type { RunContext } from '../../src/engine/runtime.ts';
import { newState } from '../../src/engine/state.ts';
import { buildGraph } from '../../src/graph/build.ts';
import type { Step } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';
import { HerdrRuntime, terminalName } from '../../src/runtime/herdr-runtime.ts';
import type { Attention, HerdrRuntimeOptions } from '../../src/runtime/herdr-runtime.ts';
import type { MaterializedMapping } from '../../src/workspace/run-dir.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import type { FakeTerminal } from '../helpers/fake-hc.ts';

const RUN_ID = 'Acme-Repo-#123-20261120T101500';
const H4 = createHash('sha256').update(RUN_ID).digest('hex').slice(0, 4);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-herdr-rt-'));
  dirs.push(d);
  return d;
}

function step(over: Partial<Step> = {}): Step {
  return {
    id: 'plan',
    name: 'plan',
    stage: 'plan',
    role: 'slot',
    def: { agent: 'claude' } as Step['def'],
    slotLast: true,
    source: 'test',
    locked: false,
    ...over,
  };
}

function ctx(executed: Record<string, number> = {}): RunContext {
  const state = newState({ runId: RUN_ID, ticket: '#123', profile: 'default', groundVersions: {} });
  state.executed = executed;
  return { state, graph: { steps: [step()] } as RunContext['graph'], round: 1, maxRounds: 1, previousOutputs: {} };
}

type Env = { root: string; runDir: string; worktree: string; hc: FakeHc; sleeps: number[]; attention: Attention[] };

async function env(behave?: ConstructorParameters<typeof FakeHc>[0]): Promise<Env> {
  const root = await tmp();
  const runDir = path.join(root, 'runs', RUN_ID);
  const worktree = path.join(root, 'work tree');
  await fs.mkdir(worktree, { recursive: true });
  return { root, runDir, worktree, hc: new FakeHc(behave), sleeps: [], attention: [] };
}

function runtime(e: Env, over: Partial<HerdrRuntimeOptions> = {}): HerdrRuntime {
  return new HerdrRuntime({
    hc: e.hc,
    runId: RUN_ID,
    ticket: '#123',
    runDir: e.runDir,
    worktree: e.worktree,
    branch: 'perc/123',
    base: 'main',
    mappings: [],
    grounds: {},
    space: 'space-1',
    sleep: async (ms) => {
      e.sleeps.push(ms);
    },
    now: () => 0,
    onAttention: (a) => e.attention.push(a),
    ...over,
  });
}

/** The step dir of a fake terminal, from the task path in its message. */
function dirOf(hc: FakeHc, t: FakeTerminal): string {
  return path.dirname(hc.taskFileOf(t));
}

async function finishWith(hc: FakeHc, t: FakeTerminal, done: unknown, outputs: Record<string, string> = {}) {
  const dir = dirOf(hc, t);
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
  for (const [k, v] of Object.entries(outputs)) await fs.writeFile(path.join(dir, 'outputs', `${k}.md`), v);
  await fs.writeFile(path.join(dir, 'done.json'), typeof done === 'string' ? done : JSON.stringify(done));
}

const subs = (hc: FakeHc) => hc.calls.map((c) => c[0]);

test('terminalName is self-documenting, valid, deterministic and distinct per step and attempt', () => {
  assert.equal(terminalName(RUN_ID, '#123', 'groom', 1), `t123_groom_a1_${H4}`);
  assert.equal(terminalName(RUN_ID, '#123', 'plan.1', 1), `t123_plan-1_a1_${H4}`);
  assert.equal(terminalName(RUN_ID, '#123', 'review', 2), `t123_review_a2_${H4}`);
  assert.equal(terminalName(RUN_ID, '#123', 'Threat_Model', 1), `t123_threat-model_a1_${H4}`);
  assert.match(terminalName(RUN_ID, 'acme/repo#123', 'plan', 1), /^t123_plan_/);
  assert.match(terminalName(RUN_ID, 'https://github.com/acme/repo/issues/123', 'plan', 1), /^t123_plan_/);
  assert.equal(terminalName(RUN_ID, 'PROJ-42', 'plan', 1), `proj-42_plan_a1_${H4}`);

  const longId = `${'abcdefghi-'.repeat(4)}`;
  assert.equal(longId.length, 40);
  const long = terminalName(RUN_ID, '#123', longId, 1);
  assert.ok(long.startsWith('t123_'));
  assert.ok(long.endsWith(`_a1_${H4}`));
  assert.ok(long.length <= 32, long);
  assert.ok(!long.slice(0, -`_a1_${H4}`.length).endsWith('-'), long);

  for (const n of [long, terminalName(RUN_ID, '!!!', '???', 7), terminalName(RUN_ID, '#123', 'review', 2)]) {
    assert.match(n, /^[a-z0-9_-]{1,32}$/);
  }
  assert.equal(terminalName(RUN_ID, '#123', 'review', 2), terminalName(RUN_ID, '#123', 'review', 2));
  assert.notEqual(terminalName(RUN_ID, '#123', 'review', 2), terminalName(`${RUN_ID}x`, '#123', 'review', 2));
});

test('agent step: launches claude in the worktree with space label, collects outputs, saves transcript, cleans up', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: '# Plan' });
  });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });

  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  const run = e.hc.calls.find((c) => c[0] === 'run')![1] as { name: string; cwd: string; argv: string[]; labels: Record<string, string> };
  const stepDir = path.join(e.runDir, 'steps', 'plan', '1');
  assert.equal(run.name, name);
  assert.equal(run.cwd, e.worktree);
  assert.equal(run.argv[0], 'claude');
  assert.deepEqual(run.argv.slice(-2), ['--', `Your task is in ${path.join(stepDir, 'task.md')}. Read it and follow it exactly.`]);
  assert.ok(run.argv.includes('--add-dir') && run.argv[run.argv.indexOf('--add-dir') + 1] === e.runDir);
  assert.deepEqual(run.labels, {
    'percolator.run': RUN_ID,
    'percolator.step': 'plan',
    'percolator.worktree': e.worktree,
    'herdr.space': 'space-1',
  });
  assert.match(await fs.readFile(path.join(stepDir, 'task.md'), 'utf8'), /^# Percolator task: plan/);
  assert.equal(await fs.readFile(path.join(stepDir, 'transcript.txt'), 'utf8'), `screen of ${name}`);
  assert.deepEqual(subs(e.hc).slice(-2), ['kill', 'rm']);
  assert.equal(e.hc.terminals.size, 0);
});

test('codex step argv has --no-daemon and skill files listed in task.md', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const groundDir = path.join(e.root, 'ground');
  await fs.mkdir(path.join(groundDir, 'skills', 'tdd'), { recursive: true });
  await fs.writeFile(path.join(groundDir, 'skills', 'tdd', 'SKILL.md'), '# tdd');
  const mapping = {
    from: 'g', dir: 'skills', as: 'skills', applies_to: ['*'], required: false,
    absPath: path.join(groundDir, 'skills'), ground: 'g', commit: 'local', runPath: path.join(groundDir, 'skills'),
  } as MaterializedMapping;
  const grounds: Record<string, ResolvedGround> = { g: { name: 'g', dir: groundDir, commit: 'local', source: { path: groundDir } } };
  const out = await runtime(e, { mappings: [mapping], grounds }).executeStep(
    step({ def: { agent: 'codex', skill: 'g:tdd' } as Step['def'] }),
    ctx(),
  );
  assert.equal(out.status, 'pass');
  const run = e.hc.calls.find((c) => c[0] === 'run')![1] as { argv: string[] };
  assert.deepEqual(run.argv.slice(0, 2), ['codex', '--no-daemon']);
  assert.ok(!run.argv.includes('--plugin-dir'));
  const task = await fs.readFile(path.join(e.runDir, 'steps', 'plan', '1', 'task.md'), 'utf8');
  assert.ok(task.includes(`- ${path.join(groundDir, 'skills', 'tdd', 'SKILL.md')}`), task);
});

test('review fail passes findings through', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'fail' }, { findings: '- bug' });
  });
  const out = await runtime(e).executeStep(step({ id: 'review', name: 'review', stage: 'review' }), ctx());
  assert.deepEqual(out, { status: 'fail', outputs: { findings: 'steps/review/1/outputs/findings.md' } });
});

test('idle without done.json keeps waiting and reports attention once per turn', async () => {
  let term: FakeTerminal | undefined;
  const e = await env((t, n) => {
    if (n === 1) {
      term = t;
      t.status = 'idle';
      t.turn = 1;
    }
  });
  const rt = runtime(e, {
    sleep: async (ms) => {
      e.sleeps.push(ms);
      if (e.sleeps.length === 3) await finishWith(e.hc, term!, { status: 'pass' }, { plan: 'p' });
    },
  });
  const out = await rt.executeStep(step(), ctx());
  assert.equal(out.status, 'pass');
  assert.deepEqual(e.attention, [{ stepId: 'plan', terminal: terminalName(RUN_ID, '#123', 'plan', 1), kind: 'idle' }]);
  assert.ok(e.sleeps.length >= 3);
  assert.deepEqual(e.sleeps, [2000, 2000, 2000]);
});

test('blocked is surfaced and the run keeps waiting', async () => {
  let term: FakeTerminal | undefined;
  const e = await env(async (t, n) => {
    if (n === 1) {
      term = t;
      t.status = 'blocked';
    }
    if (n === 2) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const rt = runtime(e, {
    sleep: async (ms) => {
      e.sleeps.push(ms);
      if (e.sleeps.length === 2) term!.status = 'working';
    },
  });
  const out = await rt.executeStep(step(), ctx());
  assert.equal(out.status, 'pass');
  assert.deepEqual(e.attention.map((a) => a.kind), ['blocked']);
  assert.equal(e.sleeps.length, 2);
  assert.equal(subs(e.hc).filter((s) => s === 'wait').length, 2);
});

test('resume re-attaches to a live terminal without relaunching or rewriting task.md', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const name = terminalName(RUN_ID, '#123', 'plan', 2);
  const stepDir = path.join(e.runDir, 'steps', 'plan', '2');
  await fs.mkdir(stepDir, { recursive: true });
  await fs.writeFile(path.join(stepDir, 'task.md'), 'MARKER');
  e.hc.add({ name, argv: ['claude', '--', `Your task is in ${path.join(stepDir, 'task.md')}. Read it and follow it exactly.`] });

  const out = await runtime(e).executeStep(step(), ctx({ plan: 1 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/2/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
  assert.equal(await fs.readFile(path.join(stepDir, 'task.md'), 'utf8'), 'MARKER');
});

test('a finished terminal without done.json is removed and relaunched', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  e.hc.add({ name, state: 'finished', exitCode: 1, address: 'old' });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.equal(out.status, 'pass');
  assert.deepEqual(subs(e.hc).slice(0, 3), ['get', 'rm', 'run']);
});

test('a finished terminal with a done.json is collected without relaunching', async () => {
  const e = await env();
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  const stepDir = path.join(e.runDir, 'steps', 'plan', '1');
  const t = e.hc.add({ name, state: 'finished', exitCode: 0, argv: ['claude', '--', `Your task is in ${path.join(stepDir, 'task.md')}. Read it and follow it exactly.`] });
  await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
});

test('agent exiting without done.json escalates with a reason naming the step', async () => {
  const e = await env((t, n) => {
    if (n === 1) {
      t.state = 'finished';
      t.exitCode = 0;
    }
  });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'plan: agent exited without a valid done.json' });
});

test('invalid done.json after the turn ends escalates naming the file', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) {
      t.status = 'idle';
      await finishWith(e.hc, t, '{"status":"maybe"}');
    }
  });
  const out = await runtime(e).executeStep(step(), ctx());
  const doneFile = path.join(e.runDir, 'steps', 'plan', '1', 'done.json');
  assert.equal(out.status, 'escalate');
  assert.ok(out.reason!.startsWith(`${doneFile} is invalid: status: `), out.reason);
  assert.equal(e.sleeps.length, 0);
  assert.ok(!subs(e.hc).includes('kill'));
});

test('timeout_s escalates and leaves the terminal live', async () => {
  const e = await env((t) => {
    t.status = 'working';
  });
  let clock = 0;
  const out = await runtime(e, {
    now: () => {
      const v = clock;
      clock += 4000;
      return v;
    },
  }).executeStep(step({ def: { agent: 'claude', timeout_s: 10 } as Step['def'] }), ctx());
  assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'plan timed out after 10s' });
  assert.ok(!subs(e.hc).includes('kill'));
  assert.equal(e.hc.terminals.get(terminalName(RUN_ID, '#123', 'plan', 1))!.state, 'live');
});

test('undelivered first message escalates and removes the terminal', async () => {
  const e = await env();
  e.hc.firstMessageSent = false;
  const out = await runtime(e).executeStep(step(), ctx());
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  const stepDir = path.join(e.runDir, 'steps', 'plan', '1');
  assert.deepEqual(out, {
    status: 'escalate',
    outputs: {},
    reason: `task was not delivered to ${name}; check its screen in ${path.join(stepDir, 'transcript.txt')}, then resume`,
  });
  assert.equal(await fs.readFile(path.join(stepDir, 'transcript.txt'), 'utf8'), `screen of ${name}`);
  assert.deepEqual(subs(e.hc).slice(-2), ['kill', 'rm']);
  assert.ok(!subs(e.hc).includes('wait'));
});

test('script step: exit code decides; placeholders are substituted', async () => {
  for (const [code, expected] of [
    [0, { status: 'pass', outputs: {} }],
    [2, { status: 'fail', outputs: {}, reason: 'exit code 2' }],
  ] as const) {
    const e = await env((t) => {
      t.state = 'finished';
      t.exitCode = code;
    });
    const s = step({ id: 'lint', name: 'lint', role: 'hook', slotLast: false, def: { command: ['node', 'x.js', '{outputs_dir}', '{run_dir}:{worktree}'] } as Step['def'] });
    const out = await runtime(e).executeStep(s, ctx());
    assert.deepEqual(out, expected);
    const run = e.hc.calls.find((c) => c[0] === 'run')![1] as { argv: string[] };
    assert.deepEqual(run.argv, ['node', 'x.js', path.join(e.runDir, 'steps', 'lint', '1', 'outputs'), `${e.runDir}:${e.worktree}`]);
  }
});

test('builtin and gate dispatch to handlers; missing ones escalate with the exact reasons', async () => {
  const e = await env();
  const seen: string[] = [];
  const rt = runtime(e, {
    builtins: {
      intake: async (s, _c, io) => {
        seen.push(io.outputsDir);
        return { status: 'pass', outputs: { ticket: 'x' } };
      },
    },
    gate: async (s) => ({ status: 'fail', outputs: {}, reason: `no ${s.id}` }),
  });
  const intake = step({ id: 'intake', name: 'intake', stage: 'intake', def: { builtin: 'intake' } as Step['def'] });
  assert.deepEqual(await rt.executeStep(intake, ctx()), { status: 'pass', outputs: { ticket: 'x' } });
  const outputsDir = path.join(e.runDir, 'steps', 'intake', '1', 'outputs');
  assert.deepEqual(seen, [outputsDir]);
  assert.ok((await fs.stat(outputsDir)).isDirectory());
  const gate = step({ id: 'approve-groom', name: 'approve-groom', role: 'hook', def: { kind: 'gate' } as Step['def'] });
  assert.deepEqual(await rt.executeStep(gate, ctx()), { status: 'fail', outputs: {}, reason: 'no approve-groom' });

  const bare = runtime(e);
  assert.deepEqual(await bare.executeStep(step({ def: { builtin: 'pr' } as Step['def'] }), ctx()), {
    status: 'escalate', outputs: {}, reason: 'no builtin "pr" is installed',
  });
  assert.deepEqual(await bare.executeStep(gate, ctx()), {
    status: 'escalate', outputs: {}, reason: 'gate approve-groom needs approval',
  });
  assert.equal(e.hc.calls.length, 0);
});

test('template error escalates before any terminal starts', async () => {
  const e = await env();
  const out = await runtime(e).executeStep(step({ def: { agent: 'claude', prompt: 'do {{ nope }}' } as Step['def'] }), ctx());
  assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'unknown template variable(s): nope' });
  assert.equal(e.hc.calls.length, 0);
});

test('a prompt file is read from its ground; a missing one escalates', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const groundDir = path.join(e.root, 'g');
  await fs.mkdir(groundDir);
  await fs.writeFile(path.join(groundDir, 'plan.md'), 'Plan ticket {{ticket}} carefully.');
  const grounds: Record<string, ResolvedGround> = { g: { name: 'g', dir: groundDir, commit: 'local', source: { path: groundDir } } };
  const rt = runtime(e, { grounds });
  assert.equal((await rt.executeStep(step({ def: { agent: 'claude', prompt: { from: 'g', file: 'plan.md' } } as Step['def'] }), ctx())).status, 'pass');
  assert.match(await fs.readFile(path.join(e.runDir, 'steps', 'plan', '1', 'task.md'), 'utf8'), /Plan ticket #123 carefully\./);

  const missing = await rt.executeStep(step({ def: { agent: 'claude', prompt: { from: 'g', file: 'nope.md' } } as Step['def'] }), ctx({ plan: 1 }));
  assert.deepEqual(missing, { status: 'escalate', outputs: {}, reason: 'ground "g": nope.md does not exist' });
});

test('end-to-end: runGraph with HerdrRuntime and FakeHc completes a graph', async () => {
  const outputsFor: Record<string, string> = { groom: 'groomed_ticket', plan: 'plan', implement: 'summary', review: 'findings' };
  let reviews = 0;
  const e = await env(async (t) => {
    const stage = t.labels['percolator.step']!;
    let status = 'pass';
    if (stage === 'review' && ++reviews === 1) status = 'fail';
    await finishWith(e.hc, t, { status }, { [outputsFor[stage]!]: status === 'fail' ? '- fix it' : 'No findings.' });
  });
  const fragment: GraphFragment = {
    bindings: {
      intake: { builtin: 'intake' },
      groom: { agent: 'claude' },
      plan: { agent: 'claude' },
      implement: { agent: 'claude' },
      review: { agent: 'claude' },
      deliver: { builtin: 'deliver' },
    },
  };
  const g = buildGraph(mergeLayers([{ source: 'test', fragment }]));
  const rt = runtime(e, {
    builtins: {
      intake: async () => ({ status: 'pass', outputs: { ticket: 'x' } }),
      deliver: async () => ({ status: 'pass', outputs: { pr_url: 'y' } }),
    },
    gate: async () => ({ status: 'pass', outputs: {} }),
  });
  const state = newState({ runId: RUN_ID, ticket: '#123', profile: 'default', groundVersions: {} });
  const s = await runGraph(g, state, { runtime: rt, save: async () => {} });
  assert.equal(s.status, 'completed', s.pausedReason);
  assert.equal(s.executed['implement'], 2);
  const task2 = await fs.readFile(path.join(e.runDir, 'steps', 'implement', '2', 'task.md'), 'utf8');
  const inputs = task2.slice(task2.indexOf('## Inputs'), task2.indexOf('## Workspace'));
  assert.ok(
    inputs.includes(`- findings (from review): ${path.join(e.runDir, 'steps', 'review', '1', 'outputs', 'findings.md')}`),
    inputs,
  );
  assert.equal(e.hc.terminals.size, 0);
});
