import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { cliGit } from '../../src/grounds/git.ts';
import { readLock } from '../../src/grounds/lock.ts';
import { resolveGrounds } from '../../src/grounds/resolve.ts';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
    })
  ).stdout.trim();

test('cliGit clones a real bare repo, pins it, and moves only on update', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-git-'));
  const work = path.join(tmp, 'work');
  const bare = path.join(tmp, 'origin.git');
  await fs.mkdir(work);
  await git(work, 'init');
  await fs.writeFile(path.join(work, 'policy.md'), 'one\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-m', 'first');
  const first = await git(work, 'rev-parse', 'HEAD');
  await git(tmp, 'clone', '--bare', work, bare);

  const lockFile = path.join(tmp, 'percolator.lock');
  const cacheDir = path.join(tmp, 'cache');
  const specs = { company: { git: bare, ref: 'HEAD' } };
  const opts = { lockFile, cacheDir, git: cliGit };

  const r = await resolveGrounds(specs, opts);
  expect(r.company!.commit).toBe(first);
  expect((await fs.readFile(path.join(r.company!.dir, 'policy.md'), 'utf8')).trim()).toBe('one');
  expect((await readLock(lockFile)).grounds.company!.commit).toBe(first);

  // upstream moves
  await fs.writeFile(path.join(work, 'policy.md'), 'two\n');
  await git(work, 'commit', '-am', 'second');
  const second = await git(work, 'rev-parse', 'HEAD');
  const branch = await git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
  await git(work, 'push', bare, `HEAD:refs/heads/${branch}`);

  expect((await resolveGrounds(specs, opts)).company!.commit).toBe(first);
  const u = await resolveGrounds(specs, { ...opts, update: true });
  expect(u.company!.commit).toBe(second);
  expect((await fs.readFile(path.join(u.company!.dir, 'policy.md'), 'utf8')).trim()).toBe('two');
});

test('a url that looks like an option is treated as a repository, not a flag', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-git-'));
  await expect(cliGit.clone('--upload-pack=echo', path.join(tmp, 'x'))).rejects.toThrow(/does not exist/);
});

test('refs and commits starting with a dash are rejected before reaching git', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-git-'));
  await expect(cliGit.checkout(tmp, '--orphan=x')).rejects.toThrow(/must not start with "-"/);
  await expect(cliGit.resolveRef(tmp, '-x')).rejects.toThrow(/must not start with "-"/);
});

test('remoteUrl is undefined without an origin or outside a repo, and the url otherwise', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-git-'));
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  expect(await cliGit.remoteUrl(tmp)).toBeUndefined();
  await git(repo, 'init');
  expect(await cliGit.remoteUrl(repo)).toBeUndefined();
  await git(repo, 'remote', 'add', 'origin', 'https://example.com/x.git');
  expect(await cliGit.remoteUrl(repo)).toBe('https://example.com/x.git');
});
