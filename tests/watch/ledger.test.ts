import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fire, loadLedger, markPrepared, pruneLedger } from '../../src/watch/ledger.ts';
import type { Ledger } from '../../src/watch/ledger.ts';

const NOW = () => new Date('2026-11-22T10:00:00Z');

async function home(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-ledger-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function onDisk(h: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(h, 'watch', 'fired.json'), 'utf8'));
}

test('a fired key is recorded before the run starts', async (t) => {
  const h = await home(t);
  const ledger = await loadLedger(h);
  let seen: unknown;
  const result = await fire(
    h,
    ledger,
    { key: 'label:o/r:fix:7', pipeline: 'fix', ticket: 'https://o/r/issues/7', inputs: { a: 'b' } },
    async () => {
      seen = await onDisk(h);
    },
    () => 'run-1',
    NOW,
  );
  assert.deepEqual(result, { runId: 'run-1' });
  assert.deepEqual(seen, {
    version: 1,
    fired: {
      'label:o/r:fix:7': { runId: 'run-1', at: '2026-11-22T10:00:00.000Z', pipeline: 'fix', ticket: 'https://o/r/issues/7', inputs: { a: 'b' } },
    },
    lastPoll: {},
  });

  const failed = await fire(
    h,
    ledger,
    { key: 'label:o/r:fix:8', pipeline: 'fix', inputs: {} },
    async () => {
      throw new Error('hc is not running');
    },
    () => 'run-2',
    NOW,
  );
  assert.deepEqual(failed, { runId: 'run-2', error: 'hc is not running' });
  assert.deepEqual((await loadLedger(h)).fired['label:o/r:fix:8'], {
    runId: 'run-2',
    at: '2026-11-22T10:00:00.000Z',
    pipeline: 'fix',
    inputs: {},
  });
});

test('a restarted watcher does not refire', async (t) => {
  const h = await home(t);
  const f = { key: 'schedule:o/r:nightly:0:2026-11-22T02:00', pipeline: 'nightly', inputs: {} };
  await fire(h, await loadLedger(h), f, async () => {}, () => 'run-1', NOW);

  let started = false;
  const again = await fire(
    h,
    await loadLedger(h),
    f,
    async () => {
      started = true;
    },
    () => 'run-2',
    NOW,
  );
  assert.deepEqual(again, { skipped: true });
  assert.equal(started, false);
  assert.equal((await loadLedger(h)).fired['schedule:o/r:nightly:0:2026-11-22T02:00'].runId, 'run-1');
});

test('loadLedger of a missing file is empty', async (t) => {
  const h = await home(t);
  assert.deepEqual(await loadLedger(h), { version: 1, fired: {}, lastPoll: {} });
});

test("markPrepared records on disk that the firing's run was prepared", async (t) => {
  const h = await home(t);
  const ledger = await loadLedger(h);
  await fire(h, ledger, { key: 'label:o/r:fix:7', pipeline: 'fix', inputs: {} }, async () => {}, () => 'run-1', NOW);
  await markPrepared(h, ledger, 'label:o/r:fix:7');
  assert.equal((await loadLedger(h)).fired['label:o/r:fix:7']?.prepared, true);
});

test('pruneLedger drops schedule firings older than the 7-day lookback and keeps the rest', () => {
  const ledger: Ledger = {
    version: 1,
    fired: {
      'schedule:o/r:n:0:2026-11-14T10:00': { runId: 'old', at: '2026-11-14T10:00:00.000Z' },
      'schedule:o/r:n:0:2026-11-16T10:00': { runId: 'new', at: '2026-11-16T10:00:00.000Z' },
      'label:o/r:fix:7': { runId: 'label', at: '2026-01-01T00:00:00.000Z' },
    },
    lastPoll: {},
  };
  pruneLedger(ledger, new Date('2026-11-22T10:00:00Z'));
  assert.deepEqual(Object.keys(ledger.fired), ['schedule:o/r:n:0:2026-11-16T10:00', 'label:o/r:fix:7']);
});
