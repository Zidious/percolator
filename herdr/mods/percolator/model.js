// The Percolator panel's pure logic: what `perc status --json` (schema 1) means for the board, the pipeline and the
// actions. No `herdr` imports, so node:test covers it (tests/herdr/model.test.ts); model.d.ts declares it.

export const STAGES = Object.freeze(['intake', 'groom', 'plan', 'implement', 'review', 'deliver']);

const INVALID = 'perc status --json returned invalid JSON';

/** `perc status --json` stdout → `{ ok: true, data }`, or `{ ok: false, error }` when it is not a status object. */
export function parseStatus(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: INVALID };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.runs)) {
    return { ok: false, error: INVALID };
  }
  return { ok: true, data };
}

/** Whether a run waits on you. A blocked agent does not: Herdr already shows it, so the panel counts that run as running. */
export const needsYou = (r) => Boolean(r.attention) && r.attention.kind !== 'agent';

/** The tone the active stop rings in: blocked when the run needs you or failed, else working. */
export const nowTone = (r) => (needsYou(r) || r.status === 'failed' ? 'blocked' : 'working');
const rank = (r) => (needsYou(r) ? 0 : r.status === 'running' ? 1 : r.status === 'unreadable' ? 3 : 2);
const created = (r) => (typeof r.createdAt === 'string' ? Date.parse(r.createdAt) || 0 : 0);

/** A sorted copy: needing you first, then running, then the rest (unreadable last); newest first within each. */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => rank(a) - rank(b) || created(b) - created(a));
}

/** "active": everything except completed and failed runs that need nothing; "all": everything. */
export function visibleRuns(runs, filter) {
  if (filter === 'all') return [...runs];
  return runs.filter((r) => needsYou(r) || (r.status !== 'completed' && r.status !== 'failed'));
}

/** The board row's state line and its tone. */
export function rowState(run) {
  const a = run.attention;
  const step = run.currentStep;
  if (a && a.kind !== 'agent') {
    const blocked = (text) => ({ tone: 'blocked', text });
    switch (a.kind) {
      case 'gate':
        return blocked(`your turn · ${step}`);
      case 'cap':
        return blocked(`paused · ${step} at cap`);
      case 'paused':
        return blocked(`paused · ${step}`);
      case 'failed':
        return blocked(`failed · ${step}`);
      case 'stalled':
        return blocked('stalled · driver stopped');
    }
  }
  if (run.status === 'running') {
    const loop = (run.loops ?? []).find((l) => l.from === step && l.round > 0);
    return loop ? { tone: 'working', text: `${step}`, round: `round ${roundOf(loop).n}/${loop.max}` } : { tone: 'working', text: `${step}` };
  }
  if (run.status === 'completed') {
    const pr = run.pr?.url.split('/').pop();
    return { tone: 'dim', text: pr ? `delivered · PR #${pr}` : 'delivered' };
  }
  if (run.status === 'unreadable') return { tone: 'muted', text: `unreadable · ${run.error}` };
  return { tone: 'muted', text: run.status };
}

/** Runs in `next` that need you and did not in `prev` (or were not there); none on the first load (`prev` null). */
export function newlyNeeding(prev, next) {
  if (prev === null) return [];
  const had = new Set(prev.filter(needsYou).map((r) => r.id));
  return next.filter((r) => needsYou(r) && !had.has(r.id));
}

/** The `perc` argv for an action, or null when it needs no perc call (open-pane). Feedback stays one element. */
export function actionArgv(action, run, feedback) {
  switch (action) {
    case 'approve':
      return ['approve', run.id];
    case 'reject':
      if (typeof feedback !== 'string' || feedback.trim() === '') throw new Error('Say what to change');
      return ['reject', run.id, '--', feedback];
    case 'grant':
    case 'resume':
      return ['resume', run.id];
    case 'clean':
      return ['clean', run.id];
    default:
      return null;
  }
}

/** Runs that need you. */
export function needsCount(runs) {
  return runs.filter(needsYou).length;
}

/** Running runs that need nothing from you. */
export function runningCount(runs) {
  return runs.filter((r) => r.status === 'running' && !needsYou(r)).length;
}

/** parseStatus, and refuses a schema this panel does not know. */
export function readStatus(stdout) {
  const parsed = parseStatus(stdout);
  if (parsed.ok && parsed.data.schema !== 1) {
    return { ok: false, error: `perc status --json returned schema ${parsed.data.schema}; update the Percolator panel` };
  }
  return parsed;
}

