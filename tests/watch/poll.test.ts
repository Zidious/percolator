import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Trigger } from '../../src/config/schema.ts';
import type { PipelineSpec } from '../../src/config/pipelines.ts';
import { fire, loadLedger, markPrepared } from '../../src/watch/ledger.ts';
import type { Ledger } from '../../src/watch/ledger.ts';
import { pollTriggers, triggerId } from '../../src/watch/poll.ts';
import type { Firing } from '../../src/watch/poll.ts';
import { FakeGh } from '../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';

async function home(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-poll-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function spec(name: string, triggers: Trigger[]): Record<string, PipelineSpec> {
  return {
    [name]: { name, stages: ['intake', 'fix', 'deliver'], exit: 'pr', ticket: 'optional', inputs: {}, default: false, triggers },
  };
}

function emptyLedger(): Ledger {
  return { version: 1, fired: {}, lastPoll: {} };
}

/** The ledger mark of each trigger of `specs`. */
function marks(specs: Record<string, PipelineSpec>): string[] {
  return Object.values(specs).flatMap((p) => (p.triggers ?? []).map((t) => `${REPO}:${p.name}:${triggerId(t)}`));
}

/** The mark of the only trigger of `specs`. */
function mark(specs: Record<string, PipelineSpec>): string {
  const [only, ...rest] = marks(specs);
  assert.ok(only !== undefined && rest.length === 0);
  return only;
}

/** A ledger whose watcher already polled every trigger of `specs` once, at `at`. */
function polled(specs: Record<string, PipelineSpec>, at = '2026-11-22T09:00:00.000Z'): Ledger {
  return { version: 1, fired: {}, lastPoll: Object.fromEntries(marks(specs).map((m) => [m, at])) };
}

type Opts = { h: string; gh: FakeGh; specs: Record<string, PipelineSpec>; ledger: Ledger; now: Date; live?: Set<string>; first?: boolean };

function poll(o: Opts): Promise<Firing[]> {
  return pollTriggers({
    home: o.h,
    repoRoot: o.h,
    repo: REPO,
    specs: o.specs,
    gh: o.gh,
    now: o.now,
    ledger: o.ledger,
    liveRunOn: async (ref) => o.live?.has(ref) ?? false,
    ...(o.first !== undefined ? { first: o.first } : {}),
  });
}

/** Fire every firing through the real ledger, as the watcher does. */
async function fireAll(h: string, ledger: Ledger, firings: Firing[]): Promise<void> {
  let n = 0;
  for (const f of firings) await fire(h, ledger, f, async () => {}, () => `run-${++n}`);
}

test('a schedule fires once for the latest missed tick', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '0 * * * *', timezone: 'UTC', inputs: { scope: 'all' } }]);
  const ledger = emptyLedger();
  ledger.lastPoll[mark(specs)] = '2026-11-22T07:30:00.000Z';
  const now = new Date('2026-11-22T10:15:00Z');
  const firings = await poll({ h, gh: new FakeGh(), specs, ledger, now });
  assert.deepEqual(firings, [{ key: `schedule:${mark(specs)}:2026-11-22T10:00`, pipeline: 'nightly', inputs: { scope: 'all' } }]);
  assert.equal(ledger.lastPoll[mark(specs)], now.toISOString());
  await fireAll(h, ledger, firings);
  assert.deepEqual(await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-22T10:45:00Z') }), []);
});

test('a trigger id is its kind and a short hash of its config, whatever the key order', () => {
  const id = triggerId({ schedule: '0 * * * *', timezone: 'UTC' });
  assert.match(id, /^schedule-[0-9a-f]{8}$/);
  assert.equal(triggerId({ timezone: 'UTC', schedule: '0 * * * *' }), id);
  assert.notEqual(triggerId({ schedule: '0 * * * *', timezone: 'UTC', inputs: { scope: 'all' } }), id);
  assert.match(triggerId({ check_failed: { branch: 'main' } }), /^check_failed-[0-9a-f]{8}$/);
});

