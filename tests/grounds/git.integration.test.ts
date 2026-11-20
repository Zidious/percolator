import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { cliGit, redactUrls } from '../../src/grounds/git.ts';
import { readLock } from '../../src/grounds/lock.ts';
import { resolveGrounds } from '../../src/grounds/resolve.ts';
import { samePath } from '../../src/util/paths.ts';

const tmps: string[] = [];
const mktmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-git-'));
  tmps.push(d);
  return d;
};
after(async () => {
  await Promise.all(tmps.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
    })
  ).stdout.trim();

test('cliGit clones a real bare repo, pins it, and moves only on update', async () => {
  const tmp = await mktmp();
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
  assert.equal(r.company!.commit, first);
  assert.equal((await fs.readFile(path.join(r.company!.dir, 'policy.md'), 'utf8')).trim(), 'one');
  assert.equal((await readLock(lockFile)).grounds.company!.commit, first);

  // upstream moves
  await fs.writeFile(path.join(work, 'policy.md'), 'two\n');
  await git(work, 'commit', '-am', 'second');
  const second = await git(work, 'rev-parse', 'HEAD');
  const branch = await git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
  await git(work, 'push', bare, `HEAD:refs/heads/${branch}`);

  assert.equal((await resolveGrounds(specs, opts)).company!.commit, first);
  const u = await resolveGrounds(specs, { ...opts, update: true });
  assert.equal(u.company!.commit, second);
  assert.equal((await fs.readFile(path.join(u.company!.dir, 'policy.md'), 'utf8')).trim(), 'two');
});

test('a url that looks like an option is treated as a repository, not a flag', async () => {
  const tmp = await mktmp();
  await assert.rejects(cliGit.clone('--upload-pack=echo', path.join(tmp, 'x')), /does not exist/);
});

test('refs and commits starting with a dash are rejected before reaching git', async () => {
  const tmp = await mktmp();
  await assert.rejects(cliGit.checkout(tmp, '--orphan=x'), /must not start with "-"/);
  await assert.rejects(cliGit.resolveRef(tmp, '-x'), /must not start with "-"/);
});

test('remoteUrl is undefined without an origin or outside a repo, and the url otherwise', async () => {
  const tmp = await mktmp();
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  assert.equal(await cliGit.remoteUrl(tmp), undefined);
  await git(repo, 'init');
  assert.equal(await cliGit.remoteUrl(repo), undefined);
  await git(repo, 'remote', 'add', 'origin', 'https://example.com/x.git');
  assert.equal(await cliGit.remoteUrl(repo), 'https://example.com/x.git');
});

test('toplevel is the repo root from a subdirectory, and undefined outside a repo', async () => {
  const tmp = await mktmp();
  const repo = path.join(tmp, 'repo');
  const sub = path.join(repo, 'a', 'b');
  await fs.mkdir(sub, { recursive: true });
  assert.equal(await cliGit.toplevel(tmp), undefined);
  await git(repo, 'init');
  const top = await cliGit.toplevel(sub);
  assert.ok(top !== undefined);
  assert.equal(path.isAbsolute(top), true);
  assert.ok(samePath(await fs.realpath(top), await fs.realpath(repo)), `${top} is not ${repo}`);
});

test('credentials in a url never appear in git error messages', async () => {
  const tmp = await mktmp();
  const err = await cliGit.clone('https://user:s3cr3t-token@127.0.0.1:9/x.git', path.join(tmp, 'x')).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /s3cr3t-token|user:/);
  assert.match(err.message, /https:\/\/\*\*\*@127\.0\.0\.1:9\/x\.git/);
});

test('redactUrls hides userinfo in every url of a message', () => {
  assert.equal(
    redactUrls('fatal: https://u:tok@host/a.git and ssh://git@h2/b, not mail a@b.c or https://host/x'),
    'fatal: https://***@host/a.git and ssh://***@h2/b, not mail a@b.c or https://host/x',
  );
});
