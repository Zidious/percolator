import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../../engine/runtime.ts';

/** Text of output `key` from the last step in graph order that wrote it; undefined when none did or its file is gone. */
export async function latestOutput(ctx: RunContext, runDir: string, key: string): Promise<string | undefined> {
  const last = ctx.graph.steps.findLast((s) => ctx.previousOutputs[s.id]?.[key]);
  const rel = last ? ctx.previousOutputs[last.id]?.[key] : undefined;
  if (!rel) return undefined;
  try {
    return await fs.readFile(path.join(runDir, rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