/** Seconds as "12s", "4m", "3h" or "2d". */
export function duration(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** How long ago an ISO date was, from `now` (ms); "" without a date. */
export function ago(iso, now) {
  return iso ? duration((now - Date.parse(iso)) / 1000) : '';
}

/** A finished step's duration, or how long a running step has run; "" otherwise. */
export function took(step, now) {
  if (step.startedAt && step.endedAt) return duration((Date.parse(step.endedAt) - Date.parse(step.startedAt)) / 1000);
  if (step.startedAt && step.status === 'running') return ago(step.startedAt, now);
  return '';
}

const TONES = { pass: 'done', running: 'working', waiting: 'blocked', fail: 'blocked', escalate: 'blocked', contract_error: 'blocked' };

/** The theme colour name for a step status, or null for one that has not run. */
export function stepTone(status) {
  return TONES[status] ?? null;
}

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** `p` as is when absolute, else joined to the folder `base`. */
export function resolvePath(base, p) {
  return ABSOLUTE.test(p) ? p : `${base.replace(/[\\/]+$/, '')}/${p}`;
}

const TAGS = { gate: 'GATE', cap: 'PAUSED', paused: 'PAUSED', failed: 'FAILED', stalled: 'STALLED' };

/** The tag shown before an attention message. */
export function attentionTag(kind) {
  return TAGS[kind] ?? 'NEEDS YOU';
}

/** The round the engine is in: `round` counts back-edges already taken, the engine's round is one more, up to the cap. */
export function roundOf(loop) {
  return { n: Math.min(1 + loop.round, loop.max), max: loop.max, taken: loop.round > 0, atCap: loop.round >= loop.max };
}

function loopTone(r) {
  return r.atCap ? 'blocked' : r.taken ? 'working' : 'dim';
}

/** The pill on the step a loop starts from; null when no loop starts there. */
export function roundPill(run, stepId) {
  const loop = (run.loops ?? []).find((l) => l.from === stepId);
  if (!loop) return null;
  const r = roundOf(loop);
  return { text: `round ${r.n}/${r.max}${r.atCap ? ' · cap' : ''}`, tone: loopTone(r) };
}

/** The engine's round of a loop that goes back to `stepId`, past round 1; null otherwise. */
function roundAt(run, stepId) {
  const loop = (run.loops ?? []).find((l) => l.to === stepId && roundOf(l).n > 1);
  return loop ? roundOf(loop).n : null;
}

/** Beside the step a loop goes back to, past round 1: "round N · <time>" (its latest attempt's), else "". */
export function roundNote(run, stepId, now) {
  const n = roundAt(run, stepId);
  if (n === null) return '';
  const last = stepAttempts(run, stepId).at(-1);
  const time = last ? took(last, now) : '';
  return time ? `round ${n} · ${time}` : `round ${n}`;
}

/** Every loop, taken or not, with its tone. */
export function loopSpans(run) {
  return (run.loops ?? []).map((l) => ({ id: l.id, from: l.from, to: l.to, tone: loopTone(roundOf(l)) }));
}

const ALL = new Set(['before-all', 'after-all']);
const SIDE = { 'before-all': 'before', before: 'before', after: 'after', 'after-all': 'after' };

const FAILED = new Set(['fail', 'escalate', 'contract_error']);

/** A loop start that sent the run back and is under its cap: its failure is the loop going on, not the run failing. */
const sentBack = (run, step) =>
  (run.loops ?? []).some((l) => l.from === step.id && roundOf(l).taken && !roundOf(l).atCap);

function pipeState(run, step) {
  if (step.id === run.currentStep && run.status !== 'completed') return 'active';
  if (FAILED.has(step.status) && !sentBack(run, step)) return 'failed';
  return step.status === 'pending' ? 'future' : 'past';
}

/**
 * The vertical pipeline, top to bottom: `before-all` hooks, then each stage where its first core step (else its first
 * node) appears in the run, its steps in run order, then `after-all` hooks. A stage's nodes before its first core step
 * are `before`, the rest `after`; a stage with no core step lists its nodes as `before`. When `narrow`, or a side has
 * more than 3 passed hooks, that side's passed hooks fold into the stage's first core row (`before-all` counts as
 * intake's before, `after-all` as deliver's after), unless the stage is in `unfolded`. The active row never folds.
 */
export function pipelineRows(run, o) {
  const steps = run.steps ?? [];
  const base = (step) => ({ step, gate: step.kind === 'gate', state: pipeState(run, step) });
  const hook = (step, where) => ({ type: 'hook', ...base(step), where });
  const allHooks = (where) => steps.filter((s) => s.stage === where).map((s) => hook(s, where));

  const groups = new Map(); // stage → { stage, steps, at: index of its first core step, else of its first node }
  steps.forEach((s, i) => {
    if (ALL.has(s.stage)) return;
    const g = groups.get(s.stage) ?? { stage: s.stage, steps: [], at: i, core: false };
    if (s.role === 'core' && !g.core) Object.assign(g, { at: i, core: true });
    g.steps.push(s);
    groups.set(s.stage, g);
  });
  const ordered = [...groups.values()].sort((a, b) => a.at - b.at);
  const blocks = ordered.map((g) => {
    const firstCore = g.steps.findIndex((s) => s.role === 'core');
    // a node between two core steps of one stage counts as `after` its first core step
    const rows = g.steps.map((s, i) =>
      s.role === 'core'
        ? { type: 'stage', ...base(s), round: roundPill(run, s.id), folded: [] }
        : hook(s, firstCore < 0 || i < firstCore ? 'before' : 'after'),
    );
    return { stage: g.stage, rows };
  });
  const block = (stage) => blocks.find((b) => b.stage === stage);
  const before = allHooks('before-all');
  const after = allHooks('after-all');
  if (block('intake')) block('intake').rows.unshift(...before);
  else blocks.unshift({ stage: null, rows: before });
  if (block('deliver')) block('deliver').rows.push(...after);
  else blocks.push({ stage: null, rows: after });

  return blocks.flatMap(({ stage, rows }) => {
    const head = rows.find((r) => r.type === 'stage');
    if (!head || o.unfolded.includes(stage)) return rows;
    const fold = new Set();
    for (const side of ['before', 'after']) {
      const passed = rows.filter(
        (r) => r.type === 'hook' && SIDE[r.where] === side && r.step.status === 'pass' && r.state !== 'active',
      );
      if (o.narrow || passed.length > 3) for (const r of passed) fold.add(r);
    }
    head.folded = rows.filter((r) => fold.has(r)).map((r) => r.step);
    return rows.filter((r) => !fold.has(r));
  });
}

/** Each loop as the row indexes its `from` and `to` steps show in: the step's own row, or for a folded hook the stage
 *  row holding it; a loop with an end not in the pipeline is left out. */
export function pipelineSpans(rows, run) {
  const at = (id) => rows.findIndex((r) => r.step.id === id || (r.type === 'stage' && r.folded.some((s) => s.id === id)));
  return loopSpans(run).flatMap((l) => {
    const from = at(l.from);
    const to = at(l.to);
    return from < 0 || to < 0 ? [] : [{ from, to, tone: l.tone }];
  });
}

/** Row indexes in a pipeline (-1 when none): the active row; the last row the spine is reached to (the active one, else
 *  the last that is not future); and the row holding `stopSel`, which rings as picked and the strip opens under (its
 *  own, or the stage row folding it). */
export function pipelineMarks(rows, stopSel) {
  const active = rows.findIndex((r) => r.state === 'active');
  const reached = active >= 0 ? active : rows.reduce((at, r, i) => (r.state === 'future' ? at : i), -1);
  const holds = (r) => r.step.id === stopSel || (r.type === 'stage' && r.folded.some((s) => s.id === stopSel));
  return { active, reached, stripAt: stopSel ? rows.findIndex(holds) : -1 };
}

/** The muted note beside a hook row: where it runs, the round when a loop went back to it (past round 1), its latest
 *  gate decision, how long it took (or has waited). */
export function hookNote(run, row, now) {
  const s = row.step;
  const waited = s.status === 'waiting' && s.startedAt ? `waiting ${ago(s.startedAt, now)}` : '';
  const decision = decisionNote(stepAttempts(run, s.id).at(-1)?.decision);
  const n = roundAt(run, s.id);
  return [row.where, n === null ? '' : `round ${n}`, decision, took(s, now) || waited].filter(Boolean).join(' · ');
}

/** The stages to show unfolded after the selected stop moves from `from` to `to` (null closes it): a picked stage row
 *  holding folded hooks opens; closing an open stage folds it again. */
export function unfoldAfterPick(run, o, from, to) {
  if (to === null) {
    const closed = (run.steps ?? []).find((s) => s.id === from && s.role === 'core')?.stage;
    return o.unfolded.filter((s) => s !== closed);
  }
  const row = pipelineRows(run, o).find((r) => r.step.id === to);
  return row?.type === 'stage' && row.folded.length > 0 ? [...o.unfolded, row.step.stage] : o.unfolded;
}

/** Whether a stop can be selected: one that has not started has nothing to show. */
export function canPick(step) {
  return step.status !== 'pending';
}

/** The started step one pipeline row up (-1) or down (1) from the selected stop, else from the current (or last)
 *  step, over the rows the pipeline shows (`narrow`: it folds every passed hook) with `unfolded` stages open (other
 *  folded hooks are skipped); null if none. */
export function moveStop(run, selected, dir, unfolded = [], narrow = false) {
  const order = pipelineRows(run, { narrow, unfolded }).flatMap((r) => (canPick(r.step) ? [r.step.id] : []));
  if (order.length === 0) return null;
  let at = order.indexOf(selected);
  if (at < 0) at = order.indexOf(run.currentStep);
  if (at < 0) at = order.length - 1;
  return order[Math.max(0, Math.min(order.length - 1, at + dir))];
}

/** The run id one row up (-1) or down (1) from `selId` in `rows`; the first row if `selId` is not there. */
export function moveRow(rows, selId, dir) {
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.id === selId);
  if (at < 0) return rows[0].id;
  return rows[Math.max(0, Math.min(rows.length - 1, at + dir))].id;
}

