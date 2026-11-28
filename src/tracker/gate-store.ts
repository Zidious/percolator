import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../util/fs.ts';
import { commentIdOf } from './gh.ts';

export type Decision = {
  decision: 'approve' | 'reject';
  feedback?: string;
  /** a pick-pipeline gate's answer: `perc approve <run-id> --pipeline <name>` */
  pipeline?: string;
  by: string;
  via: 'comment' | 'local';
  url?: string;
};
/** `commentUrl` is absent when the run has no issue: the gate then waits only for `perc approve`/`perc reject`. */
export type Waiting = { stepId: string; stepDir: string; since: string; commentUrl?: string };

export const DecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    feedback: z.string().optional(),
    pipeline: z.string().optional(),
    by: z.string(),
    via: z.enum(['comment', 'local']),
    url: z.string().optional(),
  })
  .passthrough();

const WaitingSchema = z.object({
  stepId: z.string(),
  stepDir: z.string(),
  since: z.string(),
  commentUrl: z.string().optional(),
});

export const waitingFile = (runDir: string) => path.join(runDir, 'waiting.json');

export async function readJson(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

export async function readWaiting(runDir: string): Promise<Waiting | undefined> {
  const file = waitingFile(runDir);
  const invalid = (why: string) => new Error(`Waiting file ${file} is invalid: ${why}; delete it and resume the run`);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw invalid(err.message);
    throw err;
  }
  if (raw === undefined) return undefined;
  const r = WaitingSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw invalid(`${i.path.join('.') || 'value'}: ${i.message}`);
  }
  return r.data;
}

export async function writeDecision(
  runDir: string,
  d: { decision: 'approve' | 'reject'; feedback?: string; pipeline?: string; by: string },
): Promise<Waiting> {
  const waiting = await readWaiting(runDir);
  if (!waiting) throw new Error('run is not waiting at a gate');
  const full: Decision = { ...d, via: 'local' };
  await writeFileAtomic(path.join(waiting.stepDir, 'decision.json'), `${JSON.stringify(full, null, 2)}\n`);
  return waiting;
}

/** `<stepDir>/gate.json`: where this round's comment is and when its text went up. */
export type SavedGate = { commentUrl: string; commentId: number; round?: number; postedAt: string };

export const gateJson = (g: SavedGate) => `${JSON.stringify(g, null, 2)}\n`;

export async function readGate(file: string): Promise<SavedGate | undefined> {
  let raw: Partial<SavedGate> | undefined;
  try {
    raw = (await readJson(file)) as Partial<SavedGate> | undefined;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`Gate file ${file} is invalid: ${err.message}; delete it and resume the run`);
    throw err;
  }
  if (!raw) return undefined;
  // a gate.json from before the upgrade has only commentUrl and postedAt
  return { ...raw, commentId: raw.commentId ?? commentIdOf(raw.commentUrl ?? '') } as SavedGate;
}

/** This round's gate.json in an earlier attempt dir of the step, newest attempt first. */
export async function earlierGate(stepDir: string, round: number): Promise<SavedGate | undefined> {
  const parent = path.dirname(stepDir);
  const self = path.basename(stepDir);
  const attempts = (await fs.readdir(parent, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name !== self)
    .map((d) => d.name)
    .sort((a, b) => Number(b) - Number(a));
  for (const a of attempts) {
    const g = await readGate(path.join(parent, a, 'gate.json'));
    if (g?.round === round) return g;
  }
  return undefined;
}
