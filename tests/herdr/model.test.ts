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
  titleLayout,
  readRatio,
  clock,
  timelineRows,
  cupLabel,
  cupMoves,
  driverPeek,
  deleteArgv,
  deleteConfirm,
  deleteBusyError,
  deleteFinishedConfirm,
  finishedNotice,
  duration,
  isFinished,
  selectAfterDelete,
  selectAfterRefresh,
  deleteCommand,
  deleteCommandIds,
  findNode,
  ownsCommands,
  roundOf,
  roundPill,
  loopSpans,
  moveRow,
  canPick,
  moveStop,
  pipelineRows,
  pipelineSpans,
  hookNote,
  roundNote,
  unfoldAfterPick,
  pipelineMarks,
  needsCount,
  needsYou,
  nowTone,
  newlyNeeding,
  notice,
  parseStatus,
  readStatus,
  roundView,
  stepAttempts,
  timelineOf,
  resolvePath,
  rowState,
  runningCount,
  showsHere,
  terminalAddress,
  activeBox,
  agentCard,
  agentAddress,
  openAgentAt,
  agentTone,
  textTone,
  boxActions,
  boxOutside,
  columns,
  detailParts,
  panelShape,
  readerFiles,
  readerMax,
  slotOpensAgent,
  showsOutcome,
  boxAsks,
  programInitial,
  agentNote,
  boxDriver,
  historyLabel,
  readFullShown,
  ticketTitle,
  outcomeOf,
  pipelineChip,
  runLabel,
  sortRuns,
  stepTone,
  took,
  visibleRuns,
} from '../../herdr/mods/percolator/model.js';
import type { RunStatusJson, StatusJson } from '../../src/run/status.ts';
import type { Loop, PipeRow } from '../../herdr/mods/percolator/model.d.ts';
import { driverName } from '../../src/run/meta.ts';
import { terminalName } from '../../src/runtime/herdr-runtime.ts';
import {
  canStart,
  commandLine,
  guessRepo,
  knownRepos,
  linkedLine,
  pipelineOption,
  startedRun,
  startPick,
  sliceRows,
  fanOutRow,
  watcherState,
  wouldStart,
  pipelinesFixture,
  previewRun,
  previewSide,
  readPipelines,
  runNextChoices,
  startArgv,
  startFields,
  ticketRepo,
} from '../../herdr/mods/percolator/model.js';
import type { Pipeline } from '../../herdr/mods/percolator/model.d.ts';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'status.json');
const RAW = fs.readFileSync(FIXTURE, 'utf8');
const load = (): StatusJson => JSON.parse(RAW) as StatusJson;
const runs = () => load().runs;
const byId = (prefix: string): RunStatusJson => runs().find((r) => r.id.startsWith(`${prefix}-`))!;
type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
const readable = (prefix: string) => byId(prefix) as Readable;
const ids = (rs: { id: string }[]) => rs.map((r) => r.id.split('-')[0]);

test('the fixture covers every attention kind, a running run, a completed run and an unreadable entry', () => {
  const kinds = runs().flatMap((r) => ('attention' in r && r.attention ? [r.attention.kind] : []));
  assert.deepEqual([...new Set(kinds)].sort(), ['agent', 'cap', 'failed', 'gate', 'paused', 'stalled']);
  assert.ok(runs().some((r) => r.status === 'running' && !('attention' in r && r.attention)));
  assert.ok(runs().some((r) => r.status === 'completed'));
  assert.ok(runs().some((r) => r.status === 'unreadable'));
});

test('the fixture has a run before intake wrote its title and url, one read from history, and a cleaned failed run', () => {
  const rs = runs().filter((r): r is Readable => r.status !== 'unreadable');
  assert.ok(rs.some((r) => r.ticket !== null && r.ticket.title === undefined && r.ticket.url === undefined));
  assert.ok(rs.some((r) => r.graph === 'history'));
  assert.ok(rs.some((r) => r.status === 'failed' && r.attention === undefined));
});

test("the fixture's terminals are named as perc names them (names, not Herdr addresses)", () => {
  for (const r of runs()) {
    if (r.status === 'unreadable') continue;
    // a ticketless run's terminals are named after its pipeline
    const ticket = r.ticket?.ref ?? r.pipeline;
    assert.equal(r.driver.terminal, driverName(r.id, ticket), r.id);
    for (const [step, name] of Object.entries(r.terminals)) {
      const st = r.steps.find((s) => s.id === step);
      // without a timeline, `attempts` counts finished records, so a live step runs attempt `attempts + 1`
      const live = !Array.isArray(r.timeline) && (st?.status === 'running' || st?.status === 'waiting');
      const attempts: number = (st?.attempts ?? 0) + (live ? 1 : 0);
      assert.equal(name, step === 'driver' ? driverName(r.id, ticket) : terminalName(r.id, ticket, step, attempts), `${r.id} ${step}`);
    }
    if (r.attention?.terminal !== undefined) assert.equal(r.attention.terminal, r.terminals[r.currentStep!], r.id);
  }
});

test('terminalAddress finds a terminal by its hc name or its address; null when it is not live', () => {
  const live = [
    { address: 'w1:p3', name: 't8_review_a1_9f2a' },
    { address: 'w1:p4', name: null },
  ];
  assert.equal(terminalAddress(live, 't8_review_a1_9f2a'), 'w1:p3');
  assert.equal(terminalAddress(live, 'w1:p4'), 'w1:p4');
  assert.equal(terminalAddress(live, 't8_driver_a0_0000'), null);
  assert.equal(terminalAddress(live, undefined), null);
  assert.equal(terminalAddress(live, ''), null);
});

test("ticketTitle is the issue's title, else its ref (before intake reads the issue)", () => {
  assert.equal(ticketTitle(readable('t8')), 'add a security scan after implement');
  assert.equal(ticketTitle(readable('t14')), 'github.com/zidious/percolator#14');
});

test('showsHere: the copy where the panel lives, and only while it is shown', () => {
  assert.equal(showsHere('panel', false, true), true);
  assert.equal(showsHere(null, false, true), true, 'docked by default');
  assert.equal(showsHere('panel', false, false), false, 'a hidden docked block');
  assert.equal(showsHere('window', false, true), false, 'the docked copy while the window is the place');
  assert.equal(showsHere('window', true, false), true, 'the window, whatever the block');
  assert.equal(showsHere('panel', true, true), false, 'a window left over after docking back');
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
  assert.deepEqual(ids(sortRuns(input)), ['t22', 'dd', 't12', 't2', 't11', 't9', 't4', 't23', 't23', 't21', 't17', 't16', 't14', 't13', 't8', 't23', 't21', 't15', 'audit', 't3', 't5']);
  assert.deepEqual(ids(input), before, 'sortRuns does not mutate its input');
});

test('visibleRuns "active" hides completed and failed runs unless they need attention', () => {
  const rs = runs();
  const failedQuiet = { ...readable('t9'), id: 't99-quiet' } as Readable;
  delete failedQuiet.attention;
  assert.deepEqual(ids(visibleRuns([...rs, failedQuiet], 'active')), ['t8', 't2', 't4', 't12', 't9', 't11', 't13', 't14', 't16', 't17', 'dd', 't21', 't22', 't23', 't23', 't5']);
});

test('visibleRuns "all" keeps everything in order', () => {
  assert.deepEqual(ids(visibleRuns(runs(), 'all')), ids(runs()));
});

test('rowState gives the tone and the board text for each kind of run', () => {
  const cases: [string, string, string, string?][] = [
    ['t2', 'blocked', 'Your turn · approve-groom'],
    ['t4', 'blocked', 'Paused · review at cap'],
    ['t12', 'blocked', 'Paused · plan'],
    ['t9', 'blocked', 'Failed · implement'],
    ['t11', 'blocked', 'Stalled · driver stopped'],
    ['t13', 'working', 'groom'],
    ['t8', 'working', 'review', 'Round 3/3'],
    ['t3', 'muted', 'Delivered · PR #7'],
    ['t5', 'muted', 'Unreadable · state.json: Unexpected end of JSON input'],
  ];
  for (const [id, tone, text, round] of cases) assert.deepEqual(rowState(byId(id)), { tone, text, ...(round ? { round } : {}) }, id);
});

test('rowState capitalises a bare status: a run with nothing more to say', () => {
  const failed = { ...readable('t3'), status: 'failed', attention: undefined } as Readable;
  assert.deepEqual(rowState(failed), { tone: 'muted', text: 'Failed' });
});

test('textTone gives text a readable colour: dim (and no tone) read as muted, other tones stay', () => {
  assert.deepEqual(['dim', null, undefined, 'muted', 'working', 'blocked', 'done'].map(textTone), [
    'muted',
    'muted',
    'muted',
    'muted',
    'working',
    'blocked',
    'done',
  ]);
});

test('rowState for a running step outside a loop shows only the step', () => {
  assert.deepEqual(rowState({ ...readable('t8'), currentStep: 'implement' }), { tone: 'working', text: 'implement' });
});

test('rowState for a completed run without a PR says delivered', () => {
  assert.deepEqual(rowState({ ...readable('t3'), pr: null }), { tone: 'muted', text: 'Delivered' });
});

test('rowState for a completed router says where it routed; a ticketless run that opened nothing says done', () => {
  const triage = runs().find((r) => r.id === TRIAGE) as Readable;
  assert.deepEqual(rowState(triage), { tone: 'muted', text: 'Routed → hotfix' });
  assert.deepEqual(rowState({ ...triage, children: [] }), { tone: 'muted', text: 'Routed' });
  const dd = { ...readable('dd'), status: 'completed', attention: undefined, currentStep: undefined } as Readable;
  assert.deepEqual(rowState(dd), { tone: 'muted', text: 'Done' });
  // a ticketless run whose exit opened issues delivered them
  assert.deepEqual(rowState(readable('audit')), { tone: 'muted', text: 'Delivered' });
});

test("a completed run's outcome box says what rowState says: delivered, routed or done", () => {
  assert.deepEqual(outcomeOf(readable('t3')), { tag: 'DELIVERED', text: 'Opened Zidious/percolator/pull/7' });
  assert.deepEqual(outcomeOf({ ...readable('t3'), pr: null }), { tag: 'DELIVERED', text: 'Done.' });
  const triage = runs().find((r) => r.id === TRIAGE) as Readable;
  assert.deepEqual(outcomeOf(triage), { tag: 'ROUTED', text: '→ hotfix' });
  assert.deepEqual(outcomeOf({ ...triage, children: [] }), { tag: 'ROUTED', text: '' });
  const dd = { ...readable('dd'), status: 'completed', attention: undefined, currentStep: undefined } as Readable;
  assert.deepEqual(outcomeOf(dd), { tag: 'DONE', text: '' });
  assert.deepEqual(outcomeOf(readable('audit')), { tag: 'DELIVERED', text: 'Done.' });
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
  const prev = next.filter((r) => !r.id.startsWith('t12-'));
  assert.deepEqual(ids(newlyNeeding(prev, next)), ['t12']);
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
  assert.equal(needsCount(runs()), 7);
  assert.equal(runningCount(runs()), 8);
  assert.equal(needsCount([]), 0);
  assert.equal(runningCount([]), 0);
});

