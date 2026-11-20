import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultWorktreeDir, ensureWorktree } from '../../src/workspace/worktree.ts';

const run = promisify(execFile);
const G = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'advice.detachedHead=false'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', [...G, ...args], { cwd })).stdout.trim();
}

async function setup(): Promise<{ root: string; repo: string; cleanup: () => Promise<void> }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-wt-')));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '--quiet', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), 'a');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '--quiet', '-m', 'init');
  return { root, repo, cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test('defaultWorktreeDir nests under ~/.percolator/worktrees', () => {
  assert.equal(
    defaultWorktreeDir('/h', 'repo', 'r1'),
    path.join('/h', '.percolator', 'worktrees', 'repo', 'r1'),
  );
});

test('creates a worktree on a new branch from base', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    const r = await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    assert.deepEqual(r, { created: true });
    assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'perc/t1');
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'main'));
  } finally {
    await cleanup();
  }
});

test('is idempotent on resume', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    assert.deepEqual(await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' }), {
      created: false,
    });
  } finally {
    await cleanup();
  }
});

test('reuses an existing branch', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    await fs.writeFile(path.join(dir, 'b.txt'), 'b');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '--quiet', '-m', 'work');
    const head = await git(dir, 'rev-parse', 'HEAD');
    await git(repo, 'worktree', 'remove', '--', dir);
    const r = await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    assert.deepEqual(r, { created: true });
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    await cleanup();
  }
});

test('refuses a dir that is a different worktree or a plain folder', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/other', base: 'main' });
    await assert.rejects(
      ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' }),
      (e: Error) => e.message === `worktree ${dir} is on perc/other, expected perc/t1`,
    );
    const plain = path.join(root, 'plain');
    await fs.mkdir(plain);
    await assert.rejects(
      ensureWorktree({ repoRoot: repo, dir: plain, branch: 'perc/t2', base: 'main' }),
      (e: Error) => e.message === `${plain} exists and is not a worktree of ${repo}`,
    );
  } finally {
    await cleanup();
  }
});

test('rejects option-like or invalid branch names', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    for (const b of ['-x', 'a..b']) {
      await assert.rejects(
        ensureWorktree({ repoRoot: repo, dir, branch: b, base: 'main' }),
        (e: Error) => e.message === `invalid branch name "${b}"`,
      );
    }
    await assert.rejects(ensureWorktree({ repoRoot: repo, dir, branch: 'ok', base: '-x' }));
  } finally {
    await cleanup();
  }
});

test('works with a path containing spaces', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'with space', 'r 1');
    assert.deepEqual(await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' }), {
      created: true,
    });
    assert.deepEqual(await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' }), {
      created: false,
    });
  } finally {
    await cleanup();
  }
});

test('is idempotent when dir is reached through a symlinked parent', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const real = path.join(root, 'wt');
    const dir = path.join(real, 'r1');
    await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    const link = path.join(root, 'link');
    await fs.symlink(real, link, 'junction');
    assert.deepEqual(
      await ensureWorktree({ repoRoot: repo, dir: path.join(link, 'r1'), branch: 'perc/t1', base: 'main' }),
      { created: false },
    );
  } finally {
    await cleanup();
  }
});

test('re-creates a worktree whose dir was deleted by hand, on its branch', async () => {
  const { root, repo, cleanup } = await setup();
  try {
    const dir = path.join(root, 'wt', 'r1');
    await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    assert.deepEqual(await ensureWorktree({ repoRoot: repo, dir, branch: 'perc/t1', base: 'main' }), { created: true });
    assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'perc/t1');
  } finally {
    await cleanup();
  }
});