test('a trigger inserted before another neither takes its mark nor fires what is already open', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 1, author: 'alice' });
  const nightly: Trigger = { schedule: '0 * * * *', timezone: 'UTC' };
  const ledger = emptyLedger();
  assert.deepEqual(await poll({ h, gh, specs: spec('nightly', [nightly]), ledger, now: new Date('2026-11-22T10:30:00Z') }), []);
  const specs = spec('nightly', [{ pr_opened: true }, nightly]);
  const firings = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T11:30:00Z') });
  assert.deepEqual(firings.map((f) => f.key), [`schedule:${REPO}:nightly:${triggerId(nightly)}:2026-11-22T11:00`]);
  assert.deepEqual(ledger.fired[`pr:${REPO}:nightly:1`], { runId: '', at: '2026-11-22T11:30:00.000Z' });
});

test('the first poll seeds lastPoll and fires nothing', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '* * * * *', timezone: 'Europe/London' }]);
  const ledger = emptyLedger();
  const now = new Date('2026-11-22T10:15:00Z');
  assert.deepEqual(await poll({ h, gh: new FakeGh(), specs, ledger, now }), []);
  assert.deepEqual(ledger.lastPoll, { [mark(specs)]: now.toISOString() });
});

test('a fall-back duplicate hour does not refire', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '30 1 * * *', timezone: 'America/New_York' }]);
  const ledger = emptyLedger();
  ledger.lastPoll[mark(specs)] = '2026-11-01T05:00:00.000Z';
  // 01:30 EDT is 05:30Z; 01:30 EST is 06:30Z, the same wall key
  const first = await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-01T05:31:00Z') });
  assert.deepEqual(first.map((f) => f.key), [`schedule:${mark(specs)}:2026-11-01T01:30`]);
  await fireAll(h, ledger, first);
  const second = await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-01T06:31:00Z') });
  assert.deepEqual(second, []);
});

test('a label trigger fires once per issue', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addIssue(REPO, 7, { labels: ['bug'] });
  gh.addIssue(REPO, 8, { labels: ['bug'] });
  gh.addIssue(REPO, 9, { labels: ['other'] });
  const specs = spec('hotfix', [{ label: 'bug' }]);
  const ledger = await loadLedger(h);
  const live = new Set([`https://${REPO}/issues/8`]);
  const first = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z'), live });
  assert.deepEqual(first, [{ key: `label:${REPO}:hotfix:7`, pipeline: 'hotfix', ticket: `https://${REPO}/issues/7`, inputs: {} }]);
  await fireAll(h, ledger, first);
  const second = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z'), live });
  assert.deepEqual(second, []);
  const fired = (await loadLedger(h)).fired;
  assert.deepEqual(Object.keys(fired).sort(), [`label:${REPO}:hotfix:7`, `label:${REPO}:hotfix:8`]);
  assert.equal(fired[`label:${REPO}:hotfix:8`]?.runId, '');
});

test('a labelled issue a live run already answers does not fire once that run finishes', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addIssue(REPO, 5, { labels: ['bug'] });
  const specs = spec('hotfix', [{ label: 'bug' }]);
  const ledger = emptyLedger();
  const live = new Set([`https://${REPO}/issues/5`]);
  assert.deepEqual(await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z'), live }), []);
  const after = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z'), live: new Set() });
  assert.deepEqual(after, []);
  assert.deepEqual(ledger.fired[`label:${REPO}:hotfix:5`], { runId: '', at: '2026-11-22T10:00:00.000Z' });
});