test('readStatus accepts schema 2', () => {
  assert.deepEqual(readStatus(RAW), { ok: true, data: load() });
});

test('readStatus refuses schema 1', () => {
  assert.deepEqual(readStatus('{"schema":1,"runs":[]}'), {
    ok: false,
    error: 'perc status --json returned schema 1; update the Percolator panel',
  });
});

test('readStatus refuses another schema and says to update the panel', () => {
  assert.deepEqual(readStatus('{"schema":3,"runs":[]}'), {
    ok: false,
    error: 'perc status --json returned schema 3; update the Percolator panel',
  });
});

test('status and model functions handle ticket: null', () => {
  const dd = readable('dd-alert');
  assert.equal(dd.ticket, null);
  assert.deepEqual(rowState(dd), { tone: 'blocked', text: 'Your turn · sign-off' });
  assert.equal(ticketTitle(dd), 'dd-alert · https://app.datadoghq.com/monitors/1234…');
  assert.equal(ticketTitle(dd).length, 'dd-alert · '.length + 40);
  assert.deepEqual(notice(dd), {
    title: 'dd-alert needs you',
    body: 'approve or reject here (no issue to comment on)',
    level: 'warning',
    action: { name: `percolator-cup.open/${dd.id}` },
  });
  assert.deepEqual(cupLabel([dd]), { text: '1 needs you', tone: 'blocked' });
  assert.equal(runLabel(dd), 'dd-alert');
  assert.equal(runLabel(readable('t2')), '#2');
  assert.deepEqual(deleteConfirm(dd), {
    title: 'Delete dd-alert?',
    detail: `Deletes run ${dd.id}: its terminals, worktree and record. Uncommitted changes in the worktree are lost. The branch ${dd.branch} is kept. The run is stopped first.`,
  });
  assert.equal(deleteFinishedConfirm([{ ...dd, status: 'completed' }])!.detail.startsWith(`Deletes ${dd.id} (dd-alert): `), true);
  assert.equal(guessRepo('github.com/zidious/percolator#99', [dd]), null);
  assert.equal(runNextChoices({ ...dd, status: 'completed' }, [], [dd]), null);
});

test('ticketTitle of a ticketless run without inputs is its pipeline', () => {
  assert.equal(ticketTitle({ ...readable('dd-alert'), inputs: {} }), 'dd-alert');
  assert.equal(ticketTitle({ ...readable('dd-alert'), inputs: { alert_url: 'short' } }), 'dd-alert · short');
});

test('pipelineChip is null on feature and the name otherwise', () => {
  assert.equal(pipelineChip(readable('t2')), null);
  assert.equal(pipelineChip(readable('t21')), 'hotfix');
  assert.equal(pipelineChip(readable('dd-alert')), 'dd-alert');
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

test('attentionTag names each attention kind', () => {
  assert.deepEqual(['gate', 'cap', 'paused', 'failed', 'stalled', 'agent'].map(attentionTag), [
    'GATE', 'PAUSED', 'PAUSED', 'FAILED', 'STALLED', 'NEEDS YOU',
  ]);
});

test('moveStop walks the train in execution order from the selected stop, else the current step', () => {
  const r = byId('t8');
  assert.equal(moveStop(r, null, 1), 'review');
  assert.equal(moveStop(r, null, -1), 'security-scan');
  assert.equal(moveStop(r, 'setup', -1), 'setup');
  assert.equal(moveStop(r, 'approve-groom', 1), 'plan');
  assert.equal(moveStop(readable('t3'), null, 1), 'deliver');
  assert.equal(moveStop(byId('t5'), null, 1), null);
});

test('canPick refuses a stop that has not started', () => {
  assert.equal(canPick({ status: 'pending' }), false);
  for (const s of ['running', 'waiting', 'pass', 'fail', 'escalate', 'contract_error']) assert.equal(canPick({ status: s }), true);
});

test('moveStop never lands on a stop that has not started', () => {
  const r = readable('t2'); // waiting at approve-groom; plan onwards pending
  assert.equal(moveStop(r, 'approve-groom', 1), 'approve-groom');
  assert.equal(moveStop(r, null, 1), 'approve-groom');
  assert.equal(moveStop(r, 'groom', 1), 'approve-groom');
});

test('moveStop is null when nothing has started', () => {
  const r = readable('t14');
  assert.equal(moveStop({ ...r, steps: r.steps.map((s) => ({ ...s, status: 'pending' })) }, null, 1), null);
});

test('moveRow moves the selection within the shown rows and stays at the ends', () => {
  const rows = runs();
  assert.equal(moveRow(rows, rows[0]!.id, -1), rows[0]!.id);
  assert.equal(moveRow(rows, rows[0]!.id, 1), rows[1]!.id);
  assert.equal(moveRow(rows, rows.at(-1)!.id, 1), rows.at(-1)!.id);
  assert.equal(moveRow(rows, 'gone', 1), rows[0]!.id);
  assert.equal(moveRow([], 'gone', 1), null);
});

test('the fixture has timelines for t8, t3, t2, t4, t16, t17, dd-alert, t21 (hotfix and triage), t22, t23 (epic and two slices) and audit, and none for the rest (an older perc)', () => {
  assert.deepEqual(runs().filter((r) => 'timeline' in r).map((r) => r.id.split('-')[0]), ['t8', 't3', 't2', 't4', 't16', 't17', 'dd', 't21', 't21', 't22', 't23', 't23', 't23', 'audit']);
});

test('roundView defaults to the latest round and marks it running', () => {
  const v = roundView(readable('t8'), 'review', null)!;
  assert.deepEqual([v.attempt.attempt, v.n, v.of, v.mark, v.prev, v.next], [3, 3, 3, 'running', 2, null]);
});

test('roundView shows a picked earlier round, unmarked, with both neighbours', () => {
  const v = roundView(readable('t8'), 'review', 2)!;
  assert.deepEqual([v.attempt.status, v.n, v.mark, v.prev, v.next], ['fail', 2, null, 1, 3]);
});

test('roundView marks a finished last round latest, and a waiting one waiting', () => {
  assert.equal(roundView(readable('t3'), 'review', null)!.mark, 'latest');
  assert.equal(roundView(readable('t2'), 'approve-groom', null)!.mark, 'waiting');
});

test('roundView falls back to the latest round when the picked one is not there', () => {
  assert.equal(roundView(readable('t8'), 'review', 9)!.n, 3);
});

test('roundView is null for a step that has not run', () => {
  assert.equal(roundView(readable('t2'), 'plan', null), null);
});

test('without a timeline (older perc) a step that ran is one round from its own data', () => {
  const v = roundView(readable('t9'), 'implement', null)!; // t9 has no timeline
  assert.deepEqual([v.attempt.status, v.of, v.mark], ['contract_error', 1, 'latest']);
});

test('timelineOf is the run timeline, else one attempt per step that ran, in order; empty when unreadable', () => {
  assert.deepEqual(timelineOf(readable('t8')), readable('t8').timeline);
  assert.deepEqual(
    timelineOf(readable('t9')).map((e) => e.kind === 'attempt' && [e.step, e.attempt, e.status]),
    [['intake', 1, 'pass'], ['groom', 1, 'pass'], ['approve-groom', 1, 'pass'], ['plan', 1, 'pass'], ['implement', 1, 'contract_error']],
  );
  assert.deepEqual(timelineOf(byId('t5')), []);
});

test('stepAttempts is one step attempts in order', () => {
  assert.deepEqual(stepAttempts(readable('t8'), 'review').map((a) => a.attempt), [1, 2, 3]);
  assert.deepEqual(stepAttempts(readable('t8'), 'deliver'), []);
});

test('cupLabel says how many need you, else how many run, else Percolator, with its tone', () => {
  assert.deepEqual(cupLabel(runs()), { text: '7 need you', tone: 'blocked' });
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
  assert.ok(Number.isFinite(dragBoard(300, 50, 0, 90)), 'an area not measured yet gives a number, not Infinity');
});

test('readRatio: a stored ratio between 0 and 1, else the default', () => {
  assert.equal(readRatio('0.42'), 0.42);
  assert.equal(readRatio(null), BOARD_RATIO);
  assert.equal(readRatio('nope'), BOARD_RATIO);
  assert.equal(readRatio('0'), BOARD_RATIO);
  assert.equal(readRatio('1.5'), BOARD_RATIO);
  assert.equal(readRatio(0.42), 0.42, 'a number from shared state');
  assert.equal(readRatio(undefined), BOARD_RATIO, 'nothing shared yet');
  assert.equal(BOARD_RATIO, 0.3);
});

test('titleLayout: the buttons always fit; the needs chip shortens, then the tabs move to a second row', () => {
  // + New run is an icon under 800px (text from there): it takes ~30px, so the chip shortens and the tabs move sooner
  assert.deepEqual(titleLayout(400, 2), { tabs: 'inline', chip: 'long', newRun: 'icon' });
  assert.deepEqual(titleLayout(380, 2), { tabs: 'inline', chip: 'short', newRun: 'icon' }, 'the default 380px panel');
  assert.deepEqual(titleLayout(350, 2), { tabs: 'inline', chip: 'short', newRun: 'icon' });
  assert.deepEqual(titleLayout(340, 2), { tabs: 'below', chip: 'long', newRun: 'icon' });
  assert.deepEqual(titleLayout(260, 2), { tabs: 'below', chip: 'short', newRun: 'icon' });
  assert.deepEqual(titleLayout(330, 0), { tabs: 'inline', chip: 'long', newRun: 'icon' }, 'no chip: the tabs fit inline longer');
  assert.deepEqual(titleLayout(320, 0), { tabs: 'below', chip: 'long', newRun: 'icon' });
  assert.deepEqual(titleLayout(720, 2).newRun, 'icon');
  assert.deepEqual(titleLayout(800, 2), { tabs: 'inline', chip: 'long', newRun: 'text' }, 'the window');
});

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('clock is the local HH:MM of a date, empty without one', () => {
  assert.equal(clock('2026-11-21T00:15:03.000Z'), hhmm('2026-11-21T00:15:03.000Z'));
  assert.equal(clock(undefined), '');
});

test('timelineRows lists every attempt newest first, with round, start, duration and decision', () => {
  const rows = timelineRows(readable('t8'), Date.parse('2026-11-21T00:41:10.000Z') + 120000);
  assert.deepEqual(rows[0], {
    key: 'review#3',
    mark: '●',
    tone: 'working',
    step: 'review',
    round: 'Round 3',
    status: 'running',
    started: hhmm('2026-11-21T00:41:10.000Z'),
    took: '2m',
    note: '',
  });
  assert.equal(rows.find((r) => r.key === 'approve-groom#1')!.note, 'Approved by @zidious');
  assert.equal(rows.at(-1)!.step, 'setup');
});

test('timelineRows shows a cap as its own row', () => {
  const cap = timelineRows(readable('t4'), 0).find((r) => r.status === 'cap')!;
  assert.deepEqual([cap.mark, cap.tone, cap.step, cap.note], ['↺', 'blocked', 'review', 'review → implement hit its cap of 3 rounds']);
});

test('timelineRows without a timeline lists the steps that ran, newest first', () => {
  assert.deepEqual(timelineRows(readable('t9'), 0).map((r) => r.key), ['implement#1', 'plan#1', 'approve-groom#1', 'groom#1', 'intake#1']);
});

test('timelineRows without a timeline counts a live step as the attempt in progress', () => {
  const first = timelineRows(readable('t14'), 0).find((r) => r.key === 'intake#1');
  assert.equal(first?.round, 'Round 1');
  assert.equal(stepAttempts(readable('t11'), 'implement').at(-1)!.attempt, 1);
  assert.equal(stepAttempts(readable('t11'), 'plan').at(-1)!.attempt, 1, 'a finished step keeps its attempts');
});

test('rowState keeps the round apart from a long step name, so it is never cut', () => {
  const r = readable('t8');
  const long = { ...r, currentStep: 'security-scan-extended', loops: [{ ...r.loops[0]!, from: 'security-scan-extended' }] };
  assert.deepEqual(rowState(long), { tone: 'working', text: 'security-scan-extended', round: 'Round 3/3' });
});

const T8_DRIVER = 't8_driver_a0_b65d';
const withDriver = (driver: Partial<Readable['driver']>, terminals?: Record<string, string>): Readable => {
  const r = readable('t8');
  return { ...r, driver: { alive: true, terminal: T8_DRIVER, shown: false, ...driver }, ...(terminals !== undefined ? { terminals } : {}) };
};

// a peek closes without ending the terminal; closing a pane in the space ended the driver and stopped the run
test('driverPeek offers the live driver terminal as a peek', () => {
  assert.deepEqual(driverPeek(withDriver({ space: 'w1:s3' })), { terminal: T8_DRIVER, label: 'Driver pane ↗' });
});

test('driverPeek needs no space: the peek floats over whatever is open', () => {
  assert.deepEqual(driverPeek(withDriver({})), { terminal: T8_DRIVER, label: 'Driver pane ↗' });
});

test('driverPeek is null when terminals has no driver or a different one', () => {
  assert.equal(driverPeek(withDriver({}, {})), null);
  assert.equal(driverPeek(withDriver({}, { driver: 'someone_else' })), null);
});

test('driverPeek is null for a finished run and an unreadable entry', () => {
  assert.equal(driverPeek({ ...readable('t3'), driver: { alive: false, terminal: 't3_driver_a0_53dd', space: 'w1:s3', shown: false } }), null);
  assert.equal(driverPeek(byId('t5')), null);
});

test('driverPeek is null when no run is selected', () => {
  assert.equal(driverPeek(null), null);
  assert.equal(driverPeek(undefined), null);
});

test('deleteArgv deletes exactly the ids given, always with --yes', () => {
  assert.deepEqual(deleteArgv(['r1']), ['delete', 'r1', '--yes']);
  assert.deepEqual(deleteArgv(['r1', 'r2']), ['delete', 'r1', 'r2', '--yes']);
});

test('deleteCommand carries the confirmed ids, and deleteCommandIds reads them back', () => {
  assert.equal(deleteCommand(['r1']), 'delete/r1');
  assert.equal(deleteCommand(['r1', 'r2']), 'delete/r1,r2');
  assert.deepEqual(deleteCommandIds('delete/r1,r2'), ['r1', 'r2']);
  assert.deepEqual(deleteCommandIds('delete/r1'), ['r1']);
  assert.equal(deleteCommandIds('delete/'), null);
  assert.equal(deleteCommandIds('clean/r1'), null);
});

test('isFinished is true for completed and failed runs only', () => {
  assert.deepEqual(
    runs().filter(isFinished).map((r) => r.id.split('-')[0]),
    ['t3', 't9', 't15', 't21', 't23', 'audit'],
  );
});

test('deleteConfirm names the run, says what is lost and kept, and that an active run is stopped', () => {
  const done = readable('t3');
  assert.deepEqual(deleteConfirm(done), {
    title: 'Delete #3?',
    detail: `Deletes run ${done.id} (${done.ticket!.ref}): its terminals, worktree and record. Uncommitted changes in the worktree are lost. The branch ${done.branch} is kept.`,
  });
  for (const id of ['t8', 't2', 't4']) {
    const r = readable(id);
    assert.equal(
      deleteConfirm(r).detail,
      `Deletes run ${r.id} (${r.ticket!.ref}): its terminals, worktree and record. Uncommitted changes in the worktree are lost. The branch ${r.branch} is kept. The run is stopped first.`,
      id,
    );
  }
  const bad = byId('t5');
  assert.deepEqual(deleteConfirm(bad), {
    title: `Delete ${bad.id}?`,
    detail: `Deletes run ${bad.id}: its terminals, its worktree if its record still names one (uncommitted changes there are lost), and its record. The branch percolator/${bad.id} is kept.`,
  });
});

test('deleteFinishedConfirm lists the finished runs, or is null when there are none', () => {
  const [a, b, c] = ['t3', 't9', 't15'].map((id) => byId(id).id);
  const d = 't21-triage-20261121-065800-9e3a';
  const s = 't23-epic-20261121-090000-7c2a-s1';
  const e = 'audit-20261120-180000-2d7c';
  assert.deepEqual(deleteFinishedConfirm(runs()), {
    title: 'Delete 6 finished run(s)?',
    detail: `Deletes ${a} (#3), ${b} (#9), ${c} (#15), ${d} (#21), ${s} (#23), ${e} (audit): their terminals, worktrees and records. Uncommitted changes are lost; their branches are kept.`,
    ids: [a, b, c, d, s, e],
  });
  assert.equal(deleteFinishedConfirm(runs().filter((r) => !isFinished(r))), null);
});

test('finishedNotice says No finished runs until a finished run is listed; another notice stays', () => {
  const unfinished = runs().filter((r) => !isFinished(r));
  assert.equal(finishedNotice(null, unfinished, true), 'No finished runs');
  assert.equal(finishedNotice(null, runs(), true), null);
  assert.equal(finishedNotice('No finished runs', unfinished, false), 'No finished runs');
  assert.equal(finishedNotice('No finished runs', runs(), false), null);
  assert.equal(finishedNotice(null, unfinished, false), null);
});

test('deleteBusyError tells the owner a confirmed delete did not run', () => {
  assert.equal(deleteBusyError('approve'), 'Another action is running; try Delete again');
  assert.equal(deleteBusyError(null), null);
});

test('selectAfterDelete moves to the next row, else the previous, else none; an unrelated selection stays', () => {
  const rows = ['a', 'b', 'c'].map((id) => ({ id }) as RunStatusJson);
  assert.equal(selectAfterDelete(rows, ['b'], 'b'), 'c');
  assert.equal(selectAfterDelete(rows, ['c'], 'c'), 'b');
  assert.equal(selectAfterDelete(rows, ['b', 'c'], 'b'), 'a');
  assert.equal(selectAfterDelete([rows[0]!], ['a'], 'a'), null);
  assert.equal(selectAfterDelete(rows, ['b'], 'a'), 'a');
  assert.equal(selectAfterDelete(rows, ['b'], null), null);
});

test('selectAfterRefresh keeps a listed selection, else takes the one planned at the delete, else the first row', () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id }) as RunStatusJson);
  // the deleted run is gone from fresh runs: the row planned when the owner confirmed, not the first row
  assert.equal(selectAfterRefresh(rows('a', 'c'), rows('a', 'c'), 'b', { ids: ['b'], next: 'c' }), 'c');
  // a refresh that still lists the deleted run keeps it selected until it goes
  assert.equal(selectAfterRefresh(rows('a', 'b', 'c'), rows('a', 'b', 'c'), 'b', { ids: ['b'], next: 'c' }), 'b');
  // the planned row went too: the first row
  assert.equal(selectAfterRefresh(rows('a'), rows('a'), 'b', { ids: ['b'], next: 'c' }), 'a');
  assert.equal(selectAfterRefresh(rows('a', 'c'), rows('a', 'c'), 'b', null), 'a');
  assert.equal(selectAfterRefresh([], [], 'b', null), null);
  // listed in all runs but filtered out of the rows: still the selection, as before
  assert.equal(selectAfterRefresh(rows('a', 'b'), rows('a'), 'b', null), 'b');
});

