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
import { attentionNext, driverAlive, runStatusJson, statusJson, yourTurn } from '../../src/run/status.ts';
import type { RunStatusJson, TimelineJson } from '../../src/run/status.ts';
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
  /** prepares a run on `ticket` (default #5) */
  prepare(ticket?: string): Promise<RunMeta>;
  edit(m: RunMeta, f: (s: RunState) => void): Promise<void>;
  liveDriver(m: RunMeta): void;
  /** `waiting.json` at approve-groom attempt 1, after a groom that produced `groomed_ticket` */
  waitAtGate(m: RunMeta): Promise<void>;
  /** the whole status JSON, `timeline` included */
  full(m: RunMeta): Promise<RunStatusJson>;
  /** `full` without `timeline` (the timeline has its own tests) */
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
    prepare: (ticket = '#5') => prepareRun({ ticket, repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps),
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
    full: async (m) => {
      const l = (await listRuns(base.home)).find((x) => x.meta?.runId === m.runId)!;
      return runStatusJson(l, base.deps);
    },
    status: async (m) => {
      const l = (await listRuns(base.home)).find((x) => x.meta?.runId === m.runId)!;
      const { timeline: _t, ...rest } = (await runStatusJson(l, base.deps)) as Record<string, unknown>;
      return rest as RunStatusJson;
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

type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
const timelineOf = async (e: Env, m: RunMeta): Promise<TimelineJson[]> => ((await e.full(m)) as Readable).timeline;

/** The timeline of a fresh prepared run: the live intake attempt. */
const freshTimeline = (m: RunMeta) => [{ kind: 'attempt', step: 'intake', attempt: 1, status: 'running', startedAt: m.createdAt, outputs: {} }];

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
    pipeline: 'feature',
    inputs: {},
    ticket: { ref: TICKET, number: 5 },
    parent: null,
    children: [],
    opened: [],
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

test('timeline lists every attempt in history order with absolute outputs', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'approve-groom';
      s.history.push(
        rec('intake', 1, 'pass'),
        rec('groom', 1, 'pass', { groomed_ticket: rel('groom', 1, 'groomed_ticket') }),
        rec('approve-groom', 1, 'fail', { findings: rel('approve-groom', 1, 'findings') }),
        rec('groom', 2, 'pass', { groomed_ticket: rel('groom', 2, 'groomed_ticket') }),
      );
    });
    const tl = await timelineOf(e, m);
    assert.deepEqual(
      tl.map((x) => x.kind === 'attempt' && `${x.step}#${x.attempt}:${x.status}`),
      ['intake#1:pass', 'groom#1:pass', 'approve-groom#1:fail', 'groom#2:pass'],
    );
    assert.deepEqual(tl[3], {
      kind: 'attempt',
      step: 'groom',
      attempt: 2,
      status: 'pass',
      startedAt: T1,
      endedAt: T2,
      outputs: { groomed_ticket: path.join(e.dir(m), rel('groom', 2, 'groomed_ticket')) },
    });
  } finally {
    await e.cleanup();
  }
});

test('timeline ends with the live attempt of a running step, started when the last record ended', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.currentStep = 'plan';
      s.executed = { intake: 1, groom: 1 };
      s.history.push(rec('intake', 1, 'pass'), rec('groom', 1, 'pass'));
    });
    assert.deepEqual((await timelineOf(e, m)).at(-1), { kind: 'attempt', step: 'plan', attempt: 1, status: 'running', startedAt: T2, outputs: {} });
  } finally {
    await e.cleanup();
  }
});

test('timeline ends with a waiting gate attempt, started when it began waiting', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    await e.edit(m, (s) => {
      s.executed = { intake: 1, groom: 1 };
    });
    assert.deepEqual((await timelineOf(e, m)).at(-1), {
      kind: 'attempt',
      step: 'approve-groom',
      attempt: 1,
      status: 'waiting',
      startedAt: NOW.toISOString(),
      outputs: {},
    });
  } finally {
    await e.cleanup();
  }
});

test('a fresh run is running intake: its timeline is the live intake attempt, started at createdAt', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    assert.deepEqual(await timelineOf(e, m), freshTimeline(m));
  } finally {
    await e.cleanup();
  }
});

