// The start picker's state and handlers: "+ New run" and "▸ Run next…" open it over the panel (`panel.picker`), it
// lists a repo's pipelines and starts `perc run`. start.js draws it (startDialog); model.js holds its pure logic.

import { checking, exec, pickFolder } from 'herdr';
import { canStart, guessRepo, runNextChoices, sameRepo, startArgv, startPick, startRepo, startedRun, wouldStart } from './model.js';
import { fetchPipelines, firstLine } from './source.js';

export class StartPicker {
  constructor(panel) {
    this.panel = panel; // the view: its runs, connection, busy action, typing and focus
    // { mode, run, repo, pick, tickets, ticket, error, said } while open
    this.start = null;
    this.pipes = {}; // repo → readPipelines's result, or 'loading'
    this.tops = {}; // space folder → its git toplevel, null when not in a repo, or 'loading'
    this.inputs = {}; // `<pipeline>/<input>` → its InputState, made when the pipelines arrive
    this.ticketInput = this.ticketState();
  }

  /** A picker field (panel.textState): typing clears the picker's error and Enter starts the run; `on.change` and
   *  `on.submit` replace that. */
  textState(options, on = {}) {
    const change =
      on.change ??
      (() => {
        if (this.start) {
          this.start.error = this.start.said = null;
          this.start.auto = false; // the owner is filling in the picker: a late probe leaves its repo alone
        }
      });
    const submit = on.submit ?? ((cx) => this.startRun(cx));
    return this.panel.textState(options, { change, submit });
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

  /** The git toplevel of a folder (argv only), or null when it is not in a repo or git can't run there. */
  async gitTop(folder) {
    const got = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: folder, timeout: 10000 }).catch(() => null);
    return got?.code === 0 ? got.stdout.trim() || null : null;
  }

  /** Asks git once per local space folder where its repo is; a late answer moves the picker's automatic repo. */
  probeSpaces(cx) {
    if (checking()) return;
    for (const s of this.panel.openSpaces()) {
      const folder = s.folder;
      if (s.machine != null || !folder || folder in this.tops) continue;
      this.tops[folder] = 'loading';
      cx.spawn(async (cx) => {
        this.tops[folder] = await this.gitTop(folder);
        const st = this.start;
        if (st?.mode === 'new' && st.auto) {
          const repo = startRepo(this.panel.openSpaces(), this.tops, this.panel.runs);
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
    const repo = startRepo(this.panel.openSpaces(), this.tops, this.panel.runs);
    this.start = { mode: 'new', run: null, repo, auto: pick === null, pick, tickets: [], ticket: '', error: null, said: null };
    this.loadPipelines(cx);
  }

  /** "▸ Run next…" on the selected finished run: its ticket (or the issues it opened) and repo, fixed. Again closes. */
  openRunNext(cx) {
    const r = this.panel.current();
    if (!r || this.start?.run === r.id) return this.closeStart(cx);
    this.start = { mode: 'next', run: r.id, repo: r.repo, auto: false, pick: null, tickets: [], ticket: '', error: null, said: null };
    this.loadPipelines(cx);
  }

  closeStart(cx) {
    this.start = null;
    this.panel.typing = false;
    this.panel.handle.focus();
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
      const got = await fetchPipelines(this.panel, repo).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
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
      const r = this.panel.runs.find((x) => x.id === s.run);
      const c = r ? runNextChoices(r, all, this.panel.runs) : null;
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
    const repo = guessRepo(text, this.panel.runs);
    if (repo && !sameRepo(repo, s.repo)) this.pickRepo(repo, cx);
  }

  /** Start: `perc run …` (argv only, never a shell); fixtures mode says what it would run instead. */
  startRun(cx) {
    const s = this.start;
    if (s) s.auto = false; // Start, even a refused one, is the owner's choice: a late probe leaves its repo alone
    const pl = this.startPipeline();
    if (!s || !pl || this.panel.busy) return;
    const choice = this.startChoice(pl);
    const can = canStart(choice);
    if (!can.ok) {
      s.error = can.why;
      cx.notify();
      return;
    }
    const argv = startArgv(choice);
    s.error = null;
    if (this.panel.conn === 'fixtures') {
      s.said = wouldStart(argv);
      cx.notify();
      return;
    }
    this.panel.busy = 'start';
    cx.spawn(async (cx) => {
      const res = await exec(this.panel.perc.node, [this.panel.perc.cli, ...argv], { timeout: 120000 }).catch((e) => ({
        code: -1,
        stdout: '',
        stderr: String(e?.message ?? e),
      }));
      this.panel.busy = null;
      if (res.code === 0) {
        this.panel.startedId = startedRun(res.stdout);
        this.closeStart();
        this.panel.refresh(cx);
      } else if (this.start) {
        this.start.error = firstLine(res.stderr) || `perc run exited ${res.code}`;
      }
      cx.notify();
    });
  }
}
