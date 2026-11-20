import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Copy the content at `src` (a file or a tree) to `tmp`. Symlinks are replaced by their target's
 * content, but only when the target's realpath is inside `rootReal`. `chain` holds the realpaths of
 * the directories being copied, so a link back to an ancestor cannot recurse forever.
 */
async function copyEntry(src: string, tmp: string, rootReal: string, rel: string, chain: string[]): Promise<void> {
  const real = await fs.realpath(src);
  if (!isInside(rootReal, real)) throw new Error(`${rel === '' ? path.basename(src) : rel} links outside the ground`);
  const st = await fs.stat(real);
  if (st.isDirectory()) {
    if (chain.includes(real)) throw new Error(`${rel} links to a parent directory`);
    await fs.mkdir(tmp);
    for (const name of await fs.readdir(src)) {
      await copyEntry(path.join(src, name), path.join(tmp, name), rootReal, rel === '' ? name : `${rel}/${name}`, [
        ...chain,
        real,
      ]);
    }
  } else if (st.isFile()) {
    await fs.copyFile(real, tmp);
  }
}

/** Rename with the retries Windows needs when a scanner briefly holds a file. */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/**
 * Copy a file or directory tree to `dest` atomically (tmp sibling, then rename). Every symlink must
 * resolve inside `root`; its content is copied, never the link itself.
 */
export async function copyContained(src: string, dest: string, root: string): Promise<void> {
  if (await exists(dest)) throw new Error(`${dest} already exists`);
  const rootReal = await fs.realpath(root);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await copyEntry(src, tmp, rootReal, '', []);
    if (await exists(dest)) throw new Error(`${dest} already exists`);
    await renameRetry(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
}
