import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STAGES } from '../config/schema.ts';
import type { RunState, StepRecord } from '../engine/state.ts';
import { loadState } from '../engine/state.ts';
import { openedIssues } from '../tracker/exits/issues.ts';
import { readWaiting } from '../tracker/gate.ts';
import type { Waiting } from '../tracker/gate.ts';
import { liveness, prUrl } from './drive.ts';
import { readRunGraph } from './graph-file.ts';
import type { RunGraphLoop, RunGraphStep } from './graph-file.ts';
import { lockIsLive, pidAlive, readDriverLock } from './lock.ts';
import type { DriverLock } from './lock.ts';
import { readFanOut } from './fan-out.ts';
import type { FanOutFile } from './fan-out.ts';
import { listRuns } from './meta.ts';
import type { RunListing, RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { askedItems } from './answer.ts';
import { parsePick } from './route.ts';
import { watcherStatus } from '../watch/watch.ts';
import { samePath } from '../util/paths.ts';

export type AttentionKind = 'gate' | 'cap' | 'paused' | 'questions' | 'findings' | 'failed' | 'stalled' | 'agent';
export type Action = 'approve' | 'pick' | 'reject' | 'grant' | 'resume' | 'answer' | 'clean' | 'open-pane' | 'run-again';
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
  /** paused only: the agent's saved screen (an absolute path) when the pause reason names it; `detail` keeps it in its text */
  transcript?: string;
  /** a pick-pipeline gate only: the pipelines `pick` may name (`perc approve <id> --pipeline <name>`) */
  choices?: string[];
  /** questions or findings only: what the run asks, item by item (`perc answer <id>` numbers them from 1) */
  asked?: { step: string; attempt: number; items: string[] };
};
export type StepJson = RunGraphStep & {
  status: 'pending' | 'running' | 'waiting' | StepRecord['status'];
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  outputs: Record<string, string>;
};
export type DecisionJson = { decision: 'approve' | 'reject'; by?: string };
export type AttemptJson = {
  kind: 'attempt';
  step: string;
  attempt: number;
  /** `running` or `waiting` only on the live entry, which is always last */
  status: Exclude<StepJson['status'], 'pending'>;
  startedAt?: string;
  /** absent on the live entry */
  endedAt?: string;
  outputs: Record<string, string>;
  /** gate attempts only: pass is approve, fail is reject */
  decision?: DecisionJson;
};
export type CapJson = { kind: 'cap'; loop: string; from: string; to: string; max: number; at: string };
export type TimelineJson = AttemptJson | CapJson;
export type LoopJson = RunGraphLoop & { round: number };
export type TicketJson = { ref: string; number: number; title?: string; url?: string };
/** A run this one started (route or fan-out child); `slice` only on a fan-out child. */
export type ChildJson = { id: string; pipeline: string; status: RunStatusJson['status'] | 'pending'; slice?: { index: number; title: string } };
export type RunStatusJson =
  | {
      id: string;
      /** the pipeline the run was started on (`feature` for a run from before pipelines) */
      pipeline: string;
      /** the `--input` values the run was started with */
      inputs: Record<string, string>;
      /** the profile the run was started with */
      profile: string;
      /** the config file the run was started with, null when it is perc's default (`~/.percolator/config.yaml`) */
      config: string | null;
      /** null on a ticketless run */
      ticket: TicketJson | null;
      /** the run that started this one, else null */
      parent: string | null;
      /** fan-out slices by index (pending until started), then listed runs whose parent is this run, in listing order */
      children: ChildJson[];
      /** the issues the run's exit opened, from its latest `issue_urls` output */
      opened: { ref: string; url: string }[];
      repo: string;
      branch: string;
      worktree: string;
      createdAt: string;
      status: 'running' | 'waiting' | 'paused' | 'failed' | 'completed';
      currentStep?: string;
      driver: { alive: boolean | null; terminal: string; space?: string; shown: boolean };
      attention?: AttentionJson;
      steps: StepJson[];
      loops: LoopJson[];
      /** every attempt in execution order, oldest first; the live attempt (if any) is last */
      timeline: TimelineJson[];
      terminals: Record<string, string>;
      pr: { url: string } | null;
      graph: 'full' | 'history';
    }
  | { id: string; status: 'unreadable'; error: string };