test('a completed or paused run has no live attempt', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    for (const status of ['completed', 'paused'] as const) {
      await e.edit(m, (s) => {
        s.status = status;
        s.currentStep = 'plan';
        s.history = [rec('intake', 1, 'pass'), rec('groom', 1, 'pass')];
      });
      assert.deepEqual(
        (await timelineOf(e, m)).map((x) => x.kind === 'attempt' && `${x.step}#${x.attempt}:${x.status}`),
        ['intake#1:pass', 'groom#1:pass'],
        status,
      );
    }
  } finally {
    await e.cleanup();
  }
});

const gateEntries = (tl: TimelineJson[]) => tl.filter((x) => x.kind === 'attempt' && x.step === 'approve-groom');

test('a gate attempt carries its decision and who made it, from decision.json', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.history.push(
        rec('intake', 1, 'pass'),
        rec('groom', 1, 'pass'),
        rec('approve-groom', 1, 'fail', { findings: rel('approve-groom', 1, 'findings') }),
        rec('groom', 2, 'pass'),
        rec('approve-groom', 2, 'pass', { approval: rel('approve-groom', 2, 'approval') }),
      );
    });
    await writeJson(path.join(e.dir(m), 'steps', 'approve-groom', '1', 'decision.json'), { decision: 'reject', by: 'zidious', via: 'local', feedback: 'x' });
    await writeJson(path.join(e.dir(m), 'steps', 'approve-groom', '2', 'decision.json'), { decision: 'approve', by: 'zidious', via: 'local' });
    assert.deepEqual(
      gateEntries(await timelineOf(e, m)).map((x) => x.kind === 'attempt' && x.decision),
      [{ decision: 'reject', by: 'zidious' }, { decision: 'approve', by: 'zidious' }],
    );
  } finally {
    await e.cleanup();
  }
});

test('a gate decided by a GitHub comment takes who from its approval or findings output', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.history.push(
        rec('approve-groom', 1, 'fail', { findings: rel('approve-groom', 1, 'findings') }),
        rec('approve-groom', 2, 'pass', { approval: rel('approve-groom', 2, 'approval') }),
      );
    });
    const out = async (attempt: number, key: string, text: string) => {
      const f = path.join(e.dir(m), rel('approve-groom', attempt, key));
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, text);
    };
    await out(2, 'approval', 'Approved by @octo via comment https://github.com/o/r/issues/5#issuecomment-9\n');
    await out(1, 'findings', 'Rejected by @octo-cat: tighten scope\n');
    assert.deepEqual(
      gateEntries(await timelineOf(e, m)).map((x) => x.kind === 'attempt' && x.decision),
      [{ decision: 'reject', by: 'octo-cat' }, { decision: 'approve', by: 'octo' }],
    );
  } finally {
    await e.cleanup();
  }
});

test('a gate decision without a readable decision.json or output has no by', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.history.push(rec('approve-groom', 1, 'pass', { approval: rel('approve-groom', 1, 'approval') }));
    });
    const f = path.join(e.dir(m), 'steps', 'approve-groom', '1', 'decision.json');
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'not json');
    const entry = gateEntries(await timelineOf(e, m))[0] as { decision?: unknown };
    assert.deepEqual(entry.decision, { decision: 'approve' });
    assert.notEqual((await e.full(m)).status, 'unreadable');
  } finally {
    await e.cleanup();
  }
});

test('agent attempts and escalated gate attempts carry no decision', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'approve-groom';
      s.history.push(rec('groom', 1, 'pass'), rec('approve-groom', 1, 'escalate'));
    });
    const [groomEntry, gateEntry] = await timelineOf(e, m);
    assert.equal('decision' in groomEntry!, false);
    assert.equal('decision' in gateEntry!, false);
  } finally {
    await e.cleanup();
  }
});

async function reviewLoop(e: Env, m: RunMeta, round: number): Promise<TimelineJson[]> {
  await e.edit(m, (s) => {
    s.currentStep = 'deliver';
    s.rounds = { review: round };
    s.history.push(
      rec('implement', 1, 'pass'),
      rec('review', 1, 'fail'),
      rec('implement', 2, 'pass'),
      rec('review', 2, 'fail'),
      rec('implement', 3, 'pass'),
      rec('review', 3, 'fail'),
    );
  });
  return timelineOf(e, m);
}

