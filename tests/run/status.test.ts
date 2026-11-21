import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../../src/engine/state.ts';
import type { RunState, StepRecord } from '../../src/engine/state.ts';
import { listRuns, writeRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { terminalName } from '../../src/runtime/herdr-runtime.ts';
import { driverAlive, runStatusJson, statusJson, yourTurn } from '../../src/run/status.ts';
import type { RunStatusJson } from '../../src/run/status.ts';
import { NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';
const TICKET = `${REPO}#5`;
const URL = `https://${REPO}/issues/5#issuecomment-7`;
const T1 = '2026-03-04T05:10:00.000Z';
const T2 = '2026-03-04T05:20:00.000Z';
const STALLED_FRESH = {
  message: 'the driver stopped while intake was running',
  detail: 'Nothing is driving this run. Resume picks up at intake.',
};
const STALLED_PLAN = {
  message: 'the driver stopped while plan was running',
  detail: 'Nothing is driving this run. Resume picks up at plan.',
};

type Env = RunEnv & {
  clock: { t: number };
  dir(m: RunMeta): string;
  prepare(): Promise<RunMeta>;
  edit(m: RunMeta, f: (s: RunState) => void): Promise<void>;
  liveDriver(m: RunMeta): void;
  /** `waiting.json` at approve-groom attempt 1, after a groom that produced `groomed_ticket` */
  waitAtGate(m: RunMeta): Promise<void>;
  status(m: RunMeta): Promise<RunStatusJson>;
};

async function setup(): Promise<Env> {
  const base = await setupRunEnv();
  const clock = { t: NOW.getTime() };
  base.deps.now = () => new Date(clock.t);
  const dir = (m: RunMeta) => path.join(base.home, '.percolator', 'runs', m.runId);
  const edit = async (m: RunMeta, f: (s: RunState) => void) => {
    const s = await loadState(dir(m));
    f(s);
    await saveState(dir(m), s);
  };
  return {
    ...base,
    clock,
    dir,
    prepare: () => prepareRun({ ticket: '#5', repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps),
    edit,
    liveDriver: (m) => {
      base.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } });
    },
    waitAtGate: async (m) => {
      await edit(m, (s) => {
        s.currentStep = 'approve-groom';
        s.history.push(rec('intake', 1, 'pass'), rec('groom', 1, 'pass', { groomed_ticket: rel('groom', 1, 'groomed_ticket') }));
      });
      await writeJson(path.join(dir(m), 'waiting.json'), {
        stepId: 'approve-groom',
        stepDir: path.join(dir(m), 'steps', 'approve-groom', '1'),
        since: NOW.toISOString(),
        commentUrl: URL,
      });
    },
    status: async (m) => {
      const l = (await listRuns(base.home)).find((x) => x.meta?.runId === m.runId)!;
      return runStatusJson(l, base.deps);
    },
  };
}

async function writeJson(file: string, v: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(v));
}

const rel = (step: string, attempt: number, key: string) => path.join('steps', step, String(attempt), 'outputs', `${key}.md`);

function rec(stepId: string, attempt: number, status: StepRecord['status'], outputs: Record<string, string> = {}): StepRecord {
  return { stepId, attempt, startedAt: T1, endedAt: T2, status, outputs };
}

const GRAPH: [string, string, 'core' | 'node', 'agent' | 'builtin' | 'script' | 'gate'][] = [
  ['intake', 'intake', 'core', 'builtin'],
  ['groom', 'groom', 'core', 'script'],
  ['approve-groom', 'groom', 'node', 'gate'],
  ['plan', 'plan', 'core', 'script'],
  ['implement', 'implement', 'core', 'script'],
  ['review', 'review', 'core', 'script'],
  ['deliver', 'deliver', 'core', 'builtin'],
];

type Step = Record<string, unknown>;

/** Every graph step pending, with `over[id]` merged in. */
function steps(over: Record<string, Step> = {}): Step[] {
  return GRAPH.map(([id, stage, role, kind]) => ({ id, stage, role, kind, status: 'pending', attempts: 0, outputs: {}, ...over[id] }));
}

const done = (attempt = 1, outputs: Record<string, string> = {}): Step => ({ status: 'pass', attempts: attempt, startedAt: T1, endedAt: T2, outputs });

