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

/** Stubs InputState.new with an input that keeps its text and every handler, so a test can fire its real `change`. */
function fakeInputs() {
  const made: Array<{ text: string; handlers: Record<string, Array<(e: unknown, cx: unknown) => void>>; fire(ev: string, cx: unknown): void }> = [];
  fakes['InputState.new'] = () => {
    const s = {
      text: '',
      handlers: {} as Record<string, Array<(e: unknown, cx: unknown) => void>>,
      on(ev: string, h: (e: unknown, cx: unknown) => void) {
        (s.handlers[ev] ??= []).push(h);
        return true;
      },
      set_value(v: string) {
        s.text = v;
      },
      value() {
        return s.text;
      },
      fire(ev: string, cx: unknown) {
        for (const h of s.handlers[ev] ?? []) h({}, cx);
      },
    };
    made.push(s);
    return s;
  };
  return made;
}

test("the ticket field's change on opening (emptied) leaves the preselection automatic, so a late probe still moves it", async () => {
  fakeInputs();
  try {
    const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
    p.ticketInput = p.ticketState();
    p.probeSpaces(cx);
    p.openStart(cx);
    p.ticketInput.fire('change', cx); // set_value('') may emit change after the picker opened
    release();
    await settle();
    assert.equal(p.start.repo, 'C:/src/app');
    assert.equal(p.start.auto, true);
  } finally {
    delete fakes['InputState.new'];
  }
});

test("typing in the ticket field ends the automatic preselection and clears the picker's error", () => {
  fakeInputs();
  try {
    const { p, cx } = panelWithSpaces([], {});
    p.ticketInput = p.ticketState();
    p.openStart(cx);
    p.start.error = 'boom';
    p.ticketInput.set_value('owner/old#7');
    p.ticketInput.fire('change', cx);
    assert.equal(p.start.auto, false);
    assert.equal(p.start.error, null);
  } finally {
    delete fakes['InputState.new'];
  }
});

test('+ New run opened on a named pipeline keeps its repo and pick when a probe answers late', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.pipes['C:/src/old'] = { ok: true, data: { pipelines: [{ name: 'feature', inputs: [] }, { name: 'dd-alert', inputs: [] }] } };
  p.probeSpaces(cx);
  p.openStart(cx, 'dd-alert');
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.pick, 'dd-alert');
  assert.equal(p.start.auto, false);
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

test('a refused Start also ends the automatic preselection', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.pipes['C:/src/old'] = { ok: true, data: { pipelines: [{ name: 'feature', ticket: 'required', inputs: [] }] } };
  p.probeSpaces(cx);
  p.openStart(cx);
  p.startRun(cx);
  assert.ok(p.start.error, 'Start is refused without a ticket');
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.auto, false);
});

test('pressing Start ends the automatic preselection, so a late probe leaves its repo alone', async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.probeSpaces(cx);
  p.conn = 'fixtures'; // says what it would run instead of spawning perc
  p.openStart(cx);
  p.startRun(cx);
  const said = p.start.said;
  assert.match(said, /--repo C:\/src\/old/);
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/old');
  assert.equal(p.start.auto, false);
  assert.equal(p.start.said, said, "the would-run message stays under the repo it names");
});

test("fixtures mode lists no open spaces, so it never probes the machine's real folders", () => {
  fakes.spaces = () => [toSpace({ folder: 'C:/src/real', active: true })];
  try {
    const p = Object.create(Percolator.prototype);
    p.conn = 'fixtures';
    p.tops = {};
    const spawned: unknown[] = [];
    p.probeSpaces({ spawn: (fn: unknown) => spawned.push(fn), notify() {} });
    assert.deepEqual(p.openSpaces(), []);
    assert.deepEqual(spawned, []);
    p.conn = 'perc';
    assert.equal(p.openSpaces().length, 1);
  } finally {
    delete fakes.spaces;
  }
});

test("a late probe that moves the automatic repo preselects the new repo's default pipeline", async () => {
  const { p, cx, settle, release } = panelWithSpaces(APP_SPACES, APP_TOPS, ['/src/a', 'C:/src/app/.worktrees/t1-x']);
  p.pipes['C:/src/old'] = { ok: true, data: { pipelines: [{ name: 'feature', default: true, inputs: [] }] } };
  p.pipes['C:/src/app'] = { ok: true, data: { pipelines: [{ name: 'feature', inputs: [] }, { name: 'triage', default: true, inputs: [] }] } };
  p.probeSpaces(cx);
  p.openStart(cx);
  assert.equal(p.start.pick, 'feature');
  release();
  await settle();
  assert.equal(p.start.repo, 'C:/src/app');
  assert.equal(p.start.pick, 'triage');
  assert.equal(p.start.auto, true);
});

