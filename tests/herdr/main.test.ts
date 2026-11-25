import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// main.js imports Herdr's host modules, which only exist inside the app: stand them in with exports that call the
// test's fake in `fakes` (by name, `InputState.new` for a static) when it set one, and do nothing otherwise.
const fakes: Record<string, (...a: any[]) => any> = {};
(globalThis as any).hostFakes = fakes;
const HOST: Record<string, string[]> = {
  'gpui-kit': ['div', 'View', 'svg'],
  'gpui-base': ['v_flex', 'h_flex', 'InputState', 'ScrollHandle', 'Scrollbar', 'TextareaState', 'Input', 'Textarea', 'TextView'],
  herdr: [
    'checking', 'closeOverlay', 'exec', 'layout', 'nextCommand', 'openOverlay', 'pickFolder', 'props', 'readTextFile', 'run',
    'setShared', 'settings', 'shared', 'spaces', 'terminals', 'theme', 'appHome', 'home', 'watchFolder', 'agents',
  ],
};
registerHooks({
  resolve: (specifier, context, next) => (specifier in HOST ? { url: `host:${specifier}`, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => {
    if (!url.startsWith('host:')) return next(url, context);
    const names = HOST[url.slice('host:'.length)] ?? [];
    const call = (n: string) => `(...a) => globalThis.hostFakes['${n}']?.(...a)`;
    const source = names
      .map((n) => (n === 'View' ? 'export class View {}' : `export const ${n} = Object.assign(${call(n)}, { new: ${call(`${n}.new`)} });`))
      .join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});
const MAIN: string = '../../herdr/mods/percolator/main.js'; // untyped: the panel's view has no .d.ts
const { default: Percolator } = await import(MAIN);

/** A panel with one run on `repo` whose pipelines are already listed, and a cx that counts redraws. */
function panelWithListedPipelines() {
  const repo = 'C:/src/app';
  const p = Object.create(Percolator.prototype);
  Object.assign(p, {
    runs: [{ id: 'r1', repo, createdAt: '2026-11-23T00:00:00Z' }],
    start: null,
    typing: false,
    pipes: { [repo]: { ok: true, data: { pipelines: [{ name: 'feature', inputs: [] }] } } },
    inputs: {},
    ticketInput: { set_value() {} },
    handle: { focus() {} },
  });
  const cx = { redraws: 0, notify() { this.redraws++; }, spawn() { throw new Error('the pipelines are listed: nothing to fetch'); } };
  return { p, cx };
}

test('+ New run opened again after closing it redraws the picker when the pipelines are already listed', () => {
  const { p, cx } = panelWithListedPipelines();
  p.openStart(cx);
  p.openStart(cx); // the same button closes it
  assert.equal(p.start, null);
  const before = cx.redraws;
  p.openStart(cx);
  assert.equal(p.start?.mode, 'new');
  assert.ok(cx.redraws > before, 'reopening the picker must redraw the panel');
});

type Space = { folder: string; machine?: string | null; active?: boolean };
const toSpace = (s: Space) => ({ id: s.folder, index: 1, name: '', named: false, folder: s.folder, machine: s.machine ?? null, branch: null, active: s.active ?? false, status: null, tabs: [] });
const listed = { ok: true, data: { pipelines: [{ name: 'feature', inputs: [] }] } };

/**
 * A panel with runs on C:/src/old, the given spaces, and git toplevels from `tops`; a folder in `held`
 * answers only when the test calls `release()`. cx.spawn keeps the jobs so the test can await them.
 */
function panelWithSpaces(spaces: Space[], tops: Record<string, string | null>, held: string[] = []) {
  const p = Object.create(Percolator.prototype);
  const asked: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  Object.assign(p, {
    runs: [{ id: 'r1', repo: 'C:/src/old', createdAt: '2026-11-23T00:00:00Z', ticket: { ref: 'owner/old#1' } }],
    start: null,
    typing: false,
    tops: {},
    pipes: { 'C:/src/old': listed, 'C:/src/app': listed, 'C:/src/mine': listed, '/src/a': listed, '/notes': listed },
    inputs: {},
    ticketInput: { text: '', set_value(v: string) { this.text = v; }, value() { return this.text; } },
    handle: { focus() {} },
    openSpaces: () => spaces.map(toSpace),
    gitTop: async (folder: string) => {
      asked.push(folder);
      if (held.includes(folder)) await gate;
      return tops[folder] ?? null;
    },
  });
  const jobs: Promise<unknown>[] = [];
  const cx = {
    notify() {},
    spawn(fn: (cx: unknown) => Promise<unknown>) {
      jobs.push(fn(this));
    },
  };
  const settle = async () => {
    while (jobs.length) await jobs.shift();
  };
  return { p, cx, asked, settle, release };
}

const APP_SPACES: Space[] = [{ folder: '/src/a' }, { folder: 'C:/src/app/.worktrees/t1-x', active: true }];
const APP_TOPS = { '/src/a': '/src/a', 'C:/src/app/.worktrees/t1-x': 'C:/src/app/.worktrees/t1-x' };

test("+ New run preselects the shown space's repo once its folder resolved", async () => {
  const { p, cx, settle } = panelWithSpaces(APP_SPACES, APP_TOPS);
  p.probeSpaces(cx);
  await settle();
  p.openStart(cx);
  assert.equal(p.start.repo, 'C:/src/app');
  assert.equal(p.start.auto, true);
  assert.deepEqual(Object.keys(p.tops).sort(), ['/src/a', 'C:/src/app/.worktrees/t1-x']);
});

test('a probe that resolves after the picker opened moves the automatic preselection', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.probeSpaces(cx);
  p.openStart(cx);
  assert.equal(p.start.repo, 'C:/src/old');
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/app');
  assert.equal(p.start.auto, true);
  assert.equal(p.start.pick, 'feature');
});

test("a probe that resolves after the owner picked a repo keeps the owner's pick", async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.probeSpaces(cx);
  p.openStart(cx);
  p.pickRepo('C:/src/mine', cx);
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/mine');
  assert.equal(p.start.auto, false);
});

test('each space folder is probed once, and remote or empty folders never', async () => {
  const { p, cx, asked, settle } = panelWithSpaces([{ folder: '/a' }, { folder: '/a' }, { folder: '' }, { folder: '/r', machine: 'box' }], { '/a': '/a' });
  p.probeSpaces(cx);
  p.probeSpaces(cx);
  await settle();
  p.probeSpaces(cx);
  await settle();
  assert.deepEqual(asked, ['/a']);
  assert.deepEqual(p.tops, { '/a': '/a' });
});

test('a probe that resolves after the owner picked a pipeline keeps the repo', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.probeSpaces(cx);
  p.openStart(cx);
  p.pickPipeline('feature', cx);
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.auto, false);
});

