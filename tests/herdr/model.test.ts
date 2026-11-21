import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  STAGES,
  actionArgv,
  needsCount,
  newlyNeeding,
  parseStatus,
  rowState,
  runningCount,
  sortRuns,
  trainLayout,
  visibleRuns,
  xOf,
} from '../../herdr/mods/percolator/model.js';
import type { RunStatusJson, StatusJson } from '../../src/run/status.ts';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'status.json');
const RAW = fs.readFileSync(FIXTURE, 'utf8');
const load = (): StatusJson => JSON.parse(RAW) as StatusJson;
const runs = () => load().runs;
const byId = (prefix: string): RunStatusJson => runs().find((r) => r.id.startsWith(`${prefix}-`))!;
type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
const readable = (prefix: string) => byId(prefix) as Readable;
const ids = (rs: { id: string }[]) => rs.map((r) => r.id.split('-')[0]);
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('the fixture covers every attention kind, a running run, a completed run and an unreadable entry', () => {
  const kinds = runs().flatMap((r) => ('attention' in r && r.attention ? [r.attention.kind] : []));
  assert.deepEqual([...new Set(kinds)].sort(), ['agent', 'cap', 'failed', 'gate', 'paused', 'stalled']);
  assert.ok(runs().some((r) => r.status === 'running' && !('attention' in r && r.attention)));
  assert.ok(runs().some((r) => r.status === 'completed'));
  assert.ok(runs().some((r) => r.status === 'unreadable'));
});

test('STAGES lists the six core stages in order', () => {
  assert.deepEqual([...STAGES], ['intake', 'groom', 'plan', 'implement', 'review', 'deliver']);
});

test('parseStatus returns the parsed data for good JSON', () => {
  assert.deepEqual(parseStatus(RAW), { ok: true, data: load() });
});

test('parseStatus refuses text that is not JSON', () => {
  assert.deepEqual(parseStatus('{"schema": 1, "ru'), { ok: false, error: 'perc status --json returned invalid JSON' });
});

test('parseStatus refuses JSON without a runs list', () => {
  for (const bad of ['null', '[]', '{"schema":1}', '{"schema":1,"runs":3}']) {
    assert.deepEqual(parseStatus(bad), { ok: false, error: 'perc status --json returned invalid JSON' }, bad);
  }
});

test('sortRuns puts attention first, then running, then the rest, each newest first; unreadable last', () => {
  const input = runs();
  const before = ids(input);
  assert.deepEqual(ids(sortRuns(input)), ['t13', 't12', 't2', 't11', 't9', 't4', 't8', 't3', 't5']);
  assert.deepEqual(ids(input), before, 'sortRuns does not mutate its input');
});

test('visibleRuns "active" hides completed and failed runs unless they need attention', () => {
  const rs = runs();
  const failedQuiet = { ...readable('t9'), id: 't99-quiet' } as Readable;
  delete failedQuiet.attention;
  assert.deepEqual(ids(visibleRuns([...rs, failedQuiet], 'active')), ['t8', 't2', 't4', 't12', 't9', 't11', 't13', 't5']);
});

test('visibleRuns "all" keeps everything in order', () => {
  assert.deepEqual(ids(visibleRuns(runs(), 'all')), ids(runs()));
});

test('rowState gives the tone and the board text for each kind of run', () => {
  const cases: [string, string, string][] = [
    ['t2', 'blocked', 'your turn · approve-groom'],
    ['t4', 'blocked', 'paused · review at cap'],
    ['t12', 'blocked', 'paused · plan'],
    ['t9', 'blocked', 'failed · implement'],
    ['t11', 'blocked', 'stalled · driver stopped'],
    ['t13', 'blocked', 'agent blocked · groom'],
    ['t8', 'working', 'review · round 2/3'],
    ['t3', 'dim', 'delivered · PR #7'],
    ['t5', 'muted', 'unreadable · state.json: Unexpected end of JSON input'],
  ];
  for (const [id, tone, text] of cases) assert.deepEqual(rowState(byId(id)), { tone, text }, id);
});

test('rowState for a running step outside a loop shows only the step', () => {
  assert.deepEqual(rowState({ ...readable('t8'), currentStep: 'implement' }), { tone: 'working', text: 'implement' });
});

test('rowState for a completed run without a PR says delivered', () => {
  assert.deepEqual(rowState({ ...readable('t3'), pr: null }), { tone: 'dim', text: 'delivered' });
});

test('trainLayout wide shows every step in its zone in execution order', () => {
  const zones = trainLayout(byId('t8'), false);
  assert.deepEqual(
    zones.map((z) => [z.stage, z.shown.map((s) => s.id), z.hidden.map((s) => s.id)]),
    [
      ['intake', ['setup', 'intake'], []],
      ['groom', ['groom', 'approve-groom'], []],
      ['plan', ['plan'], []],
      ['implement', ['lint-plan', 'implement', 'security-scan'], []],
      ['review', ['review'], []],
      ['deliver', ['deliver', 'notify'], []],
    ],
  );
});

test('trainLayout narrow keeps core steps and folds the hooks', () => {
  const zones = trainLayout(byId('t8'), true);
  assert.deepEqual(
    zones.map((z) => [z.stage, z.shown.map((s) => s.id), z.hidden.map((s) => s.id)]),
    [
      ['intake', ['intake'], ['setup']],
      ['groom', ['groom'], ['approve-groom']],
      ['plan', ['plan'], []],
      ['implement', ['implement'], ['lint-plan', 'security-scan']],
      ['review', ['review'], []],
      ['deliver', ['deliver'], ['notify']],
    ],
  );
});

