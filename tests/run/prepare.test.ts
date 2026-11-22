import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../../src/engine/state.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { readRunGraph, toRunGraph } from '../../src/run/graph-file.ts';
import { validate } from '../../src/validate.ts';
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
  assert.equal(await exists(path.join(e.root, '.worktrees')), false);
  assert.deepEqual(e.deps.app.calls, []);
}

test('prepareRun creates worktree, space, run.json and state', async () => {
  const e = await setup();
  try {
    const meta = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.match(meta.runId, /^t5-20260304-050607-[0-9a-f]{4}$/);
    const worktree = path.join(e.root, '.worktrees', meta.runId);
    const dir = path.join(e.home, '.percolator', 'runs', meta.runId);
    const expected: RunMeta = {
      version: 2,
      runId: meta.runId,
      pipeline: 'feature',
      inputs: {},
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
    // the in-repo worktree folder is kept out of git without changing any tracked file
    assert.doesNotMatch(await git(e.root, 'status', '--porcelain', '--untracked-files=all'), /\.worktrees/);
    assert.deepEqual(e.deps.app.calls, [[`r #5 · ${meta.runId.slice(-4)}`, worktree]]);
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
  version: 2,
  runId: 't5-20260304-050607-ab12',
  pipeline: 'feature',
  inputs: {},
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

test("launchDriver argv and labels: the driver stays out of the run's Herdr space", async () => {
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
        labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' },
        outliveParent: true,
      },
    ],
  ]);
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

test('prepare writes graph.json matching the run\'s graph', async () => {
  const e = await setup();
  try {
    const meta = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    const dir = path.join(e.home, '.percolator', 'runs', meta.runId);
    const v = await validate({ configFile: e.configFile, cwd: e.root, home: e.home, profile: 'work' });
    assert.deepEqual(await readRunGraph(dir), toRunGraph(v.graph));
  } finally {
    await e.cleanup();
  }
});

const PIPELINES = [
  '    pipelines:',
  '      dd-alert:',
  '        stages: [intake, triage, deliver]',
  '        exit: pr',
  '        ticket: none',
  '        inputs:',
  '          alert_url: { required: true }',
  '        bindings:',
  '          triage: { command: [echo, triage] }',
  '      hotfix:',
  '        stages: [intake, implement, deliver]',
  '        exit: pr',
  '        ticket: optional',
  '        bindings:',
  '          implement: { command: [echo, implement] }',
].join('\n');

test('a ticketless run is prepared from inputs', async () => {
  const e = await setup();
  try {
    await e.writeConfig(PIPELINES);
    const meta = await prepareRun(
      { pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x?a=b' }, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    assert.match(meta.runId, /^dd-alert-20260304-050607-[0-9a-f]{4}$/);
    assert.equal(meta.branch, `percolator/${meta.runId}`);
    assert.equal('ticket' in meta, false);
    assert.equal('issue' in meta, false);
    assert.equal(meta.pipeline, 'dd-alert');
    assert.deepEqual(meta.inputs, { alert_url: 'https://dd/x?a=b' });
    assert.equal(meta.repo, 'github.com/o/r');
    const dir = path.join(e.home, '.percolator', 'runs', meta.runId);
    assert.deepEqual(await readRunMeta(dir), meta);
    assert.deepEqual(e.deps.app.calls, [[`r dd-alert · ${meta.runId.slice(-4)}`, meta.worktree]]);
    assert.equal(await git(meta.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), meta.branch);
    assert.equal((await loadState(dir)).ticket, undefined);
    // nothing on GitHub is read for a run without a ticket
    assert.deepEqual(e.deps.gh.calls, []);
  } finally {
    await e.cleanup();
  }
});

test('a ticket on a profile with several pipelines picks the pipeline its label names', async () => {
  const e = await setup();
  try {
    await e.writeConfig(PIPELINES);
    e.deps.gh.addIssue('github.com/o/r', 5, { labels: ['pipeline:hotfix'] });
    const meta = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.equal(meta.pipeline, 'hotfix');
    assert.match(meta.runId, /^t5-hotfix-20260304-050607-[0-9a-f]{4}$/);
    assert.deepEqual(e.deps.gh.calls.filter((c) => c.method === 'issue').map((c) => c.args), [['github.com/o/r', 5]]);
  } finally {
    await e.cleanup();
  }
});

test('a second live run on a ticket is refused', async () => {
  const e = await setup();
  try {
    const first = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    const before = await git(e.root, 'worktree', 'list', '--porcelain');
    await assert.rejects(prepareRun({ ticket: 'o/r#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps), {
      message: `ticket github.com/o/r#5 already has a live run ${first.runId} (pipeline feature, running); finish or delete it first (perc delete ${first.runId})`,
    });
    assert.equal(await git(e.root, 'worktree', 'list', '--porcelain'), before);
    assert.equal(e.deps.app.calls.length, 1);
    assert.deepEqual(await fs.readdir(path.join(e.home, '.percolator', 'runs')), [first.runId]);
  } finally {
    await e.cleanup();
  }
});

test('a run on a ticket whose only run completed is allowed', async () => {
  const e = await setup();
  try {
    const first = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    const dir = path.join(e.home, '.percolator', 'runs', first.runId);
    await saveState(dir, { ...(await loadState(dir)), status: 'completed' });
    const second = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    assert.notEqual(second.runId, first.runId);
  } finally {
    await e.cleanup();
  }
});

test('a linked child run is exempt from its parent and siblings, and keeps a given run id', async () => {
  const e = await setup();
  try {
    const parent = await prepareRun({ ticket: '#5', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    const child = await prepareRun(
      { ticket: '#5', runId: `${parent.runId}-s1`, parent: parent.runId, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    assert.equal(child.runId, `${parent.runId}-s1`);
    assert.equal(child.parent, parent.runId);
    const sibling = await prepareRun(
      { ticket: '#5', runId: `${parent.runId}-s2`, parent: parent.runId, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    assert.equal(sibling.parent, parent.runId);
  } finally {
    await e.cleanup();
  }
});