test('removing the label re-arms an issue, so labelling it again starts a new run', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const issue = gh.addIssue(REPO, 7, { labels: ['bug'] });
  const specs = spec('hotfix', [{ label: 'bug' }]);
  const ledger = emptyLedger();
  const key = `label:${REPO}:hotfix:7`;
  const first = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  await fireAll(h, ledger, first);
  await markPrepared(h, ledger, key);
  issue.labels = [];
  assert.deepEqual(await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') }), []);
  assert.equal(Object.hasOwn(ledger.fired, key), false);
  issue.labels = ['bug'];
  const again = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:02:00Z') });
  assert.deepEqual(again.map((f) => f.key), [key]);
});

test("an issue one label trigger fired stays fired while another label trigger of the pipeline polls", async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addIssue(REPO, 7, { labels: ['bug'] });
  const specs = spec('hotfix', [{ label: 'bug' }, { label: 'urgent' }]);
  const ledger = emptyLedger();
  await fireAll(h, ledger, await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') }));
  await markPrepared(h, ledger, `label:${REPO}:hotfix:7`);
  assert.deepEqual(await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') }), []);
  assert.equal(Object.hasOwn(ledger.fired, `label:${REPO}:hotfix:7`), true);
});

test('a label firing never prepared is kept for a restarted watcher to start, even without its label', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const issue = gh.addIssue(REPO, 7, { labels: ['bug'] });
  const specs = spec('hotfix', [{ label: 'bug' }]);
  const ledger = emptyLedger();
  await fireAll(h, ledger, await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') }));
  issue.labels = [];
  await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') });
  assert.equal(Object.hasOwn(ledger.fired, `label:${REPO}:hotfix:7`), true);
});

test('a full page of labelled issues re-arms nothing, since more may be past it', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  for (let n = 1; n <= 100; n++) gh.addIssue(REPO, n, { labels: ['bug'] });
  const specs = spec('hotfix', [{ label: 'bug' }]);
  const ledger = emptyLedger();
  ledger.fired[`label:${REPO}:hotfix:500`] = { runId: '', at: '2026-11-22T09:00:00.000Z' };
  await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  assert.equal(Object.hasOwn(ledger.fired, `label:${REPO}:hotfix:500`), true);
});

test('dependabot fires only for dependabot PRs', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 1, author: 'dependabot[bot]' });
  gh.addPr(REPO, { number: 2, author: 'app/dependabot' });
  gh.addPr(REPO, { number: 3, author: 'alice' });
  const specs = spec('deps', [{ dependabot: true }]);
  const firings = await poll({ h, gh, specs, ledger: polled(specs), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(firings, [
    { key: `pr:${REPO}:deps:1`, pipeline: 'deps', inputs: { pr: `https://${REPO}/pull/1` } },
    { key: `pr:${REPO}:deps:2`, pipeline: 'deps', inputs: { pr: `https://${REPO}/pull/2` } },
  ]);
});

test('pr_opened skips not_author', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 4, author: 'alice' });
  gh.addPr(REPO, { number: 5, author: 'renovate[bot]' });
  const specs = spec('review', [{ pr_opened: { not_author: ['renovate[bot]'] } }]);
  const firings = await poll({ h, gh, specs, ledger: polled(specs), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(firings, [{ key: `pr:${REPO}:review:4`, pipeline: 'review', inputs: { pr: `https://${REPO}/pull/4` } }]);
  const every = spec('review', [{ pr_opened: true }]);
  const all = await poll({ h, gh, specs: every, ledger: polled(every), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(all.map((f) => f.key), [`pr:${REPO}:review:4`, `pr:${REPO}:review:5`]);
});

test('check_failed passes branch and run_url', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const run = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI', workflow: 'ci.yml' });
  gh.addFailedRun(REPO, { branch: 'main', workflowName: 'Docs', workflow: 'docs.yml' });
  gh.addFailedRun(REPO, { branch: 'dev', workflowName: 'CI', workflow: 'ci.yml' });
  const specs = spec('ci-fix', [{ check_failed: { branch: 'main', workflow: 'ci.yml' } }]);
  const firings = await poll({ h, gh, specs, ledger: polled(specs), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(firings, [
    { key: `check:${REPO}:ci-fix:${run.databaseId}`, pipeline: 'ci-fix', inputs: { branch: 'main', run_url: run.url } },
  ]);
});

test('the first poll of a pr trigger records every open PR as seen and fires only later ones', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 1, author: 'alice' });
  gh.addPr(REPO, { number: 2, author: 'bob' });
  const specs = spec('review', [{ pr_opened: true }]);
  const ledger = emptyLedger();
  const now = new Date('2026-11-22T10:00:00Z');
  assert.deepEqual(await poll({ h, gh, specs, ledger, now }), []);
  assert.deepEqual(ledger.fired, {
    [`pr:${REPO}:review:1`]: { runId: '', at: now.toISOString() },
    [`pr:${REPO}:review:2`]: { runId: '', at: now.toISOString() },
  });
  assert.equal(ledger.lastPoll[mark(specs)], now.toISOString());
  gh.addPr(REPO, { number: 3, author: 'carol' });
  const later = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') });
  assert.deepEqual(later.map((f) => f.key), [`pr:${REPO}:review:3`]);
});

