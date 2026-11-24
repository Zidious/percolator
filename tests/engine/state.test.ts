import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { answerFindings, answerQuestions, loadState, newState, saveState } from '../../src/engine/state.ts';
import type { RunState } from '../../src/engine/state.ts';
import type { Graph } from '../../src/graph/build.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-state-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const init = { runId: 'r1', ticket: 'T-1', profile: 'default', groundVersions: { spec: 'abc' } };

test('newState starts at cursor 0, running, empty history', () => {
  assert.deepEqual(newState(init), {
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
  assert.deepEqual(await loadState(dir), s);
});

test('a stray partial tmp file does not affect load', async () => {
  const s1 = newState(init);
  await saveState(dir, s1);
  await fs.writeFile(path.join(dir, 'state.json.123.x.tmp'), '{"trunc');
  assert.deepEqual(await loadState(dir), s1);
});

test('later save replaces earlier and leaves no tmp files', async () => {
  const s = newState(init);
  await saveState(dir, s);
  s.cursor = 5;
  await saveState(dir, s);
  assert.equal((await loadState(dir)).cursor, 5);
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('unknown version is rejected naming the file', async () => {
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...newState(init), version: 2 }));
  await assert.rejects(loadState(dir), /state\.json.*version/);
});

test('missing state.json is rejected naming the file', async () => {
  await assert.rejects(loadState(dir), /state\.json/);
});

test('invalid JSON is rejected naming the file', async () => {
  await fs.writeFile(path.join(dir, 'state.json'), '{"trunc');
  await assert.rejects(loadState(dir), /state\.json.*not valid JSON/);
});

test('round-trips a pending back-edge jump', async () => {
  const s = newState(init);
  s.pendingJump = { edgeId: 'review', stepId: 'review', findings: 'f1' };
  await saveState(dir, s);
  assert.deepEqual((await loadState(dir)).pendingJump, { edgeId: 'review', stepId: 'review', findings: 'f1' });
});

for (const [field, value] of [
  ['cursor', -1],
  ['cursor', 1.5],
  ['cursor', '2'],
  ['status', 'bogus'],
  ['history', {}],
  ['rounds', { review: 'x' }],
  ['rounds', null],
  ['executed', [1]],
  ['graphFingerprint', 7],
] as const) {
  test(`loadState rejects an invalid ${field} (${JSON.stringify(value)}) naming the file and field`, async () => {
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, JSON.stringify({ ...newState(init), [field]: value }));
    await assert.rejects(loadState(dir), (e: Error) => {
      assert.equal(e.message, `Run state ${file} has an invalid "${field}": ${JSON.stringify(value)}`);
      return true;
    });
  });
}

test('round-trips a graph fingerprint', async () => {
  const s = { ...newState(init), graphFingerprint: 'abc' };
  await saveState(dir, s);
  assert.equal((await loadState(dir)).graphFingerprint, 'abc');
});

test('pendingJump without stepId still loads', async () => {
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, JSON.stringify({ ...newState(init), pendingJump: { edgeId: 'review', findings: 'f1' } }));
  assert.deepEqual((await loadState(dir)).pendingJump, { edgeId: 'review', findings: 'f1' });
});

for (const field of ['pausedCap', 'currentStep', 'grantedRound']) {
  test(`loadState rejects a non-string ${field}`, async () => {
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...newState(init), [field]: 7 }));
    await assert.rejects(loadState(dir), new RegExp(`invalid "${field}": 7`));
  });

  test(`${field} round-trips`, async () => {
    await saveState(dir, { ...newState(init), [field]: 'qa' });
    assert.equal((await loadState(dir) as Record<string, unknown>)[field], 'qa');
  });
}

test('loadState rejects a non-string mappingsFingerprint or a non-string-array mappingKeys', async () => {
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...newState(init), mappingsFingerprint: 7 }));
  await assert.rejects(loadState(dir), /invalid "mappingsFingerprint": 7/);
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...newState(init), mappingKeys: [1] }));
  await assert.rejects(loadState(dir), /invalid "mappingKeys": \[1\]/);
});

test('mappingsFingerprint and mappingKeys round-trip', async () => {
  await saveState(dir, { ...newState(init), mappingsFingerprint: 'f', mappingKeys: ['k'] });
  const s = await loadState(dir);
  assert.equal(s.mappingsFingerprint, 'f');
  assert.deepEqual(s.mappingKeys, ['k']);
});

test('answerQuestions records the answers for the asking step and stops asking', () => {
  const s = newState(init);
  s.cursor = 3;
  s.status = 'paused';
  s.asking = { kind: 'questions', stepId: 'plan.0', attempt: 1, items: ['q'] };
  answerQuestions(s, 'steps/plan.0/1/answers.md');
  assert.deepEqual(s.answered, { 'plan.0': { answers: 'steps/plan.0/1/answers.md' } });
  assert.ok(!('asking' in s));
  assert.equal(s.cursor, 3);
  assert.equal(s.status, 'paused');
  assert.throws(() => answerQuestions(s, 'x'), { message: 'run state is not asking questions' });
});

const loopGraph = {
  backEdges: { review: { id: 'review', fromStepId: 'review', toStepIndex: 5, jumpAfterIndex: 7, maxRounds: 3, onCap: 'continue' } },
} as unknown as Graph;

function askingFindings(findings?: string): RunState {
  const s = newState(init);
  s.cursor = 7;
  s.status = 'paused';
  s.rounds = { review: 3 };
  s.asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', ...(findings === undefined ? {} : { findings }) };
  return s;
}

test('answerFindings with agreed findings grants one more round with only those', () => {
  const s = askingFindings('steps/review/3/outputs/findings.md');
  answerFindings(s, loopGraph, 'steps/review/3/agreed-findings.md');
  assert.equal(s.rounds['review'], 2);
  assert.equal(s.grantedRound, 'review');
  assert.deepEqual(s.answered, { review: { findings: 'steps/review/3/agreed-findings.md' } });
  assert.ok(!('asking' in s));
});

test('answerFindings with none moves past the loop and keeps the findings as unresolved', () => {
  const s = askingFindings('steps/review/3/outputs/findings.md');
  answerFindings(s, loopGraph, undefined);
  assert.equal(s.cursor, 8);
  assert.equal(s.unresolvedFindings, 'steps/review/3/outputs/findings.md');
  assert.ok(!('asking' in s));
  assert.ok(!('grantedRound' in s));
  const t = askingFindings();
  t.unresolvedFindings = 'stale';
  answerFindings(t, loopGraph, undefined);
  assert.ok(!('unresolvedFindings' in t));
  assert.throws(() => answerFindings(t, loopGraph, undefined), { message: 'run state is not asking about findings' });
});

test('loadState rejects a bad asking or answered', async () => {
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, JSON.stringify({ ...newState(init), asking: { kind: 'maybe' } }));
  await assert.rejects(loadState(dir), { message: `Run state ${file} has an invalid "asking": {"kind":"maybe"}` });
  await fs.writeFile(file, JSON.stringify({ ...newState(init), answered: { plan: { answers: 1 } } }));
  await assert.rejects(loadState(dir), { message: `Run state ${file} has an invalid "answered": {"plan":{"answers":1}}` });
});

test('asking and answered round-trip', async () => {
  const s = askingFindings('f');
  s.answered = { plan: { answers: 'steps/plan/1/answers.md' } };
  await saveState(dir, s);
  assert.deepEqual(await loadState(dir), s);
  const q = newState(init);
  q.asking = { kind: 'questions', stepId: 'plan', attempt: 2, items: ['a'] };
  await saveState(dir, q);
  assert.deepEqual(await loadState(dir), q);
});
