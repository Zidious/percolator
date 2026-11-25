import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// main.js imports Herdr's host modules, which only exist inside the app: stand them in with inert exports.
const HOST: Record<string, string[]> = {
  'gpui-kit': ['div', 'View', 'svg'],
  'gpui-base': ['v_flex', 'h_flex', 'InputState', 'ScrollHandle', 'Scrollbar', 'TextareaState', 'Input', 'Textarea', 'TextView'],
  herdr: [
    'checking', 'closeOverlay', 'exec', 'layout', 'nextCommand', 'openOverlay', 'pickFolder', 'props', 'readTextFile', 'run',
    'setShared', 'settings', 'shared', 'terminals', 'theme', 'appHome', 'home', 'watchFolder', 'agents',
  ],
};
registerHooks({
  resolve: (specifier, context, next) => (specifier in HOST ? { url: `host:${specifier}`, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => {
    if (!url.startsWith('host:')) return next(url, context);
    const names = HOST[url.slice('host:'.length)] ?? [];
    const source = names.map((n) => (n === 'View' ? 'export class View {}' : `export const ${n} = () => {};`)).join('\n');
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