test("a trigger's first poll does not swallow a PR another trigger of the pipeline fires in that poll, in either order", async (t) => {
  const h = await home(t);
  const old = { pr_opened: true } as const;
  const added = { dependabot: true } as const;
  for (const triggers of [[old, added], [added, old]]) {
    const gh = new FakeGh();
    gh.addPr(REPO, { number: 7, author: 'dependabot[bot]' });
    const ledger: Ledger = { version: 1, fired: {}, lastPoll: { [`${REPO}:deps:${triggerId(old)}`]: '2026-11-22T09:00:00.000Z' } };
    const firings = await poll({ h, gh, specs: spec('deps', triggers), ledger, now: new Date('2026-11-22T10:00:00Z') });
    assert.deepEqual(firings.map((f) => f.key), [`pr:${REPO}:deps:7`], JSON.stringify(triggers));
    assert.equal(Object.hasOwn(ledger.fired, `pr:${REPO}:deps:7`), false);
  }
});

test('a poll drops done PR and check keys older than a week that its lists no longer show, and keeps the rest', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 2, author: 'alice' });
  const failing = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI', workflow: 'ci.yml' });
  const specs = spec('ops', [{ pr_opened: true }, { check_failed: { branch: 'main' } }]);
  const ledger = polled(specs);
  const old = '2026-11-10T10:00:00.000Z';
  const recent = '2026-11-20T10:00:00.000Z';
  ledger.fired = {
    [`pr:${REPO}:ops:1`]: { runId: '', at: old }, // closed, seen, old: dropped
    [`pr:${REPO}:ops:2`]: { runId: '', at: old }, // still open: kept
    [`pr:${REPO}:ops:3`]: { runId: 'r3', at: recent, prepared: true }, // closed but recent: kept
    [`pr:${REPO}:ops:4`]: { runId: 'r4', at: old, pipeline: 'ops', inputs: {} }, // never prepared: kept for a restart
    [`pr:${REPO}:ops:5`]: { runId: 'r5', at: old, prepared: true }, // closed, prepared, old: dropped
    [`check:${REPO}:ops:${failing.databaseId}`]: { runId: '', at: old }, // still listed: kept
    [`check:${REPO}:ops:999`]: { runId: 'r9', at: old, prepared: true }, // off the list, old: dropped
    [`check:${REPO}:ops:998`]: { runId: '', at: recent }, // off the list but recent: kept
  };
  await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(Object.keys(ledger.fired).sort(), [
    `check:${REPO}:ops:${failing.databaseId}`,
    `check:${REPO}:ops:998`,
    `pr:${REPO}:ops:2`,
    `pr:${REPO}:ops:3`,
    `pr:${REPO}:ops:4`,
  ]);
});