test('a probe that resolves after the owner typed a ticket of the preselected repo keeps the repo', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.probeSpaces(cx);
  p.openStart(cx);
  p.ticketInput.set_value('owner/old#7');
  p.ticketChanged(cx);
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.auto, false);
});

test("the picker's emptied ticket field (opening it) leaves the preselection automatic", () => {
  const { p, cx } = panelWithSpaces([], {});
  p.openStart(cx);
  p.ticketChanged(cx);
  assert.equal(p.start.auto, true);
});

test('typing in a pipeline input ends the automatic preselection', async () => {
  const handlers: Record<string, (e: unknown, cx: unknown) => void> = {};
  fakes['InputState.new'] = () => ({ on: (ev: string, h: (e: unknown, cx: unknown) => void) => ((handlers[ev] = h), true) });
  try {
    const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
    p.probeSpaces(cx);
    p.openStart(cx);
    p.textState({ placeholder: '' });
    handlers.change({}, cx);
    release();
    await settle();
    assert.equal(p.start.repo, 'C:/src/old');
    assert.equal(p.start.auto, false);
  } finally {
    delete fakes['InputState.new'];
  }
});

test('gitTop asks git for the toplevel with an argv, in the folder, with a 10s timeout', async () => {
  const calls: unknown[][] = [];
  const answers: Array<() => Promise<unknown>> = [
    async () => ({ code: 0, stdout: 'C:/src/app\n', stderr: '' }),
    async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    async () => {
      throw new Error('no such folder');
    },
  ];
  fakes.exec = (...a: unknown[]) => (calls.push(a), answers.shift()!());
  try {
    const p = Object.create(Percolator.prototype);
    assert.equal(await p.gitTop('C:/src/app/sub'), 'C:/src/app');
    assert.equal(await p.gitTop('/notes'), null);
    assert.equal(await p.gitTop('/gone'), null);
    assert.deepEqual(calls, [
      ['git', ['rev-parse', '--show-toplevel'], { cwd: 'C:/src/app/sub', timeout: 10000 }],
      ['git', ['rev-parse', '--show-toplevel'], { cwd: '/notes', timeout: 10000 }],
      ['git', ['rev-parse', '--show-toplevel'], { cwd: '/gone', timeout: 10000 }],
    ]);
  } finally {
    delete fakes.exec;
  }
});

