import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs.ts';

/**
 * One recorded firing. `pipeline`, `ticket` and `inputs` are what the run is started with, so a restarted
 * watcher can start a firing it recorded but never prepared without polling for it again; `prepared` is set
 * once `prepareRun` made the run dir, so a dir gone after that means `perc delete` and the firing is done.
 * A `runId` of '' marks a key seen on a trigger's first poll and never started (no backfill).
 */
export type Fired = {
  runId: string;
  at: string;
  pipeline?: string;
  ticket?: string;
  inputs?: Record<string, string>;
  prepared?: true;
};

/** `<home>/watch/fired.json`: which trigger keys have fired (and as which run), and poll marks. */
export type Ledger = {
  version: 1;
  fired: Record<string, Fired>;
  lastPoll: Record<string, string>;
};

/** What `fire` records and starts. */
export type FiringRecord = { key: string; pipeline: string; ticket?: string; inputs: Record<string, string> };

/** How far back a schedule looks for a missed tick (`latestTick`); older schedule firings can never recur. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function ledgerFile(home: string): string {
  return path.join(home, 'watch', 'fired.json');
}

export async function loadLedger(home: string): Promise<Ledger> {
  let text: string;
  try {
    text = await fs.readFile(ledgerFile(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, fired: {}, lastPoll: {} };
    throw err;
  }
  const raw = JSON.parse(text) as Partial<Ledger>;
  return { version: 1, fired: raw.fired ?? {}, lastPoll: raw.lastPoll ?? {} };
}

export async function saveLedger(home: string, l: Ledger): Promise<void> {
  const file = ledgerFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(l, null, 2)}\n`);
}

/** Records (on disk) that the run of `key` was prepared. */
export async function markPrepared(home: string, ledger: Ledger, key: string): Promise<void> {
  const f = ledger.fired[key];
  if (f === undefined || f.prepared) return;
  f.prepared = true;
  await saveLedger(home, ledger);
}

/** Drops schedule firings older than the schedule lookback: their tick can never come back. */
export function pruneLedger(ledger: Ledger, now: Date): void {
  for (const [key, f] of Object.entries(ledger.fired)) {
    if (key.startsWith('schedule:') && now.getTime() - Date.parse(f.at) > LOOKBACK_MS) delete ledger.fired[key];
  }
}

/**
 * Fire `f.key` once: record it (saved to disk) before `start` runs, so a crash or restart never
 * starts the same firing twice. A failed start keeps the entry and reports the error.
 */
export async function fire(
  home: string,
  ledger: Ledger,
  f: FiringRecord,
  start: (runId: string) => Promise<void>,
  newId: () => string,
  now: () => Date = () => new Date(),
): Promise<{ skipped: true } | { runId: string; error?: string }> {
  if (Object.hasOwn(ledger.fired, f.key)) return { skipped: true };
  const runId = newId();
  ledger.fired[f.key] = {
    runId,
    at: now().toISOString(),
    pipeline: f.pipeline,
    ...(f.ticket !== undefined ? { ticket: f.ticket } : {}),
    inputs: { ...f.inputs },
  };
  await saveLedger(home, ledger);
  try {
    await start(runId);
    return { runId };
  } catch (err) {
    return { runId, error: err instanceof Error ? err.message : String(err) };
  }
}
