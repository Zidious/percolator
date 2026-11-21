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
