// The Percolator panel: every perc run on this machine, what each needs from you, and the buttons to answer.
// Docked in the layout block `percolator-panel`, or popped out into a window (`props().overlay` is set there).
// Data: `perc status --json`, run as perc.json says (`perc herdr link` writes it); `"fixtures"` reads a file instead.

import { View, div } from 'gpui-kit';
import { v_flex, h_flex, ScrollHandle, Scrollbar, TextareaState } from 'gpui-base';
import {
  checking,
  closeOverlay,
  exec,
  hc,
  nextCommand,
  openOverlay,
  props,
  readTextFile,
  run as command,
  setShared,
  settings,
  shared,
  terminals,
  theme,
} from 'herdr';
import {
  BOARD_RATIO,
  actionArgv,
  boardHeight,
  dragBoard,
  fillHeight,
  nextBoxH,
  titleLayout,
  moveRow,
  moveStop,
  needsCount,
  ownsCommands,
  readRatio,
  readerPath,
  resolvePath,
  runningCount,
  sortRuns,
  visibleRuns,
} from './model.js';
import { mark } from './mark.js';
import { board } from './board.js';
import { header, train, stopStrip } from './train.js';
import { turn } from './turn.js';
import { own } from './ui.js';
import { connectSource, fetchStatus, firstLine, watchRuns } from './source.js';

const NARROW = 720;
const BLOCK = 'percolator-panel';
const WINDOW = 'percolator.window'; // shared: the open window's overlay id, else null
const RATIO = 'percolator.boardRatio'; // shared: the board's height as a ratio of the area under the title bar
const OLD_RATIO = 'board.ratio'; // localStorage, per copy: read when nothing is shared yet
const MIN_ROWS = { narrow: 106, wide: 92 }; // two rows of the board, in design px
const MIN_BOX = 120; // the reader's least height; below it the detail scrolls instead
const zoom = () => Number(settings()?.zoom) || 1;
const folderOf = (file) => file.replace(/[\\/][^\\/]*$/, '');

