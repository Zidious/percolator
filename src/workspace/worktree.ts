import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from '../grounds/git.ts';
import { samePath } from '../util/paths.ts';

export function defaultWorktreeDir(home: string, repoName: string, runId: string): string {
  return path.join(home, '.percolator', 'worktrees', repoName, runId);
}

interface Listed {
  dir: string;
  branch: string | undefined;
}

function parseWorktrees(porcelain: string): Listed[] {
  const out: Listed[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    let dir: string | undefined;
    let branch: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length);
    }
    if (dir !== undefined) out.push({ dir, branch });
  }
  return out;
}

// samePath does not follow symlinks or 8.3 short names, but git lists real paths.
async function real(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return p;
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function findListed(repoRoot: string, dir: string): Promise<Listed | undefined> {
  const listed = parseWorktrees(await runGit(['worktree', 'list', '--porcelain'], repoRoot));
  const realDir = await real(dir);
  for (const w of listed) {
    if (samePath(w.dir, dir) || samePath(await real(w.dir), realDir)) return w;
  }
  return undefined;
}

/** Removes a listed worktree; false when `dir` is not one. A dirty worktree needs `force`. */
export async function removeWorktree(o: { repoRoot: string; dir: string; force: boolean }): Promise<boolean> {
  const { repoRoot, dir, force } = o;
  if (!(await findListed(repoRoot, dir))) return false;
  try {
    await runGit(['worktree', 'remove', ...(force ? ['--force'] : []), '--', dir], repoRoot);
  } catch (err) {
    if (/contains modified or untracked files/.test((err as Error).message)) {
      throw new Error(`worktree ${dir} has uncommitted changes; commit them or use --force`);
    }
    throw err;
  }
  return true;
}

// Idempotent, so resume can call it again. git builds and cleans up the worktree itself and
// renaming one breaks its metadata, so this is the one exception to the atomic-dir rule.
export async function ensureWorktree(o: {
  repoRoot: string;
  dir: string;
  branch: string;
  base: string;
}): Promise<{ created: boolean }> {
  const { repoRoot, dir, branch, base } = o;
  if (branch.startsWith('-') || base.startsWith('-')) {
    throw new Error(`invalid branch name "${branch.startsWith('-') ? branch : base}"`);
  }
  try {
    await runGit(['check-ref-format', '--branch', branch], repoRoot);
  } catch {
    throw new Error(`invalid branch name "${branch}"`);
  }

  let here = await findListed(repoRoot, dir);
  if (here && !(await exists(dir))) {
    // deleted by hand: git still lists it (prunable); drop the stale entry and add it again
    await runGit(['worktree', 'prune'], repoRoot);
    here = undefined;
  }
  if (here) {
    if (here.branch === `refs/heads/${branch}`) return { created: false };
    const other = here.branch?.replace(/^refs\/heads\//, '') ?? '(detached)';
    throw new Error(`worktree ${dir} is on ${other}, expected ${branch}`);
  }
  if (await exists(dir)) throw new Error(`${dir} exists and is not a worktree of ${repoRoot}`);

  await fs.mkdir(path.dirname(dir), { recursive: true });
  let branchExists = true;
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
  } catch {
    branchExists = false;
  }
  if (branchExists) await runGit(['worktree', 'add', '--', dir, branch], repoRoot);
  else await runGit(['worktree', 'add', '-b', branch, '--', dir, base], repoRoot);
  return { created: true };
}
