import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadState, newState, saveState } from '../../src/engine/state.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-state-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const init = { runId: 'r1', ticket: 'T-1', profile: 'default', groundVersions: { spec: 'abc' } };

test('newState starts at cursor 0, running, empty history', () => {
  expect(newState(init)).toEqual({
    version: 1,
    runId: 'r1',
    ticket: 'T-1',
    profile: 'default',
    groundVersions: { spec: 'abc' },
    cursor: 0,
    rounds: {},
    executed: {},
    history: [],
    status: 'running',
  });
});

test('round-trips state', async () => {
  const s = newState(init);
  s.cursor = 2;
  s.rounds = { review: 1 };
  s.executed = { build: 1 };
  s.history.push({
    stepId: 'build',
    attempt: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'pass',
    outputs: { out: 'x' },
  });
  s.status = 'paused';
  s.pausedReason = 'needs human';
  s.unresolvedFindings = 'f1';
  await saveState(dir, s);
  expect(await loadState(dir)).toEqual(s);
});

test('a stray partial tmp file does not affect load', async () => {
  const s1 = newState(init);
  await saveState(dir, s1);
  await fs.writeFile(path.join(dir, 'state.json.123.x.tmp'), '{"trunc');
  expect(await loadState(dir)).toEqual(s1);
});

test('later save replaces earlier and leaves no tmp files', async () => {
  const s = newState(init);
  await saveState(dir, s);
  s.cursor = 5;
  await saveState(dir, s);
  expect((await loadState(dir)).cursor).toBe(5);
  expect(await fs.readdir(dir)).toEqual(['state.json']);
});

test('unknown version is rejected naming the file', async () => {
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...newState(init), version: 2 }));
  await expect(loadState(dir)).rejects.toThrow(/state\.json.*version/);
});

test('missing state.json is rejected naming the file', async () => {
  await expect(loadState(dir)).rejects.toThrow(/state\.json/);
});

test('invalid JSON is rejected naming the file', async () => {
  await fs.writeFile(path.join(dir, 'state.json'), '{"trunc');
  await expect(loadState(dir)).rejects.toThrow(/state\.json.*not valid JSON/);
});