test('roundOf counts the round the engine is in', () => {
  const l = { id: 'review', from: 'review', to: 'implement', max: 3, atCap: 'escalate', round: 0 } as Loop;
  assert.deepEqual(roundOf(l), { n: 1, max: 3, taken: false, atCap: false });
  assert.deepEqual(roundOf({ ...l, round: 1 }), { n: 2, max: 3, taken: true, atCap: false });
  assert.deepEqual(roundOf({ ...l, round: 3 }), { n: 3, max: 3, taken: true, atCap: true });
});

test('roundPill sits on the loop from step', () => {
  assert.deepEqual(roundPill(byId('t2'), 'review'), { text: 'Round 1/3', tone: 'dim' });
  assert.deepEqual(roundPill(byId('t16'), 'review'), { text: 'Round 2/3', tone: 'working' });
  assert.deepEqual(roundPill(byId('t4'), 'review'), { text: 'Round 3/3 · cap', tone: 'blocked' });
  assert.equal(roundPill(byId('t4'), 'implement'), null);
});

test('loopSpans lists every loop with its tone', () => {
  assert.deepEqual(loopSpans(byId('t2')), [{ id: 'review', from: 'review', to: 'implement', tone: 'dim' }]);
  assert.deepEqual(loopSpans(byId('t3')).length, 1);
  assert.deepEqual(loopSpans(byId('t5')), []);
});

test('rowState gives the round the engine is in', () => {
  assert.equal(rowState({ ...readable('t16'), currentStep: 'review' }).round, 'Round 2/3');
});

test('an agent-blocked run is a running run to the panel', () => {
  const t13 = byId('t13');
  assert.equal(needsYou(t13), false);
  assert.deepEqual(rowState(t13), { tone: 'working', text: 'groom' });
  assert.equal(newlyNeeding([], [t13]).length, 0);
  assert.equal(sortRuns([byId('t3'), t13])[0]!.id, t13.id); // running ranks above completed
});

test('nowTone: the active stop rings blocked when the run needs you or failed, else working', () => {
  assert.equal(nowTone(byId('t2')), 'blocked'); // a gate waits on you
  assert.equal(nowTone(byId('t9')), 'blocked'); // failed, with a box
  assert.equal(nowTone(byId('t15')), 'blocked'); // failed, no attention
  assert.equal(nowTone(byId('t13')), 'working'); // an agent-blocked run is running
  assert.equal(nowTone(byId('t8')), 'working');
});

const WIDE = { narrow: false, unfolded: [] as string[] };
const rowIds = (rows: PipeRow[]) => rows.map((r) => r.step.id);
const row = (rows: PipeRow[], id: string) => rows.find((r) => r.step.id === id)!;
const whereOf = (r: PipeRow) => (r.type === 'hook' ? r.where : r.type);
const foldedOf = (r: PipeRow) => (r.type === 'stage' ? r.folded.map((s) => s.id) : null);

