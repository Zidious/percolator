import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState } from '../../src/engine/state.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { launchDriver, prepareRun, worktreeIn } from '../../src/run/prepare.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { FakeHerdrApp } from '../helpers/fake-app.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import { git } from '../helpers/git-repo.ts';
import { ENTRY, NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

type Env = RunEnv;
const setup = () => setupRunEnv();

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function assertNothingCreated(e: Env): Promise<void> {
  assert.equal(await exists(path.join(e.home, '.percolator', 'runs')), false);
  assert.equal(await exists(path.join(e.home, '.percolator', 'worktrees')), false);
  assert.deepEqual(e.deps.app.calls, []);
}

test('prepareRun creates worktree, space, run.json and state', async () => {
  const e = await setup();
  try {
    const meta = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.match(meta.runId, /^t5-20260304-050607-[0-9a-f]{4}$/);
    const worktree = path.join(e.home, '.percolator', 'worktrees', 'r', meta.runId);
    const dir = path.join(e.home, '.percolator', 'runs', meta.runId);
    const expected: RunMeta = {
      version: 1,
      runId: meta.runId,
      ticket: 'github.com/o/r#5',
      repo: 'github.com/o/r',
      issue: 5,
      repoRoot: e.root,
      configFile: e.configFile,
      profile: 'work',
      worktree,
      branch: `percolator/${meta.runId}`,
      base: 'origin/main',
      space: 'space-1',
      keepTerminals: false,
      driver: meta.driver,
      createdAt: NOW.toISOString(),
    };
    assert.deepEqual(meta, expected);
    assert.deepEqual(await readRunMeta(dir), expected);
    assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), `percolator/${meta.runId}`);
    assert.deepEqual(e.deps.app.calls, [['r #5', worktree]]);
    assert.equal(await fs.readFile(path.join(dir, 'grounds', 'team', 'policies', 'sdlc.md'), 'utf8'), 'be careful\n');
    const state = await loadState(dir);
    assert.match(state.graphFingerprint!, /^[0-9a-f]{64}$/);
    assert.equal(state.cursor, 0);
    assert.equal(state.status, 'running');
    assert.equal(state.ticket, 'github.com/o/r#5');
    assert.deepEqual(state.groundVersions, { team: 'local' });
  } finally {
    await e.cleanup();
  }
});