test('before the panel knows it is connected to perc it lists and probes no open spaces', () => {
  fakes.spaces = () => [toSpace({ folder: 'C:/src/real', active: true })];
  try {
    const p = Object.create(Percolator.prototype);
    p.tops = {};
    p.gitTop = async () => null;
    const spawned: unknown[] = [];
    const cx = { spawn: (fn: unknown) => spawned.push(fn), notify() {} };
    for (const conn of [null, 'missing']) {
      p.conn = conn;
      p.probeSpaces(cx);
      assert.deepEqual(p.openSpaces(), [], `conn ${conn}`);
    }
    assert.deepEqual(spawned, []);
    p.conn = 'perc';
    p.probeSpaces(cx);
    assert.equal(spawned.length, 1);
  } finally {
    delete fakes.spaces;
  }
});

test('picking a box tab reads that file; selecting another run goes back to the first', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const all = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'status.json'), 'utf8')).runs;
  const t26 = all.find((r: any) => r.id.startsWith('t26-'));
  const t24 = all.find((r: any) => r.id.startsWith('t24-'));
  const p = Object.create(Percolator.prototype);
  Object.assign(p, { runs: [t26, t24], files: {}, sel: null, conn: 'perc', feedback: { set_value() {} } });
  const cx = { notify() {}, spawn() {} };
  p.select(t26.id, cx);
  assert.equal(p.boxFile, 'samples/findings-sections.md');
  p.pickBoxFile('samples/findings-list.md', cx);
  assert.equal(p.boxFile, 'samples/findings-list.md');
  p.select(t26.id, cx);
  assert.equal(p.boxFile, 'samples/findings-list.md', 'selecting the same run again keeps the pick');
  p.select(t24.id, cx);
  p.select(t26.id, cx);
  assert.equal(p.boxPick, null);
  assert.equal(p.boxFile, 'samples/findings-sections.md');
});

test('Run again starts the run and selects it once a refresh lists it', async () => {
  const p = Object.create(Percolator.prototype);
  let refreshed = 0;
  Object.assign(p, { conn: 'perc', busy: null, actError: null, startedId: null, perc: { node: 'node', cli: 'cli.ts' }, refresh: () => refreshed++ });
  fakes.exec = async () => ({ code: 0, stdout: 'run t9-20261125-120000-ab12 started\n', stderr: '' });
  try {
    let spawned: Promise<void> | undefined;
    const cx = { spawn: (fn: (cx: unknown) => Promise<void>) => (spawned = fn(cx)), notify() {} };
    p.perform('run-again', ['run', 'github.com/o/r#9', '--repo', '/r'], cx);
    await spawned;
    assert.equal(p.startedId, 't9-20261125-120000-ab12');
    assert.equal(refreshed, 1);
  } finally {
    delete fakes.exec;
  }
});

test('the Run again button reads Run again', async () => {
  const { LABELS } = await import('../../herdr/mods/percolator/turn.js' as string);
  assert.deepEqual(LABELS['run-again'], ['Run again', 'ok']);
});

const EPIC = 't23-epic-20261121-090000-7c2a';
const HOTFIX = 't21-hotfix-20261121-070000-4b5c';

/** A panel over the fixture's runs with `sel` selected; fake `run` records the Herdr commands it sends. */
async function panelOnFixture(sel: string) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const all = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'status.json'), 'utf8')).runs;
  const p = Object.create(Percolator.prototype);
  Object.assign(p, {
    runs: all, filter: 'all', files: {}, sel, stopSel: null, unfolded: [], start: null, rejecting: false, conn: 'perc', width: 900,
    feedback: { set_value() {} }, boardScroll: { scroll_to_item() {} },
  });
  const sent: unknown[][] = [];
  fakes.run = (...a: unknown[]) => sent.push(a);
  return { p, cx: { notify() {}, spawn() {} }, sent };
}