test('a loop at its cap adds a cap entry right after the attempt that hit it', async () => {
  const e = await setup();
  try {
    const tl = await reviewLoop(e, await e.prepare(), 3);
    const i = tl.findIndex((x) => x.kind === 'cap');
    assert.deepEqual(tl[i], { kind: 'cap', loop: 'review', from: 'review', to: 'implement', max: 3, at: T2 });
    assert.deepEqual(tl[i - 1], { ...tl[i - 1], step: 'review', attempt: 3 });
  } finally {
    await e.cleanup();
  }
});

test('a loop under its cap adds no cap entry', async () => {
  const e = await setup();
  try {
    const tl = await reviewLoop(e, await e.prepare(), 2);
    assert.equal(tl.some((x) => x.kind === 'cap'), false);
  } finally {
    await e.cleanup();
  }
});

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
          detail: "A failed run can't be resumed. Start a new run for the ticket, then delete this one (or clean it up to keep its record).",
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
    const term = terminalName(m.runId, m.ticket!, 'groom', 1);
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
    // one ticket each: a ticket has at most one live run
    const badGraph = await e.prepare('#6');
    await fs.writeFile(path.join(e.dir(badGraph), 'graph.json'), '{"version": 2}');
    const broken = path.join(e.home, '.percolator', 'runs', 't9-broken');
    await fs.mkdir(broken, { recursive: true });
    const graphFile = path.join(e.dir(badGraph), 'graph.json');
    e.clock.t += 1000;
    const noState = await e.prepare('#7');
    const noStateFile = path.join(e.dir(noState), 'state.json');
    await fs.rm(noStateFile);
    e.clock.t += 1000;
    const badState = await e.prepare('#8');
    const badStateFile = path.join(e.dir(badState), 'state.json');
    await fs.writeFile(badStateFile, '{not json');
    assert.deepEqual(await statusJson(e.deps), {
      schema: 2,
      runs: [
        {
          id: noState.runId,
          status: 'unreadable',
          error: `Cannot read run state ${noStateFile}: ENOENT: no such file or directory, open '${noStateFile}'`,
        },
        { id: badGraph.runId, status: 'unreadable', error: `Run graph ${graphFile} is invalid: version: Invalid input: expected 1; start a new run` },
        expected(good, { attention: { kind: 'stalled', since: good.createdAt, ...STALLED_FRESH, actions: ['resume'] }, timeline: freshTimeline(good) }),
        { id: badState.runId, status: 'unreadable', error: `Run state ${badStateFile} is not valid JSON` },
        { id: 't9-broken', status: 'unreadable', error: `Run metadata ${path.join(broken, 'run.json')} is missing or invalid: file not found` },
      ],
      watcher: { alive: false, repos: [] },
    });
  } finally {
    await e.cleanup();
  }
});

