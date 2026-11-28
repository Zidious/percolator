import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STAGES } from '../config/schema.ts';
import type { RunState, StepRecord } from '../engine/state.ts';
import { isFinished, isLive, loadState } from '../engine/state.ts';
import { CORE_GROOM_GATE, PICK_GATE } from '../graph/core.ts';
import { openedIssues } from '../tracker/exits/issues.ts';
import { readWaiting } from '../tracker/gate-store.ts';
import type { Waiting } from '../tracker/gate-store.ts';
import { latest, prUrl, readLatest } from './outputs.ts';
import { readRunGraph } from './graph-file.ts';
import type { RunGraphLoop, RunGraphStep } from './graph-file.ts';
import { liveness, lockIsLive, pidAlive, readDriverLock } from './lock.ts';
import type { DriverLock } from './lock.ts';
import { readFanOut } from './fan-out.ts';
import type { FanOutFile } from './fan-out.ts';
import { listRuns } from './meta.ts';
import type { RunListing, RunMeta, RunTrigger } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { askedItems } from './answer.ts';
import { pickDetail, runAgain, suggestion, yourTurn } from './next-steps.ts';
import type { YourTurnInput } from './next-steps.ts';
import type { AttemptJson, AttentionJson, AttentionKind, ChildJson, ReviewItem, RunStatusJson, StatusJson, StepJson, TicketJson, TimelineJson } from './status-json.ts';
import { watcherStatus } from '../watch/heartbeat.ts';
import { samePath } from '../util/paths.ts';

/** How the driver was judged: its hc terminal, its `driver.json` lock, or neither (`hcError` when hc failed). */
export type DriverLiveness = { alive: boolean | null; lock?: DriverLock; hcError?: string };

/**
 * The driver's hc terminal is live, else its `driver.json` lock is live (a foreground drive has no terminal).
 * `alive: null` when the lock's host is another machine (its pid cannot be checked), or when hc failed and no lock exists. Never throws.
 */
