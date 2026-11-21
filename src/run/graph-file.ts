import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { effectiveKind } from '../config/schema.ts';
import type { Stage } from '../config/schema.ts';
import type { Graph } from '../graph/build.ts';
import { writeFileAtomic } from '../util/fs.ts';

export type RunGraphStep = {
  id: string;
  stage: Stage | 'before-all' | 'after-all';
  role: 'core' | 'node';
  kind: 'agent' | 'builtin' | 'script' | 'gate';
};
export type RunGraphLoop = { id: string; from: string; to: string; max: number; atCap: 'continue' | 'escalate' };
export type RunGraph = { version: 1; steps: RunGraphStep[]; loops: RunGraphLoop[] };

const RunGraphSchema = z.strictObject({
  version: z.literal(1),
  steps: z.array(
    z.strictObject({
      id: z.string(),
      stage: z.string(),
      role: z.enum(['core', 'node']),
      kind: z.enum(['agent', 'builtin', 'script', 'gate']),
    }),
  ),
  loops: z.array(
    z.strictObject({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      max: z.number(),
      atCap: z.enum(['continue', 'escalate']),
    }),
  ),
});

export function toRunGraph(g: Graph): RunGraph {
  return {
    version: 1,
    steps: g.steps.map((s) => ({
      id: s.id,
      stage: s.stage,
      role: s.role === 'slot' ? 'core' : 'node',
      kind: effectiveKind(s.def),
    })),
    loops: Object.values(g.backEdges).map((e) => ({
      id: e.id,
      from: e.fromStepId,
      to: g.steps[e.toStepIndex]!.id,
      max: e.maxRounds,
      atCap: e.onCap,
    })),
  };
}

export async function writeRunGraph(dir: string, g: Graph): Promise<void> {
  await writeFileAtomic(path.join(dir, 'graph.json'), `${JSON.stringify(toRunGraph(g), null, 2)}\n`);
}

export async function readRunGraph(dir: string): Promise<RunGraph | undefined> {
  const file = path.join(dir, 'graph.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const invalid = (why: string) => new Error(`Run graph ${file} is invalid: ${why}; start a new run`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalid((err as Error).message);
  }
  const r = RunGraphSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw invalid(`${i.path.join('.') || 'value'}: ${i.message}`);
  }
  return r.data as RunGraph;
}