/** Whether `perc watch` runs (same host, live pid, fresh heartbeat), since when, and the repos it watches. */
export type WatcherJson = { alive: boolean; since?: string; repos: string[] };
export type StatusJson = { schema: 2; runs: RunStatusJson[]; watcher: WatcherJson };

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
  const live = state.status === 'running' || state.status === 'paused';
  if (live && cur !== undefined && !out.some((s) => s.id === cur)) await add(cur, waiting?.stepId === cur);
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

export type YourTurnInput = {
  kind: AttentionKind;
  runId: string;
  step: string;
  /** absent on a ticketless run */
  ticket?: string;
  /** the run's pipeline and inputs, so "start it again" starts the same kind of run */
  pipeline?: string;
  inputs?: Record<string, string>;
  repoRoot: string;
  /** the run's profile and (unless the default) config file, so it starts under the same config */
  profile?: string;
  config?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  terminal?: string;
  agentState?: string;
  /** a failed fan-out slice: its parent run, which starts the slice again once it is deleted */
  sliceOf?: string;
  /** a pick-pipeline gate: the pipelines `perc approve --pipeline` may name */
  choices?: string[];
  /** findings: the stage a granted round goes back to; gate: the stage a reject goes back to (none: a reject ends the run) */
  backTo?: string;
  /** gate: its loop is on its last round, so a reject pauses at this cap of rounds (asking which findings to fix, for a stage loop) */
  capRounds?: number;
  capAsksFindings?: boolean;
  /** findings: the failing step wrote none, so the only answer is to move on */
  nothingToTick?: boolean;
};

/**
 * A value as typed (the repo, an input after `--input k=`), backslashes kept as they are. A blank or a `'`:
 * double-quoted, which sh, PowerShell and cmd read alike. A `"`, `$` or backtick: single-quoted, which sh and
 * PowerShell take as typed (no shell reads a `\"` escape alike). Both kinds of quote: PowerShell's `''`, as
 * Windows is the owner's OS.
 */
