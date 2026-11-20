import fs from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { writeFileAtomic } from '../util/fs.ts';

export type Lock = {
  version: 1;
  grounds: Record<string, { git: string; ref: string; commit: string }>;
};

export async function readLock(file: string): Promise<Lock> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, grounds: {} };
    throw err;
  }
  const data = parse(text) as Partial<Lock> | null;
  return { version: 1, grounds: data?.grounds ?? {} };
}

export async function writeLock(file: string, lock: Lock): Promise<void> {
  await writeFileAtomic(file, stringify(lock));
}
