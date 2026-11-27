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
import { attentionNext, driverAlive, runAgain, runStatusJson, statusJson, transcriptIn, yourTurn } from '../../src/run/status.ts';
import type { AttentionJson, RunStatusJson, TimelineJson } from '../../src/run/status.ts';
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
    profile: 'work',
    config: m.configFile,
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
    trigger: null,
    comment: null,
    ...over,
  };
}

/** What a fresh running run adds to `expected`: it is running intake, its first step. */
const FRESH = { currentStep: 'intake', steps: steps({ intake: { status: 'running' } }) };

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
        attention: { kind: 'gate', since: NOW.toISOString(), message: 'approve-groom is waiting for approval', detail: 'Rejecting sends the run back to groom with your feedback.', commentUrl: URL, review: groomReview(e, m), actions: ['approve', 'reject'] },
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
        attention: { kind: 'gate', since: NOW.toISOString(), message: 'approve-groom is waiting for approval', detail: 'Rejecting sends the run back to groom with your feedback.', commentUrl: URL, review: groomReview(e, m), actions: ['approve', 'reject'] },
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
        attention: { kind: 'paused', since: T2, message: 'plan paused', detail: 'escalate: plan', review: [], actions: ['resume'] },
        steps: steps({ plan: { status: 'escalate', attempts: 1, startedAt: T1, endedAt: T2, outputs: {} } }),
      }),
    );
  } finally {
    await e.cleanup();
  }
});

test('a run started with the default config file has config null, and Run again leaves --config out', async () => {
  const e = await setup();
  try {
    const m = { ...(await e.prepare()), configFile: path.join(e.home, '.percolator', 'config.yaml') };
    await writeRunMeta(e.dir(m), m);
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.currentStep = 'implement';
    });
    const r = (await e.status(m)) as Extract<RunStatusJson, { pipeline: string }>;
    assert.equal(r.config, null);
    assert.equal(r.profile, 'work');
    assert.deepEqual(r.attention?.commands, [`perc run ${TICKET} --pipeline feature --repo ${m.repoRoot} --profile work`]);
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
          actions: ['run-again', 'clean'],
          commands: [`perc run ${TICKET} --pipeline feature --repo ${m.repoRoot} --config ${m.configFile} --profile work`],
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
        // without graph.json the loops are unknown, so the gate does not say where a reject goes
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
        expected(good, { ...FRESH, attention: { kind: 'stalled', since: good.createdAt, ...STALLED_FRESH, actions: ['resume'] }, timeline: freshTimeline(good) }),
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
    assert.deepEqual(await statusJson(e.deps), { schema: 2, runs: [expected(m, { ...FRESH, attention: { kind: 'stalled', since: m.createdAt, ...STALLED_FRESH, actions: ['resume'] }, timeline: freshTimeline(m) })], watcher: { alive: false, repos: [] } });
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
      detail: 'Rejecting sends the run back to groom with your feedback.',
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
    const again = `perc run --pipeline dd-alert --input alert_url=https://dd/x --repo ${m.repoRoot} --config ${m.configFile} --profile work`;
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

test('a failed fan-out slice says to delete it and resume its parent, never to start a new run', async () => {
  const e = await setup();
  try {
    const parent = await e.prepare();
    e.clock.t += 1000;
    const c = await e.prepare('#6');
    const fanOut = { parent: parent.runId, slice: 2, from: 'implement', title: 'Panel rows' };
    const slice = await rewriteMeta(e, c, { pipeline: 'epic', parent: parent.runId, fanOut });
    await e.edit(slice, (s) => {
      s.status = 'failed';
      s.currentStep = 'implement';
      s.history.push(rec('implement', 1, 'fail'));
    });
    const r = (await e.status(slice)) as Readable;
    assert.equal(r.attention?.detail, `Delete this slice (its branch stays), then resume ${parent.runId} to run it again`);
    assert.equal(r.attention?.commands, undefined);
    assert.deepEqual(r.attention?.actions, ['clean']);
    assert.deepEqual(attentionNext(r.attention!, r), [`perc delete ${slice.runId}`, `perc resume ${parent.runId}`]);
    // a routed child (a parent, no fanOut) still starts a new run
    const routed = await rewriteMeta(e, slice, { pipeline: 'hotfix' }, ['fanOut']);
    const rr = (await e.status(routed)) as Readable;
    assert.deepEqual(rr.attention?.commands, [`perc run ${REPO}#6 --pipeline hotfix --repo ${routed.repoRoot} --config ${routed.configFile} --profile work`]);
  } finally {
    await e.cleanup();
  }
});

test('a child with run.json but no state.json yet is listed as running', async () => {
  const e = await setup();
  try {
    const parent = await e.prepare();
    e.clock.t += 1000;
    const c = await rewriteMeta(e, await e.prepare('#6'), { parent: parent.runId });
    await fs.rm(path.join(e.dir(c), 'state.json'));
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
  assert.deepEqual(yourTurn({ ...TURN, kind: 'gate', step: 'approve-plan', backTo: 'groom' }), {
    message: 'approve-plan is waiting for approval',
    detail: 'Rejecting sends the run back to groom with your feedback.',
    next: ['perc approve r1', 'perc reject r1 "<what to change>"'],
  });
  assert.equal(yourTurn({ ...TURN, kind: 'gate', step: 'approve-plan' }).detail, "Rejecting ends the run; a failed run can't be resumed.");
});

test('yourTurn gate on the last round of its loop says a reject pauses at the cap', () => {
  const gate = { ...TURN, kind: 'gate' as const, step: 'sign-off', backTo: 'plan', capRounds: 3 };
  assert.equal(yourTurn(gate).detail, 'Rejecting pauses the run at its cap (3 rounds); perc resume grants one more.');
  assert.equal(
    yourTurn({ ...gate, capAsksFindings: true }).detail,
    'Rejecting pauses the run at its cap (3 rounds) to ask which findings to fix.',
  );
});

test('a gate on the last round of its loop says a reject pauses at the cap', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.waitAtGate(m);
    await e.edit(m, (s) => {
      s.rounds['approve-groom'] = 2;
    });
    const r = (await e.status(m)) as Readable;
    assert.equal(r.attention?.detail, 'Rejecting pauses the run at its cap (3 rounds); perc resume grants one more.');
  } finally {
    await e.cleanup();
  }
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
    message: 'groom paused',
    detail: 'escalate: groom',
    next: ['perc resume r1'],
  });
});

