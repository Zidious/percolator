import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newState } from '../../src/engine/state.ts';
import type { RunState, StepRecord } from '../../src/engine/state.ts';
import { prUrl, readLatest } from '../../src/run/outputs.ts';

function record(stepId: string, outputs: Record<string, string>): StepRecord {
  return { stepId, attempt: 1, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', status: 'pass', outputs };
}

function stateWith(...history: StepRecord[]): RunState {
  return { ...newState({ runId: 'r', profile: 'p', groundVersions: {} }), history };
}

async function runDirWith(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-outputs-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

test('readLatest reads the trimmed file of the latest record with the key', async () => {
  const dir = await runDirWith({ 'a/pr_url.md': 'old\n', 'b/pr_url.md': '  https://x/pull/2\n' });
  const state = stateWith(record('a', { pr_url: 'a/pr_url.md' }), record('c', { notes: 'c/notes.md' }), record('b', { pr_url: 'b/pr_url.md' }));
  assert.equal(await readLatest(dir, state, 'pr_url'), 'https://x/pull/2');
});

test('readLatest is undefined when no record has the key, its file is gone, or it is blank', async () => {
  const dir = await runDirWith({ 'a/blank.md': ' \n' });
  assert.equal(await readLatest(dir, stateWith(record('a', { other: 'a/other.md' })), 'pr_url'), undefined);
  assert.equal(await readLatest(dir, stateWith(record('a', { pr_url: 'a/gone.md' })), 'pr_url'), undefined);
  assert.equal(await readLatest(dir, stateWith(record('a', { pr_url: 'a/blank.md' })), 'pr_url'), undefined);
});

test('prUrl is the latest pr_url output', async () => {
  const dir = await runDirWith({ 'd/pr_url.md': 'https://x/pull/7\n' });
  assert.equal(await prUrl(dir, stateWith(record('d', { pr_url: 'd/pr_url.md' }))), 'https://x/pull/7');
});
