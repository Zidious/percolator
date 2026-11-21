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
    return { tone: 'working', text: loop ? `${step} · round ${loop.round}/${loop.max}` : `${step}` };
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

/** A loop has used all its rounds. */
export function loopAtCap(loop) {
  return loop.round >= loop.max;
}

/** "↺ review → implement · round 2 of 3", "· cap" at the cap; narrow leaves out where. */
export function loopLabel(loop, narrow) {
  const where = narrow ? '' : `${loop.from} → ${loop.to} · `;
  return `↺ ${where}round ${loop.round} of ${loop.max}${loopAtCap(loop) ? ' · cap' : ''}`;
}

/** The step one stop left (-1) or right (1) of the selected stop, else of the current (or last) step; null if none. */
export function moveStop(run, selected, dir) {
  const order = trainLayout(run, false).flatMap((z) => z.shown.map((s) => s.id));
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

/** What the reader shows: the selected stop's first output, else the first file to review, else null (as perc gave it). */
export function readerPath(run, stopSel) {
  const step = stopSel ? (run.steps ?? []).find((s) => s.id === stopSel) : undefined;
  const out = step ? Object.values(step.outputs ?? {})[0] : undefined;
  return out ?? run.attention?.review?.[0]?.path ?? null;
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
