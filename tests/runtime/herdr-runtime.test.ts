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
import type { Terminal } from '../../src/herdr/hc.ts';
import { HerdrRuntime, sweepTerminals, terminalName } from '../../src/runtime/herdr-runtime.ts';
import type { Attention, HerdrRuntimeOptions } from '../../src/runtime/herdr-runtime.ts';
import type { MaterializedMapping } from '../../src/workspace/run-dir.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import type { FakeTerminal } from '../helpers/fake-hc.ts';

const RUN_ID = 'Acme-Repo-#123-20261120T101500';
/** the labels of a terminal this run started */
const ours = { 'percolator.run': RUN_ID };
/** first 4 hex chars of sha256(runId + NUL + stepId), the name's hash */
const h4 = (stepId: string, runId = RUN_ID) => createHash('sha256').update(`${runId}\0${stepId}`).digest('hex').slice(0, 4);

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
  assert.equal(terminalName(RUN_ID, '#123', 'groom', 1), `t123_groom_a1_${h4('groom')}`);
  assert.equal(terminalName(RUN_ID, '#123', 'plan.1', 1), `t123_plan-1_a1_${h4('plan.1')}`);
  assert.equal(terminalName(RUN_ID, '#123', 'review', 2), `t123_review_a2_${h4('review')}`);
  assert.equal(terminalName(RUN_ID, '#123', 'Threat_Model', 1), `t123_threat-model_a1_${h4('Threat_Model')}`);
  assert.match(terminalName(RUN_ID, 'acme/repo#123', 'plan', 1), /^t123_plan_/);
  assert.match(terminalName(RUN_ID, 'https://github.com/acme/repo/issues/123', 'plan', 1), /^t123_plan_/);
  assert.equal(terminalName(RUN_ID, 'PROJ-42', 'plan', 1), `proj-42_plan_a1_${h4('plan')}`);

  const longId = `${'abcdefghi-'.repeat(4)}`;
  assert.equal(longId.length, 40);
  const long = terminalName(RUN_ID, '#123', longId, 1);
  const tail = `_a1_${h4(longId)}`;
  assert.ok(long.startsWith('t123_'));
  assert.ok(long.endsWith(tail));
  assert.ok(long.length <= 32, long);
  assert.ok(!long.slice(0, -tail.length).endsWith('-'), long);

  // steps whose slugs (or truncated slugs) agree still get distinct names
  assert.notEqual(terminalName(RUN_ID, '#123', 'plan.0', 1), terminalName(RUN_ID, '#123', 'plan-0', 1));
  assert.notEqual(terminalName(RUN_ID, '#123', 'Lint', 1), terminalName(RUN_ID, '#123', 'lint', 1));
  assert.notEqual(terminalName(RUN_ID, '#123', `${longId}x`, 1), terminalName(RUN_ID, '#123', `${longId}y`, 1));

  const bigTicket = terminalName(RUN_ID, `acme/repo#${'1234567890'.repeat(2)}12345`, 'plan', 1);
  assert.equal(bigTicket, `t89012345_plan_a1_${h4('plan')}`);
  const dashTicket = terminalName(RUN_ID, 'abcdefg-h', 'plan', 1);
  assert.equal(dashTicket, `abcdefg_plan_a1_${h4('plan')}`);

  for (const n of [long, bigTicket, dashTicket, terminalName(RUN_ID, '!!!', '???', 7), terminalName(RUN_ID, '#123', 'review', 2)]) {
    assert.match(n, /^[a-z0-9_-]{1,32}$/);
    assert.ok(n.length <= 32, n);
    assert.ok(!n.split('_')[0]!.endsWith('-'), n);
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
    absPath: path.join(groundDir, 'skills'), ground: 'g', commit: 'local', source: 'test', runPath: path.join(groundDir, 'skills'),
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
  e.hc.add({ name, labels: ours, argv: ['claude', '--', `Your task is in ${path.join(stepDir, 'task.md')}. Read it and follow it exactly.`] });

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
  e.hc.add({ name, labels: ours, state: 'finished', exitCode: 1, address: 'old' });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.equal(out.status, 'pass');
  assert.deepEqual(subs(e.hc).slice(0, 3), ['get', 'rm', 'run']);
});