test('pipelineRows puts before-all hooks first, then each stage in run order, then after-all hooks', () => {
  const rows = pipelineRows(byId('t8'), WIDE);
  // the fixture runs lint-plan before implement and security-scan after it
  assert.deepEqual(rowIds(rows), ['setup', 'intake', 'groom', 'approve-groom', 'plan', 'lint-plan', 'implement', 'security-scan', 'review', 'deliver', 'notify']);
  assert.deepEqual(rows.map(whereOf), ['before-all', 'stage', 'stage', 'after', 'stage', 'before', 'stage', 'after', 'stage', 'stage', 'after-all']);
});

test('pipelineRows gives each row its state, gate and the round pill on stage rows', () => {
  const rows = pipelineRows(byId('t8'), WIDE);
  assert.deepEqual(
    rows.map((r) => r.state),
    ['past', 'past', 'past', 'past', 'past', 'past', 'past', 'past', 'active', 'future', 'future'],
  );
  assert.deepEqual(rows.filter((r) => r.gate).map((r) => r.step.id), ['approve-groom']);
  const review = row(rows, 'review');
  assert.equal(review.type === 'stage' && review.round?.text, 'Round 3/3');
  const plan = row(rows, 'plan');
  assert.equal(plan.type === 'stage' && plan.round, null);
  assert.deepEqual(foldedOf(plan), []);
});

test('pipelineRows folds a side with more than 3 passed hooks into the stage row, unless the stage is unfolded', () => {
  const rows = pipelineRows(byId('t16'), WIDE);
  assert.deepEqual(foldedOf(row(rows, 'implement')), ['lint-baseline', 'deps-audit', 'license-check', 'format-check']);
  assert.deepEqual(rowIds(rows), ['intake', 'groom', 'plan', 'implement', 'typecheck', 'coverage', 'review', 'deliver']);
  assert.deepEqual([row(rows, 'typecheck').type, row(rows, 'typecheck').state], ['hook', 'future']);
  assert.deepEqual([row(rows, 'coverage').type, row(rows, 'coverage').state], ['hook', 'failed']);

  const open = pipelineRows(byId('t16'), { narrow: false, unfolded: ['implement'] });
  assert.deepEqual(rowIds(open), ['intake', 'groom', 'plan', 'lint-baseline', 'deps-audit', 'license-check', 'format-check', 'implement', 'typecheck', 'coverage', 'review', 'deliver']);
  assert.deepEqual(open.slice(3, 9).map(whereOf), ['before', 'before', 'before', 'before', 'stage', 'after']);
  assert.deepEqual(foldedOf(row(open, 'implement')), []);
});

test('pipelineRows narrow folds every passed hook, before-all into intake and after-all into deliver', () => {
  const t8 = readable('t8');
  const done = { ...t8, status: 'completed', steps: t8.steps.map((s) => ({ ...s, status: 'pass' })) } as RunStatusJson;
  const rows = pipelineRows(done, { narrow: true, unfolded: [] });
  assert.deepEqual(rowIds(rows), ['intake', 'groom', 'plan', 'implement', 'review', 'deliver']);
  assert.deepEqual(rows.map(foldedOf), [['setup'], ['approve-groom'], [], ['lint-plan', 'security-scan'], [], ['notify']]);
  assert.deepEqual(rowIds(pipelineRows(done, { narrow: true, unfolded: ['intake', 'deliver'] })), ['setup', 'intake', 'groom', 'plan', 'implement', 'review', 'deliver', 'notify']);
});

test('pipelineRows narrow keeps the active gate as a row', () => {
  const rows = pipelineRows(byId('t2'), { narrow: true, unfolded: [] });
  const gate = row(rows, 'approve-groom');
  assert.deepEqual([gate.type, whereOf(gate), gate.state, gate.gate], ['hook', 'after', 'active', true]);
  assert.deepEqual(foldedOf(row(rows, 'groom')), []);
});

test('pipelineRows never folds the active step, even when it passed', () => {
  const t2 = readable('t2');
  const r = { ...t2, steps: t2.steps.map((s) => (s.id === 'approve-groom' ? { ...s, status: 'pass' } : s)) } as RunStatusJson;
  const gate = row(pipelineRows(r, { narrow: true, unfolded: [] }), 'approve-groom');
  assert.deepEqual([gate.type, gate.state], ['hook', 'active']);
});

test('pipelineRows makes each core step of a multi-step stage a stage row; folded hooks go on the first', () => {
  const rows = pipelineRows(byId('t17'), WIDE);
  assert.deepEqual(rowIds(rows), ['intake', 'groom', 'plan', 'prep', 'implement.0', 'implement.1', 'post', 'review', 'deliver']);
  assert.deepEqual(rows.slice(3, 7).map(whereOf), ['before', 'stage', 'stage', 'after']);
  assert.deepEqual([row(rows, 'implement.0').state, row(rows, 'implement.1').state], ['past', 'active']);

  const narrow = pipelineRows(byId('t17'), { narrow: true, unfolded: [] });
  assert.deepEqual(rowIds(narrow), ['intake', 'groom', 'plan', 'implement.0', 'implement.1', 'post', 'review', 'deliver']);
  assert.deepEqual(foldedOf(row(narrow, 'implement.0')), ['prep']);
  assert.deepEqual(foldedOf(row(narrow, 'implement.1')), []);
});

test('pipelineRows lists the nodes of a stage with no core step as before, where its first node appears, unfolded', () => {
  const t3 = readable('t3');
  const sketch = { ...t3.steps[0]!, id: 'sketch', stage: 'plan', role: 'node', kind: 'script', status: 'pass' } as Readable['steps'][number];
  const steps = [...t3.steps.filter((s) => s.stage !== 'plan'), sketch];
  const rows = pipelineRows({ ...t3, steps } as RunStatusJson, { narrow: true, unfolded: [] });
  assert.deepEqual(rowIds(rows), ['intake', 'groom', 'implement', 'review', 'deliver', 'sketch']);
  assert.equal(whereOf(row(rows, 'sketch')), 'before');
  assert.deepEqual(foldedOf(row(rows, 'groom')), ['approve-groom']);
});

test('pipelineRows orders stages by where their first core step appears in the run', () => {
  const t3 = readable('t3');
  const steps = [...t3.steps.filter((s) => s.stage !== 'plan'), ...t3.steps.filter((s) => s.stage === 'plan')];
  assert.deepEqual(rowIds(pipelineRows({ ...t3, steps } as RunStatusJson, WIDE)), ['intake', 'groom', 'approve-groom', 'implement', 'review', 'deliver', 'plan']);
});

test('pipelineRows places a stage at its first core step, not at a node listed earlier', () => {
  const t8 = readable('t8');
  const lint = t8.steps.find((s) => s.id === 'lint-plan')!;
  const steps = t8.steps.filter((s) => s !== lint);
  steps.splice(steps.findIndex((s) => s.id === 'plan'), 0, lint); // an implement node listed before plan
  assert.deepEqual(rowIds(pipelineRows({ ...t8, steps } as RunStatusJson, WIDE)).slice(4, 8), ['plan', 'lint-plan', 'implement', 'security-scan']);
});

test('pipelineRows of the t4 run carries the capped round on review', () => {
  const review = row(pipelineRows(byId('t4'), WIDE), 'review');
  assert.deepEqual(review.type === 'stage' && review.round, { text: 'Round 3/3 · cap', tone: 'blocked' });
  assert.equal(review.state, 'active');
});

test('pipelineRows marks a step that is not current failed when it failed, escalated or broke its contract', () => {
  const t3 = readable('t3');
  for (const status of ['fail', 'escalate', 'contract_error'] as const) {
    const r = { ...t3, steps: t3.steps.map((s) => (s.id === 'plan' ? { ...s, status } : s)) } as RunStatusJson;
    assert.equal(row(pipelineRows(r, WIDE), 'plan').state, 'failed', status);
  }
});

test('pipelineRows shows a loop start that sent the run back, under its cap, as past, not failed', () => {
  assert.equal(row(pipelineRows(byId('t16'), WIDE), 'review').state, 'past'); // review failed, round 2/3: the loop goes on
  const t4 = readable('t4'); // review escalated at the cap
  const capped = { ...t4, currentStep: 'deliver' } as RunStatusJson;
  assert.equal(row(pipelineRows(capped, WIDE), 'review').state, 'failed');
  const t3 = readable('t3'); // a loop not taken: a failed review is failed
  const failed = { ...t3, steps: t3.steps.map((s) => (s.id === 'review' ? { ...s, status: 'fail' } : s)) } as RunStatusJson;
  assert.equal(row(pipelineRows(failed, WIDE), 'review').state, 'failed');
});

test('pipelineRows has no active row for a completed run or a current step that is not listed', () => {
  assert.deepEqual(pipelineRows(byId('t3'), WIDE).filter((r) => r.state === 'active'), []);
  const lost = { ...readable('t8'), currentStep: 'nope' } as RunStatusJson;
  assert.deepEqual(pipelineRows(lost, WIDE).filter((r) => r.state === 'active'), []);
});

test('pipelineRows is empty for an unreadable run and a run with no steps', () => {
  assert.deepEqual(pipelineRows(byId('t5'), WIDE), []);
  assert.deepEqual(pipelineRows({ ...readable('t3'), steps: [] } as RunStatusJson, WIDE), []);
});

test('pipelineSpans gives a loop as the indexes of its from and to stage rows', () => {
  const r = byId('t4');
  assert.deepEqual(pipelineSpans(pipelineRows(r, WIDE), r), [{ from: 5, to: 4, tone: 'blocked' }]);
});

test('pipelineSpans ends a loop on the hook row it targets', () => {
  const r = byId('t8'); // the loop goes back to lint-plan, the first step of the implement region
  const rows = pipelineRows(r, WIDE);
  assert.deepEqual(pipelineSpans(rows, r), [{ from: rowIds(rows).indexOf('review'), to: rowIds(rows).indexOf('lint-plan'), tone: 'working' }]);
  assert.deepEqual(pipelineSpans(rows, r), [{ from: 8, to: 5, tone: 'working' }]);
});

test('pipelineSpans ends a loop that targets a folded hook on the row holding it', () => {
  const r = byId('t16'); // the loop goes back to lint-baseline, folded into implement
  assert.deepEqual(pipelineSpans(pipelineRows(r, WIDE), r), [{ from: 6, to: 3, tone: 'working' }]);
  assert.deepEqual(pipelineSpans(pipelineRows(r, { narrow: false, unfolded: ['implement'] }), r), [{ from: 10, to: 3, tone: 'working' }]);
});

