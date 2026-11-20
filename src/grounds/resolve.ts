import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../config/load.ts';
import type { GroundSpec } from '../config/schema.ts';
import { expandHome } from '../util/paths.ts';
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
    const materialise = async (commit: string): Promise<string> => {
      const dir = path.join(cacheDir, `${name}@${commit.slice(0, 12)}`);
      if (!(await exists(dir))) {
        await git.clone(mirror, dir);
        await git.checkout(dir, commit);
      }
      return dir;
    };

    if (pinned) {
      const dir = path.join(cacheDir, `${name}@${pinned.commit.slice(0, 12)}`);
      if (!(await exists(dir))) {
        await ensureMirror(git, spec.git, mirror);
        await materialise(pinned.commit);
      }
      out[name] = { name, dir, commit: pinned.commit, source: spec };
      continue;
    }

    await ensureMirror(git, spec.git, mirror);
    const commit = await git.resolveRef(mirror, spec.ref);
    const dir = await materialise(commit);
    next.grounds[name] = { git: spec.git, ref: spec.ref, commit };
    out[name] = { name, dir, commit, source: spec };
  }

  if (JSON.stringify(next.grounds) !== JSON.stringify(lock.grounds)) await writeLock(lockFile, next);
  return out;
}

async function ensureMirror(git: Git, url: string, mirror: string): Promise<void> {
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  if (await exists(mirror)) await git.fetch(mirror);
  else await git.clone(url, mirror, { mirror: true });
}
