import fs from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from '../graph/build.ts';
import { writeFileAtomic } from '../util/fs.ts';

export type StepRecord = {
  stepId: string;
  attempt: number;
  startedAt: string;
  endedAt: string;
  status: 'pass' | 'fail' | 'escalate' | 'contract_error';
  outputs: Record<string, string>;
};

/** What a paused run asks the owner: a step's questions, or which findings left at a stage loop's cap to fix. */
export type Asking =
  | { kind: 'questions'; stepId: string; attempt: number; items: string[] }
  /**
   * `stepId` decided the round; `findings` is its run-dir-relative findings output, absent when it wrote none. `also`
   * lists the other steps of the loop that failed in that round, in step order. `items` (and `itemSteps`, the step
   * each item comes from) are filled in by the driver.
   */
  | {
      kind: 'findings';
      stepId: string;
      attempt: number;
      edgeId: string;
      findings?: string;
      also?: FindingSource[];
      items?: string[];
      itemSteps?: string[];
    };

/** A step that failed in a stage loop's last round, with its findings output. */
export type FindingSource = { stepId: string; attempt: number; findings: string };

export type RunState = {
  version: 1;
  runId: string;
  /** absent on a ticketless run */
  ticket?: string;
  profile: string;
  groundVersions: Record<string, string>;
  cursor: number;
  rounds: Record<string, number>;
  /** back-edge id → rounds the owner granted past its cap; reset with `rounds` when an enclosing loop jumps back */
  granted?: Record<string, number>;
  executed: Record<string, number>;
  history: StepRecord[];
  status: 'running' | 'paused' | 'failed' | 'completed';
  pausedReason?: string;
  /** back-edge id when paused at an escalating cap; cleared when the run resumes */
  pausedCap?: string;
  /** back-edge whose extra round `grantRound` granted; `runGraph` jumps to its loop start on resume, then clears it */
  grantedRound?: string;
  /** id of the step at `cursor`; absent once the cursor is past the end */
  currentStep?: string;
  unresolvedFindings?: string;
  /**
   * a back-edge was triggered by the fail of `stepId` but its jump waits for the step at `jumpAfterIndex`.
   * States saved before `stepId` existed lack it; the engine then uses the edge's `fromStepId`.
   */
  pendingJump?: { edgeId: string; stepId: string; findings?: string };
  /** sha256 of the graph this run started on; set by `runGraph` on a new run, checked on resume */
  graphFingerprint?: string;
  /** sha256 of `mappingKeys`; set by `prepareRun`, checked on resume; absent in older states (no check) */
  mappingsFingerprint?: string;
  /** sorted mapping keys (JSON `[as, ground, file ?? dir, required, applies_to]`) the run started on */
  mappingKeys?: string[];
  /** set while the run is paused for the owner's answers (`perc answer`) */
  asking?: Asking;
  /** stepId → output key → run-dir-relative path: the owner's answers, which override that step's outputs until it runs again */
  answered?: Record<string, Record<string, string>>;
};

const STATUSES: readonly string[] = ['running', 'paused', 'failed', 'completed'];

