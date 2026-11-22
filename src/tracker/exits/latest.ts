import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome, RunContext } from '../../engine/runtime.ts';

export const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

/** Text of the latest step's output `key` (graph order), or undefined when no step wrote it or its file is gone. */
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
