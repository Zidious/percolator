import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  STAGES,
  actionArgv,
  ago,
  attentionTag,
  BOARD_RATIO,
  boardHeight,
  dragBoard,
  fillHeight,
  readRatio,
  cliLines,
  terminalCommands,
  cupLabel,
  cupMoves,
  duration,
  findNode,
  ownsCommands,
  loopAtCap,
  loopLabel,
  moveRow,
  moveStop,
  needsCount,
  newlyNeeding,
  notice,
  parseStatus,
  readStatus,
  readerPath,
  resolvePath,
  rowState,
  runningCount,
  shownLoops,
  sortRuns,
  stepTone,
  took,
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

test('readStatus accepts schema 1', () => {
  assert.deepEqual(readStatus(RAW), { ok: true, data: load() });
});

test('readStatus refuses another schema and says to update the panel', () => {
  assert.deepEqual(readStatus('{"schema":2,"runs":[]}'), {
    ok: false,
    error: 'perc status --json returned schema 2; update the Percolator panel',
  });
});

test('readStatus passes on parseStatus errors', () => {
  assert.deepEqual(readStatus('nope'), { ok: false, error: 'perc status --json returned invalid JSON' });
});

test('duration rounds to the largest unit', () => {
  assert.deepEqual([0, 12.4, 59, 61, 3599, 3600, 7300, 86400, 200000].map(duration), [
    '0s', '12s', '59s', '1m', '60m', '1h', '2h', '1d', '2d',
  ]);
});

test('ago is the time since an ISO date, never negative; empty without one', () => {
  const now = Date.parse('2026-11-21T01:00:00.000Z');
  assert.equal(ago('2026-11-21T00:55:00.000Z', now), '5m');
  assert.equal(ago('2026-11-21T02:00:00.000Z', now), '0s');
  assert.equal(ago(undefined, now), '');
});

test('took is a finished step duration, or how long a running step has run; empty otherwise', () => {
  const now = Date.parse('2026-11-21T00:44:10.000Z');
  const step = (id: string) => readable('t8').steps.find((s) => s.id === id)!;
  assert.equal(took(step('groom'), now), '2m');
  assert.equal(took(step('review'), now), '3m');
  assert.equal(took(step('deliver'), now), '');
  assert.equal(took(step('setup'), now), '');
});

test('stepTone maps a step status to a theme colour name', () => {
  const tones = ['pass', 'running', 'waiting', 'fail', 'escalate', 'contract_error', 'pending'].map(stepTone);
  assert.deepEqual(tones, ['done', 'working', 'blocked', 'blocked', 'blocked', 'blocked', null]);
});

test('resolvePath keeps absolute paths and joins relative ones to the base folder', () => {
  assert.equal(resolvePath('C:/x/fixtures', 'samples/a.md'), 'C:/x/fixtures/samples/a.md');
  assert.equal(resolvePath('/x/fixtures/', 'samples/a.md'), '/x/fixtures/samples/a.md');
  for (const abs of ['/home/me/a.md', 'C:\\Users\\a.md', 'c:/a.md', '\\\\server\\share\\a.md']) {
    assert.equal(resolvePath('/x', abs), abs);
  }
});

test('cliLines gives the perc commands for a run actions, once each', () => {
  assert.deepEqual(cliLines(byId('t2')), [
    'perc approve t2-20261121-005347-f0ab',
    'perc reject t2-20261121-005347-f0ab -- "<feedback>"',
  ]);
  const both = { ...readable('t4'), attention: { ...readable('t4').attention!, actions: ['grant', 'resume', 'clean', 'open-pane'] } } as Readable;
  assert.deepEqual(cliLines(both), ['perc resume t4-20261121-061230-77ab', 'perc clean t4-20261121-061230-77ab']);
  assert.deepEqual(cliLines(byId('t8')), []);
});

test('terminalCommands lists the action equivalents, then the attention commands, once each', () => {
  assert.deepEqual(terminalCommands(byId('t2')), cliLines(byId('t2')));
  const failed = readable('t9');
  const cmds = failed.attention!.commands!;
  assert.ok(cmds.length > 0);
  assert.deepEqual(terminalCommands(failed), [...cliLines(failed), ...cmds]);
  const dup = { ...failed, attention: { ...failed.attention!, commands: [...cmds, ...cmds] } } as Readable;
  assert.deepEqual(terminalCommands(dup), [...cliLines(failed), ...cmds]);
  assert.deepEqual(terminalCommands(byId('t8')), []);
});

