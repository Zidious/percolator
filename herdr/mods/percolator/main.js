// The Percolator panel: every perc run on this machine, what each needs from you, and the buttons to answer.
// Docked in the layout block `percolator-panel`, or popped out into a window (`props().overlay` is set there).
// Data: `perc status --json`, run as perc.json says (`perc herdr link` writes it); `"fixtures"` reads a file instead.

import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, ScrollHandle, Scrollbar, TextareaState } from 'gpui-base';
import {
  checking,
  closeOverlay,
  exec,
  layout,
  nextCommand,
  openOverlay,
  pickFolder,
  props,
  readTextFile,
  run as command,
  setShared,
  settings,
  shared,
  spaces,
  terminals,
  theme,
} from 'herdr';
import {
  BOARD_RATIO,
  actionArgv,
  answerArgv,
  askOf,
  canStart,
  guessRepo,
  sameRepo,
  startRepo,
  startRepos,
  runNextChoices,
  startArgv,
  startPick,
  startedRun,
  wouldStart,
  activeBox,
  openAgentAt,
  boardHeight,
  boxActions,
  detailParts,
  deleteArgv,
  deleteCommand,
  deleteCommandIds,
  deleteConfirm,
  deleteBusyError,
  deleteFailures,
  deleteFinishedConfirm,
  finishedNotice,
  dragBoard,
  driverPeek,
  findNode,
  keyHints,
  panelShape,
  parentLink,
  titleLayout,
  catchUpStep,
  unfoldAfterPick,
  moveRow,
  moveStop,
  needsCount,
  ownsCommands,
  readRatio,
  readerFiles,
  readerMax,
  resolvePath,
  runLabel,
  runningCount,
  selectAfterDelete,
  selectAfterRefresh,
  spaceAfterDelete,
  trackBackSpace,
  showsHere,
  sortRuns,
  visibleRuns,
  watcherState,
} from './model.js';
import { mark } from './mark.js';
import { board } from './board.js';
import { header, pipeline } from './pipeline.js';
import { activeSlot, turn } from './turn.js';
import { addressOf, link, own } from './ui.js';
import { connectSource, fetchPipelines, fetchStatus, firstLine, watchRuns } from './source.js';
import { startDialog } from './start.js';

const LEFT = 330; // the left column of two: the board and the pipeline
const BLOCK = 'percolator-panel';
const WINDOW = 'percolator.window'; // shared: the open window's overlay id, else null
const RATIO = 'percolator.boardRatio'; // shared: the board's height as a ratio of the area under the title bar
const OLD_RATIO = 'board.ratio'; // localStorage, per copy: read when nothing is shared yet
const MIN_BOARD = 106; // two rows of the board's compact cards, in design px
const zoom = () => Number(settings()?.zoom) || 1;
const folderOf = (file) => file.replace(/[\\/][^\\/]*$/, '');

