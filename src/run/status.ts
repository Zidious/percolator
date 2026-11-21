import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STAGES } from '../config/schema.ts';
import type { RunState, StepRecord } from '../engine/state.ts';
import { loadState } from '../engine/state.ts';
import { readWaiting } from '../tracker/gate.ts';
import type { Waiting } from '../tracker/gate.ts';
import { liveness, prUrl } from './drive.ts';
import { readRunGraph } from './graph-file.ts';
import type { RunGraphLoop, RunGraphStep } from './graph-file.ts';
import { lockIsLive, readDriverLock } from './lock.ts';
import type { DriverLock } from './lock.ts';
import { listRuns } from './meta.ts';
import type { RunListing, RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';

export type AttentionKind = 'gate' | 'cap' | 'paused' | 'failed' | 'stalled' | 'agent';
export type Action = 'approve' | 'reject' | 'grant' | 'resume' | 'clean' | 'open-pane';
export type ReviewItem = { step: string; key: string; path: string };
export type AttentionJson = {
  kind: AttentionKind;
  since: string;
  message: string;
  detail?: string;
  commentUrl?: string;
  review?: ReviewItem[];
  actions: Action[];
  commands?: string[];
  terminal?: string;
  agentState?: string;
};
export type StepJson = RunGraphStep & {
  status: 'pending' | 'running' | 'waiting' | StepRecord['status'];
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  outputs: Record<string, string>;
};
export type LoopJson = RunGraphLoop & { round: number };
export type RunStatusJson =
  | {
      id: string;
      ticket: { ref: string; number: number; title?: string; url?: string };
      repo: string;
      branch: string;
      worktree: string;
      createdAt: string;
      status: 'running' | 'waiting' | 'paused' | 'failed' | 'completed';
      currentStep?: string;
      driver: { alive: boolean | null; terminal: string };
      attention?: AttentionJson;
      steps: StepJson[];
      loops: LoopJson[];
      terminals: Record<string, string>;
      pr: { url: string } | null;
      graph: 'full' | 'history';
    }
  | { id: string; status: 'unreadable'; error: string };
export type StatusJson = { schema: 1; runs: RunStatusJson[] };

/** How the driver was judged: its hc terminal, its `driver.json` lock, or neither (`hcError` when hc failed). */
export type DriverLiveness = { alive: boolean | null; lock?: DriverLock; hcError?: string };

/**
 * The driver's hc terminal is live, else its `driver.json` lock is live (a foreground drive has no terminal).
 * `alive: null` when the lock's host is another machine (its pid cannot be checked). Never throws.
 */
export async function driverLiveness(dir: string, meta: RunMeta, deps: DriverDeps): Promise<DriverLiveness> {
  let hcError: string | undefined;
  try {
    if ((await deps.hc.get(meta.driver))?.state === 'live') return { alive: true };
  } catch (err) {
    hcError = (err as Error).message;
  }
  const lock = await readDriverLock(dir);
  const out: DriverLiveness = { alive: false, ...(hcError !== undefined ? { hcError } : {}) };
  if (lock === undefined || !lockIsLive(lock, liveness(deps))) return out;
  return { ...out, alive: lock.host === os.hostname() ? true : null, lock };
}

export async function driverAlive(dir: string, meta: RunMeta, deps: DriverDeps): Promise<boolean | null> {
  return (await driverLiveness(dir, meta, deps)).alive;
}

type AttentionRecord = { stepId?: unknown; terminal?: unknown; kind?: unknown; at?: unknown };

export async function readAttention(dir: string): Promise<AttentionRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'attention.json'), 'utf8')) as AttentionRecord;
  } catch {
    return undefined;
  }
}

