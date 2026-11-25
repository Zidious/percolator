import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPipelines, runNextChoices } from '../../herdr/mods/percolator/model.js';

function readFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', name), 'utf8'));
}

test('the fixture covers every state the panel draws', () => {
  const runs = readFixture('status.json').runs;
  const kinds = new Set(runs.map((r: any) => r.attention?.kind ?? r.status));
  for (const k of ['gate', 'cap', 'paused', 'questions', 'findings', 'failed', 'stalled', 'agent', 'running', 'completed', 'unreadable']) assert.ok(kinds.has(k), k);
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

test('the empty fixture has no runs and no watcher', () =>
  assert.deepEqual(readFixture('empty.json'), { schema: 2, runs: [], watcher: { alive: false, repos: [] } }));

test('the fixture has a watcher on its repo, a triage parent with a hotfix child, and a triage run waiting at its pick', () => {
  const j = readFixture('status.json');
  assert.deepEqual(j.watcher, { alive: true, since: '2026-11-21T05:00:00.000Z', repos: ['/home/me/src/percolator'] });
  const parent = j.runs.find((r: any) => r.pipeline === 'triage' && r.status === 'completed');
  const child = j.runs.find((r: any) => r.pipeline === 'hotfix');
  assert.equal(child.parent, parent.id);
  assert.deepEqual(parent.children, [{ id: child.id, pipeline: 'hotfix', status: child.status }]);
  const pick = j.runs.find((r: any) => r.pipeline === 'triage' && r.status === 'waiting');
  assert.deepEqual([pick.currentStep, pick.attention.actions, pick.attention.choices], ['pick-pipeline', ['pick', 'reject'], ['hotfix', 'feature']]);
  assert.equal(pick.attention.message, 'pick the pipeline for this ticket (the agent suggests hotfix)');
});

test('the fixture has a fanned-out run with a finished, a running and a pending slice', () => {
  const runs = readFixture('status.json').runs;
  const parent = runs.find((r: any) => r.children.some?.((c: any) => c.slice));
  assert.equal(parent.status, 'running');
  // the parent's graph ends at its fan-out step, which waits for the slices
  assert.equal(parent.steps.at(-1).id, parent.currentStep);
  assert.deepEqual(
    parent.children.map((c: any) => [c.id, c.slice.index, c.status]),
    [1, 2, 3].map((i) => [`${parent.id}-s${i}`, i, ['completed', 'running', 'pending'][i - 1]]),
  );
  for (const c of parent.children) {
    const run = runs.find((r: any) => r.id === c.id);
    if (c.status === 'pending') {
      assert.equal(run, undefined, c.id);
      continue;
    }
    assert.deepEqual([run.parent, run.pipeline, run.status, run.ticket.ref], [parent.id, parent.pipeline, c.status, parent.ticket.ref], c.id);
    // a slice starts with its seed intake, then the fanned stage
    assert.deepEqual(run.steps.slice(0, 2).map((s: any) => s.id), ['intake', parent.currentStep], c.id);
  }
  assert.ok(runs.find((r: any) => r.id === `${parent.id}-s1`).pr.url);
});

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

test('the fixture has a finished run that offers run next and one hidden by a live run on its ticket', () => {
  const runs = readFixture('status.json').runs;
  const pipelines = readFixture('pipelines.json').pipelines;
  const of = (prefix: string) => runs.find((r: any) => r.id.startsWith(`${prefix}-`));
  assert.deepEqual(runNextChoices(of('t3'), pipelines, runs), {
    tickets: ['github.com/zidious/percolator#3'],
    pipelines: ['feature', 'hotfix', 'spike'],
  });
  assert.equal(runNextChoices(of('t21-triage'), pipelines, runs), null, 'the hotfix child is live on #21');
  // a ticketless run whose issue exit opened two issues offers them (the picker's ticket is a select)
  const audit = of('audit');
  assert.equal(audit.ticket, null);
  assert.deepEqual(runNextChoices(audit, pipelines, runs)?.tickets, ['github.com/zidious/percolator#31', 'github.com/zidious/percolator#32']);
});

test('the fixture has a findings run with two review slots, both files in its box', () => {
  const t26 = readFixture('status.json').runs.find((r: any) => r.id === 't26-20261125-030000-ab12');
  assert.deepEqual(t26.attention.review.map((r: any) => r.step), ['review.0', 'review.1']);
  assert.equal(t26.attention.asked.items.length, 5);
});
