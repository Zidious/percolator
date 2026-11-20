import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState } from '../../src/engine/state.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { launchDriver, prepareRun } from '../../src/run/prepare.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { FakeHerdrApp } from '../helpers/fake-app.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import { git, makeRepo } from '../helpers/git-repo.ts';

const NOW = new Date('2026-03-04T05:06:07Z');
const ENTRY = path.resolve('/opt/perc/dist/cli.js');

type Env = {
  root: string;
  home: string;
  configFile: string;
  deps: DriverDeps & { hc: FakeHc; app: FakeHerdrApp };
  writeConfig(extra?: string): Promise<void>;
  cleanup(): Promise<void>;
};

/**
 * A repo whose origin url is `github.com/o/r.git`: a relative path to a bare repo inside the clone,
 * so `normalizeRemote` gives `github.com/o/r` and `git fetch origin` still works offline.
 */
async function setup(): Promise<Env> {
  const repo = await makeRepo();
  const bare = path.join(repo.root, 'github.com', 'o', 'r.git');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await fs.rename(repo.origin, bare);
  await git(repo.root, 'remote', 'set-url', 'origin', 'github.com/o/r.git');
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-home-')));
  const cfgDir = path.join(home, 'cfg');
  await fs.mkdir(path.join(cfgDir, 'team', 'policies'), { recursive: true });
  await fs.writeFile(path.join(cfgDir, 'team', 'policies', 'sdlc.md'), 'be careful\n');
  const configFile = path.join(cfgDir, 'config.yaml');
  const writeConfig = (extra = '') =>
    fs.writeFile(
      configFile,
      [
        'version: 1',
        'grounds:',
        '  team: { path: ./team }',
        'profiles:',
        '  work:',
        '    use:',
        '      - { from: team, file: policies/sdlc.md, as: policy }',
        '    bindings:',
        '      intake: { builtin: github.intake }',
        '      groom: { command: [echo, groom] }',
        '      plan: { command: [echo, plan] }',
        '      implement: { command: [echo, implement] }',
        '      review: { command: [echo, review] }',
        '      deliver: { builtin: github.open_pr }',
        extra,
        '',
      ].join('\n'),
    );
  await writeConfig();
  const deps = {
    hc: new FakeHc(),
    app: new FakeHerdrApp(),
    gh: new FakeGh(),
    home,
    now: () => NOW,
    out: () => {},
    entry: ENTRY,
  };
  return {
    root: repo.root,
    home,
    configFile,
    deps,
    writeConfig,
    cleanup: async () => {
      await repo.cleanup();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

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
  } finally {
    await e.cleanup();
  }
});

const meta = (o: Partial<RunMeta> = {}): RunMeta => ({
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