test('prepareRun follows the runtime block: worktree_root, base, keep_terminals, space: false', async () => {
  const e = await setup();
  try {
    await e.writeConfig(
      '    runtime: { worktree_root: ~/wt, base: main, keep_terminals: true, space: false }',
    );
    const meta = await prepareRun({ ticket: 'o/r#9', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.equal(meta.worktree, path.join(e.home, 'wt', 'r', meta.runId));
    assert.equal(meta.base, 'main');
    assert.equal(meta.keepTerminals, true);
    assert.equal('space' in meta, false);
    assert.deepEqual(e.deps.app.calls, []);
    assert.equal(await git(meta.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), `percolator/${meta.runId}`);
  } finally {
    await e.cleanup();
  }
});

test('a relative worktree_root resolves against the config dir', async () => {
  const e = await setup();
  try {
    await e.writeConfig('    runtime: { worktree_root: wt }');
    const meta = await prepareRun({ ticket: 'o/r#9', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.equal(meta.worktree, path.join(path.dirname(e.configFile), 'wt', 'r', meta.runId));
    assert.equal(path.isAbsolute(meta.worktree), true);
    assert.equal(await git(meta.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), `percolator/${meta.runId}`);
  } finally {
    await e.cleanup();
  }
});

test('a config error creates nothing', async () => {
  const e = await setup();
  try {
    await e.writeConfig('    runtime: { bogus: true }');
    await assert.rejects(
      prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
      /bogus/,
    );
    await assertNothingCreated(e);
  } finally {
    await e.cleanup();
  }
});

test('#5 without a GitHub origin gives the ticket message and creates nothing', async () => {
  const e = await setup();
  try {
    await git(e.root, 'remote', 'remove', 'origin');
    await assert.rejects(
      prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
      { message: 'ticket "#5" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123' },
    );
    await assertNothingCreated(e);
  } finally {
    await e.cleanup();
  }
});

test('a detached HEAD with no origin/HEAD is refused before anything is created', async () => {
  const e = await setup();
  try {
    await git(e.root, 'remote', 'remove', 'origin');
    await git(e.root, 'checkout', '--quiet', '--detach');
    await assert.rejects(
      prepareRun({ ticket: 'o/r#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
      { message: 'cannot detect a base branch (HEAD is detached); set runtime.base in profile "work"' },
    );
    await assertNothingCreated(e);
  } finally {
    await e.cleanup();
  }
});

test('a path-like or invalid ticket ref is refused before anything is created', async () => {
  const e = await setup();
  try {
    for (const ticket of ['o/..#1', 'o/..\\..\\..\\..\\Temp#1', '-x/r#1', '#0']) {
      await assert.rejects(
        prepareRun({ ticket, repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
        { message: `cannot read ticket "${ticket}": use #123, owner/repo#123 or an issue URL` },
        ticket,
      );
      await assertNothingCreated(e);
    }
  } finally {
    await e.cleanup();
  }
});

test("a ticket in another repo than the clone's origin is refused before anything is created", async () => {
  const e = await setup();
  try {
    await assert.rejects(
      prepareRun({ ticket: 'other/x#3', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
      {
        message:
          "ticket github.com/other/x#3 is in other/x, but this clone's origin is o/r; run perc in a clone of other/x or pass --repo <dir>",
      },
    );
    await assertNothingCreated(e);
  } finally {
    await e.cleanup();
  }
});

test('the origin check ignores the host and case, so an ssh host alias still passes', async () => {
  const e = await setup();
  try {
    await git(e.root, 'remote', 'set-url', 'origin', 'git@gh-work:O/R.git');
    await e.writeConfig('    runtime: { base: main }');
    const meta = await prepareRun({ ticket: 'o/r#4', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.equal(meta.ticket, 'github.com/o/r#4');
  } finally {
    await e.cleanup();
  }
});

test('worktreeIn refuses a worktree that would leave its root', () => {
  const root = path.resolve('/wt');
  assert.equal(worktreeIn(root, 'r', 't1-x'), path.join(root, 'r', 't1-x'));
  for (const repoName of ['..', path.join('..', '..', 'Temp'), path.resolve('/elsewhere')]) {
    assert.throws(() => worktreeIn(root, repoName, 't1-x'), {
      message: `repository name "${repoName}" would put the worktree outside ${root}`,
    });
  }
});

test('space failure names the fix', async () => {
  const e = await setup();
  try {
    e.deps.app.fail('herdr-app space.new failed: connection refused');
    await assert.rejects(
      prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps),
      {
        message:
          'herdr-app space.new failed: connection refused; start the Herdr app or set runtime.space: false in profile "work"',
      },
    );
    assert.equal(await exists(path.join(e.home, '.percolator', 'runs')), false);
    const worktree = e.deps.app.calls[0]![1];
    const runId = path.basename(worktree);
    assert.match(runId, /^t5-20260304-050607-[0-9a-f]{4}$/);
    assert.equal(await exists(worktree), false);
    const listed = await git(e.root, 'worktree', 'list', '--porcelain');
    assert.equal(listed.includes(runId), false, listed);
    assert.equal(await git(e.root, 'branch', '--list', `percolator/${runId}`), '');
  } finally {
    await e.cleanup();
  }
});

const meta =(o: Partial<RunMeta> = {}): RunMeta => ({
  version: 1,
  runId: 't5-20260304-050607-ab12',
  ticket: 'github.com/o/r#5',
  repo: 'github.com/o/r',
  issue: 5,
  repoRoot: path.resolve('/r'),
  configFile: path.resolve('/c.yaml'),
  profile: 'work',
  worktree: path.resolve('/w'),
  branch: 'percolator/t5-20260304-050607-ab12',
  base: 'origin/main',
  space: 'space-1',
  keepTerminals: false,
  driver: 't5_driver_a0_abcd',
  createdAt: NOW.toISOString(),
  ...o,
});

const launchDeps = (hc: FakeHc): DriverDeps => ({
  hc,
  app: new FakeHerdrApp(),
  gh: new FakeGh(),
  home: path.resolve('/home'),
  out: () => {},
  entry: ENTRY,
});

test('launchDriver argv and labels', async () => {
  const hc = new FakeHc();
  const m = meta();
  assert.equal(await launchDriver(m, launchDeps(hc)), m.driver);
  assert.deepEqual(hc.calls, [
    ['get', m.driver],
    [
      'run',
      {
        name: m.driver,
        cwd: m.worktree,
        argv: [process.execPath, ENTRY, 'drive', m.runId],
        labels: { 'percolator.run': m.runId, 'percolator.role': 'driver', 'herdr.space': 'space-1' },
        outliveParent: true,
      },
    ],
  ]);
});

test('launchDriver leaves out herdr.space when the run has no space', async () => {
  const hc = new FakeHc();
  const { space: _, ...m } = meta();
  await launchDriver(m, launchDeps(hc));
  assert.deepEqual((hc.calls[1]![1] as { labels: unknown }).labels, {
    'percolator.run': m.runId,
    'percolator.role': 'driver',
  });
});

test('launchDriver refuses a live driver', async () => {
  const hc = new FakeHc();
  const m = meta();
  hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } });
  await assert.rejects(launchDriver(m, launchDeps(hc)), {
    message: `run ${m.runId} is already being driven by terminal ${m.driver}`,
  });
  assert.deepEqual(hc.calls, [['get', m.driver]]);
});

test('launchDriver removes a finished driver of this run, then relaunches', async () => {
  const hc = new FakeHc();
  const m = meta();
  hc.add({ name: m.driver, state: 'finished', labels: { 'percolator.run': m.runId } });
  await launchDriver(m, launchDeps(hc));
  assert.deepEqual(
    hc.calls.map((c) => c[0]),
    ['get', 'rm', 'run'],
  );
  assert.equal(hc.terminals.get(m.driver)!.state, 'live');
});

test('launchDriver refuses a terminal of another run, or unlabelled, and never removes it', async () => {
  const m = meta();
  for (const [labels, shown] of [
    [{ 'percolator.run': 'other-run' }, 'other-run'],
    [{}, 'none'],
  ] as const) {
    for (const state of ['live', 'finished'] as const) {
      const hc = new FakeHc();
      hc.add({ name: m.driver, state, labels });
      await assert.rejects(launchDriver(m, launchDeps(hc)), {
        message: `terminal ${m.driver} is not part of run ${m.runId} (percolator.run=${shown}); remove it with hc rm or rename it, then resume`,
      });
      assert.deepEqual(hc.calls, [['get', m.driver]]);
    }
  }
});
