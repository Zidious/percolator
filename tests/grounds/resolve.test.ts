import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { readLock, writeLock } from '../../src/grounds/lock.ts';
import { resolveGrounds } from '../../src/grounds/resolve.ts';
import type { GroundSpec } from '../../src/config/schema.ts';
import { ConfigError } from '../../src/config/load.ts';
import { FakeGit } from '../helpers/fake-git.ts';

const OLD = 'abc123def4567890abc123def4567890abc12345';
const NEW = 'fff999eee8887776fff999eee8887776fff99988';
const URL = 'https://example.com/company.git';

let tmp: string;
let lockFile: string;
let cacheDir: string;
let fake: FakeGit;
let specs: Record<string, GroundSpec>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-ground-'));
  lockFile = path.join(tmp, 'percolator.lock');
  cacheDir = path.join(tmp, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  fake = new FakeGit();
  specs = { company: { git: URL, ref: 'main' } };
});

const opts = () => ({ lockFile, cacheDir, git: fake });
const norm = (calls: string[]) => calls.map((c) => c.replace(/\.tmp-[\w-]+/g, '.tmp'));
const lockedOld = () =>
  writeLock(lockFile, { version: 1, grounds: { company: { git: URL, ref: 'main', commit: OLD } } });

describe('lock file', () => {
  test('missing file reads as an empty lock', async () => {
    expect(await readLock(lockFile)).toEqual({ version: 1, grounds: {} });
  });

  test('write then read round-trips', async () => {
    const lock = { version: 1 as const, grounds: { a: { git: URL, ref: 'main', commit: OLD } } };
    await writeLock(lockFile, lock);
    expect(await readLock(lockFile)).toEqual(lock);
  });
});