test('attentionTag names each attention kind', () => {
  assert.deepEqual(['gate', 'cap', 'paused', 'failed', 'stalled', 'agent'].map(attentionTag), [
    'GATE', 'PAUSED', 'PAUSED', 'FAILED', 'STALLED', 'AGENT',
  ]);
});

test('shownLoops keeps loops that have gone round; loopLabel says where and how far', () => {
  const [loop] = shownLoops(byId('t8'));
  assert.equal(loopLabel(loop!, false), '↺ review → implement · round 2 of 3');
  assert.equal(loopLabel({ ...loop!, round: 3 }, false), '↺ review → implement · round 3 of 3 · cap');
  assert.equal(loopLabel({ ...loop!, round: 3 }, true), '↺ round 3 of 3 · cap');
  assert.equal(loopAtCap({ ...loop!, round: 3 }), true);
  assert.equal(loopAtCap(loop!), false);
  assert.deepEqual(shownLoops({ ...readable('t8'), loops: [{ ...loop!, round: 0 }] }), []);
  assert.deepEqual(shownLoops(byId('t5')), []);
});

test('moveStop walks the train in execution order from the selected stop, else the current step', () => {
  const r = byId('t8');
  assert.equal(moveStop(r, null, 1), 'deliver');
  assert.equal(moveStop(r, null, -1), 'security-scan');
  assert.equal(moveStop(r, 'setup', -1), 'setup');
  assert.equal(moveStop(r, 'notify', 1), 'notify');
  assert.equal(moveStop(r, 'approve-groom', 1), 'plan');
  assert.equal(moveStop(readable('t3'), null, 1), 'deliver');
  assert.equal(moveStop(byId('t5'), null, 1), null);
});

test('moveRow moves the selection within the shown rows and stays at the ends', () => {
  const rows = runs();
  assert.equal(moveRow(rows, rows[0]!.id, -1), rows[0]!.id);
  assert.equal(moveRow(rows, rows[0]!.id, 1), rows[1]!.id);
  assert.equal(moveRow(rows, rows.at(-1)!.id, 1), rows.at(-1)!.id);
  assert.equal(moveRow(rows, 'gone', 1), rows[0]!.id);
  assert.equal(moveRow([], 'gone', 1), null);
});

test('readerPath shows the selected stop first output, else the first review file, else nothing', () => {
  const gate = readable('t2');
  assert.equal(readerPath(gate, null), 'samples/groomed_ticket.md');
  const out = { ...gate, steps: gate.steps.map((s) => (s.id === 'groom' ? { ...s, outputs: { groomed_ticket: '/abs/g.md' } } : s)) };
  assert.equal(readerPath(out, 'groom'), '/abs/g.md');
  assert.equal(readerPath(out, 'intake'), 'samples/groomed_ticket.md', 'a stop without outputs falls back to the review');
  assert.equal(readerPath(out, 'gone'), 'samples/groomed_ticket.md');
  const passed = { ...gate, status: 'running', currentStep: 'plan' } as Readable;
  delete passed.attention;
  assert.equal(readerPath(passed, null), null, 'once the gate passes there is nothing to read');
  assert.equal(readerPath(byId('t5'), null), null);
});

test('cupLabel says how many need you, else how many run, else Percolator, with its tone', () => {
  assert.deepEqual(cupLabel(runs()), { text: '6 need you', tone: 'blocked' });
  assert.deepEqual(cupLabel([readable('t2')]), { text: '1 needs you', tone: 'blocked' });
  assert.deepEqual(cupLabel([readable('t8'), readable('t3')]), { text: '1 running', tone: 'working' });
  assert.deepEqual(cupLabel([readable('t3'), byId('t5')]), { text: 'Percolator', tone: 'muted' });
  assert.deepEqual(cupLabel([]), { text: 'Percolator', tone: 'muted' });
});

test('notice asks for the run by number, with its message, and opens it through the cup', () => {
  assert.deepEqual(notice(readable('t2')), {
    title: '#2 needs you',
    body: 'approve-groom is waiting for approval',
    level: 'warning',
    action: { name: 'percolator-cup.open/t2-20261121-005347-f0ab' },
  });
});

