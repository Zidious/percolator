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
  unresolvedFindings?: string;
  /** a back-edge was triggered but its jump waits for the step at `jumpAfterIndex` */
  pendingJump?: { edgeId: string; findings?: string };
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
  return undefined;
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