test('pipelineSpans drops a loop whose end is not in the pipeline', () => {
  const r = readable('t4');
  const noTo = { ...r, steps: r.steps.filter((s) => s.id !== 'implement') } as RunStatusJson;
  assert.deepEqual(pipelineSpans(pipelineRows(noTo, WIDE), noTo), []);
  const noFrom = { ...r, loops: [{ ...r.loops[0]!, from: 'nope' }] } as RunStatusJson;
  assert.deepEqual(pipelineSpans(pipelineRows(noFrom, WIDE), noFrom), []);
  const t16 = readable('t16');
  const noHook = { ...t16, loops: [{ ...t16.loops[0]!, to: 'nope' }] } as RunStatusJson;
  assert.deepEqual(pipelineSpans(pipelineRows(noHook, WIDE), noHook), []);
  assert.deepEqual(pipelineSpans([], byId('t5')), []);
});

test('moveStop walks the pipeline rows that have started', () => {
  assert.equal(moveStop(byId('t8'), 'groom', 1), 'approve-groom');
  assert.equal(moveStop(byId('t8'), 'lint-plan', 1), 'implement');
  // t16: the passed before:implement hooks fold away; typecheck has not started, coverage failed
  assert.equal(moveStop(byId('t16'), 'implement', 1), 'coverage');
  assert.equal(moveStop(byId('t16'), 'coverage', 1), 'review');
});

test('moveStop reaches the hooks of an unfolded stage', () => {
  assert.equal(moveStop(byId('t16'), 'plan', 1), 'implement');
  assert.equal(moveStop(byId('t16'), 'plan', 1, ['implement']), 'lint-baseline');
});

test('moveStop walks the rows a folding (under 320px) pipeline shows', () => {
  assert.equal(moveStop(byId('t8'), 'groom', 1, [], true), 'plan'); // approve-groom folds into groom
  assert.equal(moveStop(byId('t8'), 'groom', 1, ['groom'], true), 'approve-groom');
  assert.equal(moveStop(byId('t8'), 'groom', 1, [], false), 'approve-groom');
});

test('activeBox names what shows under the active stop', () => {
  const box = (p: string) => activeBox(byId(p));
  assert.equal(box('t2'), 'gate');
  assert.equal(box('t4'), 'cap');
  assert.equal(box('t12'), 'paused');
  assert.equal(box('t9'), 'failed');
  assert.equal(box('t11'), 'stalled');
  assert.equal(box('t13'), 'agent');
  assert.equal(box('t16'), 'agent');
  assert.equal(box('t3'), null);
  assert.equal(box('t5'), null);
});

test('agentCard links the active stop to its agent terminal', () => {
  const now = Date.parse('2026-11-21T04:30:00.000Z');
  const name = 't16_implement_a2_4a92';
  const step = readable('t16').steps.find((s) => s.id === 'implement')!;
  const since = took(step, now);
  assert.ok(since);
  assert.deepEqual(agentCard(byId('t16'), [], [], now), { address: null, name, status: 'not open', program: 'Agent', since });
  const live = [{ address: 'w1:7', name }];
  const agents = [{ address: 'w1:7', status: 'working', program: { name: 'Claude Code' } }];
  assert.deepEqual(agentCard(byId('t16'), live, agents, now), { address: 'w1:7', name, status: 'working', program: 'Claude Code', since });
  assert.equal(agentCard(byId('t16'), live, [], now)!.status, 'open');
  assert.equal(agentCard(byId('t3'), live, agents, now), null);
  assert.equal(agentCard(byId('t17'), [], [], now)!.name, 't17_implement-1_a1_0641');
});

test('agentCard and agentAddress fall back to the attention terminal when the step lists none', () => {
  const t13 = readable('t13'); // agent blocked in groom; attention.terminal names its terminal
  const r = { ...t13, terminals: { driver: t13.terminals.driver } } as RunStatusJson;
  const live = [{ address: 'w1:9', name: 't13_groom_a1_cc4e' }];
  assert.equal(agentCard(r, live, [], Date.parse('2026-11-21T04:30:00.000Z'))!.name, 't13_groom_a1_cc4e');
  assert.equal(agentAddress(r, live), 'w1:9');
});

test('hookNote says where a hook runs, the gate decision and its time', () => {
  const now = Date.parse('2026-11-21T03:54:45.575Z');
  const t8 = pipelineRows(byId('t8'), WIDE);
  assert.equal(hookNote(byId('t8'), row(t8, 'approve-groom'), now), 'After · approved by @zidious');
  assert.equal(hookNote(byId('t8'), row(t8, 'security-scan'), now), 'After · 34s');
  assert.equal(hookNote(byId('t8'), row(t8, 'notify'), now), 'after-all');
  const t2 = pipelineRows(byId('t2'), WIDE);
  assert.equal(hookNote(byId('t2'), row(t2, 'approve-groom'), Date.parse('2026-11-21T03:54:45.575Z')), 'After · waiting 3h');
});

test('roundNote gives a loop target past round 1 its round and its latest attempt time', () => {
  const now = Date.parse('2026-11-21T05:00:00.000Z');
  assert.equal(roundNote(byId('t4'), 'implement', now), 'Round 3 · 4m'); // its third attempt took 3m50s
  assert.equal(roundNote(byId('t16'), 'lint-baseline', now), 'Round 2 · 4s');
  assert.equal(roundNote(byId('t3'), 'implement', now), '', 'round 1');
  assert.equal(roundNote(byId('t4'), 'review', now), '', 'a loop start, not its target');
  const t4 = readable('t4');
  const untimed = { ...t4, timeline: [] } as RunStatusJson;
  assert.equal(roundNote(untimed, 'implement', now), 'Round 3', 'no time to show');
});

test('hookNote carries the round of a hook a loop goes back to', () => {
  const now = Date.parse('2026-11-21T05:00:00.000Z');
  const r = byId('t16');
  const open = pipelineRows(r, { narrow: false, unfolded: ['implement'] });
  assert.equal(hookNote(r, row(open, 'lint-baseline'), now), 'Before · round 2 · 4s');
  assert.equal(hookNote(r, row(open, 'deps-audit'), now), 'Before · 15s');
});

test('unfoldAfterPick opens a picked stage that holds folded hooks, and folds it again when it is closed', () => {
  const t16 = byId('t16');
  assert.deepEqual(unfoldAfterPick(t16, WIDE, null, 'implement'), ['implement']);
  assert.deepEqual(unfoldAfterPick(t16, { narrow: false, unfolded: ['implement'] }, 'implement', 'lint-baseline'), ['implement']);
  assert.deepEqual(unfoldAfterPick(t16, { narrow: false, unfolded: ['implement'] }, 'implement', null), []);
  assert.deepEqual(unfoldAfterPick(t16, WIDE, null, 'plan'), []);
  assert.deepEqual(unfoldAfterPick(byId('t8'), { narrow: true, unfolded: [] }, null, 'intake'), ['intake']);
  assert.deepEqual(unfoldAfterPick(byId('t8'), { narrow: true, unfolded: ['groom'] }, 'groom', 'plan'), ['groom']);
});

test('pipelineMarks finds the active row, the last reached row and the row the stop strip opens under', () => {
  const t16 = pipelineRows(byId('t16'), WIDE);
  assert.deepEqual(pipelineMarks(t16, null), { active: 3, reached: 3, stripAt: -1 });
  // a picked visible hook opens its strip on its own row; one folded into its stage, on the stage's row
  assert.deepEqual(pipelineMarks(t16, 'coverage'), { active: 3, reached: 3, stripAt: 5 });
  assert.deepEqual(pipelineMarks(t16, 'deps-audit'), { active: 3, reached: 3, stripAt: 3 });
  assert.deepEqual(pipelineMarks(t16, 'nope'), { active: 3, reached: 3, stripAt: -1 });

  // no active row: the spine is reached up to the last row that is not future
  assert.deepEqual(pipelineMarks(pipelineRows(byId('t3'), WIDE), 'plan'), { active: -1, reached: 6, stripAt: 3 });
  const t3 = readable('t3');
  const undelivered = { ...t3, steps: t3.steps.map((s) => (s.id === 'deliver' ? { ...s, status: 'pending' as const } : s)) };
  assert.deepEqual(pipelineMarks(pipelineRows(undelivered, WIDE), null), { active: -1, reached: 5, stripAt: -1 });

  assert.deepEqual(pipelineMarks(pipelineRows(byId('t5'), WIDE), 'intake'), { active: -1, reached: -1, stripAt: -1 });
  assert.deepEqual(pipelineMarks([], null), { active: -1, reached: -1, stripAt: -1 });
});

test('agentTone colours the agent status Herdr reports', () => {
  assert.deepEqual(['blocked', 'working', 'idle', 'done', 'open', 'not open'].map(agentTone), [
    'blocked',
    'working',
    'muted',
    'muted',
    'muted',
    'muted',
  ]);
});

test('openAgentAt focuses a live agent terminal, else says why it did not', () => {
  const name = 't16_implement_a2_4a92';
  const live = [{ address: 'w1:7', name }];
  assert.deepEqual(openAgentAt(byId('t16'), live, false), { address: 'w1:7' });
  assert.deepEqual(openAgentAt(byId('t16'), [], false), { error: `${name} is not a live terminal; refresh the panel` });
  assert.deepEqual(openAgentAt(byId('t16'), live, true), { said: `Fixtures: would open ${name}` });
  assert.equal(openAgentAt(byId('t11'), live, false), null, 'the step has no terminal');
  assert.equal(openAgentAt(byId('t5'), live, true), null, 'unreadable');
});

test('agentAddress is the live terminal of the current step, else null: Open terminal is off without one', () => {
  const name = 't16_implement_a2_4a92';
  assert.equal(agentAddress(byId('t16'), [{ address: 'w1:7', name }]), 'w1:7');
  assert.equal(agentAddress(byId('t16'), []), null, 'not live');
  assert.equal(agentAddress(byId('t11'), [{ address: 'w1:7', name }]), null, 'the step has no terminal');
  assert.equal(agentAddress(byId('t5'), [{ address: 'w1:7', name }]), null, 'unreadable');
});

test('boxActions are the attention buttons without open-pane (Open terminal ↗ does that)', () => {
  assert.deepEqual(boxActions(byId('t2')), ['approve', 'reject']);
  assert.deepEqual(boxActions(byId('t13')), []);
  const both = { ...readable('t4'), attention: { ...readable('t4').attention!, actions: ['grant', 'open-pane'] } } as Readable;
  assert.deepEqual(boxActions(both), ['grant']);
  assert.deepEqual(boxActions(byId('t8')), []);
});

test('readerFiles: the box reads the first review file; the strip its picked output, else its round first output', () => {
  assert.deepEqual(readerFiles(byId('t2'), null, null, null), { box: 'samples/groomed_ticket.md', strip: null });
  assert.deepEqual(readerFiles(byId('t12'), null, null, null), { box: null, strip: null }, 'nothing to review');
  assert.deepEqual(readerFiles(byId('t13'), null, null, null), { box: null, strip: null }, 'an agent card reads nothing');
  const groom = Object.values(stepAttempts(byId('t2'), 'groom').at(-1)!.outputs ?? {});
  assert.ok(groom.length > 0);
  assert.equal(groom[0], 'samples/groomed_ticket.md');
  assert.deepEqual(readerFiles(byId('t2'), 'groom', null, null), { box: 'samples/groomed_ticket.md', strip: null }, 'the box already reads it');
  assert.deepEqual(readerFiles(byId('t2'), 'groom', null, 'samples/groomed_ticket.md'), { box: 'samples/groomed_ticket.md', strip: null });
  assert.deepEqual(readerFiles(byId('t2'), 'groom', null, 'x/other.md'), { box: 'samples/groomed_ticket.md', strip: 'x/other.md' });
  assert.deepEqual(readerFiles(byId('t2'), 'plan', null, null), { box: 'samples/groomed_ticket.md', strip: null }, 'not run: no review fallback');
  assert.deepEqual(readerFiles(byId('t2'), null, null, 'x/other.md'), { box: 'samples/groomed_ticket.md', strip: null }, 'no stop: no strip');
});

