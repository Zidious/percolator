import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Trigger } from '../../src/config/schema.ts';
import type { PipelineSpec } from '../../src/config/pipelines.ts';
import { fire, loadLedger } from '../../src/watch/ledger.ts';
import type { Ledger } from '../../src/watch/ledger.ts';
import { pollTriggers } from '../../src/watch/poll.ts';
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

type Opts = { h: string; gh: FakeGh; specs: Record<string, PipelineSpec>; ledger: Ledger; now: Date; live?: Set<string> };

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
  });
}

/** Fire every firing through the real ledger, as the watcher does. */
async function fireAll(h: string, ledger: Ledger, firings: Firing[]): Promise<void> {
  let n = 0;
  for (const f of firings) await fire(h, ledger, f.key, async () => {}, () => `run-${++n}`);
}

test('a schedule fires once for the latest missed tick', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '0 * * * *', timezone: 'UTC', inputs: { scope: 'all' } }]);
  const ledger = emptyLedger();
  ledger.lastPoll[`${REPO}:nightly:0`] = '2026-11-22T07:30:00.000Z';
  const now = new Date('2026-11-22T10:15:00Z');
  const firings = await poll({ h, gh: new FakeGh(), specs, ledger, now });
  assert.deepEqual(firings, [{ key: `schedule:${REPO}:nightly:0:2026-11-22T10:00`, pipeline: 'nightly', inputs: { scope: 'all' } }]);
  assert.equal(ledger.lastPoll[`${REPO}:nightly:0`], now.toISOString());
  await fireAll(h, ledger, firings);
  assert.deepEqual(await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-22T10:45:00Z') }), []);
});

test('the first poll seeds lastPoll and fires nothing', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '* * * * *', timezone: 'Europe/London' }]);
  const ledger = emptyLedger();
  const now = new Date('2026-11-22T10:15:00Z');
  assert.deepEqual(await poll({ h, gh: new FakeGh(), specs, ledger, now }), []);
  assert.deepEqual(ledger.lastPoll, { [`${REPO}:nightly:0`]: now.toISOString() });
});

test('a fall-back duplicate hour does not refire', async (t) => {
  const h = await home(t);
  const specs = spec('nightly', [{ schedule: '30 1 * * *', timezone: 'America/New_York' }]);
  const ledger = emptyLedger();
  ledger.lastPoll[`${REPO}:nightly:0`] = '2026-11-01T05:00:00.000Z';
  // 01:30 EDT is 05:30Z; 01:30 EST is 06:30Z, the same wall key
  const first = await poll({ h, gh: new FakeGh(), specs, ledger, now: new Date('2026-11-01T05:31:00Z') });
  assert.deepEqual(first.map((f) => f.key), [`schedule:${REPO}:nightly:0:2026-11-01T01:30`]);
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
  assert.deepEqual(Object.keys((await loadLedger(h)).fired), [`label:${REPO}:hotfix:7`]);
});

test('dependabot fires only for dependabot PRs', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  gh.addPr(REPO, { number: 1, author: 'dependabot[bot]' });
  gh.addPr(REPO, { number: 2, author: 'app/dependabot' });
  gh.addPr(REPO, { number: 3, author: 'alice' });
  const specs = spec('deps', [{ dependabot: true }]);
  const firings = await poll({ h, gh, specs, ledger: emptyLedger(), now: new Date('2026-11-22T10:00:00Z') });
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
  const firings = await poll({ h, gh, specs, ledger: emptyLedger(), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(firings, [{ key: `pr:${REPO}:review:4`, pipeline: 'review', inputs: { pr: `https://${REPO}/pull/4` } }]);
  const all = await poll({ h, gh, specs: spec('review', [{ pr_opened: true }]), ledger: emptyLedger(), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(all.map((f) => f.key), [`pr:${REPO}:review:4`, `pr:${REPO}:review:5`]);
});

test('check_failed passes branch and run_url', async (t) => {
  const h = await home(t);
  const gh = new FakeGh();
  const run = gh.addFailedRun(REPO, { branch: 'main', workflowName: 'CI', workflow: 'ci.yml' });
  gh.addFailedRun(REPO, { branch: 'main', workflowName: 'Docs', workflow: 'docs.yml' });
  gh.addFailedRun(REPO, { branch: 'dev', workflowName: 'CI', workflow: 'ci.yml' });
  const specs = spec('ci-fix', [{ check_failed: { branch: 'main', workflow: 'ci.yml' } }]);
  const firings = await poll({ h, gh, specs, ledger: emptyLedger(), now: new Date('2026-11-22T10:00:00Z') });
  assert.deepEqual(firings, [
    { key: `check:${REPO}:ci-fix:${run.databaseId}`, pipeline: 'ci-fix', inputs: { branch: 'main', run_url: run.url } },
  ]);
});
