import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../config/load.ts';
import type { GroundSpec } from '../config/schema.ts';
import { expandHome, toPosix } from '../util/paths.ts';
import type { Git } from './git.ts';
import { readLock, writeLock } from './lock.ts';

export type ResolvedGround = {
  name: string;
  dir: string;
  /** 'local' for path grounds */
  commit: string;
  source: GroundSpec;
};

export type ResolveOptions = {
  lockFile: string;
  cacheDir: string;
  git: Git;
  update?: boolean;
  home?: string;
  /** the config file that declares the grounds; problems with path grounds are reported against it */
  configFile?: string;
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveGrounds(
  specs: Record<string, GroundSpec>,
  opts: ResolveOptions,
): Promise<Record<string, ResolvedGround>> {
  const { lockFile, cacheDir, git } = opts;
  const lock = await readLock(lockFile);
  const next = { version: 1 as const, grounds: { ...lock.grounds } };
  const out: Record<string, ResolvedGround> = {};

  for (const [name, spec] of Object.entries(specs)) {
    if ('path' in spec) {
      const dir = expandHome(spec.path, opts.home);
      if (!(await exists(dir))) {
        throw new ConfigError(`ground "${name}": path ${spec.path} does not exist`, opts.configFile ?? 'config');
      }
      out[name] = { name, dir, commit: 'local', source: spec };
      continue;
    }

    const locked = lock.grounds[name];
    const pinned = locked && locked.git === spec.git && locked.ref === spec.ref && !opts.update ? locked : undefined;
    const mirror = path.join(cacheDir, `${name}.mirror`);
    const dirFor = (commit: string) => path.join(cacheDir, `${name}@${commit.slice(0, 12)}`);

    if (pinned) {
      const dir = dirFor(pinned.commit);
      if (!(await exists(dir))) {
        // Use the cached mirror as-is; only go to the network if it lacks the pinned commit.
        const fresh = await openMirror(git, spec.git, mirror);
        try {
          await materialise(git, mirror, dir, pinned.commit);
        } catch (err) {
          if (fresh) throw err;
          await git.fetch(mirror);
          await materialise(git, mirror, dir, pinned.commit);
        }
      }
      out[name] = { name, dir, commit: pinned.commit, source: spec };
      continue;
    }

    if (!(await openMirror(git, spec.git, mirror))) await git.fetch(mirror);
    const commit = await git.resolveRef(mirror, spec.ref);
    const dir = dirFor(commit);
    await materialise(git, mirror, dir, commit);
    next.grounds[name] = { git: spec.git, ref: spec.ref, commit };
    out[name] = { name, dir, commit, source: spec };
  }

  if (JSON.stringify(next.grounds) !== JSON.stringify(lock.grounds)) await writeLock(lockFile, next);
  return out;
}

function sameUrl(a: string | undefined, b: string): boolean {
  return a !== undefined && (a === b || toPosix(a) === toPosix(b));
}

const tmpSibling = (target: string, tag = 'tmp') => `${target}.${tag}-${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * Rename the finished `tmp` dir to `target`. If a concurrent run got there first (the rename fails
 * because `target` now exists), ours is discarded and theirs is used.
 */
async function renameIntoPlace(tmp: string, target: string): Promise<void> {
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') && (await exists(target))) {
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/** Clone `url` as a mirror into a tmp sibling of `mirror`; the caller moves it into place. */
async function cloneMirror(git: Git, url: string, mirror: string): Promise<string> {
  const tmp = tmpSibling(mirror);
  try {
    await git.clone(url, tmp, { mirror: true });
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return tmp;
}

/** Make sure `mirror` is a mirror of `url`. Returns true when it was cloned just now. */
async function openMirror(git: Git, url: string, mirror: string): Promise<boolean> {
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  if (!(await exists(mirror))) {
    await renameIntoPlace(await cloneMirror(git, url, mirror), mirror);
    return true;
  }
  if (sameUrl(await git.remoteUrl(mirror), url)) return false;
  // the ground now points elsewhere: build the new mirror first, then swap it in
  const tmp = await cloneMirror(git, url, mirror);
  const old = tmpSibling(mirror, 'old');
  try {
    await fs.rename(mirror, old);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  try {
    await renameIntoPlace(tmp, mirror);
  } catch (err) {
    await fs.rename(old, mirror).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  await fs.rm(old, { recursive: true, force: true });
  return true;
}

/** Build `dir` at `commit` in a temp sibling and rename it in, so a partial checkout never looks pinned. */
async function materialise(git: Git, mirror: string, dir: string, commit: string): Promise<void> {
  if (await exists(dir)) return;
  const tmp = tmpSibling(dir);
  try {
    await git.clone(mirror, tmp);
    await git.checkout(tmp, commit);
    await renameIntoPlace(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
