import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState } from '../../src/engine/state.ts';
import { runGit } from '../../src/grounds/git.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { validate } from '../../src/validate.ts';
import { loadLedger, saveLedger } from '../../src/watch/ledger.ts';
import { triggerId } from '../../src/watch/poll.ts';
import { otherWatcher, watcherStatus, watchLoop } from '../../src/watch/watch.ts';
import { setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';

const TRIAGE = [
  '    pipelines:',
  '      triage:',
  '        stages: [intake, fix, deliver]',
  '        exit: pr',
  '        ticket: optional',
  '        bindings:',
  '          fix: { command: [echo, fix] }',
  '        triggers:',
  '          - { schedule: "0 * * * *", timezone: UTC }',
  '          - { label: triage }',
].join('\n');

/** The ledger mark of triage's schedule trigger. */
const HOURLY = `${REPO}:triage:${triggerId({ schedule: '0 * * * *', timezone: 'UTC' })}`;

const pdir = (e: RunEnv) => path.join(e.home, '.percolator');
const runPath = (e: RunEnv, id: string) => path.join(e.home, '.percolator', 'runs', id);
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** Runs `watchLoop` for `polls` polls with a clock that moves a minute per poll; returns the log lines. */
async function loop(
  e: RunEnv,
  o: { polls?: number; start?: string; onSleep?: (n: number) => Promise<void> | void; repos?: string[] } = {},
): Promise<string[]> {
  const lines: string[] = [];
  const ac = new AbortController();
  let clock = new Date(o.start ?? '2026-11-22T10:15:00Z');
  let n = 0;
  await watchLoop(
    { repos: o.repos ?? [e.root], configFile: e.configFile, profile: 'work', intervalS: 60 },
    {
      ...e.deps,
      now: () => clock,
      out: (s) => lines.push(s),
      pid: 4242,
      signal: ac.signal,
      sleep: async (ms) => {
        assert.equal(ms, 60_000);
        n++;
        await o.onSleep?.(n);
        clock = new Date(clock.getTime() + 60_000);
        if (n >= (o.polls ?? 1)) ac.abort();
      },
    },
  );
  return lines;
}

test('one poll starts a run for a label trigger', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    e.deps.gh.addIssue(REPO, 7, { labels: ['triage'] });
    const lines = await loop(e);
    const ledger = await loadLedger(pdir(e));
    const key = `label:${REPO}:triage:7`;
    const runId = ledger.fired[key]?.runId;
    assert.match(runId ?? '', /^t7-triage-20261122-101500-[0-9a-f]{4}$/);
    assert.deepEqual(lines, [`watch: ${key} → run ${runId}`]);
    const meta = await readRunMeta(runPath(e, runId!));
    assert.equal(meta.pipeline, 'triage');
    assert.equal(meta.ticket, `${REPO}#7`);
    const driver = e.deps.hc.terminals.get(meta.driver);
    assert.deepEqual(driver?.argv.slice(-2), ['drive', runId]);
    assert.equal(driver?.labels['percolator.role'], 'driver');
  } finally {
    await e.cleanup();
  }
});

test("a clone whose origin is an ssh host alias is watched on the alias's real host", async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    await runGit(['remote', 'set-url', 'origin', 'git@gh-work:o/r.git'], e.root);
    e.deps.sshHostname = async (h) => (h === 'gh-work' ? 'github.com' : undefined);
    e.deps.gh.addIssue(REPO, 7, { labels: ['triage'] });
    await loop(e);
    assert.deepEqual(
      e.deps.gh.calls.filter((c) => c.method === 'listIssues').map((c) => c.args[0]),
      [REPO],
    );
    assert.deepEqual(Object.keys((await loadLedger(pdir(e))).fired), [`label:${REPO}:triage:7`]);
  } finally {
    await e.cleanup();
  }
});

test('a broken config is logged and skipped', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig('    nope: 1');
    const message = await validate({ configFile: e.configFile, cwd: e.root, home: e.home, profile: 'work' }).then(
      () => assert.fail('the config should not validate'),
      (err: Error) => err.message,
    );
    const lines = await loop(e);
    assert.deepEqual(lines, [`watch: ${e.root}: ${message}`]);
    assert.deepEqual(e.deps.hc.calls, []);
    assert.deepEqual(e.deps.gh.calls, []);
  } finally {
    await e.cleanup();
  }
});