test('yourTurn paused names the step once', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'paused', reason: 'groom: agent exited with code 1 without a valid done.json' }), {
    message: 'groom paused',
    detail: 'agent exited with code 1 without a valid done.json',
    next: ['perc resume r1'],
  });
});

test('yourTurn paused with no reason has no detail', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'paused', reason: '' }), { message: 'groom paused', next: ['perc resume r1'] });
  assert.deepEqual(yourTurn({ ...TURN, kind: 'paused', reason: 'groom: ' }), { message: 'groom paused', next: ['perc resume r1'] });
});

test('a transcript path with spaces is found whole', () => {
  const runDir = path.join(os.tmpdir(), 'with space', 'runs', 'r1');
  const t = path.join(runDir, 'steps', 'plan', '2', 'transcript.txt');
  assert.equal(transcriptIn(`task was not delivered to x; check its screen in ${t}, then resume`, runDir, 'plan'), t);
  assert.equal(transcriptIn(`plan: agent exited without a valid done.json; full screen in ${t}`, runDir, 'plan'), t);
  assert.equal(transcriptIn('escalate: plan', runDir, 'plan'), undefined);
  assert.equal(transcriptIn(`full screen in ${path.join(runDir, 'steps', 'groom', '1', 'transcript.txt')}`, runDir, 'plan'), undefined, 'another step');
});

test("paused with the agent's saved screen gives its transcript", async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const t = path.join(e.dir(m), 'steps', 'plan', '1', 'transcript.txt');
    await fs.mkdir(path.dirname(t), { recursive: true });
    await fs.writeFile(t, 'screen\n');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.pausedReason = `plan: agent exited with code 1 without a valid done.json; full screen in ${t}`;
      s.history.push(rec('plan', 1, 'escalate'));
    });
    const a = ((await e.status(m)) as { attention?: AttentionJson }).attention;
    assert.equal(a?.message, 'plan paused');
    assert.equal(a?.detail, `agent exited with code 1 without a valid done.json; full screen in ${t}`);
    assert.equal(a?.transcript, t);
  } finally {
    await e.cleanup();
  }
});

