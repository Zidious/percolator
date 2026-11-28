// What `perc status --json` (schema 2) and `perc pipelines --json` (schema 1) mean for the cup and the panel alike:
// reading them, who needs you, the cup's label and notices, and where the panel lives. The cup carries a copy of this
// file (tests/herdr/cup.test.ts keeps them equal); model.js re-exports it. No `herdr` imports; status.d.ts declares it.

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

/** Runs in `next` that need you and did not in `prev` (or were not there); none on the first load (`prev` null). */
export function newlyNeeding(prev, next) {
  if (prev === null) return [];
  const had = new Set(prev.filter(needsYou).map((r) => r.id));
  return next.filter((r) => needsYou(r) && !had.has(r.id));
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
  if (parsed.ok && parsed.data.schema !== 2) {
    return { ok: false, error: `perc status --json returned schema ${parsed.data.schema}; update the Percolator panel` };
  }
  return parsed;
}

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** `p` as is when absolute, else joined to the folder `base`. */
export function resolvePath(base, p) {
  return ABSOLUTE.test(p) ? p : `${base.replace(/[\\/]+$/, '')}/${p}`;
}

/** How a run is named in a short line: `#<issue>`, else (ticketless) its pipeline. */
export function runLabel(run) {
  return run.ticket ? `#${run.ticket.number}` : (run.pipeline ?? '#?');
}

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
    title: `${runLabel(run)} needs you`,
    // a paused run's message only names the step: its detail says why
    body: run.attention?.kind === 'paused' && run.attention.detail ? `${run.attention.message}: ${run.attention.detail}` : (run.attention?.message ?? ''),
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

// ── `perc pipelines --json` (schema 1) ──

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
  if (!/[\\/]/.test(statusFixture)) return 'pipelines.json';
  return `${statusFixture.replace(/[\\/][^\\/]*$/, '')}/pipelines.json`;
}