test('trainLayout puts before-all hooks first in intake and after-all hooks last in deliver', () => {
  const r = readable('t3');
  const hook = (id: string, stage: 'before-all' | 'after-all') =>
    ({ id, stage, role: 'node', kind: 'script', status: 'pass', attempts: 1, outputs: {} }) as Readable['steps'][number];
  const steps = [...r.steps.slice(0, 1), hook('late-setup', 'before-all'), hook('early-notify', 'after-all'), ...r.steps.slice(1)];
  const zones = trainLayout({ ...r, steps }, false);
  assert.deepEqual(zones[0]!.shown.map((s) => s.id), ['late-setup', 'intake']);
  assert.deepEqual(zones[5]!.shown.map((s) => s.id), ['deliver', 'early-notify']);
});

test('trainLayout narrow shows each slot step of a multi-step stage as a core stop', () => {
  const r = readable('t3');
  const core = (id: string) =>
    ({ id, stage: 'implement', role: 'core', kind: 'agent', status: 'pass', attempts: 1, outputs: {} }) as Readable['steps'][number];
  const steps = r.steps.flatMap((s) => (s.id === 'implement' ? [core('implement.0'), core('implement.1')] : [s]));
  assert.deepEqual(trainLayout({ ...r, steps }, true)[3]!.shown.map((s) => s.id), ['implement.0', 'implement.1']);
});

test('trainLayout narrow shows the hooks of a zone that has no core step', () => {
  const r = readable('t3');
  const steps = r.steps.map((s) => (s.id === 'plan' ? { ...s, role: 'node' as const } : s));
  const plan = trainLayout({ ...r, steps }, true)[2]!;
  assert.deepEqual([plan.shown.map((s) => s.id), plan.hidden], [['plan'], []]);
});

test('trainLayout of an unreadable run is six empty zones', () => {
  assert.deepEqual(
    trainLayout(byId('t5'), false),
    STAGES.map((stage) => ({ stage, shown: [], hidden: [] })),
  );
});

test('xOf gives the centre of a stop as % of the track', () => {
  const zones = trainLayout(byId('t2'), false);
  // each zone is a sixth; groom (zone 1) has two stops
  near(xOf(zones, 'intake'), (0.5 / 6) * 100);
  near(xOf(zones, 'groom'), (1.25 / 6) * 100);
  near(xOf(zones, 'approve-groom'), (1.75 / 6) * 100);
  near(xOf(zones, 'deliver'), (5.5 / 6) * 100);
});

test('xOf puts a folded step on its zone first shown stop', () => {
  const zones = trainLayout(byId('t2'), true);
  assert.equal(xOf(zones, 'approve-groom'), 25);
  assert.equal(xOf(zones, 'groom'), 25);
});

test('xOf is null for a step that is not on the train', () => {
  assert.equal(xOf(trainLayout(byId('t2'), false), 'nope'), null);
});

test('newlyNeeding is empty on the first load', () => {
  assert.deepEqual(newlyNeeding(null, runs()), []);
});

test('newlyNeeding returns a run that gained attention', () => {
  const prev = runs().map((r) => {
    if (!r.id.startsWith('t2-')) return r;
    const quiet = { ...(r as Readable) };
    delete quiet.attention;
    return quiet;
  });
  assert.deepEqual(ids(newlyNeeding(prev, runs())), ['t2']);
});

test('newlyNeeding returns a new run that arrives needing attention', () => {
  const next = runs();
  const prev = next.filter((r) => !r.id.startsWith('t13-'));
  assert.deepEqual(ids(newlyNeeding(prev, next)), ['t13']);
});

test('newlyNeeding is empty when nothing changed', () => {
  assert.deepEqual(newlyNeeding(runs(), runs()), []);
});

test('actionArgv maps each action to the perc argv', () => {
  const r = byId('t2');
  assert.deepEqual(actionArgv('approve', r), ['approve', r.id]);
  assert.deepEqual(actionArgv('reject', r, 'split it'), ['reject', r.id, '--', 'split it']);
  assert.deepEqual(actionArgv('grant', r), ['resume', r.id]);
  assert.deepEqual(actionArgv('resume', r), ['resume', r.id]);
  assert.deepEqual(actionArgv('clean', r), ['clean', r.id]);
});

test('actionArgv has no perc call for open-pane', () => {
  assert.equal(actionArgv('open-pane', byId('t13')), null);
});

test('rejectArgv keeps feedback whole', () => {
  const r = byId('t2');
  const feedback = '-x "quoted"\nline2';
  assert.deepEqual(actionArgv('reject', r, feedback), ['reject', r.id, '--', feedback]);
});

test('actionArgv refuses a reject without feedback', () => {
  for (const fb of [undefined, '', '  \n ']) {
    assert.throws(() => actionArgv('reject', byId('t2'), fb), { message: 'Say what to change' });
  }
});

test('needsCount counts runs with attention; runningCount counts running runs that need nothing', () => {
  assert.equal(needsCount(runs()), 6);
  assert.equal(runningCount(runs()), 1);
  assert.equal(needsCount([]), 0);
  assert.equal(runningCount([]), 0);
});