test('a transcript the runtime could not save is not given', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const t = path.join(e.dir(m), 'steps', 'plan', '1', 'transcript.txt');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.pausedReason = `plan: agent exited; full screen in ${t}`;
      s.history.push(rec('plan', 1, 'escalate'));
    });
    const a = ((await e.status(m)) as { attention?: AttentionJson }).attention;
    assert.equal(a?.detail, `agent exited; full screen in ${t}`, 'the detail keeps the path');
    assert.equal(a?.transcript, undefined);
  } finally {
    await e.cleanup();
  }
});

test('a transcript of another step is not given', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.pausedReason = `plan: agent exited; full screen in ${path.join(e.dir(m), 'steps', 'groom', '1', 'transcript.txt')}`;
      s.history.push(rec('plan', 1, 'escalate'));
    });
    assert.equal(((await e.status(m)) as { attention?: AttentionJson }).attention?.transcript, undefined);
  } finally {
    await e.cleanup();
  }
});

test('yourTurn failed', () => {
  assert.deepEqual(yourTurn({ ...TURN, kind: 'failed' }), {
    message: 'groom failed',
    detail: "A failed run can't be resumed. Start a new run for the ticket, then delete this one (or clean it up to keep its record).",
    next: ['perc run github.com/o/r#5 --repo /repo', 'perc delete r1', 'perc clean r1'],
  });
});

test('yourTurn failed says why the step failed', () => {
  assert.equal(yourTurn({ ...TURN, kind: 'failed', reason: 'exit code 1', step: 'lint' }).message, 'lint failed (exit code 1)');
  assert.equal(yourTurn({ ...TURN, kind: 'failed' }).message, 'groom failed');
});

test('yourTurn failed on a ticketless run starts a new run of its pipeline', () => {
  const { ticket: _t, ...ticketless } = TURN;
  assert.equal(
    yourTurn({ ...ticketless, kind: 'failed', pipeline: 'dry-fail', inputs: {} }).detail,
    "A failed run can't be resumed. Start a new run of pipeline dry-fail, then delete this one (or clean it up to keep its record).",
  );
});