test('status json reads runs four at a time, in listRuns order', async () => {
  const e = await setup();
  try {
    for (let i = 0; i < 6; i++) {
      await e.prepare(`#${5 + i}`);
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
    assert.deepEqual(await statusJson(e.deps), { schema: 2, runs: [expected(m, { attention: { kind: 'stalled', since: m.createdAt, ...STALLED_FRESH, actions: ['resume'] }, timeline: freshTimeline(m) })], watcher: { alive: false, repos: [] } });
  } finally {
    await e.cleanup();
  }
});

/** Rewrites `m`'s run.json with `over` merged in, dropping the keys in `drop`; returns the new meta. */
async function rewriteMeta(e: Env, m: RunMeta, over: Partial<RunMeta>, drop: (keyof RunMeta)[] = []): Promise<RunMeta> {
  const next = { ...m, ...over } as Record<string, unknown>;
  for (const k of drop) delete next[k];
  await writeRunMeta(e.dir(m), next as RunMeta);
  return next as RunMeta;
}

/** A prepared run turned into a ticketless dd-alert run (run.json without ticket or issue). */
async function ticketless(e: Env): Promise<RunMeta> {
  const m = await e.prepare('#9');
  return rewriteMeta(e, m, { pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x' } }, ['ticket', 'issue']);
}

test('statusJson is schema 2 with pipeline and inputs', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const hotfix = await rewriteMeta(e, m, { pipeline: 'hotfix', inputs: { service: 'api', note: 'a=b c' } });
    const j = await statusJson(e.deps);
    assert.equal(j.schema, 2);
    const r = j.runs[0] as Readable;
    assert.deepEqual([r.pipeline, r.inputs, r.ticket, r.parent, r.children], ['hotfix', hotfix.inputs, { ref: TICKET, number: 5 }, null, []]);
  } finally {
    await e.cleanup();
  }
});

test('a ticketless run has ticket null', async () => {
  const e = await setup();
  try {
    const m = await ticketless(e);
    const r = (await e.status(m)) as Readable;
    assert.equal(r.ticket, null);
    assert.equal(r.pipeline, 'dd-alert');
    assert.deepEqual(r.inputs, { alert_url: 'https://dd/x' });
  } finally {
    await e.cleanup();
  }
});

test('a ticketless gate is answered here: no commentUrl, its own message', async () => {
  const e = await setup();
  try {
    const m = await ticketless(e);
    await e.edit(m, (s) => {
      s.currentStep = 'approve-groom';
      s.history.push(rec('intake', 1, 'pass'), rec('groom', 1, 'pass', { groomed_ticket: rel('groom', 1, 'groomed_ticket') }));
    });
    await writeJson(path.join(e.dir(m), 'waiting.json'), {
      stepId: 'approve-groom',
      stepDir: path.join(e.dir(m), 'steps', 'approve-groom', '1'),
      since: NOW.toISOString(),
    });
    e.liveDriver(m);
    const r = (await e.status(m)) as Readable;
    assert.deepEqual(r.attention, {
      kind: 'gate',
      since: NOW.toISOString(),
      message: 'approve or reject here (no issue to comment on)',
      review: groomReview(e, m),
      actions: ['approve', 'reject'],
    });
  } finally {
    await e.cleanup();
  }
});

test('a failed ticketless run says how to start it again with its pipeline and inputs', async () => {
  const e = await setup();
  try {
    const m = await ticketless(e);
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.currentStep = 'implement';
      s.history.push(rec('implement', 1, 'fail'));
    });
    const r = (await e.status(m)) as Readable;
    const again = `perc run --pipeline dd-alert --input alert_url=https://dd/x --repo ${m.repoRoot}`;
    assert.deepEqual(r.attention?.commands, [again]);
    assert.deepEqual(attentionNext(r.attention!, r), [again, `perc delete ${m.runId}`, `perc clean ${m.runId}`]);
  } finally {
    await e.cleanup();
  }
});

test('status lists the issues a run opened', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const write = async (attempt: number, text: string) => {
      const file = path.join(e.dir(m), rel('ship', attempt, 'issue_urls'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    };
    await write(1, `https://${REPO}/issues/40\n`);
    // the latest issue_urls wins; a line that is not an issue url is skipped
    await write(2, `https://${REPO}/issues/41\r\nnot a url\n\nhttps://github.com/O/Other/issues/7\n`);
    await e.edit(m, (s) => {
      s.status = 'completed';
      s.history.push(rec('ship', 1, 'pass', { issue_urls: rel('ship', 1, 'issue_urls') }), rec('ship', 2, 'pass', { issue_urls: rel('ship', 2, 'issue_urls') }));
    });
    const r = (await e.status(m)) as Readable;
    assert.deepEqual(r.opened, [
      { ref: `${REPO}#41`, url: `https://${REPO}/issues/41` },
      { ref: 'github.com/o/other#7', url: 'https://github.com/O/Other/issues/7' },
    ]);
  } finally {
    await e.cleanup();
  }
});

test('a recorded issue_urls output whose file is gone opens nothing and keeps the run readable', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'completed';
      s.history.push(rec('ship', 1, 'pass', { issue_urls: rel('ship', 1, 'issue_urls') }));
    });
    const r = (await e.status(m)) as Readable;
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.opened, []);
  } finally {
    await e.cleanup();
  }
});

