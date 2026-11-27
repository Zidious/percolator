import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunState } from '../engine/state.ts';

/**
 * The trimmed text of the latest history record's `key` output; undefined when no record has it, or its file
 * is gone or blank (a removed output file only means nothing to show).
 */
export async function readLatest(dir: string, state: RunState, key: string): Promise<string | undefined> {
  const rel = state.history.findLast((h) => h.outputs[key] !== undefined)?.outputs[key];
  if (rel === undefined) return undefined;
  return (await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '')).trim() || undefined;
}

/** The PR url the deliver step recorded, if any. */
export function prUrl(dir: string, state: RunState): Promise<string | undefined> {
  return readLatest(dir, state, 'pr_url');
}
