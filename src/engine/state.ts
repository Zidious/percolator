import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs.ts';

export type StepRecord = {
  stepId: string;
  attempt: number;
  startedAt: string;
  endedAt: string;
  status: 'pass' | 'fail' | 'escalate' | 'contract_error';
  outputs: Record<string, string>;
};

export type RunState = {
  version: 1;
  runId: string;
  ticket: string;
  profile: string;
  groundVersions: Record<string, string>;
  cursor: number;
  rounds: Record<string, number>;
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
  if (s['graphFingerprint'] !== undefined && typeof s['graphFingerprint'] !== 'string') return 'graphFingerprint';
  if (s['pausedCap'] !== undefined && typeof s['pausedCap'] !== 'string') return 'pausedCap';
  if (s['currentStep'] !== undefined && typeof s['currentStep'] !== 'string') return 'currentStep';
  if (s['grantedRound'] !== undefined && typeof s['grantedRound'] !== 'string') return 'grantedRound';
  return undefined;
}

/**
 * Grant one more round at the cap the run is paused on: lowers `rounds[pausedCap]` by one (floor 0),
 * clears `pausedCap`, sets `grantedRound` and returns the edge id; undefined when not paused at a cap. Leaves `status` to the caller.
 */
export function grantRound(state: RunState): string | undefined {
  const edgeId = state.pausedCap;
  if (edgeId === undefined) return undefined;
  state.rounds[edgeId] = Math.max((state.rounds[edgeId] ?? 0) - 1, 0);
  delete state.pausedCap;
  state.grantedRound = edgeId;
  return edgeId;
}

const STATE_FILE = 'state.json';

export function newState(init: {
  runId: string;
  ticket: string;
  profile: string;
  groundVersions: Record<string, string>;
}): RunState {
  return {
    version: 1,
    runId: init.runId,
    ticket: init.ticket,
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