function loops(rounds: Record<string, number> = {}) {
  return [
    { id: 'approve-groom', from: 'approve-groom', to: 'groom', round: rounds['approve-groom'] ?? 0, max: 3, atCap: 'escalate' },
    { id: 'review', from: 'review', to: 'implement', round: rounds['review'] ?? 0, max: 3, atCap: 'continue' },
  ];
}

/** The run object of a fresh prepared run (no attention, nothing live), with `over` merged in. */
function expected(m: RunMeta, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: m.runId,
    ticket: { ref: TICKET, number: 5 },
    repo: m.repoRoot,
    branch: m.branch,
    worktree: m.worktree,
    createdAt: m.createdAt,
    status: 'running',
    driver: { alive: false, terminal: m.driver, space: m.space, shown: false },
    steps: steps(),
    loops: loops(),
    terminals: {},
    pr: null,
    graph: 'full',
    ...over,
  };
}

/** Steps of a run waiting at approve-groom (see `waitAtGate`). */
function gateSteps(e: Env, m: RunMeta, gate: Step = { status: 'waiting' }): Step[] {
  return steps({
    intake: done(),
    groom: done(1, { groomed_ticket: path.join(e.dir(m), rel('groom', 1, 'groomed_ticket')) }),
    'approve-groom': gate,
  });
}

function groomReview(e: Env, m: RunMeta) {
  return [{ step: 'groom', key: 'groomed_ticket', path: path.join(e.dir(m), rel('groom', 1, 'groomed_ticket')) }];
}

test('gate with live driver', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    e.liveDriver(m);
    await writeJson(path.join(e.dir(m), 'issue.json'), { repo: REPO, number: 5, title: 'Fix the thing', url: `https://${REPO}/issues/5` });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        ticket: { ref: TICKET, number: 5, title: 'Fix the thing', url: `https://${REPO}/issues/5` },
        status: 'waiting',
        currentStep: 'approve-groom',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        attention: { kind: 'gate', since: NOW.toISOString(), message: 'approve-groom is waiting for approval', commentUrl: URL, review: groomReview(e, m), actions: ['approve', 'reject'] },
        steps: gateSteps(e, m),
        terminals: { driver: m.driver },
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('dead-driver gate', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'waiting',
        currentStep: 'approve-groom',
        attention: { kind: 'gate', since: NOW.toISOString(), message: 'approve-groom is waiting for approval', commentUrl: URL, review: groomReview(e, m), actions: ['approve', 'reject'] },
        steps: gateSteps(e, m),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('decided gate', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    await writeJson(path.join(e.dir(m), 'steps', 'approve-groom', '1', 'decision.json'), { decision: 'approve', by: 'alice', via: 'local' });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'waiting',
        currentStep: 'approve-groom',
        attention: { kind: 'stalled', since: NOW.toISOString(), message: 'approved; resume to continue', actions: ['resume'] },
        steps: gateSteps(e, m),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('paused at cap', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const findings = rel('approve-groom', 3, 'findings');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'approve-groom';
      s.pausedReason = 'cap: approve-groom reached 3 rounds';
      s.pausedCap = 'approve-groom';
      s.rounds['approve-groom'] = 3;
      s.history.push(rec('intake', 1, 'pass'), rec('groom', 3, 'pass'), rec('approve-groom', 3, 'fail', { findings }));
    });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'paused',
        currentStep: 'approve-groom',
        attention: {
          kind: 'cap',
          since: T2,
          message: 'approve-groom hit its cap (approve-groom reached 3 rounds)',
          detail: 'Grant one more round and the run goes back with the open findings.',
          review: [{ step: 'approve-groom', key: 'findings', path: path.join(e.dir(m), findings) }],
          actions: ['grant'],
        },
        steps: steps({
          intake: done(),
          groom: done(3),
          'approve-groom': { status: 'fail', attempts: 3, startedAt: T1, endedAt: T2, outputs: { findings: path.join(e.dir(m), findings) } },
        }),
        loops: loops({ 'approve-groom': 3 }),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('paused on escalate', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.pausedReason = 'escalate: plan';
      s.history.push(rec('plan', 1, 'escalate'));
    });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'paused',
        currentStep: 'plan',
        attention: { kind: 'paused', since: T2, message: 'plan paused: escalate: plan', review: [], actions: ['resume'] },
        steps: steps({ plan: { status: 'escalate', attempts: 1, startedAt: T1, endedAt: T2, outputs: {} } }),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('failed run with worktree → failed attention (clean)', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const summary = rel('implement', 1, 'summary');
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.currentStep = 'implement';
      s.history.push(rec('implement', 1, 'fail', { summary }));
    });
    e.deps.hc.calls.length = 0;
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'failed',
        currentStep: 'implement',
        attention: {
          kind: 'failed',
          since: T2,
          message: 'implement failed',
          detail: "A failed run can't be resumed. Start a new run for the ticket, or clean this one up.",
          review: [{ step: 'implement', key: 'summary', path: path.join(e.dir(m), summary) }],
          actions: ['clean'],
          commands: [`perc run ${TICKET} --repo ${m.repoRoot}`],
        },
        steps: steps({ implement: { status: 'fail', attempts: 1, startedAt: T1, endedAt: T2, outputs: { summary: path.join(e.dir(m), summary) } } }),
      }),
    );
    assert.deepEqual(e.deps.hc.calls, [], 'a failed run asks hc nothing');
  } finally {
    await e.cleanup();
  }
});