/** The run's attempts in order (with gate decisions and loop caps): its `timeline`; an older perc sends none, so one
 *  attempt per step that ran, from the step's own data. [] for an unreadable run. */
export function timelineOf(run) {
  if (Array.isArray(run.timeline)) return run.timeline;
  return (run.steps ?? [])
    .filter((s) => s.status !== 'pending')
    .map((s) => ({
      kind: 'attempt',
      step: s.id,
      // an older perc's `attempts` counts finished records, so a live step is on the next one
      attempt: s.status === 'running' || s.status === 'waiting' ? (s.attempts ?? 0) + 1 : s.attempts,
      status: s.status,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      outputs: s.outputs ?? {},
    }));
}

/** One step's attempts, in order. */
export function stepAttempts(run, stepId) {
  return timelineOf(run).filter((e) => e.kind === 'attempt' && e.step === stepId);
}

/** The round of a step the strip shows: `roundSel` (an attempt number), else the last attempt, with its place among
 *  the rounds and its neighbours' numbers. `mark` is set on the last round only. Null when the step has not run. */
export function roundView(run, stepId, roundSel) {
  const all = stepAttempts(run, stepId);
  if (all.length === 0) return null;
  const found = all.findIndex((a) => a.attempt === roundSel);
  const i = found < 0 ? all.length - 1 : found;
  const attempt = all[i];
  const last = i === all.length - 1;
  return {
    attempt,
    n: i + 1,
    of: all.length,
    mark: last ? (attempt.status === 'running' || attempt.status === 'waiting' ? attempt.status : 'latest') : null,
    prev: i > 0 ? all[i - 1].attempt : null,
    next: last ? null : all[i + 1].attempt,
  };
}

