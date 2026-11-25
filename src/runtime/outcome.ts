import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const DoneSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'escalate']),
    reason: z.string().optional(),
    questions: z
      .array(z.string().refine((s) => s.trim() !== '', 'must be a non-empty string'), {
        error: 'must be an array of non-empty strings',
      })
      .min(1, 'must list at least one question')
      .optional(),
  })
  .superRefine((d, ctx) => {
    if (d.questions !== undefined && d.status !== 'escalate') {
      ctx.addIssue({ code: 'custom', path: ['questions'], message: 'only allowed with status "escalate"' });
    }
  });

export type DoneResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; status: 'pass' | 'fail' | 'escalate'; reason?: string; questions?: string[] };

/** Read the agent's done file: absent, invalid (with why), or the validated status. */
export async function readDone(file: string): Promise<DoneResult> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', error: (err as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { kind: 'invalid', error: `not valid JSON: ${(err as Error).message}` };
  }
  const parsed = DoneSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { kind: 'invalid', error: issues };
  }
  const { status, reason, questions } = parsed.data;
  return {
    kind: 'ok',
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(questions === undefined ? {} : { questions }),
  };
}

/** Key every non-empty regular file in `outputsDir` by its name without the last extension. */
export async function collectOutputs(
  outputsDir: string,
  runDir: string,
): Promise<{ outputs: Record<string, string> } | { error: string }> {
  let names: string[];
  try {
    names = (await fs.readdir(outputsDir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { outputs: {} };
    throw err;
  }
  const outputs: Record<string, string> = {};
  const fileOf: Record<string, string> = {};
  for (const name of names) {
    const full = path.join(outputsDir, name);
    const st = await fs.lstat(full);
    if (!st.isFile() || st.size === 0) continue;
    const key = path.parse(name).name;
    if (Object.hasOwn(fileOf, key)) {
      return { error: `outputs/${fileOf[key]} and outputs/${name} both produce "${key}"` };
    }
    fileOf[key] = name;
    outputs[key] = path.relative(runDir, full).split(path.sep).join('/');
  }
  return { outputs };
}