test('yourTurn failed on another pipeline starts it again with its inputs, quoted when they hold a blank or a quote', () => {
  const { ticket: _t, ...ticketless } = TURN;
  const t = yourTurn({ ...ticketless, kind: 'failed', pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x', note: 'a b', q: 'say "hi"' } });
  assert.equal(t.next[0], `perc run --pipeline dd-alert --input alert_url=https://dd/x --input note="a b" --input q='say "hi"' --repo /repo`);
  assert.equal(yourTurn({ ...TURN, kind: 'failed', pipeline: 'hotfix', inputs: {} }).next[0], 'perc run github.com/o/r#5 --pipeline hotfix --repo /repo');
  assert.equal(yourTurn({ ...TURN, kind: 'failed', pipeline: 'feature', inputs: {} }).next[0], 'perc run github.com/o/r#5 --pipeline feature --repo /repo');
});

test('runAgain always names the pipeline, and carries the profile and a config file other than the default', () => {
  // a profile may mark another pipeline default: true, so feature is named too
  assert.equal(runAgain({ ticket: 'o/r#1', pipeline: 'feature', repoRoot: '/repo' }), 'perc run o/r#1 --pipeline feature --repo /repo');
  assert.equal(
    runAgain({ ticket: 'o/r#1', pipeline: 'feature', repoRoot: '/repo', profile: 'work', config: 'C:\My Configs\p.yaml' }),
    'perc run o/r#1 --pipeline feature --repo /repo --config "C:\My Configs\p.yaml" --profile work',
  );
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
      detail: 'Rejecting has the agent pick again with your feedback.',
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

test('perc status on a pick-pipeline gate names --pipeline for each choice, then reject', async () => {
  const e = await setup();
  try {
    const m = await waitAtPick(e, '');
    const r = (await e.status(m)) as Readable;
    assert.deepEqual(attentionNext(r.attention!, r), [
      `perc approve ${m.runId} --pipeline hotfix`,
      `perc approve ${m.runId} --pipeline feature`,
      `perc reject ${m.runId} "<what to change>"`,
    ]);
  } finally {
    await e.cleanup();
  }
});

test('runAgain double-quotes a repo or input with a blank and keeps Windows backslashes single', () => {
  assert.equal(
    runAgain({ ticket: 'o/r#1', pipeline: 'hotfix', inputs: { path: 'C:\\a b\\c' }, repoRoot: 'C:\\My Repos\\r' }),
    'perc run o/r#1 --pipeline hotfix --input path="C:\\a b\\c" --repo "C:\\My Repos\\r"',
  );
});

test('runAgain single-quotes a value with a double quote, $ or backtick, which PowerShell and sh then take as typed', () => {
  const line = (v: string) => runAgain({ inputs: { q: v }, repoRoot: '/repo' });
  assert.equal(line('say "hi"'), `perc run --input q='say "hi"' --repo /repo`);
  assert.equal(line('cost $5'), `perc run --input q='cost $5' --repo /repo`);
  assert.equal(line('a`b'), "perc run --input q='a`b' --repo /repo");
  assert.equal(line("it's"), `perc run --input q="it's" --repo /repo`);
  // both kinds of quote: PowerShell's '' escape (Windows is the owner's OS)
  assert.equal(line(`it's "x"`), `perc run --input q='it''s "x"' --repo /repo`);
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

test('paused on questions', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const plan = rel('plan', 1, 'notes');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'plan';
      s.pausedReason = 'questions: plan asks 2';
      s.asking = { kind: 'questions', stepId: 'plan', attempt: 1, items: ['Which DB?', 'Keep v1?'] };
      s.history.push(rec('plan', 1, 'escalate', { notes: plan }));
    });
    const run = (await e.status(m)) as Readable;
    assert.deepEqual(run.attention, {
      kind: 'questions',
      since: T2,
      message: 'plan has questions for you',
      detail: 'Answer each one or mark it N/A; plan then runs again with your answers.',
      review: [{ step: 'plan', key: 'notes', path: path.join(e.dir(m), plan) }],
      actions: ['answer'],
      asked: { step: 'plan', attempt: 1, items: ['Which DB?', 'Keep v1?'] },
    });
  } finally {
    await e.cleanup();
  }
});

test('paused on findings at a cap, split from the findings file when state has no items', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const findings = rel('review', 3, 'findings');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'review';
      s.pausedReason = 'findings: review reached 3 rounds';
      s.rounds['review'] = 3;
      s.asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', findings: findings.split(path.sep).join('/') };
      s.history.push(rec('review', 3, 'fail', { findings }));
    });
    await fs.mkdir(path.dirname(path.join(e.dir(m), findings)), { recursive: true });
    await fs.writeFile(path.join(e.dir(m), findings), '## Missing test\n\nwhy\n\n## Typo\n');
    const run = (await e.status(m)) as Readable;
    assert.deepEqual(run.attention, {
      kind: 'findings',
      since: T2,
      message: 'review hit its cap with findings left',
      detail: 'Tick the findings to fix: the run goes back to implement for one more round with only those. With none ticked, it moves on.',
      review: [{ step: 'review', key: 'findings', path: path.join(e.dir(m), findings) }],
      actions: ['answer'],
      asked: { step: 'review', attempt: 3, items: ['## Missing test\n\nwhy', '## Typo'] },
    });
  } finally {
    await e.cleanup();
  }
});

test('paused on findings of two failing reviewers lists both steps\' files under review, the others first', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const f0 = rel('review.0', 3, 'findings');
    const f1 = rel('review.1', 3, 'findings');
    const posix = (p: string) => p.split(path.sep).join('/');
    await e.edit(m, (s) => {
      s.status = 'paused';
      s.currentStep = 'review.1';
      s.pausedReason = 'findings: review reached 3 rounds';
      s.rounds['review'] = 3;
      s.asking = {
        kind: 'findings',
        stepId: 'review.1',
        attempt: 3,
        edgeId: 'review',
        findings: posix(f1),
        also: [{ stepId: 'review.0', attempt: 3, findings: posix(f0) }, { stepId: 'review.0', attempt: 3, findings: posix(f0) }],
        items: ['## A0', '## A1'],
      };
      s.history.push(rec('review.0', 3, 'fail', { findings: f0 }), rec('review.1', 3, 'fail', { findings: f1 }));
    });
    const run = (await e.status(m)) as Readable;
    assert.ok(run.attention?.kind === 'findings');
    assert.deepEqual(run.attention.review, [
      { step: 'review.0', key: 'findings', path: path.join(e.dir(m), f0) },
      { step: 'review.1', key: 'findings', path: path.join(e.dir(m), f1) },
    ]);
  } finally {
    await e.cleanup();
  }
});