const isNumberRecord = (v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((n) => typeof n === 'number');

/** Name of the first field of `s` with an invalid shape, or undefined. */
function invalidField(s: Record<string, unknown>): string | undefined {
  if (!Number.isInteger(s['cursor']) || (s['cursor'] as number) < 0) return 'cursor';
  if (!STATUSES.includes(s['status'] as string)) return 'status';
  if (!Array.isArray(s['history'])) return 'history';
  if (!isNumberRecord(s['rounds'])) return 'rounds';
  if (!isNumberRecord(s['executed'])) return 'executed';
  if (s['granted'] !== undefined && !isNumberRecord(s['granted'])) return 'granted';
  if (s['graphFingerprint'] !== undefined && typeof s['graphFingerprint'] !== 'string') return 'graphFingerprint';
  if (s['pausedCap'] !== undefined && typeof s['pausedCap'] !== 'string') return 'pausedCap';
  if (s['currentStep'] !== undefined && typeof s['currentStep'] !== 'string') return 'currentStep';
  if (s['grantedRound'] !== undefined && typeof s['grantedRound'] !== 'string') return 'grantedRound';
  if (s['mappingsFingerprint'] !== undefined && typeof s['mappingsFingerprint'] !== 'string') return 'mappingsFingerprint';
  const keys = s['mappingKeys'];
  if (keys !== undefined && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) return 'mappingKeys';
  if (s['asking'] !== undefined && !isAsking(s['asking'])) return 'asking';
  const answered = s['answered'];
  if (answered !== undefined && !(isRecord(answered) && Object.values(answered).every(isStringRecord))) return 'answered';
  return undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringRecord = (v: unknown) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isAsking(v: unknown): boolean {
  if (!isRecord(v) || typeof v['stepId'] !== 'string' || !Number.isInteger(v['attempt'])) return false;
  if (v['kind'] === 'questions') return isStrings(v['items']);
  if (v['kind'] !== 'findings' || typeof v['edgeId'] !== 'string') return false;
  if (v['findings'] !== undefined && typeof v['findings'] !== 'string') return false;
  const also = v['also'];
  if (also !== undefined && !(Array.isArray(also) && also.every(isFindingSource))) return false;
  if (v['itemSteps'] !== undefined && !isStrings(v['itemSteps'])) return false;
  return v['items'] === undefined || isStrings(v['items']);
}

function isFindingSource(v: unknown): boolean {
  return isRecord(v) && typeof v['stepId'] === 'string' && Number.isInteger(v['attempt']) && typeof v['findings'] === 'string';
}

/** The owner answered the step's questions (file at `answersRel`): the step re-runs with them as input `answers`. Leaves `status` to the caller. */
export function answerQuestions(state: RunState, answersRel: string): void {
  const asking = state.asking;
  if (asking?.kind !== 'questions') throw new Error('run state is not asking questions');
  state.answered = { ...state.answered, [asking.stepId]: { ...state.answered?.[asking.stepId], answers: answersRel } };
  delete state.asking;
}

/**
 * The owner ticked findings at a stage loop's cap. With `agreed` (the agreed findings file of the deciding step, or one
 * per failing step), one more round runs and the loop start sees only those as each step's `findings`; without it,
 * the run moves past the loop. Leaves `status` to the caller.
 */
export function answerFindings(state: RunState, graph: Graph, agreed: string | Record<string, string> | undefined): void {
  const asking = state.asking;
  if (asking?.kind !== 'findings') throw new Error('run state is not asking about findings');
  const edge = graph.backEdges[asking.edgeId];
  if (!edge) throw new Error(`run state asks about back-edge "${asking.edgeId}", which is not in this graph (config changed since this run started); start a new run`);
  if (agreed !== undefined) {
    state.rounds[edge.id] = Math.max((state.rounds[edge.id] ?? 0) - 1, 0);
    countGrant(state, edge.id);
    state.grantedRound = edge.id;
    const perStep = typeof agreed === 'string' ? { [asking.stepId]: agreed } : agreed;
    const answered = { ...state.answered };
    for (const [stepId, rel] of Object.entries(perStep)) answered[stepId] = { ...answered[stepId], findings: rel };
    state.answered = answered;
  } else {
    state.cursor = edge.jumpAfterIndex + 1;
    if (asking.findings === undefined) delete state.unresolvedFindings;
    else state.unresolvedFindings = asking.findings;
  }
  delete state.asking;
}

/**
 * Grant one more round at the cap the run is paused on: lowers `rounds[pausedCap]` by one (floor 0),
 * clears `pausedCap`, sets `grantedRound` and returns the edge id; undefined when not paused at a cap. Leaves `status` to the caller.
 */
export function grantRound(state: RunState): string | undefined {
  const edgeId = state.pausedCap;
  if (edgeId === undefined) return undefined;
  state.rounds[edgeId] = Math.max((state.rounds[edgeId] ?? 0) - 1, 0);
  countGrant(state, edgeId);
  delete state.pausedCap;
  state.grantedRound = edgeId;
  return edgeId;
}

function countGrant(state: RunState, edgeId: string): void {
  state.granted = { ...state.granted, [edgeId]: (state.granted?.[edgeId] ?? 0) + 1 };
}

const STATE_FILE = 'state.json';

export function newState(init: {
  runId: string;
  ticket?: string;
  profile: string;
  groundVersions: Record<string, string>;
}): RunState {
  return {
    version: 1,
    runId: init.runId,
    ...(init.ticket !== undefined ? { ticket: init.ticket } : {}),
    profile: init.profile,
    groundVersions: init.groundVersions,
    cursor: 0,
    rounds: {},
    executed: {},
    history: [],
    status: 'running',
  };
}

// Atomic (tmp + rename): a crash mid-save never replaces the last good state.json.
export async function saveState(dir: string, s: RunState): Promise<void> {
  await writeFileAtomic(path.join(dir, STATE_FILE), JSON.stringify(s, null, 2));
}

// Reads only state.json; stray *.tmp files from a crashed save are ignored.
export async function loadState(dir: string): Promise<RunState> {
  const file = path.join(dir, STATE_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read run state ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Run state ${file} is not valid JSON`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== 1) {
    throw new Error(`Run state ${file} has unsupported version ${String(version)} (expected 1)`);
  }
  const record = parsed as Record<string, unknown>;
  const field = invalidField(record);
  if (field !== undefined) {
    throw new Error(`Run state ${file} has an invalid "${field}": ${JSON.stringify(record[field]) ?? 'undefined'}`);
  }
  return parsed as RunState;
}