test('readerMax: the inline reader is at most half the panel', () => {
  assert.equal(readerMax(600), 300);
  assert.equal(readerMax(601), 301);
  assert.equal(readerMax(0), 0);
});

test('readFullShown: Read full ↗ pops the panel out, so it shows only when docked', () => {
  assert.equal(readFullShown(false), true);
  assert.equal(readFullShown(true), false);
});

test('boxOutside: an active box with no active row in the pipeline shows below it instead', () => {
  assert.equal(boxOutside(byId('t2'), WIDE), false, 'under its stop');
  assert.equal(boxOutside(byId('t3'), WIDE), false, 'no box');
  const lost = { ...readable('t9'), currentStep: 'gone' } as Readable;
  assert.equal(boxOutside(lost, WIDE), true);
  assert.equal(boxOutside(byId('t5'), WIDE), false, 'unreadable');
});

test('readerFiles reads the step outputs of an older perc, and the picked round', () => {
  const gate = readable('t2');
  const { timeline: _t, ...older } = gate; // an older perc: the steps' own outputs are read
  const out = { ...older, steps: gate.steps.map((s) => (s.id === 'groom' ? { ...s, outputs: { groomed_ticket: '/abs/g.md' } } : s)) } as unknown as Readable;
  assert.equal(readerFiles(out, 'groom', null, null).strip, '/abs/g.md');
  assert.equal(readerFiles(out, 'intake', null, null).strip, null, 'no outputs: no review fallback');
  assert.equal(readerFiles(readable('t8'), 'review', 2, null).strip, 'samples/findings.md');
  assert.equal(readerFiles(readable('t8'), 'review', null, null).strip, null, 'the running round has no outputs yet');
});

test('slotOpensAgent: the active stop opens the agent while one works there in a live terminal', () => {
  const name = 't16_implement_a2_4a92';
  assert.equal(slotOpensAgent(byId('t16'), [{ address: 'w1:7', name }]), true);
  assert.equal(slotOpensAgent(byId('t16'), []), false, 'not live');
  const t13 = readable('t13');
  assert.equal(slotOpensAgent(t13, [{ address: 'w1:2', name: t13.terminals.groom! }]), true, 'a blocked agent');
  assert.equal(slotOpensAgent(byId('t2'), [{ address: 'w1:1', name: 't2_driver_a0_b90e' }]), false, 'a gate');
  assert.equal(slotOpensAgent(byId('t5'), []), false);
});

test('boxAsks and showsOutcome: what the lower half shows besides the history', () => {
  assert.deepEqual(['t2', 't4', 't12', 't9', 't11', 't13', 't16', 't3', 't14', 't15', 't5'].map((p) => boxAsks(byId(p))), [
    true, true, true, true, true, false, false, false, false, false, false,
  ]);
  assert.deepEqual(['t2', 't16', 't3', 't14', 't15', 't5'].map((p) => showsOutcome(byId(p))), [false, false, true, false, true, true]);
});

test('programInitial is the badge letter of the agent program', () => {
  assert.equal(programInitial('Claude Code'), 'C');
  assert.equal(programInitial('codex'), 'C');
  assert.equal(programInitial('  amp'), 'A');
  assert.equal(programInitial(''), '?');
});

test('agentNote says the agent has not started when the active stop has no agent terminal', () => {
  assert.equal(agentNote(null), 'Agent not started');
  assert.equal(agentNote({ address: null, name: 'x', status: 'not open', program: 'Agent', since: '' }), null);
});

test('boxDriver: a failed or stalled box offers the driver peek when there is one', () => {
  const t11 = readable('t11');
  const drv = 't11_driver_a0_1111';
  const stalled = { ...t11, driver: { ...t11.driver, terminal: drv }, terminals: { driver: drv } } as Readable;
  assert.deepEqual(boxDriver(stalled), { terminal: drv, label: 'Driver pane ↗' });
  const t9 = readable('t9');
  const failed = { ...t9, driver: { ...t9.driver, terminal: drv }, terminals: { driver: drv } } as Readable;
  assert.deepEqual(boxDriver(failed), { terminal: drv, label: 'Driver pane ↗' });
  assert.equal(boxDriver(byId('t11')), null, 'no live driver');
  assert.equal(boxDriver(byId('t2')), null, 'a gate: the header has it');
  assert.equal(boxDriver(byId('t16')), null);
});

test('historyLabel counts the attempts, singular for one, none for an empty history', () => {
  assert.equal(historyLabel(byId('t3'), false), 'History ▸ 7 attempts');
  assert.equal(historyLabel(byId('t3'), true), 'History ▾ 7 attempts');
  assert.equal(historyLabel(byId('t14'), false), 'History ▸ 1 attempt');
  assert.equal(historyLabel(byId('t5'), false), 'History ▸');
  assert.equal(historyLabel(byId('t5'), true), 'History ▾');
  assert.equal(historyLabel(byId('t4'), false), 'History ▸ 10 attempts', 'its loop-cap row is not an attempt');
});

test('columns: two columns from 720px wide (the window, a wide panel), else one', () => {
  assert.equal(columns(719), 'one');
  assert.equal(columns(720), 'two');
  assert.equal(columns(860), 'two');
  assert.equal(columns(380), 'one');
});

test('panelShape: narrow, columns and fold all measure design px, so they agree at any zoom', () => {
  assert.deepEqual(panelShape(570, 1.5), { narrow: true, cols: 'one', fold: false });
  assert.deepEqual(panelShape(1080, 1.5), { narrow: false, cols: 'two', fold: false });
  assert.deepEqual(panelShape(750, 1.5), { narrow: true, cols: 'one', fold: false });
  assert.deepEqual(panelShape(720, 1), { narrow: false, cols: 'two', fold: false });
  assert.deepEqual(panelShape(380, 1), { narrow: true, cols: 'one', fold: false });
  assert.deepEqual(panelShape(700, 0.8), { narrow: false, cols: 'two', fold: false });
  assert.deepEqual(panelShape(575.99, 0.8), { narrow: false, cols: 'two', fold: false }); // 720 at zoom 0.8, measured in floats
});

test('panelShape folds every passed hook only under 320 design px; the 330px left column of two does not', () => {
  assert.equal(panelShape(319, 1).fold, true);
  assert.equal(panelShape(320, 1).fold, false);
  assert.equal(panelShape(450, 1.5).fold, true); // 300 design px
  assert.equal(panelShape(255.99, 0.8).fold, false); // 320 at zoom 0.8
});

test('detailParts: one column keeps the box and strip under their rows; two columns move them to the right column', () => {
  const one = (stopSel: string | null) => ({ cols: 'one' as const, narrow: false, unfolded: [] as string[], stopSel });
  const two = (stopSel: string | null) => ({ cols: 'two' as const, narrow: true, unfolded: [] as string[], stopSel });
  assert.deepEqual(detailParts(byId('t2'), one(null)), { under: true, side: [] }, 'the gate box sits under its stop');
  assert.deepEqual(detailParts(byId('t2'), one('groom')), { under: true, side: [] }, 'the strip sits under its row');
  assert.deepEqual(detailParts(byId('t3'), one('review')), { under: true, side: ['outcome'] });
  const lost = { ...readable('t9'), currentStep: 'gone' } as Readable;
  assert.deepEqual(detailParts(lost, one(null)), { under: true, side: ['box'] }, 'no active row: the box shows below');

  assert.deepEqual(detailParts(byId('t2'), two(null)), { under: false, side: ['box'] }, 'the gate box moves right');
  assert.deepEqual(detailParts(byId('t2'), two('groom')), { under: false, side: ['box', 'strip'] }, 'the strip under it');
  assert.deepEqual(detailParts(lost, two(null)), { under: false, side: ['box'] });
  assert.deepEqual(detailParts(byId('t16'), two(null)), { under: false, side: ['box'] }, 'the agent card moves right');
  assert.deepEqual(detailParts(byId('t3'), two(null)), { under: false, side: ['outcome'] });
  assert.deepEqual(detailParts(byId('t3'), two('review')), { under: false, side: ['outcome', 'strip'] });
  assert.deepEqual(detailParts(byId('t3'), two('gone')), { under: false, side: ['outcome'] }, 'a stop not in the run');
  assert.deepEqual(detailParts(byId('t5'), two(null)), { under: false, side: ['outcome'] }, 'unreadable');
});

// ── the start dialog (perc pipelines --json) ──

const PIPES_RAW = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'pipelines.json'), 'utf8');
const pipe = (name: string) => (JSON.parse(PIPES_RAW).pipelines as Pipeline[]).find((p) => p.name === name)!;
const started = (o: { id: string; repo: string; createdAt: string; ref?: string }) =>
  ({ ...readable('t3'), id: o.id, repo: o.repo, createdAt: o.createdAt, ticket: o.ref ? { ref: o.ref, number: 1 } : null }) as unknown as Readable;

test('readPipelines reads perc pipelines --json and refuses what it does not know', () => {
  const read = readPipelines(PIPES_RAW);
  assert.ok(read.ok);
  assert.equal(read.data.pipelines.length, 4);
  assert.deepEqual(readPipelines('nope'), { ok: false, error: 'perc pipelines --json returned invalid JSON' });
  assert.deepEqual(readPipelines('{"schema":1}'), { ok: false, error: 'perc pipelines --json returned invalid JSON' });
  assert.deepEqual(readPipelines('{"schema":2,"pipelines":[]}'), {
    ok: false,
    error: 'perc pipelines --json returned schema 2; update the Percolator panel',
  });
});

test('pipelinesFixture is pipelines.json beside the status fixture', () => {
  assert.equal(pipelinesFixture('/home/me/fx/status.json'), '/home/me/fx/pipelines.json');
  assert.equal(pipelinesFixture('C:\\fx\\status.json'), 'C:\\fx/pipelines.json');
});

test('pipelinesFixture of a bare file name is pipelines.json beside it', () => {
  assert.equal(pipelinesFixture('status.json'), 'pipelines.json');
});

test('startFields: the ticket field (hidden when the pipeline takes none) and each input with its description', () => {
  assert.deepEqual(startFields(pipe('feature')), { ticket: 'required', inputs: [] });
  assert.deepEqual(startFields(pipe('dd-alert')), {
    ticket: 'hidden',
    inputs: [{ name: 'alert_url', required: true, description: 'Datadog alert URL' }],
  });
  assert.deepEqual(startFields(pipe('spike')), {
    ticket: 'optional',
    inputs: [
      { name: 'question', required: false, description: 'What to find out' },
      { name: 'depth', required: false, description: '' },
    ],
  });
});