test('children list linked runs', async () => {
  const e = await setup();
  try {
    const parent = await e.prepare();
    e.clock.t += 1000;
    const c = await e.prepare('#6');
    const child = await rewriteMeta(e, c, { pipeline: 'hotfix', parent: parent.runId });
    const j = await statusJson(e.deps);
    const of = (id: string) => j.runs.find((r) => r.id === id) as Readable;
    assert.deepEqual(of(parent.runId).children, [{ id: child.runId, pipeline: 'hotfix', status: 'running' }]);
    assert.equal(of(child.runId).parent, parent.runId);
    assert.deepEqual(of(child.runId).children, []);
    // one run read alone lists its children too
    assert.deepEqual(((await e.status(parent)) as Readable).children, [{ id: child.runId, pipeline: 'hotfix', status: 'running' }]);
  } finally {
    await e.cleanup();
  }
});

test('status orders slices by index with their titles', async () => {
  const e = await setup();
  try {
    const parent = await e.prepare();
    e.clock.t += 1000;
    const a = await rewriteMeta(e, await e.prepare('#6'), { parent: parent.runId });
    e.clock.t += 1000;
    const b = await rewriteMeta(e, await e.prepare('#7'), { parent: parent.runId });
    const pending = `${parent.runId}-s3`;
    const fanout = {
      children: [
        { index: 2, id: a.runId, title: 'Panel rows' },
        { index: 3, id: pending, title: 'Docs' },
        { index: 1, id: b.runId, title: 'Status field' },
      ],
    };
    await fs.writeFile(path.join(e.dir(parent), 'fanout.json'), JSON.stringify(fanout));
    const j = await statusJson(e.deps);
    const of = (id: string) => j.runs.find((r) => r.id === id) as Readable;
    // a slice not started yet has no run dir: it is listed as pending, on the parent's pipeline
    assert.deepEqual(of(parent.runId).children, [
      { id: b.runId, pipeline: 'feature', status: 'running', slice: { index: 1, title: 'Status field' } },
      { id: a.runId, pipeline: 'feature', status: 'running', slice: { index: 2, title: 'Panel rows' } },
      { id: pending, pipeline: 'feature', status: 'pending', slice: { index: 3, title: 'Docs' } },
    ]);
  } finally {
    await e.cleanup();
  }
});

test('a broken fanout.json leaves the parent readable with its listed children', async () => {
  const e = await setup();
  try {
    const parent = await e.prepare();
    e.clock.t += 1000;
    const c = await rewriteMeta(e, await e.prepare('#6'), { parent: parent.runId });
    await fs.writeFile(path.join(e.dir(parent), 'fanout.json'), '{ not json');
    const r = (await e.status(parent)) as Readable;
    assert.deepEqual(r.children, [{ id: c.runId, pipeline: 'feature', status: 'running' }]);
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
    const term = terminalName(m.runId, m.ticket!, 'groom', 1);
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
    detail: "A failed run can't be resumed. Start a new run for the ticket, then delete this one (or clean it up to keep its record).",
    next: ['perc run github.com/o/r#5 --repo /repo', 'perc delete r1', 'perc clean r1'],
  });
});