test('heartbeat is written each poll', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const file = path.join(pdir(e), 'watch', 'watch.json');
    const beats: unknown[] = [];
    await loop(e, { polls: 2, onSleep: async () => void beats.push(JSON.parse(await fs.readFile(file, 'utf8'))) });
    const beat = (at: string) => ({
      pid: 4242,
      host: os.hostname(),
      startedAt: '2026-11-22T10:15:00.000Z',
      heartbeatAt: at,
      repos: [e.root],
      intervalS: 60,
    });
    assert.deepEqual(beats, [beat('2026-11-22T10:15:00.000Z'), beat('2026-11-22T10:16:00.000Z')]);
  } finally {
    await e.cleanup();
  }
});

test('the heartbeat is written before the first poll and after each repo, so a long pass does not look dead', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const file = path.join(pdir(e), 'watch', 'watch.json');
    const seen: string[] = [];
    const gh = e.deps.gh;
    const listIssues = gh.listIssues.bind(gh);
    gh.listIssues = async (repo, o) => {
      seen.push((JSON.parse(await fs.readFile(file, 'utf8')) as { heartbeatAt: string }).heartbeatAt);
      return listIssues(repo, o);
    };
    let clock = new Date('2026-11-22T10:15:00Z');
    const ac = new AbortController();
    await watchLoop(
      { repos: [e.root, e.root], configFile: e.configFile, profile: 'work', intervalS: 60 },
      {
        ...e.deps,
        // every read of the clock moves it 10s on, as a slow pass would
        now: () => (clock = new Date(clock.getTime() + 10_000)),
        out: () => {},
        pid: 4242,
        signal: ac.signal,
        sleep: async () => ac.abort(),
      },
    );
    assert.equal(seen.length, 2);
    // the second repo's poll sees a beat written after the first repo, newer than the one before the pass
    assert.ok(Date.parse(seen[1]!) > Date.parse(seen[0]!), seen.join(' '));
  } finally {
    await e.cleanup();
  }
});

test('a poll that throws loses no schedule tick', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const mark = HOURLY;
    await saveLedger(pdir(e), { version: 1, fired: {}, lastPoll: { [mark]: '2026-11-22T07:30:00.000Z' } });
    const gh = e.deps.gh;
    const listIssues = gh.listIssues.bind(gh);
    let failing = true;
    gh.listIssues = async (repo, o) => {
      if (failing) throw new Error('gh issue list: HTTP 502');
      return listIssues(repo, o);
    };
    const lines = await loop(e, {
      polls: 2,
      onSleep: async (n) => {
        if (n !== 1) return;
        // the failed poll saved nothing that moves the schedule past its tick
        assert.equal((await loadLedger(pdir(e))).lastPoll[mark], '2026-11-22T07:30:00.000Z');
        failing = false;
      },
    });
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0]!, new RegExp(`^watch: ${e.root.replaceAll('\\', '\\\\')}: .*HTTP 502`));
    const key = `schedule:${HOURLY}:2026-11-22T10:00`;
    assert.match(lines[1]!, new RegExp(`^watch: ${key} → run triage-20261122-101600-[0-9a-f]{4}$`));
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher prepares a firing it recorded but never started, with the same id', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    e.deps.gh.addIssue(REPO, 7, { labels: ['triage'] });
    const key = `label:${REPO}:triage:7`;
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [key]: { runId: 't7-triage-20261122-100000-abcd', at: '2026-11-22T10:00:00.000Z', pipeline: 'triage', ticket: `https://${REPO}/issues/7`, inputs: {} } },
      lastPoll: {},
    });
    const lines = await loop(e);
    assert.deepEqual(lines, [`watch: ${key} → run t7-triage-20261122-100000-abcd`]);
    assert.equal((await readRunMeta(runPath(e, 't7-triage-20261122-100000-abcd'))).ticket, `${REPO}#7`);
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher starts a schedule firing it recorded but never prepared', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const key = `schedule:${HOURLY}:2026-11-22T10:00`;
    const id = 'triage-20261122-100000-abcd';
    // fire() saved the entry (and the poll moved the mark past the tick), then the watcher crashed before prepareRun
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [key]: { runId: id, at: '2026-11-22T10:00:30.000Z', pipeline: 'triage', inputs: {} } },
      lastPoll: { [HOURLY]: '2026-11-22T10:00:30.000Z' },
    });
    const lines = await loop(e);
    assert.deepEqual(lines, [`watch: ${key} → run ${id}`]);
    assert.equal((await readRunMeta(runPath(e, id))).pipeline, 'triage');
    assert.equal((await loadLedger(pdir(e))).fired[key]?.prepared, true);
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher whose first poll of a repo fails still starts its unprepared firing on a later poll', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig('    nope: 1');
    const key = `schedule:${HOURLY}:2026-11-22T10:00`;
    const id = 'triage-20261122-100000-abcd';
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [key]: { runId: id, at: '2026-11-22T10:00:30.000Z', pipeline: 'triage', inputs: {} } },
      lastPoll: { [HOURLY]: '2026-11-22T10:00:30.000Z' },
    });
    const lines = await loop(e, {
      polls: 2,
      onSleep: async (n) => {
        if (n === 1) await e.writeConfig(TRIAGE);
      },
    });
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.equal(lines[1], `watch: ${key} → run ${id}`);
    assert.equal((await readRunMeta(runPath(e, id))).pipeline, 'triage');
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher whose first poll of a repo fails still records PRs opened while it was stopped as seen', async () => {
  const e = await setupRunEnv();
  try {
    const PRS = [
      '    pipelines:',
      '      review-pr:',
      '        stages: [intake, fix, deliver]',
      '        exit: pr',
      '        ticket: none',
      '        inputs: { pr: { required: true } }',
      '        bindings:',
      '          fix: { command: [echo, fix] }',
      '        triggers:',
      '          - { pr_opened: true }',
    ].join('\n');
    await e.writeConfig('    nope: 1');
    await saveLedger(pdir(e), { version: 1, fired: {}, lastPoll: { [`${REPO}:review-pr:${triggerId({ pr_opened: true })}`]: '2026-11-22T09:00:00.000Z' } });
    e.deps.gh.addPr(REPO, { number: 3, author: 'alice' });
    const lines = await loop(e, {
      polls: 2,
      onSleep: async (n) => {
        if (n === 1) await e.writeConfig(PRS);
      },
    });
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.equal((await loadLedger(pdir(e))).fired[`pr:${REPO}:review-pr:3`]?.runId, '');
  } finally {
    await e.cleanup();
  }
});