test('knownRepos lists each repo once, most recent run first, and skips unreadable runs', () => {
  const rs = [
    started({ id: 'a', repo: '/src/a', createdAt: '2026-11-01T00:00:00.000Z' }),
    started({ id: 'b', repo: '/src/b', createdAt: '2026-11-10T00:00:00.000Z' }),
    started({ id: 'c', repo: '/src/a', createdAt: '2026-11-20T00:00:00.000Z' }),
    { id: 'd', status: 'unreadable', error: 'bad' } as RunStatusJson,
  ];
  assert.deepEqual(knownRepos(rs), ['/src/a', '/src/b']);
  assert.deepEqual(knownRepos(runs()), ['/home/me/src/percolator']);
  assert.deepEqual(knownRepos([]), []);
});

test('ticketRepo is the lower-cased host/owner/repo of a ticket URL or ref, else null', () => {
  assert.equal(ticketRepo('https://github.com/O/R/issues/3'), 'github.com/o/r');
  assert.equal(ticketRepo('  https://ghe.example.com/a/b/pull/2 '), 'ghe.example.com/a/b');
  assert.equal(ticketRepo('o/r#3'), 'github.com/o/r');
  assert.equal(ticketRepo('github.com/Zidious/percolator#16'), 'github.com/zidious/percolator');
  for (const t of ['', '#3', '3', 'not a ticket', 'https://github.com/o']) assert.equal(ticketRepo(t), null, t);
});

test('guessRepo is the repo of the most recent run on the same GitHub repo, else null', () => {
  const rs = [
    started({ id: 'old', repo: '/src/r-old', createdAt: '2026-11-01T00:00:00.000Z', ref: 'github.com/o/r#1' }),
    started({ id: 'new', repo: '/src/r', createdAt: '2026-11-10T00:00:00.000Z', ref: 'github.com/o/r#2' }),
    started({ id: 'rx', repo: '/src/rx', createdAt: '2026-11-20T00:00:00.000Z', ref: 'github.com/o/rx#5' }),
    started({ id: 'none', repo: '/src/x', createdAt: '2026-11-21T00:00:00.000Z' }),
    { id: 'bad', status: 'unreadable', error: 'bad' } as RunStatusJson,
  ];
  assert.equal(guessRepo('https://github.com/o/r/issues/3', rs), '/src/r');
  assert.equal(guessRepo('o/rx#9', rs), '/src/rx');
  assert.equal(guessRepo('https://github.com/o/q/issues/3', rs), null);
  assert.equal(guessRepo('nonsense', rs), null);
  assert.equal(guessRepo('zidious/percolator#99', runs()), '/home/me/src/percolator');
});

test('startArgv: the ticket if any, repo, pipeline, then inputs in declared order without empty optional ones', () => {
  assert.deepEqual(startArgv({ pipeline: pipe('dd-alert'), inputs: { alert_url: 'https://x/a b' }, repo: '/src/r' }), [
    'run', '--repo', '/src/r', '--pipeline', 'dd-alert', '--input', 'alert_url=https://x/a b',
  ]);
  assert.deepEqual(startArgv({ pipeline: pipe('feature'), ticket: ' o/r#3 ', inputs: {}, repo: '/src/r' }), [
    'run', 'o/r#3', '--repo', '/src/r', '--pipeline', 'feature',
  ]);
  assert.deepEqual(startArgv({ pipeline: pipe('spike'), ticket: '', inputs: { depth: '2', question: 'why q' }, repo: '/r' }), [
    'run', '--repo', '/r', '--pipeline', 'spike', '--input', 'question=why q', '--input', 'depth=2',
  ]);
  assert.deepEqual(startArgv({ pipeline: pipe('spike'), inputs: { depth: '2', question: '  ' }, repo: '/r' }), [
    'run', '--repo', '/r', '--pipeline', 'spike', '--input', 'depth=2',
  ]);
});

test('commandLine quotes an argument holding whitespace or a double quote', () => {
  assert.equal(commandLine(['run', '--input', 'q=a b']), 'perc run --input "q=a b"');
  assert.equal(commandLine(['run', '--input', 'q=say "hi"']), 'perc run --input "q=say \\"hi\\""');
  assert.equal(commandLine(['run', '--repo', 'C:\\My Repos\\r']), 'perc run --repo "C:\\My Repos\\r"');
  assert.equal(commandLine(['run', 'o/r#3', '--pipeline', 'feature']), 'perc run o/r#3 --pipeline feature');
});

test('canStart says what is missing: the repo, then the ticket, then the first empty required input', () => {
  assert.deepEqual(canStart({ pipeline: pipe('dd-alert'), inputs: {}, repo: '/r' }), { ok: false, why: 'Enter alert_url' });
  assert.deepEqual(canStart({ pipeline: pipe('dd-alert'), inputs: { alert_url: ' ' }, repo: '/r' }), { ok: false, why: 'Enter alert_url' });
  assert.deepEqual(canStart({ pipeline: pipe('dd-alert'), inputs: { alert_url: 'https://x' }, repo: '/r' }), { ok: true });
  assert.deepEqual(canStart({ pipeline: pipe('dd-alert'), inputs: {}, repo: null }), { ok: false, why: 'Pick a repo' });
  assert.deepEqual(canStart({ pipeline: pipe('feature'), ticket: '', inputs: {}, repo: '' }), { ok: false, why: 'Pick a repo' });
  assert.deepEqual(canStart({ pipeline: pipe('feature'), ticket: '  ', inputs: {}, repo: '/r' }), { ok: false, why: 'Enter a ticket' });
  assert.deepEqual(canStart({ pipeline: pipe('feature'), ticket: 'o/r#3', inputs: {}, repo: '/r' }), { ok: true });
  assert.deepEqual(canStart({ pipeline: pipe('spike'), inputs: {}, repo: '/r' }), { ok: true });
});

test('canStart refuses a ticket starting with -, which perc run would read as a flag', () => {
  assert.deepEqual(canStart({ pipeline: pipe('feature'), ticket: ' --help', inputs: {}, repo: '/r' }), { ok: false, why: 'A ticket cannot start with -' });
  assert.deepEqual(canStart({ pipeline: pipe('spike'), ticket: '-x', inputs: {}, repo: '/r' }), { ok: false, why: 'A ticket cannot start with -' });
});

test('startPick keeps the wanted pipeline while it is listed and pickable, else the default, else the first pickable', () => {
  const all = ALL_PIPES_START();
  assert.equal(startPick(all, 'hotfix'), 'hotfix');
  assert.equal(startPick(all, 'gone'), 'feature', 'a pipeline the repo no longer has falls back to the default');
  assert.equal(startPick(all, 'broken'), 'feature', 'a broken pipeline cannot be picked');
  assert.equal(startPick(all, null), 'feature');
  const noDefault = all.map((p) => ('error' in p ? p : { ...p, default: false }));
  assert.equal(startPick(noDefault.slice(1), null), 'hotfix');
  assert.equal(startPick([{ name: 'broken', error: 'x' }], null), null);
  // run next: only the names it offers
  assert.equal(startPick(all, null, ['hotfix', 'spike']), 'hotfix');
  assert.equal(startPick(all, 'spike', ['hotfix', 'spike']), 'spike');
  assert.equal(startPick(all, 'dd-alert', ['hotfix', 'spike']), 'hotfix');
});

test('pipelineOption gives a picker row its tags and its note: the description, else the exit, else the error', () => {
  assert.deepEqual(pipelineOption(pipe('feature')), {
    name: 'feature',
    tags: ['Default'],
    note: 'Groom, plan, implement and review a ticket, then open a PR',
    error: false,
  });
  assert.deepEqual(pipelineOption(pipe('dd-alert')).tags, ['No ticket']);
  assert.deepEqual(pipelineOption(pipe('spike')), { name: 'spike', tags: ['Ticket optional'], note: 'Ends with none', error: false });
  assert.deepEqual(pipelineOption({ name: 'broken', error: 'pipelines.broken: no exit' }), {
    name: 'broken',
    tags: [],
    note: 'pipelines.broken: no exit',
    error: true,
  });
});

test('startedRun reads the run id perc run prints, else null', () => {
  assert.equal(startedRun('run t3-hotfix-20261122-101500-ab12 started\n  terminal t3_driver\n'),'t3-hotfix-20261122-101500-ab12');
  assert.equal(startedRun('something else'), null);
  assert.equal(startedRun(''), null);
});

test('wouldStart says what a fixture-mode Start would run', () => {
  assert.equal(
    wouldStart(['run', '--repo', '/r', '--pipeline', 'dd-alert', '--input', 'alert_url=a b']),
    'Fixture: would run perc run --repo /r --pipeline dd-alert --input "alert_url=a b"',
  );
});

const ALL_PIPES_START = () => [...(JSON.parse(PIPES_RAW).pipelines as Pipeline[]), { name: 'broken', error: 'pipelines.broken: no exit' }];

// ── run next and the pipeline preview ──

const ALL_PIPES = () => [...(JSON.parse(PIPES_RAW).pipelines as Pipeline[]), { name: 'broken', error: 'pipelines.broken: no exit' }];
const T3 = 'github.com/zidious/percolator#3';

test('run next is hidden while the ticket has a live run', () => {
  const done = readable('t3');
  for (const status of ['running', 'waiting', 'paused'] as const) {
    const live = { ...readable('t8'), id: `t3-${status}`, status, ticket: { ref: T3, number: 3 } } as Readable;
    assert.equal(runNextChoices(done, ALL_PIPES(), [...runs(), live]), null, status);
  }
  assert.equal(runNextChoices(readable('t8'), ALL_PIPES(), runs()), null, 'a running run offers no run next');
  assert.equal(runNextChoices(byId('t5'), ALL_PIPES(), runs()), null, 'an unreadable run offers none');
  const old = { ...readable('t9'), id: 't3-old', ticket: { ref: T3, number: 3 } } as Readable;
  assert.notEqual(runNextChoices(done, ALL_PIPES(), [...runs(), old]), null, 'a failed run on the ticket is not live');
});

test('run next lists only pipelines that take a ticket', () => {
  assert.deepEqual(runNextChoices(readable('t3'), ALL_PIPES(), runs()), { tickets: [T3], pipelines: ['feature', 'hotfix', 'spike'] });
  assert.deepEqual(runNextChoices(readable('t9'), ALL_PIPES(), runs()), {
    tickets: ['github.com/zidious/percolator#9'],
    pipelines: ['feature', 'hotfix', 'spike'],
  });
});