test('failed run after clean → no attention', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const summary = rel('implement', 1, 'summary');
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.currentStep = 'implement';
      s.history.push(rec('implement', 1, 'fail', { summary }));
    });
    await fs.rm(m.worktree, { recursive: true, force: true });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'failed',
        currentStep: 'implement',
        steps: steps({ implement: { status: 'fail', attempts: 1, startedAt: T1, endedAt: T2, outputs: { summary: path.join(e.dir(m), summary) } } }),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('stalled running', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'plan'));
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'plan',
        attention: { kind: 'stalled', since: m.createdAt, ...STALLED_PLAN, actions: ['resume'] },
        steps: steps({ plan: { status: 'running' } }),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('agent blocked', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'groom'));
    e.liveDriver(m);
    const term = terminalName(m.runId, m.ticket, 'groom', 1);
    e.deps.hc.add({ name: term, labels: { 'percolator.run': m.runId, 'percolator.step': 'groom' } });
    await writeJson(path.join(e.dir(m), 'attention.json'), { stepId: 'groom', terminal: term, kind: 'blocked', at: T1 });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'groom',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        attention: { kind: 'agent', since: T1, terminal: term, agentState: 'blocked', message: `groom's agent is blocked in terminal ${term}`, detail: "Attend the agent's terminal.", actions: ['open-pane'] },
        steps: steps({ groom: { status: 'running' } }),
        terminals: { driver: m.driver, groom: term },
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('running', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'implement'));
    e.liveDriver(m);
    // attention.json of an earlier step is stale: no agent attention
    await writeJson(path.join(e.dir(m), 'attention.json'), { stepId: 'groom', terminal: 'x', kind: 'idle', at: T1 });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'implement',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        steps: steps({ implement: { status: 'running' } }),
        terminals: { driver: m.driver },
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('completed', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const prFile = rel('deliver', 1, 'pr_url');
    await e.edit(m, (s) => {
      s.status = 'completed';
      delete s.currentStep;
      s.history.push(rec('deliver', 1, 'pass', { pr_url: prFile }));
    });
    await fs.mkdir(path.dirname(path.join(e.dir(m), prFile)), { recursive: true });
    await fs.writeFile(path.join(e.dir(m), prFile), `https://${REPO}/pull/3\n`);
    e.liveDriver(m); // a leftover driver terminal is not looked up
    e.deps.hc.calls.length = 0;
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'completed',
        steps: steps({ deliver: done(1, { pr_url: path.join(e.dir(m), prFile) }) }),
        pr: { url: `https://${REPO}/pull/3` },
      }),
    );
    assert.deepEqual(e.deps.hc.calls, [], 'a completed run asks hc nothing');
  } finally {
    await e.cleanup();
  }
});