test('yourTurn failed on another pipeline starts it again with its inputs, quoted when they hold a blank or a quote', () => {
  const { ticket: _t, ...ticketless } = TURN;
  const t = yourTurn({ ...ticketless, kind: 'failed', pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x', note: 'a b', q: 'say "hi"' } });
  assert.equal(t.next[0], 'perc run --pipeline dd-alert --input alert_url=https://dd/x --input note="a b" --input q="say \\"hi\\"" --repo /repo');
  assert.equal(yourTurn({ ...TURN, kind: 'failed', pipeline: 'hotfix', inputs: {} }).next[0], 'perc run github.com/o/r#5 --pipeline hotfix --repo /repo');
  assert.equal(yourTurn({ ...TURN, kind: 'failed', pipeline: 'feature', inputs: {} }).next[0], 'perc run github.com/o/r#5 --repo /repo');
});

test('yourTurn gate on a ticketless run is answered here', () => {
  const { ticket: _t, ...ticketless } = TURN;
  assert.equal(yourTurn({ ...ticketless, kind: 'gate', step: 'sign-off' }).message, 'approve or reject here (no issue to comment on)');
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

/** A prepared run turned into a triage router waiting at pick-pipeline, after a choose agent that wrote `pick`. */
async function waitAtPick(e: Env, pick: string): Promise<RunMeta> {
  const m = await rewriteMeta(e, await e.prepare(), { pipeline: 'triage' });
  await writeJson(path.join(e.dir(m), 'graph.json'), {
    version: 1,
    steps: [
      { id: 'intake', stage: 'intake', role: 'core', kind: 'builtin' },
      { id: 'route.0', stage: 'route', role: 'core', kind: 'builtin' },
      { id: 'route.1', stage: 'route', role: 'core', kind: 'agent' },
      { id: 'pick-pipeline', stage: 'route', role: 'core', kind: 'gate', choices: ['hotfix', 'feature'] },
      { id: 'route.3', stage: 'route', role: 'core', kind: 'builtin' },
    ],
    loops: [{ id: 'pick-pipeline', from: 'pick-pipeline', to: 'route.0', max: 3, atCap: 'escalate' }],
  });
  const pickRel = rel('route.1', 1, 'pick');
  await fs.mkdir(path.dirname(path.join(e.dir(m), pickRel)), { recursive: true });
  await fs.writeFile(path.join(e.dir(m), pickRel), pick);
  await e.edit(m, (s) => {
    s.currentStep = 'pick-pipeline';
    s.history.push(rec('intake', 1, 'pass'), rec('route.0', 1, 'pass'), rec('route.1', 1, 'pass', { pick: pickRel }));
  });
  await writeJson(path.join(e.dir(m), 'waiting.json'), {
    stepId: 'pick-pipeline',
    stepDir: path.join(e.dir(m), 'steps', 'pick-pipeline', '1'),
    since: NOW.toISOString(),
    commentUrl: URL,
  });
  e.liveDriver(m);
  return m;
}

test("a pick-pipeline gate asks you to pick from the router's pipelines, naming the agent's suggestion", async () => {
  const e = await setup();
  try {
    const m = await waitAtPick(e, 'pipeline: hotfix\nunsure: true\nlooks like a bug\n');
    const r = (await e.status(m)) as Readable;
    assert.deepEqual(r.attention, {
      kind: 'gate',
      since: NOW.toISOString(),
      message: 'pick the pipeline for this ticket (the agent suggests hotfix)',
      commentUrl: URL,
      review: [{ step: 'route.1', key: 'pick', path: path.join(e.dir(m), rel('route.1', 1, 'pick')) }],
      actions: ['pick', 'reject'],
      choices: ['hotfix', 'feature'],
    });
  } finally {
    await e.cleanup();
  }
});

test('a pick-pipeline gate without a valid suggestion only asks you to pick', async () => {
  const e = await setup();
  try {
    const m = await waitAtPick(e, 'pipeline: spike\nunsure: false\n');
    const a = ((await e.status(m)) as Readable).attention!;
    assert.equal(a.message, 'pick the pipeline for this ticket');
    assert.deepEqual([a.actions, a.choices], [['pick', 'reject'], ['hotfix', 'feature']]);
  } finally {
    await e.cleanup();
  }
});

/** Writes `~/.percolator/watch/watch.json` as perc watch does. */
async function writeWatch(e: Env, over: Record<string, unknown> = {}): Promise<void> {
  await writeJson(path.join(e.home, '.percolator', 'watch', 'watch.json'), {
    pid: 4242,
    host: os.hostname(),
    terminal: 'w1',
    startedAt: T1,
    heartbeatAt: new Date(e.clock.t - 30_000).toISOString(),
    repos: ['/r/a', '/r/b'],
    intervalS: 60,
    ...over,
  });
}

test('watcher alive from a fresh heartbeat; dead from a stale one', async () => {
  const e = await setup();
  try {
    assert.deepEqual((await statusJson(e.deps)).watcher, { alive: false, repos: [] });
    e.deps.pidAlive = (pid) => pid === 4242;
    await writeWatch(e);
    assert.deepEqual((await statusJson(e.deps)).watcher, { alive: true, since: T1, repos: ['/r/a', '/r/b'] });
    await writeWatch(e, { heartbeatAt: new Date(e.clock.t - 181_000).toISOString() });
    assert.deepEqual((await statusJson(e.deps)).watcher, { alive: false, repos: ['/r/a', '/r/b'] });
    await writeWatch(e);
    e.deps.pidAlive = () => false;
    assert.deepEqual((await statusJson(e.deps)).watcher, { alive: false, repos: ['/r/a', '/r/b'] });
  } finally {
    await e.cleanup();
  }
});