test('run next offers the issues an issue exit opened', () => {
  const opened = [
    { ref: 'github.com/o/r#40', url: 'https://github.com/o/r/issues/40' },
    { ref: 'github.com/o/r#41', url: 'https://github.com/o/r/issues/41' },
  ];
  const withIssues = { ...readable('t3'), opened } as unknown as Readable;
  assert.deepEqual(runNextChoices(withIssues, ALL_PIPES(), runs())?.tickets, [T3, 'github.com/o/r#40', 'github.com/o/r#41']);
  const ticketless = { ...readable('t3'), ticket: null, opened } as unknown as Readable;
  assert.deepEqual(runNextChoices(ticketless, ALL_PIPES(), runs())?.tickets, ['github.com/o/r#40', 'github.com/o/r#41']);
  assert.equal(runNextChoices({ ...ticketless, opened: [] } as unknown as Readable, ALL_PIPES(), runs()), null);
  assert.equal(runNextChoices({ ...readable('t3'), ticket: null } as unknown as Readable, ALL_PIPES(), runs()), null);
});

test('previewRun draws through pipelineRows', () => {
  const run = previewRun(pipe('hotfix'));
  assert.deepEqual(
    { id: run.id, status: run.status, ticket: run.ticket, pipeline: (run as any).pipeline, timeline: run.timeline },
    { id: 'preview', status: 'pending', ticket: null, pipeline: 'hotfix', timeline: [] },
  );
  assert.deepEqual(run.steps[1], { id: 'reproduce', stage: 'reproduce', role: 'core', kind: 'agent', status: 'pending', attempts: 0, outputs: {} });
  assert.deepEqual(run.loops, [{ id: 'review', from: 'review', to: 'fix', max: 3, atCap: 'continue', round: 0 }]);
  const rows = pipelineRows(run, { narrow: false, unfolded: [] });
  const shown = rows.map((r) => r.step.id);
  for (const id of ['reproduce', 'fix', 'deliver']) assert.ok(shown.includes(id), id);
  assert.deepEqual(shown, ['intake', 'reproduce', 'fix', 'review', 'deliver']);
  assert.ok(rows.every((r) => r.state === 'future'));
  assert.deepEqual(pipelineSpans(rows, run), [{ from: 3, to: 2, tone: 'dim' }]);
  assert.deepEqual(pipelineMarks(rows, null), { active: -1, reached: -1, stripAt: -1 });
  const feature = pipelineRows(previewRun(pipe('feature')), { narrow: false, unfolded: [] });
  assert.deepEqual(feature.map((r) => [r.type, r.step.id]).slice(1, 3), [['stage', 'groom'], ['hook', 'approve-groom']]);
});

test('previewSide is below at 280 and 380 and right at 720', () => {
  assert.equal(previewSide(280), 'below');
  assert.equal(previewSide(380), 'below');
  assert.equal(previewSide(719), 'below');
  assert.equal(previewSide(720), 'right');
  assert.equal(previewSide(1200), 'right');
});

test('actionArgv pick approves the gate with the picked pipeline', () => {
  const r = byId('t22');
  assert.deepEqual(actionArgv('pick', r, 'hotfix'), ['approve', r.id, '--pipeline', 'hotfix']);
  for (const name of [undefined, '', '  ']) assert.throws(() => actionArgv('pick', r, name), { message: 'Pick a pipeline' });
});

const HOTFIX = 't21-hotfix-20261121-070000-4b5c';
const TRIAGE = 't21-triage-20261121-065800-9e3a';

test('linkedLine for a child and for a parent', () => {
  const rs = runs();
  const of = (id: string) => rs.find((r) => r.id === id)!;
  // the parent is on the child's own ticket, so the line names its pipeline
  assert.deepEqual(linkedLine(of(HOTFIX), rs), { text: '↳ from triage', run: TRIAGE });
  assert.deepEqual(linkedLine(of(TRIAGE), rs), { text: '→ 1 run', run: HOTFIX });
  assert.equal(linkedLine(readable('t8'), rs), null);
  assert.equal(linkedLine(byId('t5'), rs), null);
});

test('linkedLine names a parent on another ticket by its number, a ticketless one by its pipeline, a gone one by its id', () => {
  const child = { ...readable('t8'), parent: 'p1' } as Readable;
  const parent = (over: Partial<Readable>) => ({ ...readable('t3'), id: 'p1', children: [], ...over }) as Readable;
  assert.deepEqual(linkedLine(child, [child, parent({})]), { text: '↳ from #3', run: 'p1' });
  assert.deepEqual(linkedLine(child, [child, parent({ ticket: null, pipeline: 'spike' })]), { text: '↳ from spike', run: 'p1' });
  assert.deepEqual(linkedLine(child, [child]), { text: '↳ from p1', run: null });
  const two = parent({ children: [{ id: 'c1', pipeline: 'hotfix', status: 'running' }, { id: 'c2', pipeline: 'hotfix', status: 'completed' }] });
  // neither child is listed: nothing to select
  assert.deepEqual(linkedLine(two, [two]), { text: '→ 2 runs', run: null });
});

const EPIC = 't23-epic-20261121-090000-7c2a';

test('linkedLine on a fan-out parent counts its slices and how many started; clicking it picks the first listed child', () => {
  const rs = runs();
  const of = (id: string) => rs.find((r) => r.id === id)!;
  assert.deepEqual(linkedLine(of(EPIC), rs), { text: '→ 3 slices · 2 started', run: `${EPIC}-s1` });
  // slice 1 deleted: the first listed child is slice 2
  const gone = rs.filter((r) => r.id !== `${EPIC}-s1`);
  assert.deepEqual(linkedLine(of(EPIC), gone), { text: '→ 3 slices · 2 started', run: `${EPIC}-s2` });
  // none listed: nothing to select
  assert.deepEqual(linkedLine(of(EPIC), [of(EPIC)]), { text: '→ 3 slices · 2 started', run: null });
  const all = { ...(of(EPIC) as Readable), children: (of(EPIC) as Readable).children.map((c) => ({ ...c, status: 'running' as const })) };
  assert.deepEqual(linkedLine(all, rs), { text: '→ 3 slices', run: `${EPIC}-s1` });
});

test('linkedLine on a slice names its index, the parent ticket and its title', () => {
  const rs = runs();
  const s2 = rs.find((r) => r.id === `${EPIC}-s2`)!;
  assert.deepEqual(linkedLine(s2, rs), { text: '↳ slice 2 of #23: Panel rows', run: EPIC });
  const parent = { ...(rs.find((r) => r.id === EPIC) as Readable), ticket: null };
  assert.deepEqual(linkedLine(s2, [s2, parent]), { text: '↳ slice 2 of epic: Panel rows', run: EPIC });
});

test('linkedLine on a routed fan-out parent says where it came from and its slices', () => {
  const rs = runs();
  const epic = { ...(rs.find((r) => r.id === EPIC) as Readable), parent: TRIAGE };
  assert.deepEqual(linkedLine(epic, [...rs.filter((r) => r.id !== EPIC), epic]), { text: '↳ from #21 · → 3 slices · 2 started', run: TRIAGE });
});

test("sliceRows shows each slice's step and PR", () => {
  const rs = runs();
  const of = (id: string) => rs.find((r) => r.id === id)!;
  assert.deepEqual(sliceRows(of(EPIC), rs), [
    { index: 1, title: 'Status field', id: `${EPIC}-s1`, status: 'completed', stepLabel: 'Done', prUrl: 'https://github.com/Zidious/percolator/pull/31' },
    { index: 2, title: 'Panel rows', id: `${EPIC}-s2`, status: 'running', stepLabel: 'review' },
    { index: 3, title: 'Docs', id: `${EPIC}-s3`, status: 'pending', stepLabel: 'Not started' },
  ]);
  // a linked run that is not a slice, a run with no children and an unreadable one have none
  assert.deepEqual(sliceRows(of(TRIAGE), rs), []);
  assert.deepEqual(sliceRows(readable('t8'), rs), []);
  assert.deepEqual(sliceRows(byId('t5'), rs), []);
});

test('sliceRows reads a slice no longer listed from its child entry', () => {
  const parent = {
    ...readable('t3'),
    children: [
      { id: 'p-s1', pipeline: 'feature', status: 'completed', slice: { index: 1, title: 'A' } },
      { id: 'p-s2', pipeline: 'feature', status: 'failed', slice: { index: 2, title: 'B' } },
    ],
  } as Readable;
  assert.deepEqual(sliceRows(parent, [parent]), [
    { index: 1, title: 'A', id: 'p-s1', status: 'completed', stepLabel: 'Done' },
    { index: 2, title: 'B', id: 'p-s2', status: 'failed', stepLabel: 'Failed' },
  ]);
});

test('fanOutRow is the row of the last stage, where the fan-out step sits; -1 without one', () => {
  const epic = runs().find((r) => r.id === EPIC)!;
  const rows = pipelineRows(epic, { narrow: false, unfolded: [] });
  assert.equal(rows[fanOutRow(rows)]!.step.id, 'implement');
  assert.equal(fanOutRow([]), -1);
});

test('watcherState labels and argv', () => {
  const st = load();
  assert.deepEqual(watcherState(st), { alive: true, label: 'Watching 1 repo', argv: ['watch', 'stop'] });
  const two = { ...st, watcher: { alive: true, since: 'x', repos: ['/a', '/b'] } };
  assert.equal(watcherState(two).label, 'Watching 2 repos');
  const off = { ...st, watcher: { alive: false, repos: [] } };
  assert.deepEqual(watcherState(off), { alive: false, label: 'Not watching', argv: ['watch', '--repo', '/home/me/src/percolator'] });
  // with no earlier runs there is no repo to watch: no Start button
  assert.deepEqual(watcherState({ schema: 2, runs: [], watcher: { alive: false, repos: [] } }), { alive: false, label: 'Not watching', argv: null });
  // a perc without the watcher field reads as not watching
  const { watcher: _w, ...older } = st;
  assert.equal(watcherState(older as StatusJson).label, 'Not watching');
});

test('watcherState says starting… after Start until the heartbeat appears, and offers nothing meanwhile', () => {
  const off = { ...load(), watcher: { alive: false, repos: [] } };
  const now = Date.parse('2026-11-21T10:00:00.000Z');
  const live = [{ address: 'w:1', name: 'percolator-watch' }];
  assert.deepEqual(watcherState(off, { startedAt: now - 5_000, now, live }), { alive: false, label: 'Starting…', argv: null });
  assert.deepEqual(watcherState(off, { startedAt: now - 5_000, now, live: [] }), { alive: false, label: 'Starting…', argv: null });
  // the heartbeat came: watching
  assert.equal(watcherState(load(), { startedAt: now - 5_000, now, live }).label, 'Watching 1 repo');
  // a minute without a heartbeat: starting is over
  assert.equal(watcherState(off, { startedAt: now - 61_000, now, live: [] }).label, 'Not watching');
});

test('watcherState offers Stop when the heartbeat is stale but the percolator-watch terminal is live', () => {
  const off = { ...load(), watcher: { alive: false, repos: ['/r'] } };
  const live = [{ address: 'w:1', name: 'percolator-watch' }];
  assert.deepEqual(watcherState(off, { startedAt: null, now: 0, live }), { alive: false, label: 'Watcher not responding', argv: ['watch', 'stop'] });
  assert.equal(watcherState(off, { startedAt: null, now: 0, live: [{ address: 'x', name: 'other' }] }).label, 'Not watching');
});