test('steps from graph.json', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const f1 = rel('review', 1, 'findings');
    const f2 = rel('review', 2, 'findings');
    await e.edit(m, (s) => {
      s.currentStep = 'implement';
      s.rounds['review'] = 1;
      s.history.push(
        rec('implement', 1, 'pass'),
        rec('review', 1, 'fail', { findings: f1 }),
        rec('implement', 2, 'pass'),
        { stepId: 'review', attempt: 2, startedAt: T2, endedAt: T2, status: 'fail', outputs: { findings: f2 } },
      );
    });
    e.liveDriver(m);
    const r = await e.status(m);
    assert.deepEqual(
      r,
      expected(m, {
        currentStep: 'implement',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        steps: steps({
          implement: { status: 'running', attempts: 2, startedAt: T1, endedAt: T2, outputs: {} },
          review: { status: 'fail', attempts: 2, startedAt: T2, endedAt: T2, outputs: { findings: path.join(e.dir(m), f2) } },
        }),
        loops: loops({ review: 1 }),
        terminals: { driver: m.driver },
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('steps from history only', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(path.join(e.dir(m), 'graph.json'));
    await e.edit(m, (s) => {
      s.currentStep = 'lint';
      s.history.push(
        rec('intake', 1, 'pass'),
        rec('groom', 1, 'pass'),
        rec('approve-groom', 1, 'pass'),
        rec('plan', 1, 'pass'),
        rec('check', 1, 'pass'),
        rec('lint', 1, 'fail'),
      );
    });
    await writeJson(path.join(e.dir(m), 'steps', 'check', '1', 'decision.json'), { decision: 'approve', by: 'a', via: 'local' });
    e.liveDriver(m);
    const pass = (id: string, stage: string, role: string, kind: string) => ({ id, stage, role, kind, ...done() });
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'lint',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        steps: [
          pass('intake', 'intake', 'core', 'agent'),
          pass('groom', 'groom', 'core', 'agent'),
          pass('approve-groom', 'groom', 'node', 'gate'),
          pass('plan', 'plan', 'core', 'agent'),
          pass('check', 'plan', 'node', 'gate'),
          { id: 'lint', stage: 'plan', role: 'node', kind: 'agent', status: 'running', attempts: 1, startedAt: T1, endedAt: T2, outputs: {} },
        ],
        loops: [],
        terminals: { driver: m.driver },
        graph: 'history',
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('history only: a waiting gate with no history record yet is still a step', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(path.join(e.dir(m), 'graph.json'));
    await e.waitAtGate(m);
    const groomOut = path.join(e.dir(m), rel('groom', 1, 'groomed_ticket'));
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        status: 'waiting',
        currentStep: 'approve-groom',
        attention: { kind: 'gate', since: NOW.toISOString(), message: 'approve-groom is waiting for approval', commentUrl: URL, review: groomReview(e, m), actions: ['approve', 'reject'] },
        steps: [
          { id: 'intake', stage: 'intake', role: 'core', kind: 'agent', ...done() },
          { id: 'groom', stage: 'groom', role: 'core', kind: 'agent', ...done(1, { groomed_ticket: groomOut }) },
          { id: 'approve-groom', stage: 'groom', role: 'node', kind: 'gate', status: 'waiting', attempts: 0, outputs: {} },
        ],
        loops: [],
        graph: 'history',
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('history only: a running step with no history record yet is still a step', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(path.join(e.dir(m), 'graph.json'));
    await e.edit(m, (s) => {
      s.currentStep = 'groom';
      s.history.push(rec('intake', 1, 'pass'));
    });
    e.liveDriver(m);
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'groom',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        steps: [
          { id: 'intake', stage: 'intake', role: 'core', kind: 'agent', ...done() },
          { id: 'groom', stage: 'groom', role: 'core', kind: 'agent', status: 'running', attempts: 0, outputs: {} },
        ],
        loops: [],
        terminals: { driver: m.driver },
        graph: 'history',
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('history only: a custom first step gets stage before-all and role node', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(path.join(e.dir(m), 'graph.json'));
    await e.edit(m, (s) => (s.currentStep = 'setup'));
    e.liveDriver(m);
    assert.deepEqual(
      await e.status(m),
      expected(m, {
        currentStep: 'setup',
        driver: { alive: true, terminal: m.driver, space: m.space, shown: false },
        steps: [{ id: 'setup', stage: 'before-all', role: 'node', kind: 'agent', status: 'running', attempts: 0, outputs: {} }],
        loops: [],
        terminals: { driver: m.driver },
        graph: 'history',
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('gate review is the groomed ticket', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    // an earlier step's outputs are not what the gate follows
    await e.edit(m, (s) => (s.history[0]!.outputs = { issue: rel('intake', 1, 'issue') }));
    const r = (await e.status(m)) as { attention?: { review?: unknown } };
    const abs = path.join(e.dir(m), 'steps', 'groom', '1', 'outputs', 'groomed_ticket.md');
    assert.ok(path.isAbsolute(abs));
    assert.deepEqual(r.attention?.review, [{ step: 'groom', key: 'groomed_ticket', path: abs }]);
  } finally {
    await e.cleanup();
  }
});

test('status json keeps going past a broken run', async () => {
  const e = await setup();
  try {
    const good = await e.prepare();
    e.clock.t += 1000;
    const badGraph = await e.prepare();
    await fs.writeFile(path.join(e.dir(badGraph), 'graph.json'), '{"version": 2}');
    const broken = path.join(e.home, '.percolator', 'runs', 't9-broken');
    await fs.mkdir(broken, { recursive: true });
    const graphFile = path.join(e.dir(badGraph), 'graph.json');
    e.clock.t += 1000;
    const noState = await e.prepare();
    const noStateFile = path.join(e.dir(noState), 'state.json');
    await fs.rm(noStateFile);
    e.clock.t += 1000;
    const badState = await e.prepare();
    const badStateFile = path.join(e.dir(badState), 'state.json');
    await fs.writeFile(badStateFile, '{not json');
    assert.deepEqual(await statusJson(e.deps), {
      schema: 1,
      runs: [
        {
          id: noState.runId,
          status: 'unreadable',
          error: `Cannot read run state ${noStateFile}: ENOENT: no such file or directory, open '${noStateFile}'`,
        },
        { id: badGraph.runId, status: 'unreadable', error: `Run graph ${graphFile} is invalid: version: Invalid input: expected 1; start a new run` },
        expected(good, { attention: { kind: 'stalled', since: good.createdAt, ...STALLED_FRESH, actions: ['resume'] } }),
        { id: badState.runId, status: 'unreadable', error: `Run state ${badStateFile} is not valid JSON` },
        { id: 't9-broken', status: 'unreadable', error: `Run metadata ${path.join(broken, 'run.json')} is missing or invalid: file not found` },
      ],
    });
  } finally {
    await e.cleanup();
  }
});

test('status json reads runs four at a time, in listRuns order', async () => {
  const e = await setup();
  try {
    for (let i = 0; i < 6; i++) {
      await e.prepare();
      e.clock.t += 1000;
    }
    let inFlight = 0;
    let most = 0;
    const get = e.deps.hc.get.bind(e.deps.hc);
    e.deps.hc.get = async (name) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return get(name);
    };
    const j = await statusJson(e.deps);
    assert.deepEqual(
      j.runs.map((r) => r.id),
      (await listRuns(e.home)).map((l) => l.meta!.runId),
    );
    assert.equal(j.runs.length, 6);
    assert.equal(most, 4);
  } finally {
    await e.cleanup();
  }
});

test('status json never loads config', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(e.configFile);
    assert.deepEqual(await statusJson(e.deps), { schema: 1, runs: [expected(m, { attention: { kind: 'stalled', since: m.createdAt, ...STALLED_FRESH, actions: ['resume'] } })] });
  } finally {
    await e.cleanup();
  }
});

const driverOf = (r: RunStatusJson) => (r as Extract<RunStatusJson, { driver: unknown }>).driver;

test('driver.shown is true when the owned driver carries the run\'s space', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    e.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver', 'herdr.space': m.space! } });
    assert.deepEqual(driverOf(await e.status(m)), { alive: true, terminal: m.driver, space: m.space, shown: true });
  } finally {
    await e.cleanup();
  }
});

test('driver.shown is false when the driver\'s herdr.space is another space', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    e.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver', 'herdr.space': 'space-9' } });
    assert.deepEqual(driverOf(await e.status(m)), { alive: true, terminal: m.driver, space: m.space, shown: false });
  } finally {
    await e.cleanup();
  }
});

test('driver.shown is false for a driver this run does not own', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    e.deps.hc.add({ name: m.driver, labels: { 'percolator.run': 'other-run', 'percolator.role': 'driver', 'herdr.space': m.space! } });
    const r = await e.status(m);
    assert.equal('terminals' in r && r.terminals['driver'], undefined);
    assert.equal('driver' in r && r.driver.shown, false);
  } finally {
    await e.cleanup();
  }
});