const ROW_MARKS = { running: '●', pass: '✓', waiting: '■' };

/** The local HH:MM of an ISO date, zero-padded; "" without one. */
export function clock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const decisionNote = (d) => {
  if (!d) return '';
  const word = d.decision === 'approve' ? 'approved' : 'rejected';
  return d.by ? `${word} by @${d.by}` : word;
};

/** The run history, newest first: one row per attempt (with its round, start, duration and gate decision) and one per
 *  loop cap that was hit. */
export function timelineRows(run, now) {
  return timelineOf(run)
    .map((e) =>
      e.kind === 'cap'
        ? {
            key: `cap:${e.loop}`,
            mark: '↺',
            tone: 'blocked',
            step: e.from,
            round: '',
            status: 'cap',
            started: clock(e.at),
            took: '',
            note: `${e.from} → ${e.to} hit its cap of ${e.max} rounds`,
          }
        : {
            key: `${e.step}#${e.attempt}`,
            mark: ROW_MARKS[e.status] ?? '✕',
            tone: stepTone(e.status),
            step: e.step,
            round: `round ${e.attempt}`,
            status: e.status,
            started: clock(e.startedAt),
            took: took(e, now),
            note: decisionNote(e.decision),
          },
    )
    .reverse();
}

// ── the board's height (a ratio of the area under the title bar, so it follows the panel's size and zoom) ──

export const BOARD_RATIO = 0.3;
const BOARD_MAX = 0.7;

const clampBoard = (px, area, min) => Math.min(Math.max(px, min), Math.max(min, area * BOARD_MAX));

/** The board's height in whole pixels for a ratio of `area`: at least `min` (two rows), at most 70% of the area. */
export function boardHeight(ratio, area, min) {
  return Math.round(clampBoard(ratio * area, area, min));
}

