import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs.ts';

/** `<home>/watch/fired.json`: which trigger keys have fired (and as which run), and poll marks. */
export type Ledger = {
  version: 1;
  fired: Record<string, { runId: string; at: string }>;
  lastPoll: Record<string, string>;
};

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

/**
 * Fire `key` once: record it (saved to disk) before `start` runs, so a crash or restart never
 * starts the same firing twice. A failed start keeps the entry and reports the error.
 */
export async function fire(
  home: string,
  ledger: Ledger,
  key: string,
  start: (runId: string) => Promise<void>,
  newId: () => string,
  now: () => Date = () => new Date(),
): Promise<{ skipped: true } | { runId: string; error?: string }> {
  if (Object.hasOwn(ledger.fired, key)) return { skipped: true };
  const runId = newId();
  ledger.fired[key] = { runId, at: now().toISOString() };
  await saveLedger(home, ledger);
  try {
    await start(runId);
    return { runId };
  } catch (err) {
    return { runId, error: err instanceof Error ? err.message : String(err) };
  }
}