test('a finished terminal with a done.json is collected without relaunching', async () => {
  const e = await env();
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  const stepDir = path.join(e.runDir, 'steps', 'plan', '1');
  const t = e.hc.add({ name, labels: ours, state: 'finished', exitCode: 0, argv: ['claude', '--', `Your task is in ${path.join(stepDir, 'task.md')}. Read it and follow it exactly.`] });
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

test('a status flip to blocked during a wait is surfaced and the run keeps waiting', async () => {
  let term: FakeTerminal | undefined;
  const e = await env((t, n) => {
    term = t;
    if (n === 1) t.status = 'blocked';
  });
  const rt = runtime(e, {
    sleep: async (ms) => {
      e.sleeps.push(ms);
      if (e.sleeps.length === 2) await finishWith(e.hc, term!, { status: 'pass' }, { plan: 'p' });
    },
  });
  const out = await rt.executeStep(step(), ctx());
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.deepEqual(e.attention.map((a) => a.kind), ['blocked']);
});

test('a script that finishes between get and wait is classified on the next poll', async () => {
  const e = await env((t) => {
    t.state = 'finished';
    t.exitCode = 0;
  });
  const s = step({ id: 'lint', name: 'lint', role: 'hook', slotLast: false, def: { command: ['node', 'x.js'] } as Step['def'] });
  assert.deepEqual(await runtime(e).executeStep(s, ctx()), { status: 'pass', outputs: {} });
  assert.deepEqual(e.sleeps, [2000]);
});

test('an error from wait that is not an HcError is rethrown', async () => {
  const e = await env(() => {
    throw new Error('boom');
  });
  await assert.rejects(runtime(e).executeStep(step(), ctx()), /^Error: boom$/);
});

test('resume after a timeout re-attaches to the live attempt-1 terminal and collects from its folder', async () => {
  let phase = 1;
  let clock = 0;
  const e = await env(async (t) => {
    if (phase === 1) {
      t.status = 'working';
      clock += 20_000;
    } else {
      await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
    }
  });
  const s = step({ def: { agent: 'claude', timeout_s: 10 } as Step['def'] });
  const rt = runtime(e, { now: () => clock });
  assert.deepEqual(await rt.executeStep(s, ctx()), { status: 'escalate', outputs: {}, reason: 'plan timed out after 10s' });
  const first = terminalName(RUN_ID, '#123', 'plan', 1);
  assert.equal(e.hc.terminals.get(first)!.state, 'live');

  phase = 2;
  e.hc.calls = [];
  const out = await rt.executeStep(s, ctx({ plan: 1 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
  assert.ok(e.hc.calls.every((c) => c[1] === first), JSON.stringify(e.hc.calls));
  assert.ok(await fs.stat(path.join(e.runDir, 'steps', 'plan', '1', 'transcript.txt')));
});

test('a later resume still adopts the newest live attempt, not just attempt N-1', async () => {
  let phase = 1;
  let clock = 0;
  const e = await env(async (t) => {
    if (phase === 1) {
      t.status = 'working';
      clock += 20_000;
    } else {
      await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
    }
  });
  const s = step({ def: { agent: 'claude', timeout_s: 10 } as Step['def'] });
  const rt = runtime(e, { now: () => clock });
  assert.equal((await rt.executeStep(s, ctx())).status, 'escalate');
  // attempt 2 adopted attempt 1 and timed out again: the engine counted it, so the next resume is attempt 3
  assert.equal((await rt.executeStep(s, ctx({ plan: 1 }))).status, 'escalate');
  const first = terminalName(RUN_ID, '#123', 'plan', 1);
  assert.equal(e.hc.terminals.get(first)!.state, 'live');

  phase = 2;
  e.hc.calls = [];
  const out = await rt.executeStep(s, ctx({ plan: 2 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
  assert.equal(e.hc.terminals.size, 0);
});

test('a live prior-attempt terminal that already wrote done.json is not adopted', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p2' });
  });
  const dir1 = path.join(e.runDir, 'steps', 'plan', '1');
  const prev = e.hc.add({
    name: terminalName(RUN_ID, '#123', 'plan', 1),
    argv: ['claude', '--', `Your task is in ${path.join(dir1, 'task.md')}. Read it and follow it exactly.`],
  });
  await finishWith(e.hc, prev, { status: 'pass' }, { plan: 'p1' });
  const out = await runtime(e, { keepTerminals: true }).executeStep(step(), ctx({ plan: 1 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/2/outputs/plan.md' } });
  const run = e.hc.calls.find((c) => c[0] === 'run')![1] as { name: string };
  assert.equal(run.name, terminalName(RUN_ID, '#123', 'plan', 2));
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

const taskArgv = (dir: string) => ['claude', '--', `Your task is in ${path.join(dir, 'task.md')}. Read it and follow it exactly.`];

test('a live prior attempt whose done.json is invalid is adopted on resume once it is fixed', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const dir1 = path.join(e.runDir, 'steps', 'plan', '1');
  const prev = e.hc.add({ name: terminalName(RUN_ID, '#123', 'plan', 1), labels: ours, status: 'working', argv: taskArgv(dir1) });
  await finishWith(e.hc, prev, '{"status":"maybe"}');
  const out = await runtime(e).executeStep(step(), ctx({ plan: 1 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
});

test('a valid done.json of this attempt with no terminal is collected without launching', async () => {
  const e = await env();
  const dir = path.join(e.runDir, 'steps', 'plan', '1');
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'outputs', 'plan.md'), '# Plan');
  await fs.writeFile(path.join(dir, 'done.json'), JSON.stringify({ status: 'fail', reason: 'nope' }));
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, { status: 'fail', outputs: { plan: 'steps/plan/1/outputs/plan.md' }, reason: 'nope' });
  assert.deepEqual([...new Set(subs(e.hc))], ['get']);
});

test('node terminals outlive perc by default; outliveParent false turns it off', async () => {
  for (const [over, expected] of [[{}, true], [{ outliveParent: false }, false]] as const) {
    const e = await env(async (t, n) => {
      if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
    });
    await runtime(e, over).executeStep(step(), ctx());
    const run = e.hc.calls.find((c) => c[0] === 'run')![1] as { outliveParent?: boolean };
    assert.equal(run.outliveParent, expected);
  }
});

test('a status-less terminal whose wait returns at once does not spin: it sleeps between polls', async () => {
  const e = await env((t, n) => {
    if (n === 4) {
      t.state = 'finished';
      t.exitCode = 0;
    }
  });
  const s = step({ id: 'lint', name: 'lint', role: 'hook', slotLast: false, def: { command: ['node', 'x.js'] } as Step['def'] });
  assert.deepEqual(await runtime(e).executeStep(s, ctx()), { status: 'pass', outputs: {} });
  assert.equal(subs(e.hc).filter((c) => c === 'wait').length, 4);
  assert.ok(e.sleeps.length >= 3, JSON.stringify(e.sleeps));
});

test('a terminal that vanishes during wait still returns its outcome; the transcript is skipped', async () => {
  const e = await env((t) => {
    e.hc.terminals.delete(t.name);
  });
  const s = step({ id: 'lint', name: 'lint', role: 'hook', slotLast: false, def: { command: ['node', 'x.js'] } as Step['def'] });
  assert.deepEqual(await runtime(e).executeStep(s, ctx()), { status: 'fail', outputs: {}, reason: 'exit code null' });
  await assert.rejects(fs.stat(path.join(e.runDir, 'steps', 'lint', '1', 'transcript.txt')), { code: 'ENOENT' });
});

test('wait never asks hc for longer than the time left before timeout_s', async () => {
  const e = await env(async (t, n) => {
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p' });
  });
  const rt = runtime(e, { waitTimeoutS: 60 });
  const s = step({ def: { agent: 'claude', timeout_s: 5 } as Step['def'] });
  assert.equal((await rt.executeStep(s, ctx())).status, 'pass');
  const waits = e.hc.calls.filter((c) => c[0] === 'wait').map((c) => (c[2] as { timeoutS: number }).timeoutS);
  assert.deepEqual(waits, [5]);
});

test('a live terminal of another run is never adopted', async () => {
  const e = await env(async (_t, n) => {
    // if it were adopted, it would complete the step
    if (n === 1) {
      const dir = path.join(e.runDir, 'steps', 'plan', '1');
      await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
      await fs.writeFile(path.join(dir, 'done.json'), JSON.stringify({ status: 'pass' }));
    }
  });
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  e.hc.add({ name, labels: { 'percolator.run': 'other' } });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, {
    status: 'escalate',
    outputs: {},
    reason: `terminal ${name} is not part of run ${RUN_ID} (percolator.run=other); remove it with hc rm or rename it, then resume`,
  });
  assert.deepEqual(subs(e.hc).filter((s) => s === 'run' || s === 'kill' || s === 'rm'), []);
  assert.equal(e.hc.terminals.get(name)!.state, 'live');
});

test('a live prior-attempt terminal without a percolator.run label is not adopted', async () => {
  const e = await env((t) => {
    // if it were adopted, it would exit here
    t.state = 'finished';
  });
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  e.hc.add({ name, status: 'working' });
  const out = await runtime(e).executeStep(step(), ctx({ plan: 1 }));
  assert.deepEqual(out, {
    status: 'escalate',
    outputs: {},
    reason: `terminal ${name} is not part of run ${RUN_ID} (percolator.run=none); remove it with hc rm or rename it, then resume`,
  });
  assert.deepEqual(subs(e.hc).filter((s) => s === 'run' || s === 'kill' || s === 'rm'), []);
});

test('keepTerminals false adopts a live attempt whose done.json is ok', async () => {
  const e = await env(async (t, n) => {
    // a relaunched attempt 2 would finish here
    if (n === 1) await finishWith(e.hc, t, { status: 'pass' }, { plan: 'p2' });
  });
  const first = terminalName(RUN_ID, '#123', 'plan', 1);
  const prev = e.hc.add({ name: first, labels: ours, argv: taskArgv(path.join(e.runDir, 'steps', 'plan', '1')) });
  await finishWith(e.hc, prev, { status: 'pass' }, { plan: 'p1' });
  const out = await runtime(e).executeStep(step(), ctx({ plan: 1 }));
  assert.deepEqual(out, { status: 'pass', outputs: { plan: 'steps/plan/1/outputs/plan.md' } });
  assert.ok(!subs(e.hc).includes('run'));
  assert.deepEqual(e.hc.calls.filter((c) => c[0] === 'kill' || c[0] === 'rm'), [['kill', first], ['rm', first]]);
  assert.equal(e.hc.terminals.size, 0);
});

test('a finished script terminal is collected from its exit code on resume', async () => {
  const e = await env((t) => {
    // a relaunched script would pass here
    t.state = 'finished';
    t.exitCode = 0;
  });
  const s = step({ id: 'lint', name: 'lint', role: 'hook', slotLast: false, def: { command: ['node', 'x.js'] } as Step['def'] });
  const name = terminalName(RUN_ID, '#123', 'lint', 1);
  e.hc.add({ name, labels: ours, state: 'finished', exitCode: 3 });
  const out = await runtime(e).executeStep(s, ctx());
  assert.deepEqual(out, { status: 'fail', outputs: {}, reason: 'exit code 3' });
  assert.ok(!subs(e.hc).includes('run'));
  assert.deepEqual(subs(e.hc).slice(-2), ['kill', 'rm']);
});

/** idle at turn 0 from the first wait; `now` advances 10 s per sleep; done.json appears on the 3rd sleep */
async function idleAtTurn0(over: Partial<HerdrRuntimeOptions>) {
  let term: FakeTerminal | undefined;
  let clock = 0;
  const e = await env((t, n) => {
    if (n === 1) {
      term = t;
      t.status = 'idle';
    }
  });
  const atSleep: number[] = [];
  const out = await runtime(e, {
    now: () => clock,
    sleep: async (ms) => {
      e.sleeps.push(ms);
      clock += 10_000;
      if (e.sleeps.length === 3) await finishWith(e.hc, term!, { status: 'pass' }, { plan: 'p' });
    },
    onAttention: (a) => {
      e.attention.push(a);
      atSleep.push(e.sleeps.length);
    },
    ...over,
  }).executeStep(step(), ctx());
  return { e, out, atSleep };
}

test('idle at turn 0 within the boot grace is not attention', async () => {
  const { e, out } = await idleAtTurn0({});
  assert.equal(out.status, 'pass');
  assert.deepEqual(e.attention, []);
  assert.deepEqual(e.sleeps, [2000, 2000, 2000]);
});

test('idle at turn 0 past the boot grace is attention once', async () => {
  const { e, out, atSleep } = await idleAtTurn0({ bootGraceS: 5 });
  assert.equal(out.status, 'pass');
  assert.deepEqual(e.attention, [{ stepId: 'plan', terminal: terminalName(RUN_ID, '#123', 'plan', 1), kind: 'idle' }]);
  // the first poll (0 s) is inside the grace; the second (10 s) is past it
  assert.deepEqual(atSleep, [1]);
  assert.deepEqual(e.sleeps, [2000, 2000, 2000]);
});

/** Like the real hc: `ls` returns no labels, only `get` does. */
class LsWithoutLabels extends FakeHc {
  override async list(o?: { labels?: Record<string, string>; all?: boolean }): Promise<Terminal[]> {
    return (await super.list(o)).map((t) => ({ ...t, labels: {} }));
  }
}

test('sweepTerminals removes the run\'s terminals but not the driver', async () => {
  const hc = new LsWithoutLabels();
  hc.add({ name: 'driver', labels: { ...ours, 'percolator.role': 'driver' } });
  hc.add({ name: 'plan-live', labels: { ...ours, 'percolator.step': 'plan' } });
  hc.add({ name: 'lint-done', labels: { ...ours, 'percolator.step': 'lint' }, state: 'finished', exitCode: 0 });
  hc.add({ name: 'other-run', labels: { 'percolator.run': 'other' } });

  assert.deepEqual(await sweepTerminals(hc, RUN_ID, { exceptRole: 'driver' }), ['plan-live', 'lint-done']);
  assert.deepEqual(hc.calls, [
    ['list', { labels: ours, all: true }],
    ['get', 'driver'],
    ['get', 'plan-live'],
    ['kill', 'plan-live'],
    ['rm', 'plan-live'],
    ['get', 'lint-done'],
    ['kill', 'lint-done'],
    ['rm', 'lint-done'],
  ]);
  assert.deepEqual([...hc.terminals.keys()], ['driver', 'other-run']);

  // without exceptRole every terminal of the run goes, driver included (still fetched: ownership is re-checked)
  hc.calls = [];
  assert.deepEqual(await sweepTerminals(hc, RUN_ID), ['driver']);
  assert.deepEqual(hc.calls, [['list', { labels: ours, all: true }], ['get', 'driver'], ['kill', 'driver'], ['rm', 'driver']]);
  assert.deepEqual([...hc.terminals.keys()], ['other-run']);
});

test('a finished terminal of another run is neither removed nor relaunched over', async () => {
  const e = await env((t) => {
    // a relaunch over it would exit here
    t.state = 'finished';
  });
  const name = terminalName(RUN_ID, '#123', 'plan', 1);
  e.hc.add({ name, labels: { 'percolator.run': 'other' }, state: 'finished', exitCode: 0 });
  const out = await runtime(e).executeStep(step(), ctx());
  assert.deepEqual(out, {
    status: 'escalate',
    outputs: {},
    reason: `terminal ${name} is not part of run ${RUN_ID} (percolator.run=other); remove it with hc rm or rename it, then resume`,
  });
  assert.deepEqual(subs(e.hc), ['get']);
  assert.ok(e.hc.terminals.has(name));
});

/** An hc whose `ls` ignores the label filter and returns no labels. */
class LsIgnoringLabels extends FakeHc {
  override async list(o?: { labels?: Record<string, string>; all?: boolean }): Promise<Terminal[]> {
    return (await super.list({ ...(o?.all !== undefined ? { all: o.all } : {}) })).map((t) => ({ ...t, labels: {} }));
  }
}

test('sweepTerminals re-checks run ownership: a terminal of another run listed by hc is left alone', async () => {
  for (const o of [undefined, { exceptRole: 'driver' }]) {
    const hc = new LsIgnoringLabels();
    hc.add({ name: 'plan-live', labels: { ...ours, 'percolator.step': 'plan' } });
    hc.add({ name: 'other-run', labels: { 'percolator.run': 'other' } });
    hc.add({ name: 'unlabelled' });
    assert.deepEqual(await sweepTerminals(hc, RUN_ID, o), ['plan-live']);
    assert.deepEqual(
      hc.calls.filter((c) => c[0] === 'kill' || c[0] === 'rm'),
      [['kill', 'plan-live'], ['rm', 'plan-live']],
    );
    assert.deepEqual([...hc.terminals.keys()], ['other-run', 'unlabelled']);
    assert.equal(hc.terminals.get('other-run')!.state, 'live');
  }
});
