import { z } from 'zod';
import { stringify } from 'yaml';
import { loadYaml } from '../config/load.ts';
import { groundRecord } from '../config/schema.ts';
import { writeFileAtomic } from '../util/fs.ts';

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const LockSchema = z.strictObject({
  version: z.literal(1),
  grounds: groundRecord(
    z.strictObject({
      git: z.string(),
      ref: z.string(),
      commit: z.string().regex(COMMIT, 'commit must be a full 40- or 64-character lower-case hex sha'),
    }),
  ),
});
export type Lock = z.infer<typeof LockSchema>;

/** A missing lock reads as empty; anything else must match LockSchema (located ConfigError otherwise). */
export async function readLock(file: string): Promise<Lock> {
  try {
    return await loadYaml(file, LockSchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, grounds: {} };
    throw err;
  }
}

export async function writeLock(file: string, lock: Lock): Promise<void> {
  await writeFileAtomic(file, stringify(lock));
}