test('a run the user deleted is not started again by a restarted watcher', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    e.deps.gh.addIssue(REPO, 7, { labels: ['triage'] });
    await loop(e);
    const key = `label:${REPO}:triage:7`;
    const id = (await loadLedger(pdir(e))).fired[key]!.runId;
    // perc delete <id>: the run dir is gone
    await fs.rm(runPath(e, id), { recursive: true, force: true });
    assert.deepEqual(await loop(e), []);
    assert.equal(await exists(runPath(e, id)), false);
  } finally {
    await e.cleanup();
  }
});

test('a poll prunes schedule firings older than the lookback from fired.json', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const old = `schedule:${HOURLY}:2026-11-10T10:00`;
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [old]: { runId: 'triage-20261110-100000-abcd', at: '2026-11-10T10:00:00.000Z', pipeline: 'triage', inputs: {}, prepared: true } },
      lastPoll: {},
    });
    await loop(e);
    assert.equal(Object.hasOwn((await loadLedger(pdir(e))).fired, old), false);
  } finally {
    await e.cleanup();
  }
});

test('a recorded firing two triggers ask for is started once after a restart', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig([
      '    pipelines:',
      '      deps:',
      '        stages: [intake, fix, deliver]',
      '        exit: pr',
      '        ticket: none',
      '        inputs: { pr: { required: true } }',
      '        bindings:',
      '          fix: { command: [echo, fix] }',
      '        triggers:',
      '          - { pr_opened: true }',
      '          - { dependabot: true }',
    ].join('\n'));
    e.deps.gh.addPr(REPO, { number: 3, author: 'dependabot[bot]' });
    const key = `pr:${REPO}:deps:3`;
    const id = 'deps-20261122-100000-abcd';
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [key]: { runId: id, at: '2026-11-22T10:00:00.000Z', pipeline: 'deps', inputs: { pr: `https://${REPO}/pull/3` } } },
      lastPoll: { [`${REPO}:deps:${triggerId({ pr_opened: true })}`]: '2026-11-22T10:00:00.000Z', [`${REPO}:deps:${triggerId({ dependabot: true })}`]: '2026-11-22T10:00:00.000Z' },
    });
    assert.deepEqual(await loop(e), [`watch: ${key} → run ${id}`]);
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher starts nothing for a PR opened while it was stopped, and fires a later one', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig([
      '    pipelines:',
      '      review-pr:',
      '        stages: [intake, fix, deliver]',
      '        exit: pr',
      '        ticket: none',
      '        inputs: { pr: { required: true } }',
      '        bindings:',
      '          fix: { command: [echo, fix] }',
      '        triggers:',
      '          - { pr_opened: true }',
    ].join('\n'));
    // the watcher polled this trigger before it stopped; PR 3 was opened while it was stopped
    await saveLedger(pdir(e), { version: 1, fired: {}, lastPoll: { [`${REPO}:review-pr:0`]: '2026-11-22T09:00:00.000Z' } });
    e.deps.gh.addPr(REPO, { number: 3, author: 'alice' });
    const lines = await loop(e, {
      polls: 2,
      onSleep: (n) => {
        if (n === 1) e.deps.gh.addPr(REPO, { number: 4, author: 'bob' });
      },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, new RegExp(`^watch: pr:${REPO}:review-pr:4 → run review-pr-`));
    assert.equal((await loadLedger(pdir(e))).fired[`pr:${REPO}:review-pr:3`]?.runId, '');
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher relaunches a run it prepared but never launched', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    e.deps.gh.addIssue(REPO, 7, { labels: ['triage'] });
    const key = `label:${REPO}:triage:7`;
    const id = 't7-triage-20261122-100000-abcd';
    const meta = await prepareRun(
      { ticket: `https://${REPO}/issues/7`, pipeline: 'triage', runId: id, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    await saveLedger(pdir(e), { version: 1, fired: { [key]: { runId: id, at: '2026-11-22T10:00:00.000Z' } }, lastPoll: {} });
    const lines = await loop(e);
    assert.deepEqual(lines, [`watch: ${key} → run ${id} (relaunched)`]);
    assert.deepEqual(e.deps.hc.terminals.get(meta.driver)?.argv.slice(-2), ['drive', id]);
    assert.equal((await loadState(runPath(e, id))).history.length, 0);
  } finally {
    await e.cleanup();
  }
});