for (const key of ['escape', 'backspace']) {
  test(`${key} on a selected slice selects its parent`, async () => {
    const { p, cx, sent } = await panelOnFixture(`${EPIC}-s2`);
    try {
      assert.equal(p.key(key, cx), true);
      assert.equal(p.sel, EPIC);
      assert.deepEqual(sent, []);
    } finally {
      delete fakes.run;
    }
  });
}

test('on a run that is not a slice, backspace does nothing and escape still hides the panel', async () => {
  const { p, cx, sent } = await panelOnFixture(HOTFIX);
  try {
    assert.equal(p.key('backspace', cx), false);
    assert.equal(p.sel, HOTFIX);
    assert.equal(p.key('escape', cx), true);
    assert.equal(p.sel, HOTFIX);
    assert.deepEqual(sent, [['layout.hide', { id: 'percolator-panel' }]]);
  } finally {
    delete fakes.run;
  }
});

test('escape on a slice with the stop strip open closes the strip and keeps the slice', async () => {
  const { p, cx } = await panelOnFixture(`${EPIC}-s2`);
  try {
    p.stopSel = 'plan';
    assert.equal(p.key('escape', cx), true);
    assert.equal(p.stopSel, null);
    assert.equal(p.sel, `${EPIC}-s2`);
  } finally {
    delete fakes.run;
  }
});

const HELD_LINE = 'run r1: worktree w is still in use; close what holds it and run perc delete r1 again';

/** A panel on perc with runs r1…r3, `sel` selected; `exec` answers perc; await `done()` for the spawned job. */
function panelDeleting(sel: string | null, exec: (...a: unknown[]) => Promise<unknown>) {
  const p = Object.create(Percolator.prototype);
  Object.assign(p, {
    conn: 'perc', perc: { node: 'node', cli: 'cli.ts' }, busy: null, actError: null, said: null, deleting: null, deleteFailed: null,
    runs: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], filter: 'all', files: {}, sel, fetches: 0, unfolded: [],
    feedback: { set_value() {} }, refresh() {},
  });
  fakes.exec = exec;
  const jobs: Promise<unknown>[] = [];
  const cx = { notify() {}, spawn: (fn: (cx: unknown) => Promise<unknown>) => jobs.push(fn(cx)) };
  const done = async () => {
    while (jobs.length) await jobs.shift();
  };
  return { p, cx, done };
}
const failing = async () => ({ code: 1, stdout: '', stderr: `${HELD_LINE}\nmore\n` });
const ok = async () => ({ code: 0, stdout: '', stderr: '' });
const pending = () => new Promise(() => {});

test('a failed delete shows Delete failed on the run and not as actError', async () => {
  const { p, cx, done } = panelDeleting('r1', failing);
  try {
    p.deleteRuns(['r1'], cx);
    await done();
    assert.deepEqual(p.deleteFailed, { ids: ['r1'], error: HELD_LINE });
    assert.equal(p.actError, null);
  } finally {
    delete fakes.exec;
  }
});

test('a timed-out delete is a failure', async () => {
  const { p, cx, done } = panelDeleting('r1', async () => {
    throw new Error('timed out after 120000 ms');
  });
  try {
    p.deleteRuns(['r1'], cx);
    await done();
    assert.deepEqual(p.deleteFailed, { ids: ['r1'], error: 'timed out after 120000 ms' });
  } finally {
    delete fakes.exec;
  }
});

test('selecting another run clears Delete failed', async () => {
  const { p, cx, done } = panelDeleting('r1', failing);
  try {
    p.deleteRuns(['r1'], cx);
    await done();
    p.select('r2', cx);
    assert.equal(p.deleteFailed, null);
  } finally {
    delete fakes.exec;
  }
});

test('retrying the delete clears Delete failed when it starts', async () => {
  const { p, cx, done } = panelDeleting('r1', failing);
  try {
    p.deleteRuns(['r1'], cx);
    await done();
    fakes.exec = pending;
    p.deleteRuns(['r1'], cx);
    assert.equal(p.deleteFailed, null);
  } finally {
    delete fakes.exec;
  }
});

test('a later successful delete clears Delete failed', async () => {
  const { p, cx, done } = panelDeleting('r1', failing);
  try {
    p.deleteRuns(['r1'], cx);
    await done();
    p.busy = null;
    // the run stays selected: clearing must come from the delete's success, not a new selection
    p.deleting = null;
    fakes.exec = ok;
    p.deleteFailed = { ids: ['r1'], error: HELD_LINE };
    p.perform('delete', ['delete', 'r2'], cx);
    await done();
    assert.equal(p.deleteFailed, null);
    assert.equal(p.sel, 'r1');
  } finally {
    delete fakes.exec;
  }
});