test('driver has no space when the run has none', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    const { space: _space, ...bare } = m;
    await writeRunMeta(e.dir(m), bare);
    e.liveDriver(m);
    assert.deepEqual(driverOf(await e.status(m)), { alive: true, terminal: m.driver, shown: false });
  } finally {
    await e.cleanup();
  }
});

test('driverAlive is null for another host', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'plan'));
    const lock = (host: string) => writeJson(path.join(e.dir(m), 'driver.json'), { pid: 4242, host, terminal: null, startedAt: NOW.toISOString() });
    await lock('elsewhere');
    assert.equal(await driverAlive(e.dir(m), m, e.deps), null);
    // no stalled attention when liveness can't be known
    assert.deepEqual(
      await e.status(m),
      expected(m, { currentStep: 'plan', driver: { alive: null, terminal: m.driver, space: m.space, shown: false }, steps: steps({ plan: { status: 'running' } }) }),
    );
    await lock(os.hostname());
    assert.equal(await driverAlive(e.dir(m), m, { ...e.deps, pidAlive: (p) => p === 4242 }), true);
    assert.equal(await driverAlive(e.dir(m), m, { ...e.deps, pidAlive: () => false }), false);
  } finally {
    await e.cleanup();
  }
});

test('driverAlive is null when hc fails and there is no lock, and no stalled attention is raised', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'plan'));
    e.deps.hc.get = async () => {
      throw new Error('hc not found');
    };
    assert.equal(await driverAlive(e.dir(m), m, e.deps), null);
    assert.deepEqual(
      await e.status(m),
      expected(m, { currentStep: 'plan', driver: { alive: null, terminal: m.driver, space: m.space, shown: false }, steps: steps({ plan: { status: 'running' } }) }),
    );
  } finally {
    await e.cleanup();
  }
});