test('findNode finds a layout node by id anywhere in the tree, else null', () => {
  const tree = { id: 'root', children: [{ id: 'a', children: [{ id: 'b', hidden: true }] }, { id: 'c' }] };
  assert.deepEqual(findNode(tree, 'b'), { id: 'b', hidden: true });
  assert.equal(findNode(tree, 'root'), tree);
  assert.equal(findNode(tree, 'gone'), null);
  assert.equal(findNode(null, 'b'), null);
});

test('cupMoves: a click hides what is open, else shows the panel where it was last', () => {
  const none = { panel: false, window: false };
  assert.deepEqual(cupMoves('panel', none, 'click'), ['show-panel']);
  assert.deepEqual(cupMoves(null, none, 'click'), ['show-panel'], 'docked is the default place');
  assert.deepEqual(cupMoves('window', none, 'click'), ['open-window']);
  assert.deepEqual(cupMoves('window', { panel: true, window: false }, 'click'), ['hide-panel']);
  assert.deepEqual(cupMoves('panel', { panel: false, window: true }, 'click'), ['close-window']);
  assert.deepEqual(cupMoves('panel', { panel: true, window: true }, 'click'), ['hide-panel', 'close-window']);
});

test('cupMoves: open shows the panel where it was last, and leaves an open one as it is', () => {
  assert.deepEqual(cupMoves('panel', { panel: false, window: false }, 'open'), ['show-panel']);
  assert.deepEqual(cupMoves('window', { panel: false, window: false }, 'open'), ['open-window']);
  assert.deepEqual(cupMoves('window', { panel: true, window: false }, 'open'), []);
  assert.deepEqual(cupMoves('panel', { panel: false, window: true }, 'open'), []);
});

test('ownsCommands: only the copy where the panel lives (shared percolator.place) acts on percolator commands', () => {
  assert.equal(ownsCommands('window', true), true);
  assert.equal(ownsCommands('window', false), false, 'the docked copy stays out while the window is the place');
  assert.equal(ownsCommands('panel', false), true);
  assert.equal(ownsCommands('panel', true), false, 'a window opened beside the docked panel stays out');
  assert.equal(ownsCommands(undefined, false), true, 'docked is the default place');
  assert.equal(ownsCommands(undefined, true), false);
});

test('boardHeight: the stored ratio of the area, at least the minimum, at most 70% of the area', () => {
  assert.equal(boardHeight(0.3, 1000, 90), 300);
  assert.equal(boardHeight(0.05, 1000, 90), 90, 'never under two rows');
  assert.equal(boardHeight(0.95, 1000, 90), 700, 'never over 70%');
  assert.equal(boardHeight(0.5, 100, 90), 90, 'a tiny area still shows the minimum');
  assert.equal(boardHeight(0.333, 601, 90), 200, 'whole pixels');
});

test('dragBoard: the ratio a divider drag leaves, from the height at the press plus the pointer move, clamped', () => {
  assert.equal(dragBoard(300, 100, 1000, 90), 0.4);
  assert.equal(dragBoard(300, -100, 1000, 90), 0.2);
  assert.equal(dragBoard(300, -500, 1000, 90), 0.09, 'stops at the minimum');
  assert.equal(dragBoard(300, 900, 1000, 90), 0.7, 'stops at 70%');
  assert.equal(boardHeight(dragBoard(300, 900, 1000, 90), 1000, 90), 700, 'the dragged ratio gives the dragged height back');
});

test('readRatio: a stored ratio between 0 and 1, else the default', () => {
  assert.equal(readRatio('0.42'), 0.42);
  assert.equal(readRatio(null), BOARD_RATIO);
  assert.equal(readRatio('nope'), BOARD_RATIO);
  assert.equal(readRatio('0'), BOARD_RATIO);
  assert.equal(readRatio('1.5'), BOARD_RATIO);
  assert.equal(BOARD_RATIO, 0.3);
});

test('fillHeight: the reader takes what the detail has left over, else its minimum and the detail scrolls', () => {
  assert.equal(fillHeight(600, 500, 200, 120), 300, 'room to spare: it grows to fill');
  assert.equal(fillHeight(600, 900, 400, 120), 120, 'the rest takes 500 of 600: the minimum');
  assert.equal(fillHeight(600, 600, 300, 120), 300, 'already filling: it stays');
  assert.equal(fillHeight(600.4, 500, 200, 120), 300, 'whole pixels');
});