export default class Percolator extends View {
  init(_props, cx) {
    this.conn = null; // null (loading) | 'missing' | 'perc' | 'fixtures'
    this.perc = null;
    this.fixture = null;
    this.runs = [];
    this.watcher = null; // watcherState of the last status: the header's indicator and its Start/Stop
    this.watchStartedAt = null; // when Start watcher succeeded, until the first heartbeat (starting… meanwhile)
    this.loaded = false;
    this.error = null;
    this.filter = 'active';
    this.sel = null;
    this.stopSel = null;
    this.roundSel = null; // the attempt number picked in the stop strip; null = the latest
    this.unfolded = []; // the selected run's stages whose folded hooks show as rows
    this.file = null; // the strip's file, read under the picked stop
    this.boxFile = null; // the file to review, read in the attention box
    this.boxPick = null; // the box file picked by its tab (as perc gave it); null = the first
    this.files = {};
    this.width = 900;
    this.busy = null;
    this.actError = null;
    this.said = null;
    this.notice = null; // beside Delete finished runs ↗, seen with or without a selection
    this.deleting = null; // { ids, next, shown, doneAt? }: the delete the owner confirmed and the row to select after it
    this.backSpace = null; // the latest shown space that is no run's: where a delete of the shown run's space goes back to
    this.deleteFailed = null; // { <id>: why }: the last delete failed; its runs' headers say so until retry or another pick
    this.fetches = 0;
    this.historyOpen = false;
    this.rejecting = false;
    this.rejectError = null;
    this.typing = false;
    this.ratio = null; // the ratio while the divider is held; otherwise the shared one (boardRatio())
    // Heights in design pixels (zoom 1), measured after each layout.
    this.area = 600; // under the title bar
    this.boardPx = 0; // the board
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
    // the start picker (+ New run, ▸ Run next…): { mode, run, repo, pick, tickets, ticket, error, said } while open
    this.start = null;
    this.pipes = {}; // repo → readPipelines's result, or 'loading'
    this.tops = {}; // space folder → its git toplevel, null when not in a repo, or 'loading'
    this.inputs = {}; // `<pipeline>/<input>` → its InputState, made when the pipelines arrive
    this.asks = {}; // askOf(run).key → { inputs, na, ticks }: a questions or findings form, made when its run arrives
    this.startedId = null; // the run Start started: selected once a refresh lists it
    this.ticketInput = this.ticketState();
    this.handle = cx.focus_handle();
    this.handle.focus();

    this.connect(cx);
    if (checking()) return;
    this.probeSpaces(cx);
    if (this.inWindow()) {
      // However the window opened (⧉, the cup, the palette), it is now the place: one copy shown, one acting.
      setShared(WINDOW, props().overlay); // the cup reads it: the window is open
      setShared('percolator.place', 'window');
      command('layout.hide', { id: BLOCK });
    }
    // Only the shown copy where the panel lives polls perc (the cup does its own polling, for notices).
    watchRuns(cx, (cx) => this.shown() && this.refresh(cx));
    this.watchShown(cx);
    cx.timer.every(30000, (cx) => cx.notify()); // the "4m ago" clocks
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
      if (this.shown()) this.refresh(cx);
    });
  }

  /** This copy is where the panel lives and is shown (a window while open; docked while its block isn't hidden). */
  shown() {
    const node = findNode(layout(), BLOCK);
    return showsHere(shared('percolator.place'), this.inWindow(), Boolean(node && !node.hidden));
  }

  /** A hidden block is not rendered, so render alone never sees this copy hidden, nor the moment it is shown again
   *  (docking back sets the place after `layout.show`): check on a short timer too. */
  watchShown(cx) {
    cx.timer.every(250, (cx) => this.catchUp(cx));
  }

  /** Called each frame and every 250ms: refreshes at once when this copy becomes the shown one again (its data went stale). */
  catchUp(cx) {
    const s = catchUpStep(this.wasShown, this.shown());
    this.wasShown = s.wasShown;
    if (s.refresh) this.refresh(cx);
  }

  refresh(cx) {
    if (this.conn !== 'perc' && this.conn !== 'fixtures') return;
    if (this.conn === 'perc' && checking()) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    const seq = ++this.fetches;
    cx.spawn(async (cx) => {
      const got = await fetchStatus(this);
      if (got.ok) {
        this.runs = sortRuns(got.data.runs);
        this.syncAsks();
        this.watcher = watcherState(got.data, { startedAt: this.watchStartedAt, now: Date.now(), live: terminals() });
        if (this.watcher.alive) this.watchStartedAt = null;
        this.notice = finishedNotice(this.notice, this.runs, false);
        this.error = null;
        this.loaded = true;
        const pick = selectAfterRefresh(this.runs, this.rows(), this.sel, this.deleting);
        // a fetch started after the delete finished has seen all of it
        if (this.deleting?.doneAt !== undefined && seq > this.deleting.doneAt) this.deleting = null;
        if (this.startedId && this.runs.some((r) => r.id === this.startedId)) {
          if (!this.rows().some((r) => r.id === this.startedId)) this.filter = 'all';
          this.select(this.startedId, cx);
          this.startedId = null;
          this.revealRow();
        } else if (!this.current()) {
          // the selected run is gone, deleted by a delete that failed on others: keep saying so
          const { actError, deleteFailed } = this;
          this.select(pick, cx);
          if (deleteFailed) Object.assign(this, { actError, deleteFailed });
        } else this.syncReader(cx); // the run moved on: new review files, or none
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
      this.deleteFailed = null;
      this.said = null;
      this.feedback.set_value('');
      this.unfolded = [];
      this.boxPick = null;
    }
    this.sel = id;
    this.stopSel = null;
    this.roundSel = null;
    this.outPick = null;
    this.syncReader(cx);
  }

  /** Selects a stop (null closes the strip and goes back to the run's review file); a stage holding folded hooks
   *  opens them, and folds them again when it is closed. */
  pickStop(id, cx) {
    const r = this.current();
    if (r && r.status !== 'unreadable') {
      this.unfolded = unfoldAfterPick(r, { narrow: this.shape().fold, unfolded: this.unfolded }, this.stopSel, id);
    }
    this.stopSel = id;
    this.roundSel = null;
    this.outPick = null;
    this.syncReader(cx);
  }

  /** An earlier (or later) round of the selected stop, from the strip: its outputs show in the reader. */
  pickRound(n, cx) {
    this.roundSel = n;
    this.outPick = null;
    this.syncReader(cx);
  }

  /** One of the selected stop's outputs, from the strip. */
  pickOutput(path, cx) {
    this.outPick = path;
    this.syncReader(cx);
  }

  /** One of the attention box's files to review, from its tabs. */
  pickBoxFile(path, cx) {
    this.boxPick = path;
    this.syncReader(cx);
  }

  /** Points the readers at what the run needs read now (readerFiles: the file to review in the attention box, the
   *  strip's output under the picked stop) and reads them again: the same path can hold new text (a re-groom rewrites
   *  groomed_ticket.md). */
  syncReader(cx) {
    const r = this.current();
    const raw = r ? readerFiles(r, this.stopSel, this.roundSel, this.outPick ?? null, this.boxPick ?? null) : { box: null, strip: null };
    this.file = raw.strip ? this.resolve(raw.strip) : null;
    this.boxFile = raw.box ? this.resolve(raw.box) : null;
    for (const path of new Set([this.file, this.boxFile])) {
      if (!path) continue;
      if (this.files[path] === undefined) this.files[path] = null;
      cx.spawn(async (cx) => {
        const text = await readTextFile(path).catch(() => null);
        this.files[path] = text ?? `_${path} could not be read._`;
        cx.notify();
      });
    }
  }

  /** The inline readers' greatest height, in design px: half the panel. */
  readerMaxH() {
    return readerMax(this.area);
  }

  /** What the pipeline draws under the active stop. */
  activeSlot(t, r, narrow) {
    return activeSlot(this, t, r, narrow);
  }

  /** Opens the selected run's active agent (agent.focus takes Herdr's address): its card, its stop and Enter call
   *  this. In fixtures mode, or with its terminal not live, it says so instead. */
  openAgent() {
    const at = openAgentAt(this.current(), terminals(), this.conn === 'fixtures');
    if (!at) return;
    this.actError = null;
    this.said = null;
    if ('said' in at) this.said = at.said;
    else if ('error' in at) this.actError = at.error;
    else command('agent.focus', { terminal: at.address });
  }

  /** Peeks at the run's driver terminal: closing a peek leaves the driver running (closing a pane would end it). */
  peekDriver() {
    const peek = driverPeek(this.current());
    if (!peek) return;
    this.actError = null;
    this.said = null;
    if (this.conn === 'fixtures') {
      this.said = `Fixtures: would peek at ${peek.terminal}`;
      return;
    }
    const terminal = addressOf(peek.terminal);
    if (terminal) command('terminal.peek', { terminal });
    else this.actError = `${peek.terminal} is not a live terminal; refresh the panel`;
  }

  // ── acting ──────────────────────────────────────────────────────────

  act(action, cx, pick) {
    const r = this.current();
    if (!r || this.busy) return;
    if (action === 'pick') {
      this.actError = null;
      this.said = null;
      this.perform('pick', actionArgv('pick', r, pick), cx);
      return;
    }
    this.actError = null;
    this.said = null;
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
          title: `Clean up ${runLabel(r)}?`,
          detail: `Removes the run's terminals and worktree and keeps its branch and run record (perc clean ${r.id}).`,
          command: { name: `percolator.clean/${r.id}` },
        },
      });
      return;
    }
    if (action === 'delete') {
      openOverlay({
        mod: 'confirm',
        kind: 'dialog',
        width: 440,
        height: 220,
        props: { ...deleteConfirm(r), command: { name: `percolator.${deleteCommand([r.id])}` } },
      });
      return;
    }
    this.perform(action, actionArgv(action, r), cx);
  }

  /** The All tab's Delete finished runs ↗: one confirm listing them, or a line saying there are none. */
  deleteFinished(cx) {
    if (this.busy) return;
    this.actError = null;
    const confirm = deleteFinishedConfirm(this.runs);
    this.notice = finishedNotice(this.notice, this.runs, true);
    if (confirm === null) {
      cx.notify();
      return;
    }
    openOverlay({
      mod: 'confirm',
      kind: 'dialog',
      width: 440,
      height: 220,
      // the command carries the ids listed here: a run that finishes while the dialog is open is not deleted
      props: { title: confirm.title, detail: confirm.detail, command: { name: `percolator.${deleteCommand(confirm.ids)}` } },
    });
  }

  /** Deletes exactly `ids`; the row to select after is worked out now, from the rows the owner saw. */
  deleteRuns(ids, cx) {
    if (this.busy) {
      // the dialog has closed: say the delete didn't run rather than drop it
      this.actError = deleteBusyError(this.busy);
      cx.notify();
      return;
    }
    this.deleteFailed = null;
    const shown = this.openSpaces().find((s) => s.active)?.id ?? null;
    if (this.conn !== 'fixtures') this.deleting = { ids, next: selectAfterDelete(this.rows(), ids, this.sel), shown };
    this.perform('delete', deleteArgv(ids), cx);
  }

  /** Keeps the space to go back to after a delete: the latest shown one that is no run's (render calls it). */
  trackSpace() {
    this.backSpace = trackBackSpace(this.backSpace ?? null, this.openSpaces(), this.runs);
  }

  /** Once perc ended a deleted run's space while it was shown, shows the space the owner came from instead of the
   *  one Herdr picked (often another run's); the deleted runs are still in `this.runs` until the refresh lands. */
  spaceBack(d) {
    const id = spaceAfterDelete({ shown: d.shown ?? null, back: this.backSpace ?? null }, this.openSpaces(), this.runs, d.ids);
    if (id !== null) command('space.select', { id });
  }

  /** One form per run that asks (all unticked, nothing answered), kept while the same ask is listed. */
  syncAsks() {
    const next = {};
    for (const r of this.runs) {
      const ask = askOf(r);
      if (!ask) continue;
      next[ask.key] =
        this.asks[ask.key] ??
        (ask.kind === 'questions'
          ? { inputs: ask.items.map(() => this.answerState()), na: ask.items.map(() => false), ticks: [] }
          : { inputs: [], na: [], ticks: ask.items.map(() => false) });
    }
    this.asks = next;
  }

  /** Submit's click: perc answer with the form's values, or the reason it can't go yet in the box. */
  submitAnswer(cx) {
    const r = this.current();
    const ask = askOf(r);
    const form = ask && this.asks[ask.key];
    if (!form || this.busy) return;
    this.said = null;
    let argv;
    try {
      argv = answerArgv(r, ask.kind === 'questions' ? form.inputs.map((s, i) => (form.na[i] ? null : s.value())) : form.ticks);
    } catch (err) {
      this.actError = err.message;
      cx.notify();
      return;
    }
    this.actError = null;
    this.perform('answer', argv, cx);
  }

  perform(action, argv, cx) {
    if (!argv) return;
    this.actError = null; // an earlier action's error is stale once another starts
    if (this.conn === 'fixtures') {
      this.said = `Fixtures: would run perc ${argv.join(' ')}`;
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
      if (action === 'delete' && this.deleting) {
        this.deleting.doneAt = this.fetches;
        this.spaceBack(this.deleting);
      }
      // a delete of several runs that exits 1 still removed some: refresh either way
      if (res.code === 0 || action === 'delete') this.refresh(cx);
      if (res.code === 0) {
        this.actError = null;
        if (action === 'delete') this.deleteFailed = null;
        if (action === 'reject') this.closeReject();
        // as Start does: the new run is selected once a refresh lists it
        if (action === 'run-again') this.startedId = startedRun(res.stdout);
      } else {
        const why = firstLine(res.stderr) || `perc ${argv[0]} exited ${res.code}`;
        const ids = action === 'delete' ? (this.deleting?.ids ?? []) : [];
        if (action === 'delete') this.deleteFailed = deleteFailures(ids, res.stderr, why);
        if (action === 'reject') this.rejectError = why;
        // the selected run's header says Delete failed: not again under its buttons; a delete of several may
        // remove the selected run and fail on another, so that one's reason must stay in view
        else if (!(ids.length === 1 && ids[0] === this.sel)) this.actError = why;
      }
      cx.notify();
    });
  }

  // ── the start picker ────────────────────────────────────────────────

  /** An answer field: typing clears the answer's error, and Enter submits the answers (never starts a run). */
  answerState() {
    return this.textState(
      { placeholder: 'Your answer' },
      {
        change: () => {
          this.actError = null;
        },
        submit: (cx) => this.submitAnswer(cx),
      },
    );
  }

  /**
   * A one-line text state that marks the panel as typing while it has the keyboard. By default (the start picker's
   * fields) typing clears the picker's error and Enter starts the run; `on.change` and `on.submit` replace that.
   */
  textState(options, on = {}) {
    const s = InputState.new(options);
    s.on('focus', (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    s.on('blur', (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
    const change =
      on.change ??
      (() => {
        if (this.start) {
          this.start.error = this.start.said = null;
          this.start.auto = false; // the owner is filling in the picker: a late probe leaves its repo alone
        }
      });
    const submit = on.submit ?? ((cx) => this.startRun(cx));
    s.on('change', (_e, cx) => {
      change(cx);
      cx.notify();
    });
    s.on('submit', (_e, cx) => submit(cx));
    return s;
  }

  /** The picker's ticket field: typing in it may preselect a repo; ticketChanged decides if it ends `auto`. */
  ticketState() {
    return this.textState(
      { placeholder: 'owner/repo#12' },
      {
        change: (cx) => {
          if (this.start) this.start.error = this.start.said = null;
          this.ticketChanged(cx);
        },
      },
    );
  }

  /** The input's state: made with the pipelines (startPipelines), so render only reads it. */
  inputState(pipeline, input) {
    return this.inputs[`${pipeline}/${input.name}`] ?? null;
  }

  /** The spaces open in Herdr: none until the panel knows it is connected to perc, so fixtures and missing modes never probe the machine's real folders. */
  openSpaces() {
    if (this.conn !== 'perc') return [];
    return spaces() ?? [];
  }

  /** The git toplevel of a folder (argv only), or null when it is not in a repo or git can't run there. */
  async gitTop(folder) {
    const got = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: folder, timeout: 10000 }).catch(() => null);
    return got?.code === 0 ? got.stdout.trim() || null : null;
  }

  /** Asks git once per local space folder where its repo is; a late answer moves the picker's automatic repo. */
  probeSpaces(cx) {
    if (checking()) return;
    for (const s of this.openSpaces()) {
      const folder = s.folder;
      if (s.machine != null || !folder || folder in this.tops) continue;
      this.tops[folder] = 'loading';
      cx.spawn(async (cx) => {
        this.tops[folder] = await this.gitTop(folder);
        const st = this.start;
        if (st?.mode === 'new' && st.auto) {
          const repo = startRepo(this.openSpaces(), this.tops, this.runs);
          if (repo && !sameRepo(repo, st.repo)) {
            st.pick = null; // the panel picked the old repo's pipeline too: the new repo's default replaces it
            this.pickRepo(repo, cx, { auto: true });
          }
        }
        cx.notify();
      });
    }
  }

  /**
   * "+ New run": the picker over any pipeline, on the shown space's repo (startRepo); `pick` names the pipeline to show.
   * A named pipeline (percolator.new/<pipeline>) is the owner's choice, so a late probe leaves the repo alone.
   */
  openStart(cx, pick = null) {
    if (this.start?.mode === 'new' && pick === null) return this.closeStart(cx);
    this.ticketInput.set_value('');
    this.tops ??= {};
    // a folder that was not in a repo (or whose git timed out) may be one now: ask again
    for (const [folder, top] of Object.entries(this.tops)) if (top === null) delete this.tops[folder];
    this.probeSpaces(cx);
    const repo = startRepo(this.openSpaces(), this.tops, this.runs);
    this.start = { mode: 'new', run: null, repo, auto: pick === null, pick, tickets: [], ticket: '', error: null, said: null };
    this.loadPipelines(cx);
  }

  /** "▸ Run next…" on the selected finished run: its ticket (or the issues it opened) and repo, fixed. Again closes. */
  openRunNext(cx) {
    const r = this.current();
    if (!r || this.start?.run === r.id) return this.closeStart(cx);
    this.start = { mode: 'next', run: r.id, repo: r.repo, auto: false, pick: null, tickets: [], ticket: '', error: null, said: null };
    this.loadPipelines(cx);
  }

  closeStart(cx) {
    this.start = null;
    this.typing = false;
    this.handle.focus();
    cx?.notify();
  }

  /** Lists the picked repo's pipelines once (a failed listing is asked again), then settles the pick and tickets. */
  loadPipelines(cx) {
    const s = this.start;
    const repo = s?.repo;
    const have = repo ? this.pipes[repo] : null;
    if (!repo || (have && (have === 'loading' || have.ok))) {
      this.settleStart();
      return cx.notify(); // nothing to fetch: draw the picker now
    }
    this.pipes[repo] = 'loading';
    cx.spawn(async (cx) => {
      const got = await fetchPipelines(this, repo).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      this.pipes[repo] = got;
      if (got.ok) {
        for (const pl of got.data.pipelines) {
          for (const i of pl.inputs ?? []) {
            const key = `${pl.name}/${i.name}`;
            this.inputs[key] ??= this.textState({ placeholder: i.description ?? '' });
          }
        }
      }
      this.settleStart();
      cx.notify();
    });
  }

  /** The picked pipeline (kept while the repo has it), and for run next the tickets it offers. */
  settleStart() {
    const s = this.start;
    if (!s) return;
    const all = this.repoPipelines();
    if (s.mode === 'next') {
      const r = this.runs.find((x) => x.id === s.run);
      const c = r ? runNextChoices(r, all, this.runs) : null;
      s.tickets = c?.tickets ?? [];
      if (!s.tickets.includes(s.ticket)) s.ticket = s.tickets[0] ?? '';
      s.names = c?.pipelines ?? [];
      s.pick = startPick(all, s.pick, s.names);
    } else s.pick = startPick(all, s.pick);
  }

  repoPipelines() {
    const got = this.start?.repo ? this.pipes[this.start.repo] : null;
    return got && got !== 'loading' && got.ok ? got.data.pipelines : [];
  }

  /** The pipelines the picker lists: all of the repo's, or for run next only those that take a ticket. */
  startList() {
    const all = this.repoPipelines();
    return this.start?.mode === 'next' ? all.filter((p) => (this.start.names ?? []).includes(p.name)) : all;
  }

  startPipeline() {
    return this.repoPipelines().find((p) => p.name === this.start?.pick && !p.error) ?? null;
  }

  startChoice(pl) {
    const s = this.start;
    const inputs = Object.fromEntries(pl.inputs.map((i) => [i.name, this.inputState(pl.name, i)?.value() ?? '']));
    const ticket = s.mode === 'next' ? s.ticket : this.ticketInput.value();
    return { pipeline: pl, ...(pl.ticket === 'none' ? {} : { ticket }), inputs, repo: s.repo };
  }

  canStartNow(choice) {
    return canStart(choice);
  }

  startArgvNow(choice) {
    return startArgv(choice);
  }

  pickPipeline(name, cx) {
    this.start.pick = name;
    this.start.auto = false;
    this.start.error = this.start.said = null;
    cx.notify();
  }

  pickTicket(ref, cx) {
    this.start.ticket = ref;
    cx.notify();
  }

  /** `auto`: the panel picked it (probeSpaces), so a later probe may still move it; the owner's pick stays. */
  pickRepo(repo, cx, { auto = false } = {}) {
    this.start.auto = auto;
    if (sameRepo(this.start.repo, repo)) return;
    this.start.repo = repo;
    this.start.error = this.start.said = null;
    this.loadPipelines(cx);
    cx.notify();
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: 'Repo for this run' }).catch(() => null);
      if (dir && this.start) this.pickRepo(dir, cx);
    });
  }

  /** A typed ticket preselects the repo the latest run on its GitHub repo ran in. */
  ticketChanged(cx) {
    const s = this.start;
    if (s?.mode !== 'new') return;
    const text = this.ticketInput.value();
    if (text) s.auto = false; // typed (emptying the field on open is not the owner's doing)
    const repo = guessRepo(text, this.runs);
    if (repo && !sameRepo(repo, s.repo)) this.pickRepo(repo, cx);
  }

  /** Start: `perc run …` (argv only, never a shell); fixtures mode says what it would run instead. */
  startRun(cx) {
    const s = this.start;
    if (s) s.auto = false; // Start, even a refused one, is the owner's choice: a late probe leaves its repo alone
    const pl = this.startPipeline();
    if (!s || !pl || this.busy) return;
    const choice = this.startChoice(pl);
    const can = canStart(choice);
    if (!can.ok) {
      s.error = can.why;
      cx.notify();
      return;
    }
    const argv = startArgv(choice);
    s.error = null;
    if (this.conn === 'fixtures') {
      s.said = wouldStart(argv);
      cx.notify();
      return;
    }
    this.busy = 'start';
    cx.spawn(async (cx) => {
      const res = await exec(this.perc.node, [this.perc.cli, ...argv], { timeout: 120000 }).catch((e) => ({
        code: -1,
        stdout: '',
        stderr: String(e?.message ?? e),
      }));
      this.busy = null;
      if (res.code === 0) {
        this.startedId = startedRun(res.stdout);
        this.closeStart();
        this.refresh(cx);
      } else if (this.start) {
        this.start.error = firstLine(res.stderr) || `perc run exited ${res.code}`;
      }
      cx.notify();
    });
  }

  /** The header's Start watcher / Stop:`perc watch …` or `perc watch stop`; what it says goes beside the tabs. */
  toggleWatcher(cx) {
    const argv = this.watcher?.argv;
    if (!argv || this.busy) return;
    if (this.conn === 'fixtures') {
      this.notice = `Fixtures: would run perc ${argv.join(' ')}`;
      cx.notify();
      return;
    }
    this.busy = 'watch';
    this.notice = null;
    cx.spawn(async (cx) => {
      const res = await exec(this.perc.node, [this.perc.cli, ...argv], { timeout: 120000 }).catch((e) => ({
        code: -1,
        stdout: '',
        stderr: String(e?.message ?? e),
      }));
      this.busy = null;
      if (res.code !== 0) this.notice = firstLine(res.stderr) || `perc ${argv.join(' ')} exited ${res.code}`;
      // a started watcher beats only after its first poll: until then the chip says Starting…, not Start again
      this.watchStartedAt = res.code === 0 && argv[1] !== 'stop' ? Date.now() : null;
      this.refresh(cx);
      cx.notify();
    });
  }

  /** The watcher in the title bar: a dot and its label, then Start watcher or Stop; narrow, the dot alone (it says both). */
  watcherChip(t, narrow) {
    const w = this.watcher;
    if (!w) return null;
    const action = w.argv === null ? '' : w.argv[1] === 'stop' ? 'Stop' : 'Start watcher';
    const dot = div().flex_none().size(7).rounded(4).bg(w.alive ? t.working : t.dim);
    const run = (_e, cx) => this.toggleWatcher(cx);
    if (narrow) {
      const tip = action ? `${w.label} · click: ${action}` : w.label;
      const el = div().id('watcher').flex_none().px(5).py(4).rounded(4).tooltip(tip).child(dot);
      return w.argv === null ? el : own(el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(run));
    }
    return h_flex()
      .flex_none()
      .gap(6)
      .items_center()
      .text_size(10.5)
      .text_color(t.muted)
      .child(dot)
      .child(div().flex_none().child(w.label))
      .when(Boolean(action), (el) => el.child(link(t, 'watcher', this.busy === 'watch' ? '…' : action, run)));
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
    const acts = r ? boxActions(r) : [];
    if (key === 'up' || key === 'down') {
      const id = moveRow(this.rows(), this.sel, key === 'up' ? -1 : 1);
      if (id) {
        this.select(id, cx);
        this.revealRow();
      }
    } else if ((key === 'left' || key === 'right') && r) {
      this.pickStop(moveStop(r, this.stopSel, key === 'left' ? -1 : 1, this.unfolded, this.shape().fold), cx);
    } else if (key === 'a' && acts.includes('approve')) this.act('approve', cx);
    else if (key === 'r' && acts.includes('reject')) this.act('reject', cx);
    else if (key === 'g' && acts.includes('grant')) this.act('grant', cx);
    else if (key === 'g' && acts.includes('resume')) this.act('resume', cx);
    else if (key === 'enter' && r && activeBox(r) === 'agent') this.openAgent();
    else if (key === 'escape') {
      if (this.start) this.closeStart();
      else if (this.rejecting) this.closeReject();
      else if (this.stopSel) this.pickStop(null, cx);
      else if (!this.toParent(cx)) this.hide();
    } else if (key === 'backspace') return this.toParent(cx);
    else return false;
    return true;
  }

  /** A selected slice's parent: selects it; false when the run is not a slice whose parent is listed. */
  toParent(cx) {
    const r = this.current();
    const up = r && parentLink(r, this.runs);
    if (!up) return false;
    // as a linked run's line does: a parent the tab hides is shown on All
    if (!this.rows().some((x) => x.id === up.run)) this.filter = 'all';
    this.select(up.run, cx);
    this.revealRow();
    cx.notify();
    return true;
  }

  onCommand(c, cx) {
    if (c.startsWith('clean/')) {
      const r = this.runs.find((x) => x.id === c.slice(6));
      if (r) this.perform('clean', actionArgv('clean', r), cx);
    } else if (deleteCommandIds(c)) this.deleteRuns(deleteCommandIds(c), cx);
    else if (c.startsWith('key/')) this.key(c.slice(4), cx);
    else if (c === 'new' || c.startsWith('new/')) this.openStart(cx, c.startsWith('new/') ? c.slice(4) : null);
    else if (c === 'next') this.openRunNext(cx);
    else if (c === 'start') this.startRun(cx);
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

  /** The panel's layout at its width: `narrow`; `cols`, one or two; `fold`, the pipeline folds every passed hook. */
  shape() {
    return panelShape(this.width, zoom());
  }

  // ── the divider between the board and the detail ──────────────────

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

  divider(t) {
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
          .text_color(this.filter === id ? t.foreground : t.muted)
          .when(this.filter === id, (el) => el.bg(t.raised))
          .on_click((_e, cx) => {
            this.filter = id;
            this.notice = null;
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
    // ⧉ and ✕ never leave: the title truncates, the tabs take a row of their own, and only under 270 does the chip shorten to "N".
    const fit = titleLayout(this.width / zoom(), needs, this.filter);
    // inline, the tabs give way before ⧉ and ✕ do (a long notice, Delete finished runs ↗ beside a busy watcher)
    const tabs = h_flex()
      .flex_shrink_1()
      .min_w(0)
      .overflow_hidden()
      .gap(8)
      .items_center()
      .child(tab('active', 'Active'))
      .child(tab('all', 'All'))
      .when(this.filter === 'all', (el) => el.child(link(t, 'delete-finished', 'Delete finished runs ↗', (_e, cx) => this.deleteFinished(cx)).flex_shrink_1().min_w(0).truncate()))
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(this.notice)));
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
      .when(this.conn !== 'missing', (el) =>
        el.child(
          fit.newRun === 'icon'
            ? icon('new-run', '+', 'New run', (_e, cx) => this.openStart(cx)).when(Boolean(this.start), (el) => el.text_color(t.accent))
            : link(t, 'new-run', '+ New run', (_e, cx) => this.openStart(cx)),
        ),
      )
      .when(Boolean(this.watcher), (el) => el.child(this.watcherChip(t, narrow || fit.tabs === 'below')))
      .when(this.conn === 'fixtures' && !narrow, (el) => el.child(div().flex_none().text_size(10).text_color(t.muted).child('Fixtures')))
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
      .text_color(t.muted)
      .child(div().min_w(0).truncate().child(keyHints(this.current(), this.runs)));
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
      .child(div().text_size(12).text_color(t.muted).child(this.error ? '' : 'Loading…'));
  }

  // The measured frames (area, board-frame) are drawn from the first frame on, whatever the state: Herdr reports sizes
  // only for elements it has had since the view's first frame. One column or two, they keep their place (area > left).
  body(t, { narrow, cols, fold }) {
    const two = cols === 'two';
    const ready = this.conn !== 'missing' && this.loaded;
    const r = ready ? this.current() : null;
    const rows = ready ? this.rows() : [];
    const parts = r ? detailParts(r, { cols, narrow: fold, unfolded: this.unfolded, stopSel: this.stopSel }) : null;
    const boardMax = boardHeight(this.boardRatio(), this.area, MIN_BOARD);
    const detail = v_flex()
      .id('detail-body')
      .flex_none()
      .when(!ready && !two, (el) => el.min_h_full().child(this.placeholder(t)))
      .when(Boolean(r), (el) =>
        el
          .when(!two, (el) => el.child(header(this, t, r, narrow)))
          .child(pipeline(this, t, r, fold, narrow, parts.under))
          .when(!two, (el) => el.child(turn(this, t, r, narrow, parts.side))),
      );
    const starting = ready && Boolean(this.start);
    const leftColumn = v_flex()
      .id('left')
      .min_h(0)
      .when(starting, (el) => el.hidden()) // kept, so its frames stay measured
      .when(two, (el) => el.w(LEFT).flex_none().h_full())
      .when(!two, (el) => el.flex_1().min_w(0))
      .child(
        v_flex()
          .id('board-frame')
          .flex_none()
          .when(rows.length > 0, (el) => el.max_h(boardMax))
          .on_size_change((size, cx) => this.measured('boardPx', size, cx))
          .when(ready, (el) => el.child(board(this, t, true, rows))), // always its compact cards
      )
      .when(rows.length > 0, (el) => el.child(this.divider(t)))
      .child(
        // One scroll for the whole detail, filled absolutely: overflow_y_scrollbar() wraps the element, so its flex
        // sizing never reaches the layout.
        div()
          .id('detail-frame')
          .flex_1()
          .min_h(0)
          .relative()
          .child(v_flex().id('detail').absolute().inset_0().overflow_y_scroll().child(detail))
          .child(Scrollbar.vertical('detail').absolute().inset_0()),
      );
    // The right column of two: the run's header, then its box (or how it ended) and the picked stop's strip, whose
    // readers take the height left; it does not scroll as a whole, so the buttons stay in view.
    const rightColumn = () =>
      v_flex()
        .id('right')
        .flex_1()
        .min_w(0)
        .min_h(0)
        .h_full()
        .border_l(1)
        .border_color(t.border)
        .when(starting, (el) => el.hidden())
        .when(!ready, (el) => el.child(this.placeholder(t)))
        .when(Boolean(r), (el) =>
          el.child(div().flex_none().child(header(this, t, r, false))).child(turn(this, t, r, false, parts.side, true)),
        );
    return div()
      .id('area')
      .flex()
      .when(two, (el) => el.flex_row().items_stretch())
      .when(!two, (el) => el.flex_col())
      .flex_1()
      .min_h(0)
      .on_size_change((size, cx) => this.measured('area', size, cx))
      .child(leftColumn)
      .when(two, (el) => el.child(rightColumn()))
      .when(starting, (el) => el.child(this.startFrame(t, { narrow, cols, fold })));
  }

  /** The start picker in place of the board and the run, scrolling on its own. */
  startFrame(t, at) {
    const dialog = startDialog(this, t, at, this.width / zoom(), startRepos(this.openSpaces(), this.tops, this.runs));
    return div()
      .id('start-frame')
      .flex_1()
      .min_w(0)
      .min_h(0)
      .relative()
      .child(v_flex().id('start').absolute().inset_0().overflow_y_scroll().child(dialog))
      .child(Scrollbar.vertical('start').absolute().inset_0());
  }

  render(cx) {
    const t = theme();
    this.catchUp(cx);
    this.probeSpaces(cx);
    this.trackSpace();
    this.followFocus(cx);
    const at = this.shape();
    const { narrow } = at;
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
        this.ratio = dragBoard(this.drag.px, dy, this.area, MIN_BOARD);
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
            if (this.start) this.closeStart();
            else this.closeReject();
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
          .child(this.body(t, at)),
      )
      .when(!narrow && this.conn !== 'missing', (el) => el.child(this.hints(t)));
  }
}