test('a restarted watcher prepares again a firing whose prepare stopped before run.json', async () => {
  const e = await setupRunEnv();
  try {
    await e.writeConfig(TRIAGE);
    const key = `label:${REPO}:triage:7`;
    const id = 't7-triage-20261122-100000-abcd';
    // prepareRun made the run dir (state.json, graph) and the watcher recorded it prepared, then it crashed before run.json
    await prepareRun(
      { ticket: `https://${REPO}/issues/7`, pipeline: 'triage', runId: id, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    await fs.rm(path.join(runPath(e, id), 'run.json'));
    await saveLedger(pdir(e), {
      version: 1,
      fired: { [key]: { runId: id, at: '2026-11-22T10:00:00.000Z', pipeline: 'triage', ticket: `https://${REPO}/issues/7`, inputs: {}, prepared: true } },
      lastPoll: {},
    });
    assert.deepEqual(await loop(e), [`watch: ${key} → run ${id}`]);
    assert.equal((await readRunMeta(runPath(e, id))).ticket, `${REPO}#7`);
  } finally {
    await e.cleanup();
  }
});

test('watcher alive from a fresh heartbeat; dead from a stale one', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-watcher-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = new Date('2026-11-22T10:15:00Z');
  assert.deepEqual(await watcherStatus(home, now, () => true), { alive: false, repos: [] });
  const write = (over: Record<string, unknown>) =>
    fs.mkdir(path.join(home, '.percolator', 'watch'), { recursive: true }).then(() =>
      fs.writeFile(
        path.join(home, '.percolator', 'watch', 'watch.json'),
        JSON.stringify({ pid: 9, host: os.hostname(), startedAt: '2026-11-22T09:00:00.000Z', heartbeatAt: '2026-11-22T10:13:00.000Z', repos: ['/r'], intervalS: 60, ...over }),
      ),
    );
  await write({});
  assert.deepEqual(await watcherStatus(home, now, (pid) => pid === 9), { alive: true, since: '2026-11-22T09:00:00.000Z', repos: ['/r'] });
  assert.deepEqual(await watcherStatus(home, now, () => false), { alive: false, repos: ['/r'] });
  await write({ heartbeatAt: '2026-11-22T10:11:59.000Z' });
  assert.deepEqual(await watcherStatus(home, now, () => true), { alive: false, repos: ['/r'] });
  await write({ host: 'elsewhere' });
  assert.deepEqual(await watcherStatus(home, now, () => true), { alive: false, repos: ['/r'] });
});

test('otherWatcher is a live watcher in watch.json that is not this process', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-watcher-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = new Date('2026-11-22T10:15:00Z');
  assert.equal(await otherWatcher(home, now, () => true, 10), undefined);
  await fs.mkdir(path.join(home, '.percolator', 'watch'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.percolator', 'watch', 'watch.json'),
    JSON.stringify({ pid: 9, host: os.hostname(), startedAt: '2026-11-22T09:00:00.000Z', heartbeatAt: '2026-11-22T10:14:00.000Z', repos: ['/r'], intervalS: 60 }),
  );
  assert.equal(await otherWatcher(home, now, () => true, 10), 9);
  // a pid reused by this very process is not another watcher
  assert.equal(await otherWatcher(home, now, () => true, 9), undefined);
  assert.equal(await otherWatcher(home, now, () => false, 10), undefined);
});
