import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { terminalName } from '../../src/runtime/herdr-runtime.ts';
import { driverName, detectBase, listRuns, newRunId, readRunMeta, writeRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { makeRepo, git } from '../helpers/git-repo.ts';

const meta = (runId: string, createdAt: string): RunMeta => ({
  version: 1,
  runId,
  ticket: 'o/r#7',
  repo: 'github.com/o/r',
  issue: 7,
  repoRoot: '/r',
  configFile: '/c.yaml',
  profile: 'work',
  worktree: '/w',
  branch: `percolator/${runId}`,
  base: 'origin/main',
  keepTerminals: false,
  driver: 'd',
  createdAt,
});

async function tmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-meta-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

test('RunMeta round-trips through run.json', async () => {
  const { dir, cleanup } = await tmp();
  try {
    const m = { ...meta('r1', '2026-01-01T00:00:00.000Z'), space: 's1' };
    await writeRunMeta(dir, m);
    assert.deepEqual(await readRunMeta(dir), m);
  } finally {
    await cleanup();
  }
});

test('readRunMeta names the invalid field', async () => {
  const { dir, cleanup } = await tmp();
  try {
    await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ ...meta('r1', 'x'), issue: 'seven' }));
    await assert.rejects(readRunMeta(dir), {
      message: `Run metadata ${path.join(dir, 'run.json')} is missing or invalid: issue`,
    });
  } finally {
    await cleanup();
  }
});

test('readRunMeta reports a missing file', async () => {
  const { dir, cleanup } = await tmp();
  try {
    await assert.rejects(readRunMeta(dir), /Run metadata .*run\.json is missing or invalid: /);
  } finally {
    await cleanup();
  }
});

test('newRunId is t<issue>-<YYYYMMDD>-<HHMMSS>-<rand> in UTC', () => {
  assert.equal(newRunId(42, new Date('2026-03-04T05:06:07Z'), 'ab12'), 't42-20260304-050607-ab12');
  assert.match(newRunId(1, new Date()), /^t1-\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test('driverName uses terminalName with @driver, attempt 0', () => {
  assert.equal(driverName('r1', 'o/r#7'), terminalName('r1', 'o/r#7', '@driver', 0));
});

test('listRuns is newest first, broken runs last with their error, missing dir is empty', async () => {
  const { dir: home, cleanup } = await tmp();
  try {
    assert.deepEqual(await listRuns(home), []);
    const runs = path.join(home, '.percolator', 'runs');
    for (const [id, at] of [
      ['old', '2026-01-01T00:00:00.000Z'],
      ['new', '2026-02-01T00:00:00.000Z'],
    ] as const) {
      await fs.mkdir(path.join(runs, id), { recursive: true });
      await writeRunMeta(path.join(runs, id), meta(id, at));
    }
    await fs.mkdir(path.join(runs, 'broken'), { recursive: true });
    const list = await listRuns(home);
    assert.deepEqual(
      list.map((r) => path.basename(r.dir)),
      ['new', 'old', 'broken'],
    );
    assert.equal(list[0]!.state, undefined);
    assert.match(list[2]!.error!, /Run metadata .*run\.json is missing or invalid/);
    assert.equal(list[2]!.meta, undefined);
  } finally {
    await cleanup();
  }
});

test('detectBase gives origin/main, else the current branch', async () => {
  const { root, cleanup } = await makeRepo();
  try {
    assert.equal(await detectBase(root), 'origin/main');
    await git(root, 'remote', 'remove', 'origin');
    await git(root, 'checkout', '--quiet', '-b', 'topic');
    assert.equal(await detectBase(root), 'topic');
  } finally {
    await cleanup();
  }
});
