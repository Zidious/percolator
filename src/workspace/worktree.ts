import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from '../grounds/git.ts';
import { samePath } from '../util/paths.ts';

/** In-repo folder for run worktrees: covered by the repo's agent trust (Claude Code trusts everything below it). */
export const WORKTREES_DIR = '.worktrees';

export function defaultWorktreeDir(repoRoot: string, runId: string): string {
  return path.join(repoRoot, WORKTREES_DIR, runId);
}

/** Lists `/.worktrees/` in the repo's `info/exclude` (once), so worktrees inside it never show as untracked. */
export async function excludeWorktreesDir(repoRoot: string): Promise<void> {
  const common = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  const file = path.join(common.trim(), 'info', 'exclude');
  const line = `/${WORKTREES_DIR}/`;
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text.split(/\r?\n/).includes(line)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, `${text}${sep}${line}\n`);
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

/**
 * Whether the worktree has uncommitted changes or untracked files; undefined when `dir` does not exist.
 * Throws when `dir` is not the top of a work tree: git would walk up and answer for the enclosing repo.
 */
export async function worktreeDirty(dir: string): Promise<boolean | undefined> {
  if (!(await exists(dir))) return undefined;
  let top: string;
  try {
    top = await runGit(['rev-parse', '--show-toplevel'], dir);
  } catch {
    top = '';
  }
  if (top === '' || !(samePath(top, dir) || samePath(await real(top), await real(dir)))) {
    throw new Error(`${dir} is not a git worktree; check it by hand`);
  }
  return (await runGit(['status', '--porcelain'], dir)) !== '';
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
