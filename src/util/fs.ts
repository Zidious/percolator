import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Document, LineCounter, parseDocument } from 'yaml';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKOFF_MS = [10, 20, 40, 80, 160];

type Rename = (from: string, to: string) => Promise<void>;

/**
 * Rename, retrying transient Windows failures (EPERM/EBUSY/EACCES while a scanner or reader holds
 * the target) up to 6 times. `rename` is a test hook.
 */
export async function renameRetry(from: string, to: string, rename: Rename = fs.rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= BACKOFF_MS.length || code === undefined || !RETRY_CODES.has(code)) throw err;
      await setTimeout(BACKOFF_MS[attempt]);
    }
  }
}

/** True when something (even a dangling link) exists at `p`. */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to a tmp sibling (fsynced), then rename it over `file`. On Windows a rename can fail
 * transiently (EPERM/EBUSY/EACCES while a scanner or reader holds the target), so it is retried up
 * to 6 times (see renameRetry). `opts.rename` is a test hook.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  opts?: { rename?: Rename },
): Promise<void> {
  const rename = opts?.rename ?? fs.rename;
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameRetry(tmp, file, rename);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readYamlFile(
  file: string,
): Promise<{ doc: Document; lineCounter: LineCounter; text: string }> {
  const text = await fs.readFile(file, 'utf8');
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  return { doc, lineCounter, text };
}

/** Names of tmp/old siblings that atomic writes and dir builds leave behind when a run crashes. */
const LEFTOVER = /\.(?:tmp|old)-(?:\d+-)?[0-9a-f]{8}$|\.\d+\.[0-9a-f]{8}\.tmp$/;

/**
 * Remove crash leftovers (see LEFTOVER) in `dir` whose mtime is older than `olderThanMs` (default
 * 1 hour; the floor protects a concurrent run's work in progress). With `recursive`, descends into
 * non-matching directories; symlinks are never followed. Returns the removed paths, sorted.
 */
export async function sweepLeftovers(
  dir: string,
  o: { olderThanMs?: number; now?: number; recursive?: boolean } = {},
): Promise<string[]> {
  const cutoff = (o.now ?? Date.now()) - (o.olderThanMs ?? 3_600_000);
  const removed: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try {
        st = await fs.lstat(p);
      } catch {
        continue;
      }
      if (LEFTOVER.test(name)) {
        if (st.mtimeMs < cutoff) {
          await fs.rm(p, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
          removed.push(p);
        }
      } else if (o.recursive && st.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(dir);
  return removed.sort();
}