export async function driverLiveness(dir: string, meta: RunMeta, deps: DriverDeps): Promise<DriverLiveness> {
  let hcError: string | undefined;
  try {
    if ((await deps.hc.get(meta.driver))?.state === 'live') return { alive: true };
  } catch (err) {
    hcError = (err as Error).message;
  }
  const lock = await readDriverLock(dir);
  // hc failed and no lock can decide: liveness is unknown, not "dead"
  if (hcError !== undefined && lock === undefined) return { alive: null, hcError };
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

async function readTicket(dir: string, meta: RunMeta): Promise<TicketJson | null> {
  if (meta.ticket === undefined) return null;
  const ticket = { ref: meta.ticket, number: meta.issue ?? 0 };
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

/**
 * Without `graph.json`: one step per distinct history step id, in order; kinds and stages guessed.
 * A live run's current step (running, waiting or paused) with no history record yet is appended, so it has a marker.
 */
async function historySteps(dir: string, state: RunState, waiting: Waiting | undefined): Promise<RunGraphStep[]> {
  const out: RunGraphStep[] = [];
  const add = async (id: string, gate: boolean) => {
    const role = isStage(id) ? 'core' : 'node';
    const stage = (isStage(id) ? id : (out.at(-1)?.stage ?? 'before-all')) as RunGraphStep['stage'];
    out.push({ id, stage, role, kind: gate || (await isGateStep(dir, id, state)) ? 'gate' : 'agent' });
  };
  for (const h of state.history) {
    if (!out.some((s) => s.id === h.stepId)) await add(h.stepId, false);
  }
  const cur = state.currentStep;
  const live = isLive(state.status);
  if (live && cur !== undefined && !out.some((s) => s.id === cur)) await add(cur, waiting?.stepId === cur);
  return out;
}

async function isGateStep(dir: string, stepId: string, state: RunState): Promise<boolean> {
  if (stepId === CORE_GROOM_GATE.name) return true;
  for (const h of state.history) {
    if (h.stepId !== stepId) continue;
    const at = path.join(dir, 'steps', stepId, String(h.attempt));
    if ((await exists(path.join(at, 'decision.json'))) || (await exists(path.join(at, 'gate.json')))) return true;
  }
  return false;
}

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

async function liveTerminals(meta: RunMeta, deps: DriverDeps): Promise<{ names: Record<string, string>; driverSpace?: string }> {
  try {
    const out: Record<string, string> = {};
    let driverSpace: string | undefined;
    for (const t of await deps.hc.list({ labels: { 'percolator.run': meta.runId } })) {
      const n = t.name ?? t.address;
      // hc ls returns no labels: get them, and re-check ownership rather than trusting the server-side filter
      const labels = Object.keys(t.labels).length > 0 ? t.labels : (await deps.hc.get(n))?.labels;
      if (labels?.['percolator.run'] !== meta.runId) continue;
      const step = labels['percolator.step'];
      if (labels['percolator.role'] === 'driver') {
        out['driver'] = n;
        driverSpace = labels['herdr.space'];
      } else if (step !== undefined) out[step] = n;
    }
    return { names: out, driverSpace };
  } catch {
    return { names: {} };
  }
}

/**
 * Where a reject of `gate` sends the run: the stage of the loop from the gate, else (a gate in a loop stage)
 * of the stage loop from a step of its stage. None: an older graph whose gate has no loop; a reject ends the run.
 */
function gateBackTo(
  gate: string,
  steps: RunGraphStep[],
  loops: RunGraphLoop[],
  rounds: Record<string, number>,
): Pick<YourTurnInput, 'backTo' | 'capRounds' | 'capAsksFindings'> {
  const stageOf = (id: string | undefined) => steps.find((s) => s.id === id)?.stage;
  const own = loops.find((l) => l.from === gate);
  const stage = stageOf(gate);
  const loop = own ?? loops.find((l) => l.atCap === 'continue' && stage !== undefined && stageOf(l.from) === stage);
  const backTo = stageOf(loop?.to);
  if (loop === undefined || backTo === undefined) return {};
  // the engine's cap: a fail that brings the loop's rounds to its max pauses instead of going back
  if ((rounds[loop.id] ?? 0) + 1 < loop.max) return { backTo };
  return { backTo, capRounds: loop.max, ...(loop.atCap === 'continue' ? { capAsksFindings: true } : {}) };
}

type AttentionInput = {
  dir: string;
  meta: RunMeta;
  state: RunState;
  waiting: Waiting | undefined;
  alive: boolean | null;
  steps: RunGraphStep[];
  loops: RunGraphLoop[];
  /** graph.json was read: without it the loops are unknown, so a gate does not say where a reject goes */
  graphKnown: boolean;
  /** the run's config file, null when it is the default */
  config: string | null;
  /** the step the run is at (its first step before any has run) */
  current: string | undefined;
};

/** What every attention check reads: the run, and what they all derive from it. */
type AttentionContext = AttentionInput & {
  lastEnd: string;
  again: Pick<YourTurnInput, 'ticket' | 'pipeline' | 'inputs' | 'repoRoot' | 'profile' | 'config'>;
  turn: (kind: AttentionKind, step: string | undefined, x?: Partial<YourTurnInput>) => { message: string; detail?: string };
  failing: (step: string | undefined) => ReviewItem[];
};

/** One check of `attentionOf`: its attention when it applies, else undefined (the next check is asked). */
type AttentionCheck = (c: AttentionContext) => Promise<AttentionJson | undefined>;

/** A waiting gate decided while the driver was dead: resume carries the decision out. */
const decidedGate: AttentionCheck = async ({ waiting, alive, turn }) => {
  if (waiting === undefined || alive !== false || !(await exists(path.join(waiting.stepDir, 'decision.json')))) return undefined;
  const d = await readDecision(waiting.stepDir);
  return { kind: 'stalled', since: waiting.since, ...turn('stalled', waiting.stepId, d !== undefined ? { decision: d } : {}), actions: ['resume'] };
};

/** A waiting pick-pipeline gate. */
const pickGate: AttentionCheck = async (o) => {
  const { dir, state, waiting } = o;
  if (waiting === undefined) return undefined;
  const choices = o.steps.find((s) => s.id === waiting.stepId && s.id === PICK_GATE)?.choices;
  if (choices === undefined) return undefined;
  const suggests = await suggestion(dir, state, choices);
  return {
    kind: 'gate',
    since: waiting.since,
    message: suggests === undefined ? 'pick the pipeline for this ticket' : `pick the pipeline for this ticket (the agent suggests ${suggests})`,
    ...pickDetail(gateBackTo(waiting.stepId, o.steps, o.loops, state.rounds)),
    ...(waiting.commentUrl !== undefined ? { commentUrl: waiting.commentUrl } : {}),
    review: gateReview(dir, waiting.stepId, o.steps, state),
    actions: ['pick', 'reject'],
    choices,
  };
};

/** Any other waiting gate. */
const gate: AttentionCheck = async (o) => {
  const { dir, state, waiting, turn } = o;
  if (waiting === undefined) return undefined;
  const { detail, ...gateTurn } = turn('gate', waiting.stepId, gateBackTo(waiting.stepId, o.steps, o.loops, state.rounds));
  return {
    kind: 'gate',
    since: waiting.since,
    ...gateTurn,
    ...(o.graphKnown && detail !== undefined ? { detail } : {}),
    ...(waiting.commentUrl !== undefined ? { commentUrl: waiting.commentUrl } : {}),
    review: gateReview(dir, waiting.stepId, o.steps, state),
    actions: ['approve', 'reject'],
  };
};

/** A run paused on questions, or on findings at a cap. */
const asked: AttentionCheck = async (o) => {
  const { dir, state, lastEnd, turn, failing } = o;
  if (state.status !== 'paused') return undefined;
  const asking = state.asking;
  if (asking === undefined) return undefined;
  const items = await askedItems(dir, state);
  const findings: Partial<YourTurnInput> = {};
  if (asking.kind === 'findings') {
    const to = o.loops.find((l) => l.id === asking.edgeId)?.to;
    const backTo = o.steps.find((s) => s.id === to)?.stage;
    if (backTo !== undefined) findings.backTo = backTo;
    if (items.length === 0) findings.nothingToTick = true;
  }
  return {
    kind: asking.kind,
    since: lastEnd,
    ...turn(asking.kind, asking.stepId, findings),
    // every step whose findings are numbered, the others first as the items are
    review: [...new Set([...(asking.kind === 'findings' ? (asking.also ?? []).map((s) => s.stepId) : []), asking.stepId])].flatMap(failing),
    actions: ['answer'],
    asked: { step: asking.stepId, attempt: asking.attempt, items },
  };
};

/** A run paused at a loop's cap. */
const cap: AttentionCheck = async (o) => {
  const { state, current, lastEnd, turn, failing } = o;
  if (state.status !== 'paused' || state.pausedCap === undefined) return undefined;
  const from = o.loops.find((l) => l.id === state.pausedCap)?.from ?? current;
  const reason = (state.pausedReason ?? '').replace(/^cap: /, '');
  return { kind: 'cap', since: lastEnd, ...turn('cap', current, { reason }), review: failing(from), actions: ['grant'] };
};

/** Any other paused run. */
const paused: AttentionCheck = async ({ dir, state, current, lastEnd, turn, failing }) => {
  if (state.status !== 'paused') return undefined;
  const reason = state.pausedReason ?? '';
  const named = current === undefined ? undefined : transcriptIn(reason, dir, current);
  // the runtime saves the screen best-effort: link it only when it was saved
  const transcript = named !== undefined && (await fs.stat(named).then((s) => s.isFile(), () => false)) ? named : undefined;
  return {
    kind: 'paused',
    since: lastEnd,
    ...turn('paused', current, { reason }),
    ...(transcript !== undefined ? { transcript } : {}),
    review: failing(current),
    actions: ['resume'],
  };
};

/** A failed run that still has its worktree. */
const failed: AttentionCheck = async ({ meta, state, current, lastEnd, again, turn, failing }) => {
  if (state.status !== 'failed') return undefined;
  // after `perc clean` (no worktree) there is nothing left to do for a failed run
  if (!(await exists(meta.worktree))) return undefined;
  // a slice is started again by its parent, not by a new run
  const sliceOf = meta.fanOut?.parent;
  return {
    kind: 'failed',
    since: lastEnd,
    ...turn('failed', current, {
      ...(sliceOf !== undefined ? { sliceOf } : {}),
      ...(state.failedReason !== undefined ? { reason: state.failedReason } : {}),
    }),
    review: failing(current),
    actions: sliceOf === undefined ? ['run-again', 'clean'] : ['clean'],
    ...(sliceOf === undefined ? { commands: [runAgain(again)] } : {}),
  };
};

/** A running run whose driver is dead. */
const stalled: AttentionCheck = async ({ state, alive, current, lastEnd, turn }) => {
  if (state.status !== 'running' || alive !== false) return undefined;
  return { kind: 'stalled', since: lastEnd, ...turn('stalled', current), actions: ['resume'] };
};

/** A running run whose current step's agent wants attention in its terminal. */
const agent: AttentionCheck = async ({ dir, state, alive, current, lastEnd, turn }) => {
  if (state.status !== 'running' || alive !== true) return undefined;
  const a = await readAttention(dir);
  if (a === undefined || a.stepId !== current || typeof a.terminal !== 'string') return undefined;
  return {
    kind: 'agent',
    since: typeof a.at === 'string' ? a.at : lastEnd,
    ...turn('agent', current, { terminal: a.terminal, agentState: typeof a.kind === 'string' ? a.kind : 'waiting' }),
    terminal: a.terminal,
    ...(typeof a.kind === 'string' ? { agentState: a.kind } : {}),
    actions: ['open-pane'],
  };
};

/** The checks of `attentionOf`, in order: the first that applies wins. */
const ATTENTION_CHECKS: AttentionCheck[] = [decidedGate, pickGate, gate, asked, cap, paused, failed, stalled, agent];

async function attentionOf(o: AttentionInput): Promise<AttentionJson | undefined> {
  const { dir, meta, state } = o;
  const lastEnd = state.history.at(-1)?.endedAt || meta.createdAt;
  const again = {
    ticket: meta.ticket,
    pipeline: meta.pipeline,
    inputs: meta.inputs,
    repoRoot: meta.repoRoot,
    profile: meta.profile,
    ...(o.config !== null ? { config: o.config } : {}),
  };
  const turn = (kind: AttentionKind, step: string | undefined, x: Partial<YourTurnInput> = {}) => {
    const t = yourTurn({ kind, runId: meta.runId, step: step ?? STAGES[0], ...again, ...x });
    return { message: t.message, ...(t.detail !== undefined ? { detail: t.detail } : {}) };
  };
  const failing = (step: string | undefined) => (step === undefined ? [] : review(dir, step, latest(state, step)?.outputs));
  const c: AttentionContext = { ...o, lastEnd, again, turn, failing };
  for (const check of ATTENTION_CHECKS) {
    const hit = await check(c);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Who decided a gate attempt: `decision.json`, else the `@login` in its approval or findings output. Any failure only means no one. */
async function deciderOf(dir: string, h: StepRecord, decision: 'approve' | 'reject'): Promise<string | undefined> {
  try {
    const d = JSON.parse(await fs.readFile(path.join(dir, 'steps', h.stepId, String(h.attempt), 'decision.json'), 'utf8')) as { by?: unknown };
    if (typeof d.by === 'string' && d.by !== '') return d.by;
  } catch {
    // fall through to the output
  }
  const rel = h.outputs[decision === 'approve' ? 'approval' : 'findings'];
  if (rel === undefined) return undefined;
  try {
    return /\bby @([A-Za-z0-9-]+)/.exec(await fs.readFile(path.join(dir, rel), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/** One entry per history record (plus a cap entry after the attempt that hit a loop's cap), then the live attempt: the waiting gate, else the running current step. */
async function timelineOf(o: {
  dir: string;
  meta: RunMeta;
  state: RunState;
  waiting: Waiting | undefined;
  steps: RunGraphStep[];
  loops: RunGraphLoop[];
  /** the step the run is at (its first step before any has run) */
  current: string | undefined;
}): Promise<TimelineJson[]> {
  const { dir, meta, state, waiting } = o;
  const gates = new Set(o.steps.filter((s) => s.kind === 'gate').map((s) => s.id));
  const out: TimelineJson[] = [];
  for (const h of state.history) {
    const entry: AttemptJson = {
      kind: 'attempt',
      step: h.stepId,
      attempt: h.attempt,
      status: h.status,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      outputs: absOutputs(dir, h.outputs),
    };
    if (gates.has(h.stepId) && (h.status === 'pass' || h.status === 'fail')) {
      const decision = h.status === 'pass' ? 'approve' : 'reject';
      const by = await deciderOf(dir, h, decision);
      entry.decision = { decision, ...(by !== undefined ? { by } : {}) };
    }
    out.push(entry);
  }
  for (const lp of o.loops) {
    if ((state.rounds[lp.id] ?? 0) < lp.max) continue;
    const at = out.findLastIndex((x) => x.kind === 'attempt' && x.step === lp.from);
    const last = out[at];
    if (last?.kind !== 'attempt' || last.endedAt === undefined) continue;
    out.splice(at + 1, 0, { kind: 'cap', loop: lp.id, from: lp.from, to: lp.to, max: lp.max, at: last.endedAt });
  }
  const live = waiting !== undefined ? { step: waiting.stepId, status: 'waiting' as const, startedAt: waiting.since } : undefined;
  const step = o.current;
  const running =
    live === undefined && state.status === 'running' && step !== undefined
      ? { step, status: 'running' as const, startedAt: state.history.at(-1)?.endedAt || meta.createdAt }
      : undefined;
  const cur = live ?? running;
  if (cur !== undefined) out.push({ kind: 'attempt', ...cur, attempt: (state.executed[cur.step] ?? 0) + 1, outputs: {} });
  return out;
}

/** A listed run's status as its status JSON gives it, read cheaply (no hc, no graph); `unreadable` on any error. */
async function listedStatus(l: RunListing): Promise<RunStatusJson['status']> {
  if (l.error !== undefined || l.meta === undefined) return 'unreadable';
  // run.json written, state.json not yet: the run is being started
  if (l.state === undefined) return 'running';
  const s = l.state.status;
  try {
    return (s === 'running' || s === 'paused') && (await readWaiting(l.dir)) !== undefined ? 'waiting' : s;
  } catch {
    return 'unreadable';
  }
}

/** A fan-out's slices from `fanout.json`, by index; none when there is none or it can't be read (status never throws on it). */
async function slicesOf(dir: string): Promise<FanOutFile['children']> {
  try {
    const f = await readFanOut(dir);
    return Array.isArray(f?.children) ? [...f.children].sort((a, b) => a.index - b.index) : [];
  } catch {
    return [];
  }
}

/**
 * The runs this one started: its fan-out slices first, by index (a slice not started yet is `pending`, on this run's
 * pipeline), then the other listed runs whose `run.json` names it as their parent, in listing order.
 */
async function childrenOf(dir: string, meta: RunMeta, listed: RunListing[]): Promise<ChildJson[]> {
  const linked = listed.filter((l) => l.meta?.parent === meta.runId);
  const statusOf = async (l: RunListing) => ({ id: l.meta!.runId, pipeline: l.meta!.pipeline, status: await listedStatus(l) });
  const slices = await slicesOf(dir);
  const out: ChildJson[] = [];
  for (const s of slices) {
    const l = linked.find((x) => x.meta!.runId === s.id);
    const base = l ? await statusOf(l) : { id: s.id, pipeline: meta.pipeline, status: 'pending' as const };
    out.push({ ...base, slice: { index: s.index, title: s.title } });
  }
  for (const l of linked) if (!slices.some((s) => s.id === l.meta!.runId)) out.push(await statusOf(l));
  return out;
}

/** The issues parsed from the latest history record with an `issue_urls` output; none when there is none. */
async function openedOf(dir: string, state: RunState): Promise<{ ref: string; url: string }[]> {
  const text = await readLatest(dir, state, 'issue_urls');
  return text === undefined ? [] : openedIssues(text);
}

/** The URL in the latest history record's `comment_url` output; null when there is none, or its file is gone or blank. */
async function commentOf(dir: string, state: RunState): Promise<{ url: string } | null> {
  const url = await readLatest(dir, state, 'comment_url');
  return url === undefined ? null : { url };
}

async function readRun(l: RunListing & { meta: RunMeta }, deps: DriverDeps, listed: RunListing[]): Promise<RunStatusJson> {
  const { dir, meta } = l;
  const state = l.state ?? (await loadState(dir));
  const graph = await readRunGraph(dir);
  const loopDefs = graph?.loops ?? [];
  const live = isLive(state.status);
  const waiting = live ? await readWaiting(dir) : undefined;
  const stepDefs = graph?.steps ?? (await historySteps(dir, state, waiting));
  // a finished run has no driver or terminals worth asking hc about
  const finished = isFinished(state.status);
  const alive = finished ? false : await driverAlive(dir, meta, deps);
  const liveT = finished ? { names: {} as Record<string, string> } : await liveTerminals(meta, deps);
  // before any step has run the engine has no current step yet: the run is at its first step (a slice's fanned stage)
  const current = state.currentStep ?? (state.history.length === 0 ? (stepDefs[0]?.id ?? STAGES[0]) : undefined);
  const steps: StepJson[] = stepDefs.map((s) => {
    const h = latest(state, s.id);
    const status: StepJson['status'] =
      waiting?.stepId === s.id
        ? 'waiting'
        : state.status === 'running' && current === s.id
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
  const config = samePath(meta.configFile, path.join(deps.home, '.percolator', 'config.yaml')) ? null : meta.configFile;
  const attention = await attentionOf({ dir, meta, state, waiting, alive, steps: stepDefs, loops: loopDefs, graphKnown: graph !== undefined, config, current });
  const url = await prUrl(dir, state);
  return {
    id: meta.runId,
    pipeline: meta.pipeline,
    inputs: meta.inputs,
    profile: meta.profile,
    config,
    ticket: await readTicket(dir, meta),
    parent: meta.parent ?? null,
    children: await childrenOf(dir, meta, listed),
    opened: await openedOf(dir, state),
    repo: meta.repoRoot,
    branch: meta.branch,
    worktree: meta.worktree,
    createdAt: meta.createdAt,
    status: waiting !== undefined ? 'waiting' : state.status,
    ...(current !== undefined && state.status !== 'completed' ? { currentStep: current } : {}),
    driver: {
      alive,
      terminal: meta.driver,
      ...(meta.space !== undefined ? { space: meta.space } : {}),
      shown: meta.space !== undefined && liveT.driverSpace === meta.space,
    },
    ...(attention !== undefined ? { attention } : {}),
    steps,
    loops: loopDefs.map((lp) => ({ ...lp, round: state.rounds[lp.id] ?? 0 })),
    timeline: await timelineOf({ dir, meta, state, waiting, steps: stepDefs, loops: loopDefs, current }),
    terminals: liveT.names,
    pr: url === undefined ? null : { url },
    graph: graph === undefined ? 'history' : 'full',
    trigger: meta.trigger ?? null,
    comment: await commentOf(dir, state),
  };
}

/**
 * One run as the `perc status --json` contract describes it; a run that can't be read is `unreadable`, never thrown.
 * `listed` (default: every run under `deps.home`) is where its children are looked for.
 */
export async function runStatusJson(l: RunListing, deps: DriverDeps, listed?: RunListing[]): Promise<RunStatusJson> {
  const id = l.meta?.runId ?? path.basename(l.dir);
  if (l.error !== undefined || l.meta === undefined) return { id, status: 'unreadable', error: l.error ?? 'run.json missing' };
  try {
    return await readRun({ ...l, meta: l.meta }, deps, listed ?? (await listRuns(deps.home)));
  } catch (err) {
    return { id, status: 'unreadable', error: (err as Error).message.split('\n')[0]! };
  }
}

const READ_AT_ONCE = 4;

/** Every run under `deps.home`, in `listRuns` order, read a few at a time. Reads run dirs only, never the config. */
export async function statusJson(deps: DriverDeps): Promise<StatusJson> {
  const listed = await listRuns(deps.home);
  const runs: RunStatusJson[] = new Array(listed.length);
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const i = next++;
      runs[i] = await runStatusJson(listed[i]!, deps, listed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, listed.length) }, worker));
  const now = (deps.now ?? (() => new Date()))();
  return { schema: 2, runs, watcher: await watcherStatus(deps.home, now, deps.pidAlive ?? pidAlive) };
}

/** The step's saved agent screen (`<runDir>/steps/<step>/<n>/transcript.txt`) when a pause reason names it. Matched as
 *  the path is built, so a path with spaces is found whole. */
export function transcriptIn(reason: string, runDir: string, step: string): string | undefined {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = esc(path.sep);
  return reason.match(new RegExp(`${esc(path.join(runDir, 'steps', step))}${sep}\\d+${sep}transcript\\.txt`))?.[0];
}