export default class Percolator extends View {
  init(_props, cx) {
    this.conn = null; // null (loading) | 'missing' | 'perc' | 'fixtures'
    this.perc = null;
    this.fixture = null;
    this.runs = [];
    this.loaded = false;
    this.error = null;
    this.filter = 'active';
    this.sel = null;
    this.stopSel = null;
    this.file = null;
    this.files = {};
    this.tail = {};
    this.width = 900;
    this.busy = null;
    this.actError = null;
    this.said = null;
    this.copied = null;
    this.cmdsOpen = false;
    this.rejecting = false;
    this.rejectError = null;
    this.typing = false;
    this.ratio = null; // the ratio while the divider is held; otherwise the shared one (boardRatio())
    // Heights in design pixels (zoom 1), measured after each layout.
    this.area = 600; // under the title bar
    this.boardPx = 0; // the board
    this.detailH = 400; // the detail's viewport
    this.rest = 0; // what the detail's content takes besides the reader (or history, or agent tail)
    this.boxH = MIN_BOX; // the reader's height, as drawn in the last frame
    this.drag = null; // { y, px } while the divider is held
    this.boardScroll = ScrollHandle.new();
    const f = shared('percolator.focus');
    this.seenFocus = f && Date.now() - f.at < 10000 ? 0 : (f?.at ?? 0);

    this.feedback = TextareaState.new({ placeholder: 'What should change? (Ctrl+Enter sends, Esc cancels)', rows: 3 });
    this.feedback.on('focus', (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.feedback.on('blur', (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
    this.feedback.on('change', (_e, cx) => {
      if (this.rejectError) {
        this.rejectError = null;
        cx.notify();
      }
    });
    this.feedback.on('submit', (e, cx) => {
      if (e.secondary) this.sendReject(cx);
    });
    this.handle = cx.focus_handle();
    this.handle.focus();

    this.connect(cx);
    if (checking()) return;
    if (this.inWindow()) {
      // However the window opened (⧉, the cup, the palette), it is now the place: one copy shown, one acting.
      setShared(WINDOW, props().overlay); // the cup reads it: the window is open
      setShared('percolator.place', 'window');
      command('layout.hide', { id: BLOCK });
    }
    watchRuns(cx, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => cx.notify()); // the "4m ago" clocks
    cx.timer.every(5000, (cx) => this.readTail(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c !== 'focus' && !ownsCommands(shared('percolator.place'), this.inWindow())) continue;
        this.onCommand(c, cx);
        cx.notify();
      }
    });
  }

  // ── data ────────────────────────────────────────────────────────────

  connect(cx) {
    cx.spawn(async (cx) => {
      const src = await connectSource();
      this.conn = src.conn;
      this.perc = src.perc ?? null;
      this.fixture = src.fixture ?? null;
      cx.notify();
      this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.conn !== 'perc' && this.conn !== 'fixtures') return;
    if (this.conn === 'perc' && checking()) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      const got = await fetchStatus(this);
      if (got.ok) {
        this.runs = sortRuns(got.data.runs);
        this.error = null;
        this.loaded = true;
        if (!this.current()) this.select(this.rows()[0]?.id ?? null, cx);
        else this.syncReader(cx); // the run moved on: new review files, or none
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

  /** Review and output paths: absolute from perc; relative to the fixture file's folder in fixtures mode. */
  resolve(path) {
    return this.conn === 'fixtures' ? resolvePath(folderOf(this.fixture), path) : path;
  }

  // ── selection ───────────────────────────────────────────────────────

  rows() {
    return visibleRuns(this.runs, this.filter);
  }

  current() {
    return this.runs.find((r) => r.id === this.sel) ?? null;
  }

  select(id, cx) {
    if (id !== this.sel) {
      this.rejecting = false;
      this.rejectError = null;
      this.actError = null;
      this.said = null;
      this.feedback.set_value('');
    }
    this.sel = id;
    this.stopSel = null;
    this.outPick = null;
    this.syncReader(cx);
    this.readTail(cx);
  }

  /** Selects a stop (null closes the strip and goes back to the run's review file). */
  pickStop(id, cx) {
    this.stopSel = id;
    this.outPick = null;
    this.syncReader(cx);
  }

  /** One of the selected stop's outputs, from the strip. */
  pickOutput(path, cx) {
    this.outPick = path;
    this.syncReader(cx);
  }

  /** Points the reader at what the run needs read now (readerPath, or an output picked in the strip) and reads it again:
   *  the same path can hold new text (a re-groom rewrites groomed_ticket.md). */
  syncReader(cx) {
    const r = this.current();
    const raw = (this.stopSel && this.outPick) || (r ? readerPath(r, this.stopSel) : null);
    const path = raw ? this.resolve(raw) : null;
    this.file = path;
    if (!path) return;
    if (this.files[path] === undefined) this.files[path] = null;
    cx.spawn(async (cx) => {
      const text = await readTextFile(path).catch(() => null);
      this.files[path] = text ?? `_${path} could not be read._`;
      cx.notify();
    });
  }

  /** The running step's agent terminal, its last 8 lines through hc. */
  readTail(cx) {
    const r = this.current();
    const term = r?.status === 'running' ? r.terminals?.[r.currentStep] : null;
    if (!term || checking() || !terminals().some((x) => x.address === term)) return;
    cx.spawn(async (cx) => {
      const out = await hc(['read', term, '--lines', '8']).catch(() => null);
      if (out?.code === 0 && out.stdout.trim()) {
        this.tail[term] = out.stdout.trimEnd();
        cx.notify();
      }
    });
  }

  focusTerminal(terminal) {
    command('pane.focus', { terminal });
  }

  // ── acting ──────────────────────────────────────────────────────────

  act(action, cx) {
    const r = this.current();
    if (!r || this.busy) return;
    this.actError = null;
    this.said = null;
    if (action === 'open-pane') return this.focusTerminal(r.attention?.terminal);
    if (action === 'reject') {
      this.rejecting = true;
      this.feedback.focus();
      return;
    }
    if (action === 'clean') {
      openOverlay({
        mod: 'confirm',
        kind: 'dialog',
        width: 440,
        height: 200,
        props: {
          title: `Clean up #${r.ticket?.number ?? '?'}?`,
          detail: `Removes the run's terminals and worktree and keeps its branch and run record (perc clean ${r.id}).`,
          command: { name: `percolator.clean/${r.id}` },
        },
      });
      return;
    }
    this.perform(action, actionArgv(action, r), cx);
  }

  perform(action, argv, cx) {
    if (!argv) return;
    if (this.conn === 'fixtures') {
      this.said = `fixtures: would run perc ${argv.join(' ')}`;
      if (action === 'reject') this.closeReject();
      return;
    }
    this.busy = action;
    cx.spawn(async (cx) => {
      const res = await exec(this.perc.node, [this.perc.cli, ...argv], { timeout: 120000 }).catch((e) => ({
        code: -1,
        stdout: '',
        stderr: String(e?.message ?? e),
      }));
      this.busy = null;
      if (res.code === 0) {
        if (action === 'reject') this.closeReject();
        this.refresh(cx);
      } else {
        const why = firstLine(res.stderr) || `perc ${argv[0]} exited ${res.code}`;
        if (action === 'reject') this.rejectError = why;
        else this.actError = why;
      }
      cx.notify();
    });
  }

  sendReject(cx) {
    const r = this.current();
    if (!r || this.busy) return;
    let argv;
    try {
      argv = actionArgv('reject', r, this.feedback.value());
    } catch (e) {
      this.rejectError = e.message; // "Say what to change"
      cx.notify();
      return;
    }
    this.rejectError = null;
    this.perform('reject', argv, cx);
    cx.notify();
  }

  closeReject() {
    this.rejecting = false;
    this.rejectError = null;
    this.feedback.set_value('');
    this.handle.focus();
  }

  cancelReject(cx) {
    this.closeReject();
    cx.notify();
  }

  // ── keys, commands, places ──────────────────────────────────────────

  /** A key press (or `percolator.key/<key>`); true when it did something. */
  key(key, cx) {
    const r = this.current();
    const acts = r?.attention?.actions ?? [];
    if (key === 'up' || key === 'down') {
      const id = moveRow(this.rows(), this.sel, key === 'up' ? -1 : 1);
      if (id) {
        this.select(id, cx);
        this.revealRow();
      }
    } else if ((key === 'left' || key === 'right') && r) {
      this.pickStop(moveStop(r, this.stopSel, key === 'left' ? -1 : 1), cx);
    } else if (key === 'a' && acts.includes('approve')) this.act('approve', cx);
    else if (key === 'r' && acts.includes('reject')) this.act('reject', cx);
    else if (key === 'g' && acts.includes('grant')) this.act('grant', cx);
    else if (key === 'g' && acts.includes('resume')) this.act('resume', cx);
    else if (key === 'escape') {
      if (this.rejecting) this.closeReject();
      else if (this.stopSel) this.pickStop(null, cx);
      else this.hide();
    } else return false;
    return true;
  }

  onCommand(c, cx) {
    if (c.startsWith('clean/')) {
      const r = this.runs.find((x) => x.id === c.slice(6));
      if (r) this.perform('clean', actionArgv('clean', r), cx);
    } else if (c.startsWith('key/')) this.key(c.slice(4), cx);
    else if (c === 'focus') this.handle.focus();
    else if (c === 'place' && this.inWindow()) this.dockBack();
    else if (c === 'place') this.popOut();
  }

  async close() {
    if (this.inWindow() && shared(WINDOW) === props().overlay) setShared(WINDOW, null);
  }

  inWindow() {
    return Boolean(props()?.overlay);
  }

  hide() {
    if (this.inWindow()) closeOverlay(props().overlay);
    else command('layout.hide', { id: BLOCK });
  }

  popOut() {
    openOverlay({ kind: 'window', key: 'percolator', keep: true, mod: 'percolator', width: 860, height: 680 });
    command('layout.hide', { id: BLOCK });
    setShared('percolator.place', 'window');
  }

  dockBack() {
    command('layout.show', { id: BLOCK });
    setShared('percolator.place', 'panel');
    closeOverlay(props().overlay);
  }

  /** The cup asks for a run (shared `percolator.focus = { run, at }`): select it. */
  followFocus(cx) {
    const f = shared('percolator.focus');
    if (!f || !(f.at > this.seenFocus) || !this.loaded) return;
    this.seenFocus = f.at;
    if (!this.runs.some((r) => r.id === f.run)) return;
    if (!this.rows().some((r) => r.id === f.run)) this.filter = 'all';
    this.select(f.run, cx);
    this.revealRow();
  }

  /** The reader's (or history's, or the agent tail's) height: what the detail has left over, at least MIN_BOX. Worked out
   *  from the viewport and `rest` only (neither depends on it), and kept unless it moves 2px, so it cannot oscillate. */
  boxHeight() {
    return this.rest ? nextBoxH(this.boxH, fillHeight(this.detailH, this.rest, 0, MIN_BOX)) : this.boxH;
  }

  /** The detail's content was laid out with the box drawn last: what the rest takes is the content minus that box. */
  measureContent(size, cx) {
    const rest = Math.round(size.height / zoom()) - this.boxH;
    if (rest === this.rest) return;
    this.rest = rest;
    cx.notify();
  }

  /** Keeps a measured height in design pixels (Herdr reports them zoomed); a change draws again. */
  measured(key, size, cx) {
    const h = Math.round(size.height / zoom());
    if (h === this[key]) return;
    this[key] = h;
    cx.notify();
  }

  /** Scrolls the board so the selected row is in view. */
  revealRow() {
    const at = this.rows().findIndex((r) => r.id === this.sel);
    if (at >= 0) this.boardScroll.scroll_to_item(at);
  }

  // ── the divider between the board and the detail ──────────────────

  minBoard(narrow) {
    return narrow ? MIN_ROWS.narrow : MIN_ROWS.wide;
  }

  /** The board's ratio: the one being dragged, else the shared one, so the docked panel and the window agree. */
  boardRatio() {
    return this.drag ? this.ratio : readRatio(shared(RATIO) ?? localStorage.getItem(OLD_RATIO));
  }

  endDrag() {
    if (!this.drag) return false;
    const from = this.drag.from;
    this.drag = null;
    if (this.ratio !== from) setShared(RATIO, this.ratio);
    return true;
  }

  divider(t, narrow) {
    const on = Boolean(this.drag);
    return div()
      .id('divider')
      .flex_none()
      .h(7)
      .flex()
      .items_center()
      .cursor_row_resize()
      .hover((s) => s.bg(t.hover))
      .when(on, (el) => el.bg(t.hover))
      .tooltip('Drag to resize · double-click resets')
      .on_mouse_down('left', (e, cx) => {
        cx.stop_propagation(); // a window drags on presses its mod doesn't stop
        if (!this.typing) this.handle.focus(); // ↑/↓ work right after a drag
        if (e.click_count >= 2) {
          this.drag = null;
          if (this.boardRatio() !== BOARD_RATIO) setShared(RATIO, BOARD_RATIO);
        } else {
          const from = this.boardRatio();
          this.ratio = from;
          this.drag = { y: e.position.y, px: this.boardPx, from };
        }
        cx.notify();
      })
      .child(div().w_full().h(1).bg(on ? t.accent : t.border));
  }

  // ── views ───────────────────────────────────────────────────────────

  titlebar(t, narrow) {
    const needs = needsCount(this.runs);
    const running = runningCount(this.runs);
    const chip = (label, c) =>
      div().flex_none().px(7).py(1).rounded(9).text_size(10.5).font_semibold().bg(c).text_color(t.background).child(label);
    const tab = (id, label) =>
      own(
        div()
          .id(`tab-${id}`)
          .px(8)
          .py(2)
          .rounded(5)
          .text_size(11.5)
          .cursor_pointer()
          .text_color(this.filter === id ? t.foreground : t.dim)
          .when(this.filter === id, (el) => el.bg(t.raised))
          .on_click((_e, cx) => {
            this.filter = id;
            if (!this.rows().some((r) => r.id === this.sel)) this.select(this.rows()[0]?.id ?? null, cx);
            cx.notify();
          })
          .child(label),
      );
    const icon = (id, label, tip, onClick) =>
      own(
        div()
          .id(id)
          .flex_none()
          .px(6)
          .py(2)
          .rounded(4)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.text_color(t.foreground).bg(t.hover))
          .tooltip(tip)
          .on_click(onClick)
          .child(label),
      );
    const window = this.inWindow();
    // ⧉ and ✕ never leave: the title truncates, the chip shortens to "N", then the tabs take a row of their own.
    const fit = titleLayout(this.width / zoom(), needs);
    const tabs = h_flex().flex_none().gap(8).items_center().child(tab('active', 'Active')).child(tab('all', 'All'));
    const bar = h_flex()
      .h(38)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .child(mark(18, t.foreground, needs ? t.blocked : running ? t.working : t.accent, needs > 0))
      .child(div().flex_shrink_1().min_w(0).truncate().font_semibold().text_size(13).child('Percolator'))
      .when(needs > 0, (el) =>
        el.child(chip(fit.chip === 'short' ? String(needs) : `${needs} need${needs === 1 ? 's' : ''} you`, t.blocked)),
      )
      .when(running > 0 && !narrow, (el) => el.child(chip(`${running} running`, t.working)))
      .when(fit.tabs === 'inline', (el) => el.child(div().flex_none().w(4)).child(tabs))
      .child(div().flex_1())
      .when(this.conn === 'fixtures' && !narrow, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child('fixtures')))
      .child(
        icon('place', '⧉', window ? 'Dock in the side panel' : 'Pop out into a window', () =>
          window ? this.dockBack() : this.popOut(),
        ),
      )
      .child(icon('close', '✕', 'Hide', () => this.hide()));
    return v_flex()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(bar)
      .when(fit.tabs === 'below', (el) => el.child(h_flex().h(28).px(12).pb(4).items_center().child(tabs)));
  }

  hints(t) {
    return h_flex()
      .flex_none()
      .h(24)
      .px(16)
      .gap(14)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .text_size(10.5)
      .text_color(t.dim)
      .children(['↑↓ runs', '←→ stops', 'a approve', 'r reject', 'g grant / resume', 'esc close'].map((h) => div().child(h)));
  }

  /** The placeholder while nothing can be shown: not linked yet, or loading. */
  placeholder(t) {
    if (this.conn === 'missing') {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(8)
        .child(mark(32, t.dim, t.dim, false))
        .child(div().text_size(13).text_color(t.muted).child('Run perc herdr link once to connect'));
    }
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .child(div().text_size(12).text_color(t.dim).child(this.error ? '' : 'Loading…'));
  }

  // The measured frames (area, board-frame, detail-frame, detail-body) are drawn from the first frame on, whatever the
  // state: Herdr reports sizes only for elements it has had since the view's first frame.
  body(t, narrow) {
    const ready = this.conn !== 'missing' && this.loaded;
    const r = ready ? this.current() : null;
    const rows = ready ? this.rows() : [];
    const boardMax = boardHeight(this.boardRatio(), this.area, this.minBoard(narrow));
    this.boxH = this.boxHeight(); // the box drawn in this frame; measureContent subtracts it after layout
    return v_flex()
      .id('area')
      .flex_1()
      .min_h(0)
      .on_size_change((size, cx) => this.measured('area', size, cx))
      .child(
        v_flex()
          .id('board-frame')
          .flex_none()
          .when(rows.length > 0, (el) => el.max_h(boardMax))
          .on_size_change((size, cx) => this.measured('boardPx', size, cx))
          .when(ready, (el) => el.child(board(this, t, narrow, rows))),
      )
      .when(rows.length > 0, (el) => el.child(this.divider(t, narrow)))
      .child(
        // One scroll for the whole detail, filled absolutely: overflow_y_scrollbar() wraps the element, so its flex
        // sizing never reaches the layout.
        div()
          .id('detail-frame')
          .flex_1()
          .min_h(0)
          .relative()
          .on_size_change((size, cx) => this.measured('detailH', size, cx))
          .child(
            v_flex()
              .id('detail')
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .child(
                v_flex()
                  .id('detail-body')
                  .flex_none()
                  .on_size_change((size, cx) => this.measureContent(size, cx))
                  .when(!ready, (el) => el.min_h_full().child(this.placeholder(t)))
                  .when(Boolean(r), (el) =>
                    el
                      .child(header(this, t, r, narrow))
                      .child(train(this, t, r, narrow))
                      .when(Boolean(this.stopSel), (el) => el.child(stopStrip(this, t, r)))
                      .child(turn(this, t, r, narrow)),
                  ),
              ),
          )
          .child(Scrollbar.vertical('detail').absolute().inset_0()),
      );
  }

  render(cx) {
    const t = theme();
    this.followFocus(cx);
    const narrow = this.width < NARROW;
    return v_flex()
      .id('root')
      .size_full()
      .bg(t.surface)
      .text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (size.width !== this.width) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const dy = (e.position.y - this.drag.y) / zoom(); // the pointer moves in zoomed pixels
        this.ratio = dragBoard(this.drag.px, dy, this.area, this.minBoard(narrow));
        cx.notify();
      })
      .on_mouse_up('left', (_e, cx) => {
        if (this.endDrag()) cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (!hovered && this.endDrag()) cx.notify();
      })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.typing) {
          if (e.key === 'escape') {
            this.closeReject();
            cx.notify();
            cx.stop_propagation();
          }
          return;
        }
        if (e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) return;
        if (this.key(e.key, cx)) {
          cx.notify();
          cx.stop_propagation();
        }
      })
      .child(this.titlebar(t, narrow))
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .flex_none()
            .px(14)
            .py(5)
            .bg(t.raised)
            .border_b(1)
            .border_color(t.border)
            .text_size(11.5)
            .text_color(t.blocked)
            .truncate()
            .child(this.error),
        ),
      )
      .child(
        v_flex()
          .id('content')
          .flex_1()
          .min_h(0)
          .on_mouse_down('left', (_e, cx) => {
            this.endDrag(); // a release the panel never heard
            if (!this.typing) this.handle.focus();
            cx.stop_propagation();
          })
          .child(this.body(t, narrow)),
      )
      .when(!narrow && this.conn !== 'missing', (el) => el.child(this.hints(t)));
  }
}