async function readDecision(stepDir: string): Promise<'approve' | 'reject' | undefined> {
  try {
    const d = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8')) as { decision?: unknown };
    return d.decision === 'approve' || d.decision === 'reject' ? d.decision : undefined;
  } catch {
    return undefined;
  }
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function readTicket(dir: string, meta: RunMeta): Promise<{ ref: string; number: number; title?: string; url?: string }> {
  const ticket = { ref: meta.ticket, number: meta.issue };
  try {
    const i = JSON.parse(await fs.readFile(path.join(dir, 'issue.json'), 'utf8')) as { title?: unknown; url?: unknown };
    return {
      ...ticket,
      ...(typeof i.title === 'string' ? { title: i.title } : {}),
      ...(typeof i.url === 'string' ? { url: i.url } : {}),
    };
  } catch {
    return ticket;
  }
}

const isStage = (id: string): boolean => (STAGES as readonly string[]).includes(id);

/** Without `graph.json`: one step per distinct history step id, in order; kinds and stages guessed. */
async function historySteps(dir: string, state: RunState): Promise<RunGraphStep[]> {
  const out: RunGraphStep[] = [];
  for (const h of state.history) {
    if (out.some((s) => s.id === h.stepId)) continue;
    const role = isStage(h.stepId) ? 'core' : 'node';
    const stage = (isStage(h.stepId) ? h.stepId : (out.at(-1)?.stage ?? 'before-all')) as RunGraphStep['stage'];
    out.push({ id: h.stepId, stage, role, kind: (await isGateStep(dir, h.stepId, state)) ? 'gate' : 'agent' });
  }
  return out;
}

async function isGateStep(dir: string, stepId: string, state: RunState): Promise<boolean> {
  if (stepId === 'approve-groom') return true;
  for (const h of state.history) {
    if (h.stepId !== stepId) continue;
    const at = path.join(dir, 'steps', stepId, String(h.attempt));
    if ((await exists(path.join(at, 'decision.json'))) || (await exists(path.join(at, 'gate.json')))) return true;
  }
  return false;
}

const latest = (state: RunState, stepId: string) => state.history.findLast((h) => h.stepId === stepId);

const absOutputs = (dir: string, outputs: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(outputs).map(([k, rel]) => [k, path.join(dir, rel)]));

function review(dir: string, step: string, outputs: Record<string, string> | undefined): ReviewItem[] {
  return Object.keys(outputs ?? {})
    .sort()
    .map((key) => ({ step, key, path: path.join(dir, outputs![key]!) }));
}

/** The outputs of the nearest earlier step that has any, as the gate renders them (`previousStepOutputs`). */
function gateReview(dir: string, gateId: string, steps: RunGraphStep[], state: RunState): ReviewItem[] {
  const at = steps.findIndex((s) => s.id === gateId);
  for (let i = (at < 0 ? steps.length : at) - 1; i >= 0; i--) {
    const id = steps[i]!.id;
    const out = latest(state, id)?.outputs;
    if (out && Object.keys(out).length > 0) return review(dir, id, out);
  }
  return [];
}

async function liveTerminals(meta: RunMeta, deps: DriverDeps): Promise<Record<string, string>> {
  try {
    const out: Record<string, string> = {};
    for (const t of await deps.hc.list({ labels: { 'percolator.run': meta.runId } })) {
      const n = t.name ?? t.address;
      // hc ls returns no labels: get them, and re-check ownership rather than trusting the server-side filter
      const labels = Object.keys(t.labels).length > 0 ? t.labels : (await deps.hc.get(n))?.labels;
      if (labels?.['percolator.run'] !== meta.runId) continue;
      const step = labels['percolator.step'];
      if (labels['percolator.role'] === 'driver') out['driver'] = n;
      else if (step !== undefined) out[step] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export type YourTurnInput = {
  kind: AttentionKind;
  runId: string;
  step: string;
  ticket: string;
  repoRoot: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  terminal?: string;
  agentState?: string;
};

/** What the owner has to do next, as one sentence plus the exact commands to type. Shared by `perc status` and the JSON. */
export function yourTurn(a: YourTurnInput): { message: string; detail?: string; next: string[] } {
  const resume = [`perc resume ${a.runId}`];
  switch (a.kind) {
    case 'gate':
      return { message: `${a.step} is waiting for approval`, next: [`perc approve ${a.runId}`, `perc reject ${a.runId} "<what to change>"`] };
    case 'cap':
      return {
        message: `${a.step} hit its cap (${a.reason})`,
        detail: 'Grant one more round and the run goes back with the open findings.',
        next: resume,
      };
    case 'paused':
      return { message: `${a.step} paused: ${a.reason}`, next: resume };
    case 'failed':
      return {
        message: `${a.step} failed`,
        detail: "A failed run can't be resumed. Start a new run for the ticket, or clean this one up.",
        next: [`perc run ${a.ticket} --repo ${a.repoRoot}`, `perc clean ${a.runId}`],
      };
    case 'stalled':
      if (a.decision !== undefined) return { message: `${a.decision === 'approve' ? 'approved' : 'rejected'}; resume to continue`, next: resume };
      return {
        message: `the driver stopped while ${a.step} was running`,
        detail: `Nothing is driving this run. Resume picks up at ${a.step}.`,
        next: resume,
      };
    case 'agent':
      return { message: `${a.step}'s agent is ${a.agentState} in terminal ${a.terminal}`, detail: "Attend the agent's terminal.", next: [] };
  }
}

async function attentionOf(o: {
  dir: string;
  meta: RunMeta;
  state: RunState;
  waiting: Waiting | undefined;
  alive: boolean | null;
  steps: RunGraphStep[];
  loops: RunGraphLoop[];
}): Promise<AttentionJson | undefined> {
  const { dir, meta, state, waiting, alive } = o;
  const lastEnd = state.history.at(-1)?.endedAt || meta.createdAt;
  const turn = (kind: AttentionKind, step: string | undefined, x: Partial<YourTurnInput> = {}) => {
    const t = yourTurn({ kind, runId: meta.runId, step: step ?? STAGES[0], ticket: meta.ticket, repoRoot: meta.repoRoot, ...x });
    return { message: t.message, ...(t.detail !== undefined ? { detail: t.detail } : {}) };
  };
  const failing = (step: string | undefined) => (step === undefined ? [] : review(dir, step, latest(state, step)?.outputs));
  if (waiting !== undefined) {
    if (alive === false && (await exists(path.join(waiting.stepDir, 'decision.json')))) {
      const d = await readDecision(waiting.stepDir);
      return { kind: 'stalled', since: waiting.since, ...turn('stalled', waiting.stepId, d !== undefined ? { decision: d } : {}), actions: ['resume'] };
    }
    return {
      kind: 'gate',
      since: waiting.since,
      ...turn('gate', waiting.stepId),
      commentUrl: waiting.commentUrl,
      review: gateReview(dir, waiting.stepId, o.steps, state),
      actions: ['approve', 'reject'],
    };
  }
  if (state.status === 'paused') {
    if (state.pausedCap !== undefined) {
      const from = o.loops.find((l) => l.id === state.pausedCap)?.from ?? state.currentStep;
      const reason = (state.pausedReason ?? '').replace(/^cap: /, '');
      return { kind: 'cap', since: lastEnd, ...turn('cap', state.currentStep, { reason }), review: failing(from), actions: ['grant'] };
    }
    return { kind: 'paused', since: lastEnd, ...turn('paused', state.currentStep, { reason: state.pausedReason ?? '' }), review: failing(state.currentStep), actions: ['resume'] };
  }
  if (state.status === 'failed') {
    return {
      kind: 'failed',
      since: lastEnd,
      ...turn('failed', state.currentStep),
      review: failing(state.currentStep),
      actions: ['clean'],
      commands: [`perc run ${meta.ticket} --repo ${meta.repoRoot}`],
    };
  }
  if (state.status !== 'running') return undefined;
  if (alive === false) return { kind: 'stalled', since: lastEnd, ...turn('stalled', state.currentStep), actions: ['resume'] };
  if (alive !== true) return undefined;
  const a = await readAttention(dir);
  if (a === undefined || a.stepId !== state.currentStep || typeof a.terminal !== 'string') return undefined;
  return {
    kind: 'agent',
    since: typeof a.at === 'string' ? a.at : lastEnd,
    ...turn('agent', state.currentStep, { terminal: a.terminal, agentState: typeof a.kind === 'string' ? a.kind : 'waiting' }),
    terminal: a.terminal,
    ...(typeof a.kind === 'string' ? { agentState: a.kind } : {}),
    actions: ['open-pane'],
  };
}

async function readRun(l: RunListing & { meta: RunMeta }, deps: DriverDeps): Promise<RunStatusJson> {
  const { dir, meta } = l;
  const state = l.state ?? (await loadState(dir));
  const graph = await readRunGraph(dir);
  const stepDefs = graph?.steps ?? (await historySteps(dir, state));
  const loopDefs = graph?.loops ?? [];
  const live = state.status === 'running' || state.status === 'paused';
  const waiting = live ? await readWaiting(dir) : undefined;
  const alive = await driverAlive(dir, meta, deps);
  const steps: StepJson[] = stepDefs.map((s) => {
    const h = latest(state, s.id);
    const status: StepJson['status'] =
      waiting?.stepId === s.id
        ? 'waiting'
        : state.status === 'running' && state.currentStep === s.id
          ? 'running'
          : (h?.status ?? 'pending');
    return {
      ...s,
      status,
      attempts: h?.attempt ?? 0,
      ...(h !== undefined ? { startedAt: h.startedAt, endedAt: h.endedAt } : {}),
      outputs: absOutputs(dir, h?.outputs ?? {}),
    };
  });
  const attention = await attentionOf({ dir, meta, state, waiting, alive, steps: stepDefs, loops: loopDefs });
  const url = await prUrl(dir, state);
  return {
    id: meta.runId,
    ticket: await readTicket(dir, meta),
    repo: meta.repoRoot,
    branch: meta.branch,
    worktree: meta.worktree,
    createdAt: meta.createdAt,
    status: waiting !== undefined ? 'waiting' : state.status,
    ...(state.currentStep !== undefined && state.status !== 'completed' ? { currentStep: state.currentStep } : {}),
    driver: { alive, terminal: meta.driver },
    ...(attention !== undefined ? { attention } : {}),
    steps,
    loops: loopDefs.map((lp) => ({ ...lp, round: state.rounds[lp.id] ?? 0 })),
    terminals: await liveTerminals(meta, deps),
    pr: url === undefined ? null : { url },
    graph: graph === undefined ? 'history' : 'full',
  };
}

/** One run as the `perc status --json` contract describes it; a run that can't be read is `unreadable`, never thrown. */
export async function runStatusJson(l: RunListing, deps: DriverDeps): Promise<RunStatusJson> {
  const id = l.meta?.runId ?? path.basename(l.dir);
  if (l.error !== undefined || l.meta === undefined) return { id, status: 'unreadable', error: l.error ?? 'run.json missing' };
  try {
    return await readRun({ ...l, meta: l.meta }, deps);
  } catch (err) {
    return { id, status: 'unreadable', error: (err as Error).message.split('\n')[0]! };
  }
}

/** Every run under `deps.home`, in `listRuns` order. Reads run dirs only, never the config. */
export async function statusJson(deps: DriverDeps): Promise<StatusJson> {
  const runs: RunStatusJson[] = [];
  for (const l of await listRuns(deps.home)) runs.push(await runStatusJson(l, deps));
  return { schema: 1, runs };
}
