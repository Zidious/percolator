// The Percolator panel's pure logic: what `perc status --json` (schema 1) means for the board, the train and the
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

const needs = (r) => Boolean(r.attention);
const rank = (r) => (needs(r) ? 0 : r.status === 'running' ? 1 : r.status === 'unreadable' ? 3 : 2);
const created = (r) => (typeof r.createdAt === 'string' ? Date.parse(r.createdAt) || 0 : 0);

/** A sorted copy: needing you first, then running, then the rest (unreadable last); newest first within each. */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => rank(a) - rank(b) || created(b) - created(a));
}

/** "active": everything except completed and failed runs that need nothing; "all": everything. */
export function visibleRuns(runs, filter) {
  if (filter === 'all') return [...runs];
  return runs.filter((r) => needs(r) || (r.status !== 'completed' && r.status !== 'failed'));
}

/** The board row's state line and its tone. */
export function rowState(run) {
  const a = run.attention;
  const step = run.currentStep;
  if (a) {
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
      case 'agent':
        return blocked(`agent ${a.agentState ?? 'waiting'} · ${step}`);
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

/**
 * Six zones, one per core stage, each with its steps in execution order: `before-all` hooks first in intake, then
 * the graph order of the stage's steps (before:<stage> hooks, slot steps, after:<stage> hooks), `after-all` hooks
 * last in deliver. Narrow shows only core stops and folds the rest into `hidden` (a zone with no core step shows all).
 */
export function trainLayout(run, narrow) {
  const steps = run.steps ?? [];
  const of = (stage) => steps.filter((s) => s.stage === stage);
  return STAGES.map((stage, i) => {
    const all = [
      ...(i === 0 ? of('before-all') : []),
      ...of(stage),
      ...(i === STAGES.length - 1 ? of('after-all') : []),
    ];
    const core = all.filter((s) => s.role === 'core');
    if (!narrow || core.length === 0) return { stage, shown: all, hidden: [] };
    return { stage, shown: core, hidden: all.filter((s) => s.role !== 'core') };
  });
}

/** The centre of a step's stop as % (0–100) of the track; a hidden step sits on its zone's first shown stop. */
export function xOf(zones, stepId) {
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    let j = z.shown.findIndex((s) => s.id === stepId);
    if (j < 0 && z.hidden.some((s) => s.id === stepId)) j = 0;
    if (j >= 0) return ((i + (j + 0.5) / z.shown.length) / zones.length) * 100;
  }
  return null;
}

/** Runs in `next` that need you and did not in `prev` (or were not there); none on the first load (`prev` null). */
export function newlyNeeding(prev, next) {
  if (prev === null) return [];
  const had = new Set(prev.filter(needs).map((r) => r.id));
  return next.filter((r) => needs(r) && !had.has(r.id));
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
  return runs.filter(needs).length;
}

/** Running runs that need nothing from you. */
export function runningCount(runs) {
  return runs.filter((r) => r.status === 'running' && !needs(r)).length;
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

const CLI = {
  approve: (id) => `perc approve ${id}`,
  reject: (id) => `perc reject ${id} -- "<feedback>"`,
  grant: (id) => `perc resume ${id}`,
  resume: (id) => `perc resume ${id}`,
  clean: (id) => `perc clean ${id}`,
};

/** The terminal commands that do what the run's action buttons do, once each. */
export function cliLines(run) {
  const lines = (run.attention?.actions ?? []).flatMap((a) => (CLI[a] ? [CLI[a](run.id)] : []));
  return [...new Set(lines)];
}

/** Every terminal command for a run's attention: the actions' perc equivalents, then its own commands, once each. */
export function terminalCommands(run) {
  return [...new Set([...cliLines(run), ...(run.attention?.commands ?? [])])];
}

const TAGS = { gate: 'GATE', cap: 'PAUSED', paused: 'PAUSED', failed: 'FAILED', stalled: 'STALLED', agent: 'AGENT' };

/** The tag shown before an attention message. */
export function attentionTag(kind) {
  return TAGS[kind] ?? 'NEEDS YOU';
}

/** Loops that have gone round at least once (drawn as arcs). */
export function shownLoops(run) {
  return (run.loops ?? []).filter((l) => l.round > 0);
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

/** Every loop, taken or not, with its tone. */
export function loopSpans(run) {
  return (run.loops ?? []).map((l) => ({ id: l.id, from: l.from, to: l.to, tone: loopTone(roundOf(l)) }));
}

/** A loop has used all its rounds. */
export function loopAtCap(loop) {
  return loop.round >= loop.max;
}

/** "↺ review → implement · round 2 of 3", "· cap" at the cap; narrow leaves out where. */
export function loopLabel(loop, narrow) {
  const where = narrow ? '' : `${loop.from} → ${loop.to} · `;
  return `↺ ${where}round ${loop.round} of ${loop.max}${loopAtCap(loop) ? ' · cap' : ''}`;
}

/** Which end of a loop arc (spanning a% to b% of the track) its label hangs from, so a label wider than the arc grows
 *  toward the middle of the track rather than past its edge. */
export function loopLabelAlign(a, b) {
  return (a + b) / 2 > 50 ? 'end' : 'start';
}

/** Whether a stop can be selected: one that has not started has nothing to show. */
export function canPick(step) {
  return step.status !== 'pending';
}

/** The started step one stop left (-1) or right (1) of the selected stop, else of the current (or last) step; null if none. */
export function moveStop(run, selected, dir) {
  const order = trainLayout(run, false).flatMap((z) => z.shown.filter(canPick).map((s) => s.id));
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

/** What the banner says while a step runs, one line picked per run and step. */
export const COFFEE_LINES = [
  'Go make an espresso.',
  'Start another ticket!',
  'Instant coffee? Not on this watch.',
  'Time for a pour-over. No rush.',
  'Grind some beans; this has it.',
  'Perfect moment for a flat white.',
  "Stretch your legs. It'll keep.",
  'Brewing. Unlike instant, worth the wait.',
  'Go pull a shot.',
  "The kettle's on. So is the agent.",
];

/** 32-bit FNV-1a over UTF-16 code units. */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The coffee line for a run's step: fixed, so it does not change from one refresh to the next. */
export function coffeeLine(runId, stepId) {
  return COFFEE_LINES[fnv1a32(`${runId}/${stepId}`) % COFFEE_LINES.length];
}

/** "<step> is running[ for <spent>]. <coffee line>" for the running step. */
export function runningText(run, now) {
  const step = run.currentStep;
  const live = stepAttempts(run, step).at(-1);
  const st = live?.status === 'running' ? live : (run.steps ?? []).find((s) => s.id === step);
  const spent = st ? took(st, now) : '';
  return `${step} is running${spent ? ` for ${spent}` : ''}. ${coffeeLine(run.id, step)}`;
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

/** What the reader shows: the selected stop's (picked, else latest) round's first output, else the first file to
 *  review, else null (as perc gave it). */
export function readerPath(run, stopSel, roundSel = null) {
  const view = stopSel ? roundView(run, stopSel, roundSel) : null;
  const out = view ? Object.values(view.attempt.outputs ?? {})[0] : undefined;
  return out ?? run.attention?.review?.[0]?.path ?? null;
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

/** The reader's height: what the detail (`view` tall, holding `content`, of which the reader is `box`) has left over
 *  once everything else is laid out, at least `min` (then the detail scrolls). Whole pixels. */
export function fillHeight(view, content, box, min) {
  return Math.round(Math.max(min, view - (content - box)));
}

/** The reader's next height: `target` in whole pixels, unless it moved less than 2px (then `prev`), so measuring
 *  and rounding cannot swing it between two heights. */
export function nextBoxH(prev, target) {
  const next = Math.round(target);
  return Math.abs(next - prev) < 2 ? prev : next;
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