describe('resolveGrounds', () => {
  test('locked commit with cached dir makes no git calls (offline)', async () => {
    await lockedOld();
    const dir = path.join(cacheDir, 'company@abc123def456');
    await fs.mkdir(dir);
    const r = await resolveGrounds(specs, opts());
    expect(fake.calls).toEqual([]);
    expect(r.company!.commit).toBe(OLD);
    expect(r.company!.dir).toBe(dir);
  });

  test('locked commit without cached dir is materialised from the mirror', async () => {
    await lockedOld();
    const r = await resolveGrounds(specs, opts());
    const mirror = path.join(cacheDir, 'company.mirror');
    const dir = path.join(cacheDir, 'company@abc123def456');
    expect(norm(fake.calls)).toEqual([
      `clone --mirror ${URL} ${mirror}`,
      `clone ${mirror} ${dir}.tmp`,
      `checkout ${dir}.tmp ${OLD}`,
    ]);
    expect(r.company!.dir).toBe(dir);
  });

  test('unlocked ground clones, resolves, materialises and writes the lock', async () => {
    fake.setRef('main', OLD);
    const r = await resolveGrounds(specs, opts());
    expect(r.company!.commit).toBe(OLD);
    expect(r.company!.source).toEqual(specs.company);
    expect((await readLock(lockFile)).grounds.company).toEqual({ git: URL, ref: 'main', commit: OLD });
  });

  test('existing mirror is fetched, not re-cloned', async () => {
    fake.setRef('main', OLD);
    const mirror = path.join(cacheDir, 'company.mirror');
    await fake.seedMirror(mirror, URL);
    await resolveGrounds(specs, opts());
    expect(fake.calls).toContain(`fetch ${mirror}`);
    expect(fake.calls).not.toContain(`clone --mirror ${URL} ${mirror}`);
  });

  test('moved branch keeps locked commit until update', async () => {
    await lockedOld();
    await fs.mkdir(path.join(cacheDir, 'company@abc123def456'));
    fake.setRef('main', NEW);
    expect((await resolveGrounds(specs, opts())).company!.commit).toBe(OLD);
    expect((await readLock(lockFile)).grounds.company!.commit).toBe(OLD);
    expect((await resolveGrounds(specs, { ...opts(), update: true })).company!.commit).toBe(NEW);
    expect((await readLock(lockFile)).grounds.company!.commit).toBe(NEW);
  });

  test('lock entry ignored when ref changed in config', async () => {
    await writeLock(lockFile, { version: 1, grounds: { company: { git: URL, ref: 'v2', commit: OLD } } });
    fake.setRef('v3', NEW);
    const r = await resolveGrounds({ company: { git: URL, ref: 'v3' } }, opts());
    expect(r.company!.commit).toBe(NEW);
    expect((await readLock(lockFile)).grounds.company).toEqual({ git: URL, ref: 'v3', commit: NEW });
  });

  test('lock is not rewritten when unchanged', async () => {
    fake.setRef('main', OLD);
    await resolveGrounds(specs, opts());
    const before = await fs.stat(lockFile);
    await new Promise((r) => setTimeout(r, 30));
    await resolveGrounds(specs, { ...opts(), update: true });
    const after = await fs.stat(lockFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('path ground resolves ~ and is never locked', async () => {
    const home = path.join(tmp, 'home');
    await fs.mkdir(path.join(home, 'x'), { recursive: true });
    const r = await resolveGrounds({ mine: { path: '~/x' } }, { ...opts(), home });
    expect(r.mine!.commit).toBe('local');
    expect(r.mine!.dir).toBe(path.join(home, 'x'));
    expect(fake.calls).toEqual([]);
    await expect(fs.access(lockFile)).rejects.toThrow();
  });

  test('missing path ground errors with name', async () => {
    const home = path.join(tmp, 'home');
    const p = resolveGrounds({ mine: { path: '~/x' } }, { ...opts(), home });
    await expect(p).rejects.toThrow(/ground "mine": path ~\/x does not exist/);
    await expect(p).rejects.toBeInstanceOf(ConfigError);
  });

  test('failed checkout leaves no final dir and no tmp dir behind', async () => {
    fake.setRef('main', OLD);
    fake.checkoutError = new Error('boom');
    await expect(resolveGrounds(specs, opts())).rejects.toThrow(/boom/);
    const entries = await fs.readdir(cacheDir);
    expect(entries).not.toContain('company@abc123def456');
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    expect((await readLock(lockFile)).grounds).toEqual({});
  });

  test('changing the git url re-creates the mirror from the new url', async () => {
    const mirror = path.join(cacheDir, 'company.mirror');
    await fake.seedMirror(mirror, 'https://old.example.com/company.git');
    fake.setRef('main', NEW);
    await resolveGrounds(specs, opts());
    expect(fake.calls).toContain(`clone --mirror ${URL} ${mirror}`);
    expect(fake.calls).not.toContain(`fetch ${mirror}`);
    expect(fake.urls.get(mirror)).toBe(URL);
  });

  test('pinned ground with missing dir uses an existing mirror without fetching', async () => {
    await lockedOld();
    const mirror = path.join(cacheDir, 'company.mirror');
    await fake.seedMirror(mirror, URL);
    const r = await resolveGrounds(specs, opts());
    expect(fake.calls.filter((c) => c.startsWith('fetch'))).toEqual([]);
    expect((await fs.stat(r.company!.dir)).isDirectory()).toBe(true);
  });

  test('pinned ground fetches only when the mirror lacks the commit', async () => {
    await lockedOld();
    const mirror = path.join(cacheDir, 'company.mirror');
    await fake.seedMirror(mirror, URL);
    fake.missing.add(OLD);
    const r = await resolveGrounds(specs, opts());
    const kinds = norm(fake.calls).map((c) => c.split(' ')[0]);
    expect(kinds.filter((k) => k === 'fetch')).toHaveLength(1);
    expect(kinds.lastIndexOf('checkout')).toBeGreaterThan(kinds.indexOf('fetch'));
    expect((await fs.stat(r.company!.dir)).isDirectory()).toBe(true);
    expect((await fs.readdir(cacheDir)).filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});
