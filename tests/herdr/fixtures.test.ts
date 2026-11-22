import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPipelines } from '../../herdr/mods/percolator/model.js';

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

test('the fixture is what perc writes: hooks carry their plain stage, loops go back to the region start of the stage before review', () => {
  const runs = readFixture('status.json').runs.filter((r: any) => r.status !== 'unreadable');
  for (const r of runs) {
    // feature's stages are the six core stages; another pipeline's are those of its core steps
    const stages: string[] =
      r.pipeline === 'feature'
        ? ['intake', 'groom', 'plan', 'implement', 'review', 'deliver']
        : [...new Set<string>(r.steps.filter((s: any) => s.role === 'core').map((s: any) => s.stage))];
    for (const s of r.steps) assert.ok([...stages, 'before-all', 'after-all'].includes(s.stage), `${r.id} ${s.id}`);
    const before = stages[stages.indexOf('review') - 1];
    const start = r.steps.find((s: any) => s.stage === before)?.id;
    for (const l of r.loops.filter((l: any) => l.id === 'review')) assert.equal(l.to, start, r.id);
  }
  const to = (id: string) => runs.find((r: any) => r.id.startsWith(`${id}-`)).loops[0].to;
  assert.deepEqual([to('t8'), to('t16'), to('t4')], ['lint-plan', 'lint-baseline', 'implement']);
  assert.equal(runs.find((r: any) => r.id.startsWith('t17-')).currentStep, 'implement.1');
});

test('the fixture is schema 2: every readable run has its pipeline, inputs, parent, children and opened issues', () => {
  const j = readFixture('status.json');
  assert.equal(j.schema, 2);
  for (const r of j.runs.filter((r: any) => r.status !== 'unreadable')) {
    assert.equal(typeof r.pipeline, 'string', r.id);
    assert.equal(typeof r.inputs, 'object', r.id);
    assert.ok('ticket' in r && 'parent' in r && Array.isArray(r.children) && Array.isArray(r.opened), r.id);
  }
});

test('the fixture has a ticketless run and a hotfix run', () => {
  const runs = readFixture('status.json').runs;
  const dd = runs.find((r: any) => r.pipeline === 'dd-alert');
  assert.equal(dd.ticket, null);
  assert.deepEqual(Object.keys(dd.inputs), ['alert_url']);
  assert.equal(dd.attention.kind, 'gate');
  assert.equal(dd.attention.message, 'approve or reject here (no issue to comment on)');
  assert.equal('commentUrl' in dd.attention, false);
  const hotfix = runs.find((r: any) => r.pipeline === 'hotfix');
  assert.equal(hotfix.ticket.number, 21);
  assert.equal(hotfix.status, 'running');
  assert.deepEqual(hotfix.steps.filter((s: any) => s.role === 'core').map((s: any) => s.id), ['intake', 'reproduce', 'fix', 'review', 'deliver']);
});

test('the empty fixture has no runs', () => assert.deepEqual(readFixture('empty.json'), { schema: 2, runs: [] }));

test('the pipelines fixture is what perc pipelines --json writes: feature (default), hotfix, dd-alert and spike', () => {
  const read = readPipelines(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'pipelines.json'), 'utf8'));
  assert.ok(read.ok, 'readPipelines accepts it');
  const ps: any[] = read.data.pipelines;
  assert.deepEqual(ps.map((p) => p.name), ['feature', 'hotfix', 'dd-alert', 'spike']);
  assert.deepEqual(ps.map((p) => [p.default, p.ticket]), [[true, 'required'], [false, 'required'], [false, 'none'], [false, 'optional']]);
  const ids = (name: string) => ps.find((p) => p.name === name).steps.map((s: any) => s.id);
  assert.deepEqual(ids('feature'), ['intake', 'groom', 'approve-groom', 'plan', 'implement', 'review', 'deliver']);
  assert.deepEqual(ids('hotfix'), ['intake', 'reproduce', 'fix', 'review', 'deliver']);
  assert.deepEqual(ids('dd-alert'), ['intake', 'gather', 'diagnose', 'report']);
  assert.deepEqual(ids('spike'), ['intake', 'research', 'write-up', 'report']);
  const dd = ps.find((p) => p.name === 'dd-alert');
  assert.equal(dd.exit, 'none');
  assert.deepEqual(dd.inputs, [{ name: 'alert_url', required: true, description: 'Datadog alert URL' }]);
  assert.deepEqual(ps[0].loops.map((l: any) => [l.from, l.to]), [['review', 'implement']]);
});