/** The ratio a divider drag leaves: the board's height at the press plus how far the pointer moved, clamped. */
export function dragBoard(startPx, dy, area, min) {
  const a = Math.max(area, 1); // not measured yet
  return clampBoard(startPx + dy, a, min) / a;
}

/** A ratio read back from shared state or storage (a number or its string): in (0, 1), else the default. */
export function readRatio(stored) {
  const n = Number(stored);
  return stored != null && n > 0 && n < 1 ? n : BOARD_RATIO;
}

/** How the title bar fits `width` design px with `needs` runs needing you: ⧉ and ✕ always stay; the "N need you" chip
 *  shortens to "N" first, then the Active/All tabs move to a row of their own. */
export function titleLayout(width, needs) {
  if (needs === 0) return { tabs: width >= 300 ? 'inline' : 'below', chip: 'long' };
  if (width >= 370) return { tabs: 'inline', chip: 'long' };
  if (width >= 320) return { tabs: 'inline', chip: 'short' };
  return { tabs: 'below', chip: width >= 270 ? 'long' : 'short' };
}

// ── the cup (mods/percolator-cup carries a copy of this file) ──

/** The cup's label and its theme tone: who needs you, else what runs, else the name. */
export function cupLabel(runs) {
  const n = needsCount(runs);
  if (n > 0) return { text: `${n} need${n === 1 ? 's' : ''} you`, tone: 'blocked' };
  const running = runningCount(runs);
  if (running > 0) return { text: `${running} running`, tone: 'working' };
  return { text: 'Percolator', tone: 'muted' };
}

/** The notification for a run that newly needs you; clicking it opens the run through the cup. */
export function notice(run) {
  return {
    title: `#${run.ticket?.number ?? '?'} needs you`,
    body: run.attention?.message ?? '',
    level: 'warning',
    action: { name: `percolator-cup.open/${run.id}` },
  };
}