test('yourTurn findings with nothing to tick says the only answer is to move on, and attentionNext agrees', () => {
  const f = yourTurn({ ...TURN, kind: 'findings', step: 'report', nothingToTick: true });
  assert.deepEqual(f, {
    message: 'report hit its cap and wrote no findings to tick',
    detail: 'The only answer is to move on past it.',
    next: ['perc answer r1'],
  });
  const run = { id: 'r1', ticket: null, pipeline: 'feature', inputs: {}, repo: '/repo' };
  const a = { kind: 'findings' as const, since: T1, message: '', actions: ['answer' as const], asked: { step: 'report', attempt: 2, items: [] } };
  assert.deepEqual(attentionNext(a, run), f.next);
  const back = yourTurn({ ...TURN, kind: 'findings', step: 'review', backTo: 'fix' });
  assert.equal(back.detail, 'Tick the findings to fix: the run goes back to fix for one more round with only those. With none ticked, it moves on.');
});

test('yourTurn questions and findings, and attentionNext gives the same', () => {
  const q = yourTurn({ ...TURN, kind: 'questions', step: 'plan' });
  assert.deepEqual(q, {
    message: 'plan has questions for you',
    detail: 'Answer each one or mark it N/A; plan then runs again with your answers.',
    next: ['perc answer r1 --answer <n>="<text>" --na <n> …'],
  });
  const f = yourTurn({ ...TURN, kind: 'findings', step: 'review' });
  assert.deepEqual(f, {
    message: 'review hit its cap with findings left',
    detail: 'Tick the findings to fix: the run goes back for one more round with only those. With none ticked, it moves on.',
    next: ['perc answer r1 --agree <n>[,<n>…]', 'perc answer r1'],
  });
  const run = { id: 'r1', ticket: null, pipeline: 'feature', inputs: {}, repo: '/repo' };
  assert.deepEqual(attentionNext({ kind: 'questions', since: T1, message: '', actions: ['answer'] }, run), q.next);
  assert.deepEqual(attentionNext({ kind: 'findings', since: T1, message: '', actions: ['answer'] }, run), f.next);
});

/** Adds steps and loops to the run's graph.json. */
async function addToGraph(e: Env, m: RunMeta, steps: Step[], loops: Step[] = []): Promise<void> {
  const file = path.join(e.dir(m), 'graph.json');
  const g = JSON.parse(await fs.readFile(file, 'utf8'));
  g.steps.push(...steps);
  g.loops.push(...loops);
  await fs.writeFile(file, JSON.stringify(g));
}

test('a gate in a loop stage says a reject goes back to the stage the loop returns to', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await addToGraph(e, m, [{ id: 'approve-x', stage: 'review', role: 'node', kind: 'gate' }]);
    await e.edit(m, (s) => {
      s.currentStep = 'approve-x';
    });
    await writeJson(path.join(e.dir(m), 'waiting.json'), { stepId: 'approve-x', stepDir: path.join(e.dir(m), 'steps', 'approve-x', '1'), since: NOW.toISOString() });
    const r = (await e.status(m)) as Readable;
    assert.equal(r.attention?.detail, 'Rejecting sends the run back to implement with your feedback.');
  } finally {
    await e.cleanup();
  }
});

test('a failed run says why it failed and offers to run again', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await addToGraph(e, m, [{ id: 'lint', stage: 'implement', role: 'node', kind: 'script' }]);
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.currentStep = 'lint';
      s.failedReason = 'exit code 1';
      s.history.push(rec('lint', 1, 'fail'));
    });
    const r = (await e.status(m)) as Readable;
    assert.equal(r.attention?.message, 'lint failed (exit code 1)');
    assert.deepEqual(r.attention?.actions, ['run-again', 'clean']);
  } finally {
    await e.cleanup();
  }
});