test('+ New run asks git again about folders that were not in a repo, and only those', async () => {
  const tops: Record<string, string | null> = { '/notes': null, '/src/a': '/src/a' };
  const { p, cx, asked, settle } = panelWithSpaces([{ folder: '/notes', active: true }, { folder: '/src/a' }], tops);
  p.probeSpaces(cx);
  await settle();
  tops['/notes'] = '/notes'; // git init, or a timeout that has passed
  p.openStart(cx);
  await settle();
  assert.deepEqual(asked, ['/notes', '/src/a', '/notes']);
  assert.equal(p.start.repo, '/notes');
});

test("with no spaces the picker opens on the latest run's repo, as before", () => {
  const { p, cx } = panelWithSpaces([], {});
  p.openStart(cx);
  assert.equal(p.start.repo, 'C:/src/old');
});

test('picking the same repo spelled differently does not reload its pipelines', () => {
  const { p, cx } = panelWithSpaces([], {});
  p.openStart(cx);
  p.start.said = 'started r1';
  p.pickRepo('c:\\src\\old', cx);
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.said, 'started r1', 'the same repo is no new pick: nothing is reset or reloaded');
});

const asking = (kind: 'questions' | 'findings') => ({
  id: 'r1',
  repo: 'C:/src/app',
  createdAt: '2026-11-23T00:00:00Z',
  attention: { kind, asked: { step: kind === 'questions' ? 'plan' : 'review', attempt: 1, items: ['## A', '## B'] }, actions: ['answer'] },
});

/** A panel selecting `run`, with perform recorded instead of spawning perc. */
function panelAsking(run: ReturnType<typeof asking>) {
  const p = Object.create(Percolator.prototype);
  const performed: { action: string; argv: string[] }[] = [];
  Object.assign(p, {
    runs: [run],
    sel: run.id,
    conn: 'perc',
    busy: null,
    actError: null,
    said: null,
    asks: {},
    // keeps the handlers the panel gives its text states, so a test can press Enter or type in one
    textState: (_options: unknown, on: { submit?: (cx: unknown) => void; change?: (cx: unknown) => void } = {}) => {
      let v = '';
      return { value: () => v, set_value: (x: string) => (v = x), on };
    },
    startRun: () => performed.push({ action: 'startRun', argv: [] }),
    perform: (action: string, argv: string[]) => performed.push({ action, argv }),
  });
  const cx = { notify() {} };
  return { p, cx, performed };
}

test('the panel keeps one form per ask, all unticked, and drops forms whose ask is gone', () => {
  const { p } = panelAsking(asking('findings'));
  p.asks = { 'old/review/1': { inputs: [], na: [], ticks: [] } };
  p.syncAsks();
  assert.deepEqual(Object.keys(p.asks), ['r1/review/1']);
  assert.deepEqual(p.asks['r1/review/1'].ticks, [false, false]);
  const kept = p.asks['r1/review/1'];
  p.syncAsks();
  assert.equal(p.asks['r1/review/1'], kept, 'a form survives a refresh of the same ask');
});

test('submitting the questions form needs every question answered or N/A', () => {
  const { p, cx, performed } = panelAsking(asking('questions'));
  p.syncAsks();
  const form = p.asks['r1/plan/1'];
  form.inputs[0].set_value('Postgres');
  p.submitAnswer(cx);
  assert.equal(p.actError, 'Answer question 2 or mark it N/A');
  assert.deepEqual(performed, []);
  form.na[1] = true;
  p.submitAnswer(cx);
  assert.equal(p.actError, null);
  assert.deepEqual(performed, [{ action: 'answer', argv: ['answer', 'r1', '--answer', '1=Postgres', '--na', '2'] }]);
});

test('Enter in an answer field submits the answers, never starts a run; typing clears the answer error', () => {
  const { p, cx, performed } = panelAsking(asking('questions'));
  p.start = { mode: 'new', error: null, said: null };
  p.syncAsks();
  const [first, second] = p.asks['r1/plan/1'].inputs;
  first.set_value('Postgres');
  second.set_value('No');
  p.actError = 'Answer question 2 or mark it N/A';
  first.on.change(cx);
  assert.equal(p.actError, null);
  second.on.submit(cx);
  assert.deepEqual(performed, [{ action: 'answer', argv: ['answer', 'r1', '--answer', '1=Postgres', '--answer', '2=No'] }]);
});

test('submitting the findings form sends the ticked ones', () => {
  const { p, cx, performed } = panelAsking(asking('findings'));
  p.syncAsks();
  p.asks['r1/review/1'].ticks[1] = true;
  p.submitAnswer(cx);
  assert.deepEqual(performed, [{ action: 'answer', argv: ['answer', 'r1', '--agree', '2'] }]);
});