/** A layout node by id (depth first), or null. */
export function findNode(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** What the cup does to the panel. `open`: which places show it now; `why`: 'click' toggles, 'open' (a notice)
 *  only shows. Nothing open → show it where it was last (`place`, shared `percolator.place`; docked by default). */
export function cupMoves(place, open, why) {
  if (open.panel || open.window) {
    if (why !== 'click') return [];
    return [...(open.panel ? ['hide-panel'] : []), ...(open.window ? ['close-window'] : [])];
  }
  return [place === 'window' ? 'open-window' : 'show-panel'];
}

/** Whether this panel copy acts on `percolator.*` commands: only the one where the panel lives (shared
 *  `percolator.place`; docked by default), so a docked copy and a window both shown never run perc twice. */
export function ownsCommands(place, inWindow) {
  return place === 'window' ? inWindow : !inWindow;
}

/** The copy that should poll and draw fresh data: the one where the panel lives (ownsCommands), while it is shown
 *  (a window is shown while open; a docked copy while its layout block is not hidden). */
export function showsHere(place, inWindow, blockShown) {
  return ownsCommands(place, inWindow) && (inWindow || blockShown);
}

/** perc names terminals (`hc` names); Herdr's terminals() lists `{ address, name }`. The live terminal's address for a
 *  name or an address, or null when none is live. */
export function terminalAddress(live, term) {
  if (!term) return null;
  return live.find((x) => x.address === term || x.name === term)?.address ?? null;
}

const BOXES = ['gate', 'cap', 'paused', 'failed', 'stalled'];

/** What shows under the run's active stop: the attention box for its kind, the agent card while an agent works, else
 *  nothing. */
export function activeBox(run) {
  if (!run || run.status === 'unreadable') return null;
  const kind = run.attention?.kind;
  if (BOXES.includes(kind)) return kind;
  if (kind === 'agent') return 'agent';
  return run.status === 'running' && run.terminals?.[run.currentStep] ? 'agent' : null;
}

/** The current step's agent terminal: the one perc lists for the step, else the one its attention names. */
const agentTerminal = (run) => run?.terminals?.[run.currentStep] ?? run?.attention?.terminal;

/** The agent terminal of the run's current step, linked to the live terminal and agent Herdr shows; null when the
 *  step has no terminal. */
export function agentCard(run, live, agents, now) {
  const name = agentTerminal(run);
  if (!name) return null;
  const address = agentAddress(run, live);
  const agent = agents.find((a) => a.address === address);
  const step = (run.steps ?? []).find((s) => s.id === run.currentStep);
  return {
    address,
    name,
    status: agent?.status ?? (address ? 'open' : 'not open'),
    program: agent?.program?.name ?? 'Agent',
    since: step ? took(step, now) : '',
  };
}

/** The colour of the agent status Herdr reports: blocked and working have their own, anything else is muted. */
export function agentTone(status) {
  return status === 'blocked' || status === 'working' ? status : 'muted';
}

/** The live address of the current step's agent terminal (Open terminal ↗ focuses it), or null: then it is off. */
export function agentAddress(run, live) {
  if (!run || run.status === 'unreadable') return null;
  return terminalAddress(live, agentTerminal(run));
}

/** What opening the run's agent does: focus its live terminal (`address`); in fixtures mode only say so (`said`); an
 *  `error` when the terminal is not live; null when the step has no agent terminal. */
export function openAgentAt(run, live, fixtures) {
  if (!run || run.status === 'unreadable') return null;
  const name = agentTerminal(run);
  if (!name) return null;
  if (fixtures) return { said: `fixtures: would open ${name}` };
  const address = terminalAddress(live, name);
  return address ? { address } : { error: `${name} is not a live terminal; refresh the panel` };
}

/** The attention's buttons; open-pane is left to Open terminal ↗. */
export function boxActions(run) {
  return (run.attention?.actions ?? []).filter((a) => a !== 'open-pane');
}

/** What the inline readers show (as perc gave it): `box`, under an attention box, its first file to review; `strip`, under
 *  the picked stop, the output picked there, else its (picked, else latest) round's first output, unless the box already
 *  reads that file (it shows once). */
export function readerFiles(run, stopSel, roundSel, outPick) {
  const box = boxAsks(run) ? (run.attention?.review?.[0]?.path ?? null) : null;
  if (!stopSel) return { box, strip: null };
  const view = roundView(run, stopSel, roundSel);
  const strip = outPick ?? (view ? Object.values(view.attempt.outputs ?? {})[0] : undefined) ?? null;
  return { box, strip: strip === box ? null : strip };
}

/** The inline reader's greatest height: half the panel's `area`. */
export function readerMax(area) {
  return Math.round(area * 0.5);
}

/** Read full ↗ pops the panel out into its window, so the window itself does not offer it. */
export function readFullShown(inWindow) {
  return !inWindow;
}

/** Whether the run's active box has no active row to sit under (its current step is not in the pipeline): then it shows
 *  under the pipeline. */
export function boxOutside(run, o) {
  if (activeBox(run) === null) return false;
  return pipelineMarks(pipelineRows(run, o), null).active < 0;
}

/** One column, or two from 720px wide (the window, a wide panel): the board and pipeline on the left, the run on the
 *  right. */
export function columns(width) {
  return width >= 720 ? 'two' : 'one';
}

/** The panel's layout from its measured width (zoomed px) and the zoom, all in design px: `narrow` under 720,
 *  `cols`, and `fold`, under 320, where the pipeline folds every passed hook (the 330px left column of two does
 *  not). */
export function panelShape(width, zoom) {
  const w = Math.round(width / zoom); // the width comes zoomed, in floats: 720 at 0.8 reads 575.99
  return { narrow: w < 720, cols: columns(w), fold: w < 320 };
}

/** Where the detail's pieces show. `under`: the active slot and the stop strip sit under their rows in the pipeline (one
 *  column). `side`, in order: what shows under the pipeline in one column (the box when it has no active row, how the
 *  run ended), or in the right column of two (the box, how the run ended, then the picked stop's strip). */
export function detailParts(run, o) {
  const outcome = showsOutcome(run) ? ['outcome'] : [];
  if (o.cols === 'one') return { under: true, side: [...(boxOutside(run, o) ? ['box'] : []), ...outcome] };
  const box = activeBox(run) === null ? [] : ['box'];
  const picked = o.stopSel !== null && (run.steps ?? []).some((s) => s.id === o.stopSel);
  return { under: false, side: [...box, ...outcome, ...(picked ? ['strip'] : [])] };
}

/** Whether the active stop (its stage stop or hook node) opens the agent: one works there in a live terminal. */
export function slotOpensAgent(run, live) {
  return activeBox(run) === 'agent' && agentAddress(run, live) !== null;
}

/** Whether the active box asks you something (gate, cap, paused, failed, stalled): it carries the action errors. */
export function boxAsks(run) {
  return BOXES.includes(activeBox(run));
}

/** Whether the lower half says how the run stands (delivered, unreadable, its status): nothing is under its stop and
 *  it is not running. */
export function showsOutcome(run) {
  return activeBox(run) === null && run.status !== 'running';
}

/** The letter on the agent card's badge. */
export function programInitial(program) {
  return program.trim().slice(0, 1).toUpperCase() || '?';
}

/** The line under an agent stop with no agent terminal yet, else null (the card shows). */
export function agentNote(card) {
  return card ? null : 'agent not started';
}

/** The driver peek a failed or stalled box offers (its last screen often says why), else null. */
export function boxDriver(run) {
  const kind = activeBox(run);
  return kind === 'failed' || kind === 'stalled' ? driverPeek(run) : null;
}

/** The History fold's label: its arrow and how many attempts the history holds (loop-cap rows are not attempts). */
export function historyLabel(run, open) {
  const n = timelineOf(run).filter((e) => e.kind === 'attempt').length;
  const head = `History ${open ? '▾' : '▸'}`;
  return n === 0 ? head : `${head} ${n} attempt${n === 1 ? '' : 's'}`;
}

/** The run's live driver terminal, to peek at (closing a peek leaves it running; closing a pane would end it), or
 *  null when there is none (a finished run, a driver not among the live terminals). */
export function driverPeek(run) {
  if (!run || run.status === 'unreadable') return null;
  const { terminal } = run.driver;
  if (typeof terminal !== 'string' || run.terminals?.driver !== terminal) return null;
  return { terminal, label: 'Driver pane ↗' };
}

/** The run's title: the issue's, else its ref (no issue.json yet: before intake, or a run that failed in it). */
export function ticketTitle(run) {
  return run.ticket?.title ?? run.ticket?.ref ?? run.id;
}

// ── delete ──

/** The `perc delete` argv for exactly these runs: the ones the owner confirmed, never a set worked out again later. */
export function deleteArgv(ids) {
  return ['delete', ...ids, '--yes'];
}

/** The `percolator.*` command a delete confirm sends: it carries the ids the dialog listed. */
export function deleteCommand(ids) {
  return `delete/${ids.join(',')}`;
}

/** The ids in a `delete/<id>,<id>` command; null for any other command. */
export function deleteCommandIds(command) {
  if (!command.startsWith('delete/')) return null;
  const ids = command.slice(7).split(',').filter((id) => id !== '');
  return ids.length > 0 ? ids : null;
}

/** What `perc delete --finished` removes: completed and failed runs. */
export function isFinished(run) {
  return run.status === 'completed' || run.status === 'failed';
}

const ACTIVE = new Set(['running', 'waiting', 'paused']);

/** The confirm dialog for deleting one run. */
export function deleteConfirm(run) {
  if (run.status === 'unreadable') {
    return { title: `Delete ${run.id}?`, detail: `Deletes run ${run.id}: its terminals, its worktree if its record still names one (uncommitted changes there are lost), and its record. The branch percolator/${run.id} is kept.` };
  }
  const stopped = ACTIVE.has(run.status) ? ' The run is stopped first.' : '';
  return {
    title: `Delete #${run.ticket.number}?`,
    detail: `Deletes run ${run.id} (${run.ticket.ref}): its terminals, worktree and record. Uncommitted changes in the worktree are lost. The branch ${run.branch} is kept.${stopped}`,
  };
}

/** The confirm dialog for deleting every finished run, or null when none is finished. */
export function deleteFinishedConfirm(runs) {
  const done = runs.filter(isFinished);
  if (done.length === 0) return null;
  return {
    title: `Delete ${done.length} finished run(s)?`,
    detail: `Deletes ${done.map((r) => `${r.id} (#${r.ticket.number})`).join(', ')}: their terminals, worktrees and records. Uncommitted changes are lost; their branches are kept.`,
    ids: done.map((r) => r.id),
  };
}

/**
 * The notice beside Delete finished runs ↗: "No finished runs" when it was just pressed (`asked`) with none;
 * on a refresh, kept until a finished run is listed.
 */
export function finishedNotice(notice, runs, asked) {
  const none = !runs.some(isFinished);
  if (asked) return none ? 'No finished runs' : null;
  return notice === 'No finished runs' && !none ? null : notice;
}

/** The action error when a confirmed delete arrives while `busy` (another action) runs; null when free. */
export function deleteBusyError(busy) {
  return busy ? 'Another action is running; try Delete again' : null;
}

/** The selection after `deletedIds` are gone: `selId` if it stays, else the next row left, else the previous, else null. */
export function selectAfterDelete(rows, deletedIds, selId) {
  const gone = new Set(deletedIds);
  if (!gone.has(selId)) return selId;
  const at = rows.findIndex((r) => r.id === selId);
  const after = rows.slice(at + 1).find((r) => !gone.has(r.id));
  if (after) return after.id;
  return rows.slice(0, Math.max(at, 0)).findLast((r) => !gone.has(r.id))?.id ?? null;
}

/**
 * The selection once fresh runs arrive: `selId` while it is still listed; else `pending.next`, the row worked out
 * when the owner confirmed a delete (later rows no longer hold the deleted ones), if listed; else the first row.
 */
export function selectAfterRefresh(runs, rows, selId, pending) {
  if (runs.some((r) => r.id === selId)) return selId;
  if (pending && rows.some((r) => r.id === pending.next)) return pending.next;
  return rows[0]?.id ?? null;
}

// ── starting a run (`perc pipelines --json`, schema 1) ──

const INVALID_PIPELINES = 'perc pipelines --json returned invalid JSON';

/** `perc pipelines --json` stdout → `{ ok: true, data }`, or `{ ok: false, error }` when it is not one this panel knows. */
export function readPipelines(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: INVALID_PIPELINES };
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.pipelines)) return { ok: false, error: INVALID_PIPELINES };
  if (data.schema !== 1) return { ok: false, error: `perc pipelines --json returned schema ${data.schema}; update the Percolator panel` };
  return { ok: true, data };
}

