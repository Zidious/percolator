// The Percolator cup: a status-bar button that says who needs you, toggles the panel, and posts a notice when a run
// newly needs you. It is always alive (the panel may be hidden), so it owns watching and notifying.
// Carries copies of the panel's model.js, mark.js and source.js (same perc call, same watch). Commands: `percolator-cup.open/<run-id>`, `percolator-cup.toggle`.

import { View, div } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { checking, closeOverlay, layout, nextCommand, notify, openOverlay, run, setShared, shared, theme } from 'herdr';
import { cupLabel, cupMoves, findNode, needsCount, newlyNeeding, notice, runningCount } from './model.js';
import { mark } from './mark.js';
import { connectSource, fetchStatus, watchRuns } from './source.js';

const BLOCK = 'percolator-panel';
const WINDOW = 'percolator.window'; // the panel's window sets it to its overlay id while open

const panelShown = () => {
  const node = findNode(layout(), BLOCK);
  return Boolean(node && !node.hidden);
};
const windowOpen = () => Boolean(shared(WINDOW));

export default class PercolatorCup extends View {
  init(_props, cx) {
    this.src = { conn: null };
    this.runs = [];
    this.prev = null; // the last good runs; null until the first load (no notices for what already needed you)
    this.error = null;
    this.loading = false;
    this.again = false;
    cx.spawn(async (cx) => {
      this.src = await connectSource();
      cx.notify();
      this.refresh(cx);
    });
    if (checking()) return;
    watchRuns(cx, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c.startsWith('open/')) this.open(c.slice(5));
        else if (c === 'toggle') this.move('click'); // what a click does, for keys.json
        cx.notify();
      }
    });
  }

  refresh(cx) {
    const { conn } = this.src;
    if (conn !== 'perc' && conn !== 'fixtures') return;
    if (conn === 'perc' && checking()) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      const got = await fetchStatus(this.src);
      if (got.ok) {
        const runs = got.data.runs;
        for (const r of newlyNeeding(this.prev, runs)) notify(notice(r));
        this.prev = runs;
        this.runs = runs;
        this.error = null;
      } else {
        this.error = got.error; // keep the last good runs
      }
      this.loading = false;
      cx.notify();
      if (this.again) {
        this.again = false;
        this.refresh(cx);
      }
    });
  }

  /** A notice was clicked: select the run in the panel and show the panel where it was last. */
  open(id) {
    setShared('percolator.focus', { run: id, at: Date.now() });
    this.move('open');
  }

  move(why) {
    const open = { panel: panelShown(), window: windowOpen() };
    for (const m of cupMoves(shared('percolator.place'), open, why)) {
      if (m === 'show-panel') run('layout.show', { id: BLOCK });
      else if (m === 'hide-panel') run('layout.hide', { id: BLOCK });
      else if (m === 'open-window') {
        openOverlay({ kind: 'window', key: 'percolator', keep: true, mod: 'percolator', width: 860, height: 680 });
      } else if (m === 'close-window') {
        closeOverlay(shared(WINDOW));
        setShared(WINDOW, null);
      }
    }
  }

  render() {
    const t = theme();
    const needs = needsCount(this.runs);
    const running = runningCount(this.runs);
    const label = cupLabel(this.runs);
    const open = panelShown() || windowOpen();
    const tip =
      this.src.conn === 'missing'
        ? 'Run perc herdr link once to connect'
        : (this.error ?? (open ? 'Hide Percolator' : 'Show Percolator'));
    return h_flex()
      .id('cup')
      .size_full()
      .px(8)
      .items_center()
      .justify_end()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .child(
        h_flex()
          .id('cup-button')
          .gap(6)
          .items_center()
          .px(8)
          .py(2)
          .rounded(5)
          .cursor_pointer()
          .when(open, (el) => el.bg(t.raised))
          .hover((s) => s.bg(t.hover))
          .tooltip(tip)
          .on_click(() => this.move('click'))
          .child(mark(14, t.foreground, needs ? t.blocked : running ? t.working : t.muted, needs > 0))
          .child(
            div()
              .truncate()
              .text_color(label.tone === 'blocked' ? t.blocked : this.error ? t.dim : t.muted)
              .child(label.text),
          ),
      );
  }
}