test('terminals when hc ls returns no labels', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.currentStep = 'groom'));
    e.liveDriver(m);
    const term = terminalName(m.runId, m.ticket, 'groom', 1);
    e.deps.hc.add({ name: term, labels: { 'percolator.run': m.runId, 'percolator.step': 'groom' } });
    const list = e.deps.hc.list.bind(e.deps.hc);
    // like the real hc ls: the label filter applies, but no labels come back
    e.deps.hc.list = async (o) => (await list(o)).map((t) => ({ ...t, labels: {} }));
    const r = (await e.status(m)) as { terminals?: unknown };
    assert.deepEqual(r.terminals, { driver: m.driver, groom: term });
  } finally {
    await e.cleanup();
  }
});

test('a corrupt waiting.json makes the run unreadable with a located error', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const file = path.join(e.dir(m), 'waiting.json');
    await fs.writeFile(file, '{"stepId": 1}');
    assert.deepEqual(await e.status(m), {
      id: m.runId,
      status: 'unreadable',
      error: `Waiting file ${file} is invalid: stepId: Invalid input: expected string, received number; delete it and resume the run`,
    });
    await fs.writeFile(file, '{oops');
    const r = (await e.status(m)) as { error?: string };
    assert.equal(r.error, `Waiting file ${file} is invalid: ${jsonError('{oops')}; delete it and resume the run`);
  } finally {
    await e.cleanup();
  }
});

function jsonError(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

const TURN = { runId: 'r1', step: 'groom', ticket: 'github.com/o/r#5', repoRoot: '/repo' };

test('yourTurn gate', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'gate', step: 'approve-groom' }), {
    message: 'approve-groom is waiting for approval',
    next: ['perc approve r1', 'perc reject r1 "<what to change>"'],
  });
});

test('yourTurn cap', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'cap', reason: '3 rounds' }), {
    message: 'groom hit its cap (3 rounds)',
    detail: 'Grant one more round and the run goes back with the open findings.',
    next: ['perc resume r1'],
  });
});

test('yourTurn paused', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'paused', reason: 'escalate: groom' }), {
    message: 'groom paused: escalate: groom',
    next: ['perc resume r1'],
  });
});

test('yourTurn failed', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'failed' }), {
    message: 'groom failed',
    detail: "A failed run can't be resumed. Start a new run for the ticket, or clean this one up.",
    next: ['perc run github.com/o/r#5 --repo /repo', 'perc clean r1'],
  });
});

test('yourTurn stalled after a decision', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'stalled', decision: 'approve' }), {
    message: 'approved; resume to continue',
    next: ['perc resume r1'],
  });
  assert.equal(yourTurn({ ...TURN, kind: 'stalled', decision: 'reject' }).message, 'rejected; resume to continue');
});

test('yourTurn stalled while running', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'stalled' }), {
    message: 'the driver stopped while groom was running',
    detail: 'Nothing is driving this run. Resume picks up at groom.',
    next: ['perc resume r1'],
  });
});

test('yourTurn agent', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'agent', agentState: 'blocked', terminal: 't-1' }), {
    message: "groom's agent is blocked in terminal t-1",
    detail: "Attend the agent's terminal.",
    next: [],
  });
});
