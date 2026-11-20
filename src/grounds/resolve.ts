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
        throw new ConfigError(`ground "${name}": path ${spec.path} does not exist`, lockFile);
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

/** Make sure `mirror` is a mirror of `url`. Returns true when it was cloned just now. */
async function openMirror(git: Git, url: string, mirror: string): Promise<boolean> {
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  if (await exists(mirror)) {
    if (sameUrl(await git.remoteUrl(mirror), url)) return false;
    await fs.rm(mirror, { recursive: true, force: true }); // ground now points elsewhere
  }
  await git.clone(url, mirror, { mirror: true });
  return true;
}

/** Build `dir` at `commit` in a temp sibling and rename it in, so a partial checkout never looks pinned. */
async function materialise(git: Git, mirror: string, dir: string, commit: string): Promise<void> {
  if (await exists(dir)) return;
  const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await git.clone(mirror, tmp);
    await git.checkout(tmp, commit);
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