test('a run started by a trigger carries it; a manual run has trigger null', async () => {
  const e = await setup();
  try {
    const manual = await e.prepare();
    e.clock.t += 1000;
    const trigger = { kind: 'schedule', detail: '0 9 * * 1' } as const;
    const fired = await rewriteMeta(e, await e.prepare('#6'), { trigger });
    assert.equal(((await e.status(manual)) as Readable).trigger, null);
    assert.deepEqual(((await e.status(fired)) as Readable).trigger, trigger);
  } finally {
    await e.cleanup();
  }
});

test("the comment a comment exit posted is the run's comment; a gone or blank file gives null and no error", async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const file = path.join(e.dir(m), rel('deliver', 1, 'comment_url'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'https://github.com/o/r/issues/47#issuecomment-1\n');
    await e.edit(m, (s) => {
      s.status = 'completed';
      s.history.push(rec('deliver', 1, 'pass', { comment_url: rel('deliver', 1, 'comment_url') }));
    });
    assert.deepEqual(((await e.status(m)) as Readable).comment, { url: 'https://github.com/o/r/issues/47#issuecomment-1' });
    await fs.writeFile(file, '  \n');
    assert.equal(((await e.status(m)) as Readable).comment, null);
    await fs.rm(file);
    const r = (await e.status(m)) as Readable;
    assert.equal(r.status, 'completed');
    assert.equal(r.comment, null);
  } finally {
    await e.cleanup();
  }
});

test('a run stalled before its first step is at intake: intake running, the stalled message names it', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const r = (await e.status(m)) as Readable;
    assert.equal(r.currentStep, 'intake');
    assert.equal(r.steps[0]?.status, 'running');
    assert.equal(r.attention?.kind, 'stalled');
    assert.equal(r.attention?.message, 'the driver stopped while intake was running');
  } finally {
    await e.cleanup();
  }
});

test('a paused or failed run with no history is at its first step, which only a running run marks running', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    for (const status of ['paused', 'failed'] as const) {
      await e.edit(m, (s) => (s.status = status));
      const r = (await e.status(m)) as Readable;
      assert.equal(r.currentStep, 'intake', status);
      assert.equal(r.steps[0]?.status, 'pending', status);
    }
  } finally {
    await e.cleanup();
  }
});

test('a fan-out slice with no history is at its first step, the fanned stage', async () => {
  const e = await setup();
  try {
    const m = await rewriteMeta(e, await e.prepare(), { parent: 'p1', fanOut: { parent: 'p1', slice: 1, from: 'implement', title: 'One' } });
    const file = path.join(e.dir(m), 'graph.json');
    const g = JSON.parse(await fs.readFile(file, 'utf8'));
    const at = g.steps.findIndex((x: { id: string }) => x.id === 'implement');
    g.steps = g.steps.slice(at);
    g.loops = g.loops.filter((l: { from: string }) => g.steps.some((x: { id: string }) => x.id === l.from));
    await fs.writeFile(file, JSON.stringify(g));
    const r = (await e.full(m)) as Readable;
    assert.equal(r.currentStep, 'implement');
    assert.equal(r.attention?.message, 'the driver stopped while implement was running');
    const liveAttempt = r.timeline.at(-1);
    assert.equal(liveAttempt?.kind === 'attempt' && liveAttempt.step, 'implement');
  } finally {
    await e.cleanup();
  }
});

test('a failed run with history and no current step in state has no currentStep', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => {
      s.status = 'failed';
      s.history.push(rec('intake', 1, 'pass'));
    });
    const r = (await e.status(m)) as Readable;
    assert.equal(Object.hasOwn(r, 'currentStep'), false);
    assert.equal(r.steps[0]?.status, 'pass');
  } finally {
    await e.cleanup();
  }
});

test('a completed run with no history has no currentStep', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.status = 'completed'));
    assert.equal(Object.hasOwn((await e.status(m)) as Readable, 'currentStep'), false);
  } finally {
    await e.cleanup();
  }
});