/** In fixtures mode, the pipelines come from pipelines.json beside the status fixture. */
export function pipelinesFixture(statusFixture) {
  return `${statusFixture.replace(/[\\/][^\\/]*$/, '')}/pipelines.json`;
}

/** What the start dialog asks for a pipeline: its ticket field (hidden when it takes none) and its inputs. */
export function startFields(pipeline) {
  return {
    ticket: pipeline.ticket === 'none' ? 'hidden' : pipeline.ticket,
    inputs: pipeline.inputs.map((i) => ({ name: i.name, required: i.required, description: i.description ?? '' })),
  };
}

const newestFirst = (runs) =>
  runs.filter((r) => r.status !== 'unreadable' && typeof r.repo === 'string').sort((a, b) => created(b) - created(a));

/** The repos earlier runs ran in, each once, most recent first. */
export function knownRepos(runs) {
  return [...new Set(newestFirst(runs).map((r) => r.repo))];
}

const TICKET_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s#]+)\/(?:issues|pull)\/\d+\/?$/i;
const TICKET_REF = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#\d+$/;

/** The lower-cased `host/owner/repo` of a ticket URL, `owner/repo#n` (github.com) or `host/owner/repo#n`; else null. */
export function ticketRepo(text) {
  const t = String(text ?? '').trim();
  const m = TICKET_URL.exec(t) ?? TICKET_REF.exec(t);
  if (!m) return null;
  return `${m[1] ?? 'github.com'}/${m[2]}/${m[3]}`.toLowerCase();
}

