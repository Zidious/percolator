import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', name), 'utf8'));
}

test('the fixture covers every state the panel draws', () => {
  const runs = readFixture('status.json').runs;
  const kinds = new Set(runs.map((r: any) => r.attention?.kind ?? r.status));
  for (const k of ['gate', 'cap', 'paused', 'failed', 'stalled', 'agent', 'running', 'completed', 'unreadable']) assert.ok(kinds.has(k), k);
  const t16 = runs.find((r: any) => r.id === 't16-20261121-040000-1a2b');
  assert.equal(t16.loops[0].round, 1);
  assert.equal(t16.steps.filter((s: any) => s.role === 'node' && s.status === 'pass').length, 4);
  assert.ok(t16.steps.some((s: any) => s.id === 'coverage' && s.status === 'fail'));
  const t17 = runs.find((r: any) => r.id === 't17-20261121-050000-3c4d');
  assert.deepEqual(t17.steps.filter((s: any) => s.role === 'core' && s.stage === 'implement').map((s: any) => s.id), ['implement.0', 'implement.1']);
});

test('the empty fixture has no runs', () => assert.deepEqual(readFixture('empty.json'), { schema: 1, runs: [] }));