const quoted = (v: string): string => {
  if (!/[\s"'$`]/.test(v)) return v;
  if (!/["$`]/.test(v)) return `"${v}"`;
  return `'${v.replace(/'/g, "''")}'`;
};

/**
 * The `perc run` that starts the same kind of run again: its ticket, its pipeline (named even when feature, as a
 * profile may mark another pipeline default), its inputs, its repo, then its config file (unless the default) and profile.
 */
export function runAgain(a: Pick<YourTurnInput, 'ticket' | 'pipeline' | 'inputs' | 'repoRoot' | 'profile' | 'config'>): string {
  const pipeline = a.pipeline !== undefined ? [`--pipeline ${a.pipeline}`] : [];
  const inputs = Object.entries(a.inputs ?? {}).map(([k, v]) => `--input ${k}=${quoted(v)}`);
  const config = a.config !== undefined ? [`--config ${quoted(a.config)}`] : [];
  const profile = a.profile !== undefined ? [`--profile ${a.profile}`] : [];
  return ['perc run', ...(a.ticket ? [a.ticket] : []), ...pipeline, ...inputs, `--repo ${quoted(a.repoRoot)}`, ...config, ...profile].join(' ');
}

/** Where a reject of a gate sends the run: back with the feedback, else to the cap of its loop on the last round. */
function gateDetail(a: Pick<YourTurnInput, 'backTo' | 'capRounds' | 'capAsksFindings'>): string {
  if (a.backTo === undefined) return "Rejecting ends the run; a failed run can't be resumed.";
  if (a.capRounds !== undefined) {
    return a.capAsksFindings === true
      ? `Rejecting pauses the run at its cap (${a.capRounds} rounds) to ask which findings to fix.`
      : `Rejecting pauses the run at its cap (${a.capRounds} rounds); perc resume grants one more.`;
  }
  return `Rejecting sends the run back to ${a.backTo} with your feedback.`;
}

/** A failed step, with why it failed when the run recorded it (`lint failed (exit code 1)`). */
export function failedText(step: string, reason: string | undefined): string {
  return reason === undefined ? `${step} failed` : `${step} failed (${reason})`;
}

/** What the owner has to do next, as one sentence plus the exact commands to type. Shared by `perc status` and the JSON. */
export function yourTurn(a: YourTurnInput): { message: string; detail?: string; next: string[] } {
  const resume = [`perc resume ${a.runId}`];
  switch (a.kind) {
    case 'gate':
      return {
        // a ticketless run has no issue for the gate to comment on
        message: a.ticket ? `${a.step} is waiting for approval` : 'approve or reject here (no issue to comment on)',
        detail: gateDetail(a),
        next: [
          ...(a.choices !== undefined ? a.choices.map((c) => `perc approve ${a.runId} --pipeline ${c}`) : [`perc approve ${a.runId}`]),
          `perc reject ${a.runId} "<what to change>"`,
        ],
      };
    case 'cap':
      return {
        message: `${a.step} hit its cap (${a.reason})`,
        detail: 'Grant one more round and the run goes back with the open findings.',
        next: resume,
      };
    case 'paused': {
      // the runtime's reasons start with the step, which the message already names
      const reason = a.reason ?? ''; // attentionNext asks for the commands only
      const why = reason.startsWith(`${a.step}: `) ? reason.slice(a.step.length + 2) : reason;
      return { message: `${a.step} paused`, ...(why.trim() !== '' ? { detail: why } : {}), next: resume };
    }
    case 'questions':
      return {
        message: `${a.step} has questions for you`,
        detail: `Answer each one or mark it N/A; ${a.step} then runs again with your answers.`,
        next: [`perc answer ${a.runId} --answer <n>="<text>" --na <n> …`],
      };
    case 'findings':
      if (a.nothingToTick === true) {
        return { message: `${a.step} hit its cap and wrote no findings to tick`, detail: 'The only answer is to move on past it.', next: [`perc answer ${a.runId}`] };
      }
      return {
        message: `${a.step} hit its cap with findings left`,
        detail: `Tick the findings to fix: the run goes back${a.backTo === undefined ? '' : ` to ${a.backTo}`} for one more round with only those. With none ticked, it moves on.`,
        next: [`perc answer ${a.runId} --agree <n>[,<n>…]`, `perc answer ${a.runId}`],
      };
    case 'failed':
      if (a.sliceOf !== undefined) {
        return {
          message: `${a.step} failed`,
          detail: `Delete this slice (its branch stays), then resume ${a.sliceOf} to run it again`,
          next: [`perc delete ${a.runId}`, `perc resume ${a.sliceOf}`],
        };
      }
      return {
        message: failedText(a.step, a.reason),
        detail: `A failed run can't be resumed. Start a new run ${a.ticket ? 'for the ticket' : `of pipeline ${a.pipeline ?? 'feature'}`}, then delete this one (or clean it up to keep its record).`,
        next: [runAgain(a), `perc delete ${a.runId}`, `perc clean ${a.runId}`],
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

/**
 * The commands `yourTurn` gives for an attention record (they depend on its kind and the run, not on its reason).
 * A failed run with a parent and no `commands` is a fan-out slice (attentionOf gives a slice none).
 */
export function attentionNext(
  a: AttentionJson,
  run: {
    id: string;
    ticket: { ref: string } | null;
    pipeline: string;
    inputs: Record<string, string>;
    repo: string;
    parent?: string | null;
    profile?: string;
    config?: string | null;
  },
): string[] {
  const again = {
    ticket: run.ticket?.ref,
    pipeline: run.pipeline,
    inputs: run.inputs,
    repoRoot: run.repo,
    ...(run.profile !== undefined ? { profile: run.profile } : {}),
    ...(typeof run.config === 'string' ? { config: run.config } : {}),
  };
  const slice = a.kind === 'failed' && a.commands === undefined && typeof run.parent === 'string' ? { sliceOf: run.parent } : {};
  const choices = a.choices !== undefined ? { choices: a.choices } : {};
  const none = a.kind === 'findings' && a.asked?.items.length === 0 ? { nothingToTick: true } : {};
  return yourTurn({ kind: a.kind, runId: run.id, step: '', ...again, ...slice, ...choices, ...none }).next;
}

const PICK_GATE = 'pick-pipeline';

/** A pick gate's reject has the choose agent pick again, or pauses at its cap on the last round. */
function pickDetail(g: Pick<YourTurnInput, 'backTo' | 'capRounds'>): { detail?: string } {
  if (g.backTo === undefined) return {};
  if (g.capRounds !== undefined) return { detail: gateDetail(g) };
  return { detail: 'Rejecting has the agent pick again with your feedback.' };
}

/** The choose agent's latest valid pick among `choices`, if it made one (sure or not). */
async function suggestion(dir: string, state: RunState, choices: string[]): Promise<string | undefined> {
  const rel = latest(state, 'route.1')?.outputs['pick'];
  if (rel === undefined) return undefined;
  const text = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
  return parsePick(text, choices).pipeline;
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

async function attentionOf(o: {
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
}): Promise<AttentionJson | undefined> {
  const { dir, meta, state, waiting, alive } = o;
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
  if (waiting !== undefined) {
    if (alive === false && (await exists(path.join(waiting.stepDir, 'decision.json')))) {
      const d = await readDecision(waiting.stepDir);
      return { kind: 'stalled', since: waiting.since, ...turn('stalled', waiting.stepId, d !== undefined ? { decision: d } : {}), actions: ['resume'] };
    }
    const choices = o.steps.find((s) => s.id === waiting.stepId && s.id === PICK_GATE)?.choices;
    if (choices !== undefined) {
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
    }
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
  }
  if (state.status === 'paused') {
    const asking = state.asking;
    if (asking !== undefined) {
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
    }
    if (state.pausedCap !== undefined) {
      const from = o.loops.find((l) => l.id === state.pausedCap)?.from ?? state.currentStep;
      const reason = (state.pausedReason ?? '').replace(/^cap: /, '');
      return { kind: 'cap', since: lastEnd, ...turn('cap', state.currentStep, { reason }), review: failing(from), actions: ['grant'] };
    }
    const reason = state.pausedReason ?? '';
    const transcript = state.currentStep === undefined ? undefined : transcriptIn(reason, dir, state.currentStep);
    return {
      kind: 'paused',
      since: lastEnd,
      ...turn('paused', state.currentStep, { reason }),
      ...(transcript !== undefined ? { transcript } : {}),
      review: failing(state.currentStep),
      actions: ['resume'],
    };
  }
  // after `perc clean` (no worktree) there is nothing left to do for a failed run
  if (state.status === 'failed') {
    if (!(await exists(meta.worktree))) return undefined;
    // a slice is started again by its parent, not by a new run
    const sliceOf = meta.fanOut?.parent;
    return {
      kind: 'failed',
      since: lastEnd,
      ...turn('failed', state.currentStep, {
        ...(sliceOf !== undefined ? { sliceOf } : {}),
        ...(state.failedReason !== undefined ? { reason: state.failedReason } : {}),
      }),
      review: failing(state.currentStep),
      actions: sliceOf === undefined ? ['run-again', 'clean'] : ['clean'],
      ...(sliceOf === undefined ? { commands: [runAgain(again)] } : {}),
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
  // a fresh run has no current step yet: it is running the first stage
  const step = state.currentStep ?? (state.history.length === 0 ? STAGES[0] : undefined);
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
  const rel = state.history.findLast((h) => h.outputs['issue_urls'] !== undefined)?.outputs['issue_urls'];
  if (rel === undefined) return [];
  try {
    return openedIssues(await fs.readFile(path.join(dir, rel), 'utf8'));
  } catch {
    // a removed output file only means nothing to list
    return [];
  }
}

async function readRun(l: RunListing & { meta: RunMeta }, deps: DriverDeps, listed: RunListing[]): Promise<RunStatusJson> {
  const { dir, meta } = l;
  const state = l.state ?? (await loadState(dir));
  const graph = await readRunGraph(dir);
  const loopDefs = graph?.loops ?? [];
  const live = state.status === 'running' || state.status === 'paused';
  const waiting = live ? await readWaiting(dir) : undefined;
  const stepDefs = graph?.steps ?? (await historySteps(dir, state, waiting));
  // a finished run has no driver or terminals worth asking hc about
  const finished = state.status === 'completed' || state.status === 'failed';
  const alive = finished ? false : await driverAlive(dir, meta, deps);
  const liveT = finished ? { names: {} as Record<string, string> } : await liveTerminals(meta, deps);
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
  const config = samePath(meta.configFile, path.join(deps.home, '.percolator', 'config.yaml')) ? null : meta.configFile;
  const attention = await attentionOf({ dir, meta, state, waiting, alive, steps: stepDefs, loops: loopDefs, graphKnown: graph !== undefined, config });
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
    ...(state.currentStep !== undefined && state.status !== 'completed' ? { currentStep: state.currentStep } : {}),
    driver: {
      alive,
      terminal: meta.driver,
      ...(meta.space !== undefined ? { space: meta.space } : {}),
      shown: meta.space !== undefined && liveT.driverSpace === meta.space,
    },
    ...(attention !== undefined ? { attention } : {}),
    steps,
    loops: loopDefs.map((lp) => ({ ...lp, round: state.rounds[lp.id] ?? 0 })),
    timeline: await timelineOf({ dir, meta, state, waiting, steps: stepDefs, loops: loopDefs }),
    terminals: liveT.names,
    pr: url === undefined ? null : { url },
    graph: graph === undefined ? 'history' : 'full',
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