test('a check trigger that lists no failure at all still drops old check keys', async (t) => {
  const h = await home(t);
  const specs = spec('ops', [{ check_failed: { branch: 'main' } }]);
  const ledger = polled(specs);
  ledger.fired = { [`check:${REPO}:ops:999`]: { runId: '', at: '2026-11-10T10:00:00.000Z' } };
  await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(ledger.fired, {});
});

test('a full page of open PRs drops no PR key, since more may be past it', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  for (let n = 100; n < 200; n++) gh.addPr(REPO, { number: n, author: 'alice' });
  const specs = spec('ops', [{ pr_opened: true }]);
  const ledger = polled(specs);
  ledger.fired = { [`pr:${REPO}:ops:1`]: { runId: '', at: '2026-11-10T10:00:00.000Z' } };
  await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  assert.equal(Object.hasOwn(ledger.fired, `pr:${REPO}:ops:1`), true);
});

test('the first poll of a check_failed trigger records every current failure as seen', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const run = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI' });
  const specs = spec('ci-fix', [{ check_failed: { branch: 'main' } }]);
  const ledger = emptyLedger();
  assert.deepEqual(await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') }), []);
  assert.deepEqual(Object.keys(ledger.fired), [`check:${REPO}:ci-fix:${run.databaseId}`]);
  const next = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI' });
  const later = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') });
  assert.deepEqual(later.map((f) => f.key), [`check:${REPO}:ci-fix:${next.databaseId}`]);
});

test('a failed run re-run that fails again fires once more, keyed by its attempt', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const run = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI' });
  const specs = spec('ci-fix', [{ check_failed: { branch: 'main' } }]);
  const ledger = polled(specs);
  const first = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(first.map((f) => f.key), [`check:${REPO}:ci-fix:${run.databaseId}`]);
  await fireAll(h, ledger, first);
  gh.rerun(run.databaseId);
  const again = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z') });
  assert.deepEqual(again, [
    { key: `check:${REPO}:ci-fix:${run.databaseId}.2`, pipeline: 'ci-fix', inputs: { branch: 'main', run_url: run.url } },
  ]);
});

test("a restarted watcher's first poll records PRs and failures that appeared while it was stopped as seen", async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 1, author: 'alice' });
  gh.addPr(REPO, { number: 2, author: 'dependabot[bot]' });
  const run = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI' });
  const specs = {
    ...spec('review', [{ pr_opened: true }]),
    ...spec('deps', [{ dependabot: true }]),
    ...spec('ci-fix', [{ check_failed: { branch: 'main' } }]),
  };
  // every trigger was polled before the watcher stopped
  const before = '2026-11-22T09:00:00.000Z';
  const ledger = polled(specs, before);
  const now = new Date('2026-11-22T10:00:00Z');
  assert.deepEqual(await poll({ h, gh, specs, ledger, now, first: true }), []);
  assert.deepEqual(ledger.fired, {
    [`pr:${REPO}:review:1`]: { runId: '', at: now.toISOString() },
    [`pr:${REPO}:review:2`]: { runId: '', at: now.toISOString() },
    [`pr:${REPO}:deps:2`]: { runId: '', at: now.toISOString() },
    [`check:${REPO}:ci-fix:${run.databaseId}`]: { runId: '', at: now.toISOString() },
  });
  gh.addPr(REPO, { number: 3, author: 'dependabot[bot]' });
  const later = await poll({ h, gh, specs, ledger, now: new Date('2026-11-22T10:01:00Z'), first: false });
  assert.deepEqual(later.map((f) => f.key), [`pr:${REPO}:review:3`, `pr:${REPO}:deps:3`]);
});

test("a restarted watcher's first poll still fires a labelled issue", async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addIssue(REPO, 7, { labels: ['hotfix'] });
  const specs = spec('hotfix', [{ label: 'hotfix' }]);
  const firings = await poll({ h, gh, specs, ledger: polled(specs), now: new Date('2026-11-22T10:00:00Z'), first: true });
  assert.deepEqual(firings.map((f) => f.key), [`label:${REPO}:hotfix:7`]);
});