/** The repo of the most recent run on the ticket's GitHub repo, to preselect; null when none ran there. */
export function guessRepo(ticketText, runs) {
  const repo = ticketRepo(ticketText);
  if (repo === null) return null;
  return newestFirst(runs).find((r) => r.ticket?.ref?.toLowerCase().startsWith(`${repo}#`))?.repo ?? null;
}

const blank = (v) => typeof v !== 'string' || v.trim() === '';

/** The `perc run` argv for the dialog's choices: inputs in the pipeline's declared order, empty optional ones left out. */
export function startArgv(o) {
  const ticket = blank(o.ticket) ? null : o.ticket.trim();
  const inputs = o.pipeline.inputs.flatMap((i) => {
    const v = o.inputs[i.name] ?? '';
    return !i.required && blank(v) ? [] : [['--input', `${i.name}=${v}`]];
  });
  return ['run', ...(ticket ? [ticket] : []), '--repo', o.repo, '--pipeline', o.pipeline.name, ...inputs.flat()];
}

/** The argv as one `perc …` line to show: an argument holding whitespace or `"` is double-quoted, its `"` escaped. */
export function commandLine(argv) {
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return ['perc', ...argv.map(quote)].join(' ');
}

/** Whether Start can run, else why not: the repo, then the ticket, then the first empty required input. */
export function canStart(o) {
  if (blank(o.repo)) return { ok: false, why: 'Pick a repo' };
  if (o.pipeline.ticket === 'required' && blank(o.ticket)) return { ok: false, why: 'Enter a ticket' };
  const missing = o.pipeline.inputs.find((i) => i.required && blank(o.inputs[i.name]));
  return missing ? { ok: false, why: `Enter ${missing.name}` } : { ok: true };
}