test('a failed delete of runs not selected sets actError as before', async () => {
  const { p, cx, done } = panelDeleting('r1', async () => ({ code: 1, stdout: '', stderr: 'run r2: boom\n' }));
  try {
    p.deleteRuns(['r2', 'r3'], cx);
    await done();
    assert.equal(p.actError, 'run r2: boom');
  } finally {
    delete fakes.exec;
  }
});

test("an action's error is cleared when the next action starts", () => {
  const { p, cx } = panelDeleting('r1', pending);
  try {
    p.actError = 'invalid run id x';
    p.perform('approve', ['approve', 'r1'], cx);
    assert.equal(p.actError, null);
    p.conn = 'fixtures';
    p.busy = null;
    p.actError = 'invalid run id x';
    p.perform('approve', ['approve', 'r1'], cx);
    assert.equal(p.actError, null);
  } finally {
    delete fakes.exec;
  }
});

const herdrSpace = (id: string, active = false) => ({ id, index: 1, name: '', named: false, folder: '/x', machine: null, branch: null, active, status: null, tabs: [] });

/** A panel on perc whose run r1 lives in space w1:s8; `open` is what spaces() lists, fake `run` records commands. */
function panelWithRunSpace(open: { list: ReturnType<typeof herdrSpace>[] }) {
  const { p, cx, done } = panelDeleting('r1', ok);
  p.runs = [{ id: 'r1', status: 'running', driver: { space: 'w1:s8' } }, { id: 'r2', status: 'running', driver: { space: 'w1:s9' } }];
  const sent: unknown[][] = [];
  fakes.run = (...a: unknown[]) => sent.push(a);
  fakes.spaces = () => open.list;
  return { p, cx, done, sent };
}
const cleanFakes = () => {
  delete fakes.exec;
  delete fakes.run;
  delete fakes.spaces;
};

test("the panel remembers the last shown space that is no run's", () => {
  const open = { list: [herdrSpace('w1:s1', true), herdrSpace('w1:s8')] };
  const { p } = panelWithRunSpace(open);
  try {
    p.backSpace = null;
    p.trackSpace();
    assert.equal(p.backSpace, 'w1:s1');
    open.list = [herdrSpace('w1:s1'), herdrSpace('w1:s8', true)];
    p.trackSpace();
    assert.equal(p.backSpace, 'w1:s1');
  } finally {
    cleanFakes();
  }
});

test("deleting the shown run's space goes back to the space shown before it", async () => {
  const open = { list: [herdrSpace('w1:s1'), herdrSpace('w1:s8', true), herdrSpace('w1:s9')] };
  const { p, cx, done, sent } = panelWithRunSpace(open);
  try {
    p.backSpace = 'w1:s1';
    fakes.exec = async () => {
      // perc ended the space's shell: Herdr closed it and shows another run's space
      open.list = [herdrSpace('w1:s1'), herdrSpace('w1:s9', true)];
      return { code: 0, stdout: '', stderr: '' };
    };
    p.deleteRuns(['r1'], cx);
    await done();
    assert.deepEqual(sent, [['space.select', { id: 'w1:s1' }]]);
  } finally {
    cleanFakes();
  }
});

test("a delete while another space is shown does not switch spaces", async () => {
  const open = { list: [herdrSpace('w1:s1', true), herdrSpace('w1:s8')] };
  const { p, cx, done, sent } = panelWithRunSpace(open);
  try {
    p.backSpace = 'w1:s1';
    fakes.exec = async () => {
      open.list = [herdrSpace('w1:s1', true)];
      return { code: 0, stdout: '', stderr: '' };
    };
    p.deleteRuns(['r1'], cx);
    await done();
    assert.deepEqual(sent, []);
  } finally {
    cleanFakes();
  }
});

test('in fixtures mode a delete sends no space.select', async () => {
  const open = { list: [herdrSpace('w1:s1'), herdrSpace('w1:s8', true)] };
  const { p, cx, done, sent } = panelWithRunSpace(open);
  try {
    p.conn = 'fixtures';
    p.backSpace = 'w1:s1';
    p.deleteRuns(['r1'], cx);
    await done();
    assert.deepEqual(sent, []);
  } finally {
    cleanFakes();
  }
});
