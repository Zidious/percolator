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
