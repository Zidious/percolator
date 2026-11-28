// The Percolator panel's pure logic: what `perc status --json` (schema 2) means for the board, the pipeline and the
// actions. No `herdr` imports, so node:test covers it (tests/herdr/model.test.ts); model.d.ts declares it. What the cup
// needs too lives in status.js, re-exported here so the panel imports it all from this file.

import { needsYou, runLabel } from './status.js';

export {
  parseStatus,
  needsYou,
  newlyNeeding,
  needsCount,
  runningCount,
  readStatus,
  resolvePath,
  runLabel,
  cupLabel,
  notice,
  findNode,
  cupMoves,
  readPipelines,
  pipelinesFixture,
} from './status.js';

export const STAGES = Object.freeze(['intake', 'groom', 'plan', 'implement', 'review', 'deliver']);

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

/** `text` with its first letter capitalised: the panel's labels are in sentence case. */
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Every attention kind that shows a box (agent shows the agent card instead): the tag before its message, its board
 * row's state line (`step`: the run's current step), whether it asks something the box answers in a form, and whether
 * its box offers the driver peek. A new kind is one entry here.
 */
export const ATTENTION = {
  gate: { tag: 'GATE', row: (step) => `Your turn · ${step}` },
  cap: { tag: 'PAUSED', row: (step) => `Paused · ${step} at cap` },
  paused: { tag: 'PAUSED', row: (step) => `Paused · ${step}` },
  questions: { tag: 'QUESTIONS', asks: true, row: (step, a) => `Your turn · ${a.asked?.step ?? step} has questions` },
  findings: { tag: 'FINDINGS', asks: true, row: (step, a) => `Your turn · ${a.asked?.step ?? step} findings at cap` },
  failed: { tag: 'FAILED', driver: true, row: (step) => `Failed · ${step}` },
  stalled: { tag: 'STALLED', driver: true, row: () => 'Stalled · driver stopped' },
};

/** The ATTENTION entry of `kind`, or undefined for agent, none, or a kind this panel does not know. */
const attentionOf = (kind) => (typeof kind === 'string' && Object.hasOwn(ATTENTION, kind) ? ATTENTION[kind] : undefined);

/** The board row's state line and its tone. */
export function rowState(run) {
  const a = run.attention;
  const step = run.currentStep;
  const known = attentionOf(a?.kind);
  if (known) return { tone: 'blocked', text: known.row(step, a) };
  if (run.status === 'running') {
    const loop = (run.loops ?? []).find((l) => l.from === step && l.round > 0);
    return loop ? { tone: 'working', text: `${step}`, round: `Round ${roundOf(loop).n}/${loop.max}` } : { tone: 'working', text: `${step}` };
  }
  if (run.status === 'completed') {
    const end = completedAs(run);
    if (end.kind === 'pr') return { tone: 'muted', text: `Delivered · PR #${end.pr.split('/').pop()}` };
    if (end.kind === 'routed') return { tone: 'muted', text: end.to ? `Routed → ${end.to}` : 'Routed' };
    return { tone: 'muted', text: sentence(end.kind) };
  }
  if (run.status === 'unreadable') return { tone: 'muted', text: `Unreadable · ${run.error}` };
  return { tone: 'muted', text: sentence(run.status) };
}

/** How a completed run ended: its PR, where a router sent it, the comment its exit posted, done (nothing delivered to a tracker), or delivered. */
function completedAs(run) {
  const pr = run.pr?.url;
  if (pr) return { kind: 'pr', pr };
  if ((run.steps ?? []).some((s) => s.stage === 'route')) return { kind: 'routed', to: (run.children ?? []).find((c) => !c.slice)?.pipeline };
  if (run.comment?.url) return { kind: 'commented', url: run.comment.url };
  // a ticketless run with no PR and no opened issues delivered nothing to a tracker (report, none)
  return { kind: run.ticket === null && (run.opened ?? []).length === 0 ? 'done' : 'delivered' };
}

/** The outcome box of a completed run: its tag and the line beside it, from the same ending as rowState. */
export function outcomeOf(run) {
  const end = completedAs(run);
  if (end.kind === 'pr') return { tag: 'DELIVERED', text: `Opened ${end.pr.replace(/^https:\/\/github\.com\//, '')}` };
  if (end.kind === 'routed') return { tag: 'ROUTED', text: end.to ? `→ ${end.to}` : '' };
  if (end.kind === 'done') return { tag: 'DONE', text: '' };
  if (end.kind === 'commented') return { tag: 'COMMENTED', text: run.ticket ? `#${run.ticket.number} ↗` : 'Comment ↗', url: end.url };
  return { tag: 'DELIVERED', text: 'Done.' };
}

/** The `perc` argv for an action, or null when it needs no perc call (open-pane). Feedback stays one element; `pick`
 *  takes the picked pipeline in its place. */
/**
 * What each action a box offers looks like and which key takes it (the key hints list them in this order); its perc
 * argv comes from actionArgv. A new action is one entry here, plus its argv.
 */
export const ACTIONS = {
  approve: { label: 'Approve', style: 'ok', key: 'a' },
  reject: { label: 'Reject…', style: 'no', key: 'r' },
  grant: { label: 'Grant a round & resume', style: 'ok', key: 'g' },
  resume: { label: 'Resume', style: 'ok', key: 'g' },
  answer: { label: 'Submit', style: 'ok' },
  clean: { label: 'Clean up', style: '' },
  'run-again': { label: 'Run again', style: 'ok' },
};

/** The action among `offered` that `key` takes, the first in ACTIONS order (grant before resume); undefined when none. */
export function actionForKey(key, offered) {
  return Object.keys(ACTIONS).find((a) => ACTIONS[a].key === key && offered.includes(a));
}

export function actionArgv(action, run, feedback) {
  switch (action) {
    case 'approve':
      return ['approve', run.id];
    case 'pick':
      if (typeof feedback !== 'string' || feedback.trim() === '') throw new Error('Pick a pipeline');
      return ['approve', run.id, '--pipeline', feedback.trim()];
    case 'reject':
      if (typeof feedback !== 'string' || feedback.trim() === '') throw new Error('Say what to change');
      return ['reject', run.id, '--', feedback];
    case 'grant':
    case 'resume':
      return ['resume', run.id];
    case 'clean':
      return ['clean', run.id];
    case 'run-again':
      // an unreadable run has no pipeline or repo to start again
      return run.status === 'unreadable' ? null : runAgainArgv(run);
    default:
      return null;
  }
}

/** The `perc run` argv that starts a failed run's kind of run again, in the order of perc's own line: its ticket,
 *  its pipeline (named even when feature, as a profile may mark another pipeline default), each input as one `k=v`
 *  element, its repo, then its config file (unless the default) and its profile. */
export function runAgainArgv(run) {
  return [
    'run',
    ...(run.ticket ? [run.ticket.ref] : []),
    ...(run.pipeline ? ['--pipeline', run.pipeline] : []),
    ...Object.entries(run.inputs ?? {}).flatMap(([k, v]) => ['--input', `${k}=${v}`]),
    '--repo',
    run.repo,
    ...(typeof run.config === 'string' ? ['--config', run.config] : []),
    ...(typeof run.profile === 'string' ? ['--profile', run.profile] : []),
  ];
}

/** An asked item's label: its first non-empty line without a leading heading or list marker, `**`, `__` or backticks;
 *  `Finding <n>` or `Question <n>` when that leaves nothing. */
export function itemLabel(text, n, kind) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  const label = (line ?? '')
    .replace(/^\s*#+\s*/, '')
    .replace(/^ {0,3}\d{1,9}[.)](?:[ \t]+|$)/, '')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(^|[\s(])__(?=\S)(.+?)(?<=\S)__(?=$|[\s,;:!?)]|\.(?:$|\s))/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
  return label !== '' ? label : `${kind === 'findings' ? 'Finding' : 'Question'} ${n}`;
}

/** What a run paused on questions or findings asks, its items numbered from 1 as `perc answer` takes them; `key` changes
 *  with every new ask, so a form's state is not carried over. Null when it asks nothing. */
export function askOf(run) {
  const a = run?.attention;
  if (!a || !attentionOf(a.kind)?.asks || !a.asked) return null;
  const { step, attempt, items } = a.asked;
  return {
    kind: a.kind,
    step,
    attempt,
    key: `${run.id}/${step}/${attempt}`,
    items: items.map((text, i) => ({ n: i + 1, label: itemLabel(text, i + 1, a.kind), text })),
  };
}

/** The `perc answer` argv for a form's values: per question its text or null (N/A); per finding whether it is ticked. */
export function answerArgv(run, values) {
  if (run.attention?.kind === 'findings') {
    const ticked = values.flatMap((v, i) => (v ? [i + 1] : []));
    return ['answer', run.id, ...(ticked.length > 0 ? ['--agree', ticked.join(',')] : [])];
  }
  const argv = ['answer', run.id];
  values.forEach((v, i) => {
    if (v === null) argv.push('--na', String(i + 1));
    else if (typeof v !== 'string' || v.trim() === '') throw new Error(`Answer question ${i + 1} or mark it N/A`);
    else argv.push('--answer', `${i + 1}=${v}`);
  });
  return argv;
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

/** The tag shown before an attention message. */
export function attentionTag(kind) {
  return attentionOf(kind)?.tag ?? 'NEEDS YOU';
}

/** The round the engine is in: `round` counts back-edges already taken, the engine's round is one more, up to the cap. */
export function roundOf(loop) {
  return { n: Math.min(1 + loop.round, loop.max), max: loop.max, taken: loop.round > 0, atCap: loop.round >= loop.max };
}

/** A finished run's loops and caps are history: muted, never an alarm. */
function loopTone(r, run) {
  if (isFinished(run)) return 'dim';
  return r.atCap ? 'blocked' : r.taken ? 'working' : 'dim';
}

/** The pill on the step a loop starts from; null when no loop starts there, or that step has not run and is not current. */
export function roundPill(run, stepId) {
  const loop = (run.loops ?? []).find((l) => l.from === stepId);
  if (!loop) return null;
  const step = (run.steps ?? []).find((s) => s.id === stepId);
  if (step?.status === 'pending' && run.currentStep !== stepId) return null;
  const r = roundOf(loop);
  return { text: `Round ${r.n}/${r.max}${r.atCap ? ' · cap' : ''}`, tone: loopTone(r, run) };
}

/** The engine's round of a loop that goes back to `stepId`, past round 1; null otherwise. */
function roundAt(run, stepId) {
  const loop = (run.loops ?? []).find((l) => l.to === stepId && roundOf(l).n > 1);
  return loop ? roundOf(loop).n : null;
}

/** Beside the step a loop goes back to, past round 1: "Round N · <time>" (its latest attempt's), else "". */
export function roundNote(run, stepId, now) {
  const n = roundAt(run, stepId);
  if (n === null) return '';
  const last = stepAttempts(run, stepId).at(-1);
  const time = last ? took(last, now) : '';
  return time ? `Round ${n} · ${time}` : `Round ${n}`;
}

/** Every loop, taken or not, with its tone. */
export function loopSpans(run) {
  return (run.loops ?? []).map((l) => ({ id: l.id, from: l.from, to: l.to, tone: loopTone(roundOf(l), run) }));
}

const ALL = new Set(['before-all', 'after-all']);
const SIDE = { 'before-all': 'before', before: 'before', after: 'after', 'after-all': 'after' };

const FAILED = new Set(['fail', 'escalate', 'contract_error']);

/**
 * A loop start that sent the run back and is under its cap: its failure is the loop going on, not the run failing.
 * So is a step routed into its stage's `continue` loop (a gate after the stage's work), as `perc status` reads it.
 */
const sentBack = (run, step) => {
  const stageOf = (id) => (run.steps ?? []).find((s) => s.id === id)?.stage;
  return (run.loops ?? []).some(
    (l) =>
      (l.from === step.id || (l.atCap === 'continue' && step.stage !== undefined && stageOf(l.from) === step.stage)) &&
      roundOf(l).taken &&
      !roundOf(l).atCap,
  );
};

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
  // before and after are words, so they lead in sentence case; before-all and after-all are the stages' names
  const where = SIDE[row.where] === row.where ? sentence(row.where) : row.where;
  return [where, n === null ? '' : `round ${n}`, decision, took(s, now) || waited].filter(Boolean).join(' · ');
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
            tone: isFinished(run) ? 'dim' : 'blocked',
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
            round: `Round ${e.attempt}`,
            status: e.status,
            started: clock(e.startedAt),
            took: took(e, now),
            note: sentence(decisionNote(e.decision)),
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

/** How the title bar fits `width` design px: ⧉ and ✕ always stay; + New run is an icon under 800px; only under
 *  270px does the "N need you" chip shorten to "N". The Active/All tabs always have a row of their own. */
export function titleLayout(width) {
  return { chip: width < 270 ? 'short' : 'long', newRun: width >= 800 ? 'text' : 'icon' };
}

/** The markdown the inline reader shows for the file at `path`. A router's pick.md starts with `pipeline:` and
 *  `unsure:` lines that markdown would run into one paragraph: each becomes a paragraph of its own. */
export function readerText(path, text) {
  if (path.split(/[\\/]/).pop() !== 'pick.md') return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields = [];
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^(pipeline|unsure):/.test(lines[i])) fields.push(lines[i]);
    else if (lines[i].trim() !== '') break;
  }
  const rest = lines.slice(i).join('\n');
  return rest === '' ? fields.join('\n\n') + (text.endsWith('\n') ? '\n' : '') : [...fields, rest].join('\n\n');
}

/** A paused run's detail split around its transcript path (`attention.transcript`), so the view can draw the path as
 *  a link; null when there is no transcript or the detail does not name it. */
export function reasonParts(detail, transcript) {
  const at = transcript ? (detail ?? '').indexOf(transcript) : -1;
  if (at < 0) return null;
  return { before: detail.slice(0, at), after: detail.slice(at + transcript.length) };
}

/** A file:// URL for an absolute path (Windows or POSIX) that the system opens. */
export function fileUrl(path) {
  return `file:///${encodeURI(path.replace(/\\/g, '/').replace(/^\//, '')).replace(/[#?]/g, encodeURIComponent)}`;
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

/** One check of whether this copy is shown: refresh when it has just become shown (`now` after a check that saw it
 *  hidden, or the first check), and remember `now` for the next check. */
export function catchUpStep(wasShown, now) {
  return { refresh: now && !wasShown, wasShown: now };
}

/** perc names terminals (`hc` names); Herdr's terminals() lists `{ address, name }`. The live terminal's address for a
 *  name or an address, or null when none is live. */
export function terminalAddress(live, term) {
  if (!term) return null;
  return live.find((x) => x.address === term || x.name === term)?.address ?? null;
}

/** What shows under the run's active stop: the attention box for its kind, the agent card while an agent works, else
 *  nothing. */
export function activeBox(run) {
  if (!run || run.status === 'unreadable') return null;
  const kind = run.attention?.kind;
  if (attentionOf(kind)) return kind;
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

/** The theme colour for text in a model tone: dim (and no tone) read as muted, so text keeps its contrast; dim stays
 *  for disabled controls, decorative glyphs and lines. */
export function textTone(tone) {
  return !tone || tone === 'dim' ? 'muted' : tone;
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
  if (fixtures) return { said: `Fixtures: would open ${name}` };
  const address = terminalAddress(live, name);
  return address ? { address } : { error: `${name} is not a live terminal; refresh the panel` };
}

/** The attention's buttons; open-pane is left to Open terminal ↗. */
export function boxActions(run) {
  return (run.attention?.actions ?? []).filter((a) => a !== 'open-pane');
}

/** The files an attention box that asks something offers to read, in perc's order, each labelled by its step (by step
 *  and key when two share a step); none when the box asks nothing. */
export function boxFiles(run) {
  if (!boxAsks(run)) return [];
  const review = run.attention?.review ?? [];
  const steps = new Set(review.map((f) => f.step));
  const distinct = steps.size === review.length;
  return review.map((f) => ({ path: f.path, label: distinct ? f.step : `${f.step} · ${f.key}` }));
}

/** What the inline readers show (as perc gave it): `box`, under an attention box, its picked file to review, else the
 *  first; `strip`, under the picked stop, the output picked there, else its (picked, else latest) round's first output,
 *  unless the box already reads that file (it shows once). */
export function readerFiles(run, stopSel, roundSel, outPick, boxPick = null) {
  const files = boxFiles(run);
  const box = files.find((f) => f.path === boxPick)?.path ?? files[0]?.path ?? null;
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
  return attentionOf(activeBox(run)) !== undefined;
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
  return card ? null : 'Agent not started';
}

/** The driver peek a failed or stalled box offers (its last screen often says why), else null. */
export function boxDriver(run) {
  return attentionOf(activeBox(run))?.driver ? driverPeek(run) : null;
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

const TITLE_INPUT_MAX = 40;

/**
 * The run's title: the issue's, else its ref (no issue.json yet: before intake, or a run that failed in it); a
 * ticketless run's is `<pipeline> · <its first input value, cut to 40>`, or its pipeline when it has no inputs.
 */
export function ticketTitle(run) {
  if (run.ticket === null && typeof run.pipeline === 'string') {
    const first = Object.values(run.inputs ?? {})[0];
    if (typeof first !== 'string' || first === '') return run.pipeline;
    const cut = first.length > TITLE_INPUT_MAX ? `${first.slice(0, TITLE_INPUT_MAX - 1)}…` : first;
    return `${run.pipeline} · ${cut}`;
  }
  return run.ticket?.title ?? run.ticket?.ref ?? run.id;
}

/** The pipeline chip a run shows: its pipeline, or null on `feature` (the default line, so boards look as before). */
export function pipelineChip(run) {
  return typeof run.pipeline === 'string' && run.pipeline !== 'feature' ? run.pipeline : null;
}

/** Where a child came from: a slice its index, its parent's ticket (else pipeline) and its title; another child the
 *  parent's ticket, or its pipeline when the ticket is the child's own or it has none. Null for a run with no parent. */
function fromLine(run, runs) {
  if (!run.parent) return null;
  const p = runs.find((r) => r.id === run.parent && r.status !== 'unreadable');
  if (!p) return { text: `↳ from ${run.parent}`, run: null };
  const slice = (p.children ?? []).find((c) => c.id === run.id && c.slice)?.slice;
  if (slice) return { text: `↳ slice ${slice.index} of ${p.ticket ? `#${p.ticket.number}` : p.pipeline}: ${slice.title}`, run: p.id };
  const own = p.ticket && run.ticket && p.ticket.ref === run.ticket.ref;
  return { text: `↳ from ${p.ticket && !own ? `#${p.ticket.number}` : p.pipeline}`, run: p.id };
}

/** What a parent started: its slices and how many started (all started: just the count), else how many runs; clicking
 *  selects the first child still listed (null when none is). Null for a run with no children. */
function startedLine(run, runs) {
  const children = run.children ?? [];
  if (children.length === 0) return null;
  const first = children.find((c) => runs.some((r) => r.id === c.id && r.status !== 'unreadable'))?.id ?? null;
  const slices = children.filter((c) => c.slice);
  if (slices.length === 0) return { text: `→ ${children.length} run${children.length === 1 ? '' : 's'}`, run: first };
  const n = slices.length;
  const k = slices.filter((c) => c.status !== 'pending').length;
  return { text: `→ ${n} slice${n === 1 ? '' : 's'}${k < n ? ` · ${k} started` : ''}`, run: first };
}

/** The line under a linked run's title, and the run clicking it selects (null when that run is not listed): where a
 *  child came from, what a parent started, both for a child that started runs (clicking then selects its parent).
 *  Null for a run with neither. */
export function linkedLine(run, runs) {
  if (run.status === 'unreadable') return null;
  const from = fromLine(run, runs);
  const started = startedLine(run, runs);
  if (from && started) return { text: `${from.text} · ${started.text}`, run: from.run };
  return from ?? started;
}

/** The header's link from a fan-out slice back to its parent (Esc and Backspace follow it too); null for any other
 *  run, or a slice whose parent is not listed. */
export function parentLink(run, runs) {
  if (run.status === 'unreadable' || !run.parent) return null;
  const p = runs.find((r) => r.id === run.parent && r.status !== 'unreadable');
  if (!p || !(p.children ?? []).some((c) => c.id === run.id && c.slice)) return null;
  return { text: `${fromLine(run, runs).text} · back to parent`, run: p.id };
}

/** The wide panel's key hints for the selected run (null: none): Esc goes back to a slice's parent. */
export function keyHints(run, runs) {
  const esc = run && parentLink(run, runs) ? 'esc parent' : 'esc close';
  const keys = [];
  for (const [action, { key }] of Object.entries(ACTIONS)) {
    if (key === undefined) continue;
    const same = keys.find((k) => k.key === key);
    if (same) same.actions.push(action);
    else keys.push({ key, actions: [action] });
  }
  const acts = keys.map((k) => `${k.key} ${k.actions.join(' / ')}`).join(' · ');
  return `↑↓ runs · ←→ stops · ⏎ open agent · ${acts} · ${esc}`;
}

// ── the watcher (`perc watch`) ──

/** How long after Start the panel waits for the watcher's first heartbeat, saying Starting… meanwhile. */
const STARTING_MS = 60_000;
const WATCH_TERMINAL = 'percolator-watch';

/** The header's watcher indicator and its one button: Stop while it watches; none while it starts (Start succeeded
 *  `o.startedAt` ms ago, under a minute, no heartbeat yet); Stop when its heartbeat is stale but its terminal is among
 *  the live ones (`o.live`); else Start over every repo earlier runs ran in (`argv` null, no button, when there is
 *  none). A perc that sends no `watcher` reads as not watching. */
export function watcherState(status, o = { startedAt: null, now: 0, live: [] }) {
  const w = status.watcher;
  if (w?.alive) {
    const n = w.repos.length;
    return { alive: true, label: `Watching ${n} repo${n === 1 ? '' : 's'}`, argv: ['watch', 'stop'] };
  }
  if (o.startedAt !== null && o.now - o.startedAt < STARTING_MS) return { alive: false, label: 'Starting…', argv: null };
  if (o.live.some((t) => t.name === WATCH_TERMINAL)) return { alive: false, label: 'Watcher not responding', argv: ['watch', 'stop'] };
  const repos = knownRepos(status.runs ?? []);
  return { alive: false, label: 'Not watching', argv: repos.length === 0 ? null : ['watch', ...repos.flatMap((r) => ['--repo', r])] };
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
    title: `Delete ${runLabel(run)}?`,
    detail: `Deletes run ${run.id}${run.ticket ? ` (${run.ticket.ref})` : ''}: its terminals, worktree and record. Uncommitted changes in the worktree are lost. The branch ${run.branch} is kept.${stopped}`,
  };
}

/** The confirm dialog for deleting every finished run, or null when none is finished. */
export function deleteFinishedConfirm(runs) {
  const done = runs.filter(isFinished);
  if (done.length === 0) return null;
  return {
    title: `Delete ${done.length} finished run(s)?`,
    detail: `Deletes ${done.map((r) => `${r.id} (${runLabel(r)})`).join(', ')}: their terminals, worktrees and records. Uncommitted changes are lost; their branches are kept.`,
    ids: done.map((r) => r.id),
  };
}

/**
 * The notice beside Delete Finished Runs ↗: "No finished runs" when it was just pressed (`asked`) with none;
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

const runSpaces = (runs) => new Set(runs.flatMap((r) => (r.status !== 'unreadable' && r.driver?.space ? [r.driver.space] : [])));

/** The space to go back to after deleting a run: the shown one when it is no listed run's space, else still `prev`. */
export function trackBackSpace(prev, spaces, runs) {
  const shown = spaces.find((s) => s.active)?.id;
  return shown !== undefined && !runSpaces(runs).has(shown) ? shown : prev;
}

/**
 * The space to select once deleting `ids` closed the space that was shown (`o.shown`, one of theirs; Herdr then shows
 * a neighbour, often another run's): `o.back` when it is still open, else the first open space that is no run's;
 * null to leave Herdr's pick (nothing closed, or every open space is a run's).
 */
export function spaceAfterDelete(o, spaces, runs, ids) {
  const deleted = runs.filter((r) => ids.includes(r.id) && r.status !== 'unreadable').map((r) => r.driver?.space);
  if (o.shown === null || !deleted.includes(o.shown) || spaces.some((s) => s.id === o.shown)) return null;
  if (o.back !== null && spaces.some((s) => s.id === o.back)) return o.back;
  const taken = runSpaces(runs);
  return spaces.find((s) => !taken.has(s.id))?.id ?? null;
}

/** What the run's header says about a delete of it: Deleting… while perc deletes it, Delete failed until the owner
 *  retries, selects another run or a delete succeeds; null otherwise. */
export function deleteView(runId, { busy, deleting, deleteFailed }) {
  if (busy === 'delete' && deleting?.ids.includes(runId) && deleting.doneAt === undefined) return { kind: 'deleting' };
  if (deleteFailed && Object.hasOwn(deleteFailed, runId)) return { kind: 'failed', error: deleteFailed[runId] };
  return null;
}

/** A failed `perc delete` of `ids` → `{ <id>: why }`: each run its own `run <id>: …` stderr line; every run `fallback`
 *  when no line names one of them. */
export function deleteFailures(ids, stderr, fallback) {
  const out = {};
  for (const line of stderr.split(/\r?\n/)) {
    const id = /^run (\S+): /.exec(line)?.[1];
    if (id !== undefined && ids.includes(id) && !Object.hasOwn(out, id)) out[id] = line;
  }
  if (Object.keys(out).length === 0) for (const id of ids) out[id] = fallback;
  return out;
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
 * The selection once fresh rows arrive: `selId` while the rows still list it (a run that finished leaves Active);
 * else `pending.next`, the row worked out when the owner confirmed a delete (later rows no longer hold the deleted
 * ones), if listed; else the first row.
 */
export function selectAfterRefresh(rows, selId, pending) {
  if (rows.some((r) => r.id === selId)) return selId;
  if (pending && rows.some((r) => r.id === pending.next)) return pending.next;
  return rows[0]?.id ?? null;
}

// ── starting a run (`perc pipelines --json`, schema 1) ──

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

/** A repo path to compare by: `/` separators, no trailing one, and lower case for Windows paths. */
export function repoKey(path) {
  const p = String(path).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  return /^[A-Za-z]:/.test(p) || p.startsWith('//') ? p.toLowerCase() : p;
}

/** Two spellings of one repo; false when either is missing. */
export function sameRepo(a, b) {
  return a != null && b != null && repoKey(a) === repoKey(b);
}

/** The repo of a git toplevel: `<repo>` for a run worktree `<repo>/.worktrees/<id>`, else the toplevel. */
export function mainRepo(top) {
  const m = /^(.*?)[\\/]\.worktrees[\\/][^\\/]+[\\/]?$/.exec(top);
  return m && m[1] ? m[1] : top;
}

const spaceRepo = (space, tops) => {
  if (space.machine != null || !space.folder) return null;
  const top = tops[space.folder];
  return typeof top === 'string' && top !== 'loading' ? mainRepo(top) : null;
};

/** The start picker's repos: the open spaces' git repos in space order, then earlier runs' repos, each once. */
export function startRepos(spaces, tops, runs) {
  const seen = new Set();
  const out = [];
  const add = (repo, open) => {
    const key = repoKey(repo);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ repo, open });
  };
  for (const s of spaces) {
    const repo = spaceRepo(s, tops);
    if (repo) add(repo, true);
  }
  for (const repo of knownRepos(runs)) add(repo, false);
  return out;
}

/** The repo to preselect: the shown space's, else the first open space's, else the latest run's, else null. */
export function startRepo(spaces, tops, runs) {
  const shown = spaces.find((s) => s.active);
  const own = shown ? spaceRepo(shown, tops) : null;
  if (own) return own;
  const open = startRepos(spaces, tops, []);
  return open[0]?.repo ?? knownRepos(runs)[0] ?? null;
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
  // perc run would read it as a flag
  if (!blank(o.ticket) && o.ticket.trim().startsWith('-')) return { ok: false, why: 'A ticket cannot start with -' };
  const missing = o.pipeline.inputs.find((i) => i.required && blank(o.inputs[i.name]));
  return missing ? { ok: false, why: `Enter ${missing.name}` } : { ok: true };
}

/** The pipeline the picker shows picked: `want` while it is listed (among `names`, when given) and not broken, else
 *  the default, else the first one that can be picked; null when none can. */
export function startPick(pipelines, want, names = null) {
  const ok = pipelines.filter((p) => !p.error && (names === null || names.includes(p.name)));
  return (ok.find((p) => p.name === want) ?? ok.find((p) => p.default) ?? ok[0])?.name ?? null;
}

/** A pipeline's row in the picker: its name, its tags (default, how it takes a ticket) and the line under it. */
export function pipelineOption(p) {
  if (p.error) return { name: p.name, tags: [], note: p.error, error: true };
  const ticket = p.ticket === 'none' ? ['No ticket'] : p.ticket === 'optional' ? ['Ticket optional'] : [];
  return { name: p.name, tags: [...(p.default ? ['Default'] : []), ...ticket], note: p.description ?? `Ends with ${p.exit}`, error: false };
}

/** The run id `perc run` prints (`run <id> started`), so the panel can select the new run; else null. */
export function startedRun(stdout) {
  return /^run (\S+) started$/m.exec(String(stdout ?? ''))?.[1] ?? null;
}

/** What Start says in fixtures mode instead of running perc. */
export function wouldStart(argv) {
  return `Fixture: would run ${commandLine(argv)}`;
}

/** What "Run next…" offers on a finished run: its ticket and the issues its exit opened, and the pipelines that take a
 *  ticket; null while a run on its ticket is live, or when it has no ticket to offer. */
export function runNextChoices(run, pipelines, runs) {
  if (!isFinished(run)) return null;
  const ref = run.ticket?.ref;
  if (ref && runs.some((r) => r.ticket?.ref === ref && ACTIVE.has(r.status))) return null;
  const tickets = [...(ref ? [ref] : []), ...(run.opened ?? []).map((o) => o.ref)];
  if (tickets.length === 0) return null;
  return { tickets, pipelines: pipelines.filter((p) => !p.error && p.ticket !== 'none').map((p) => p.name) };
}

/** A pipeline as a run that has not started, so pipelineRows, pipelineSpans and pipelineMarks draw its preview. */
export function previewRun(pipeline) {
  return {
    id: 'preview',
    status: 'pending',
    steps: pipeline.steps.map((s) => ({ ...s, status: 'pending', attempts: 0, outputs: {} })),
    loops: pipeline.loops.map((l) => ({ ...l, round: 0 })),
    timeline: [],
    ticket: null,
    pipeline: pipeline.name,
  };
}

/** Where the pipeline preview sits beside the start picker: below it under 720px wide, else to its right. */
export function previewSide(width) {
  return width < 720 ? 'below' : 'right';
}

// ── fan-out slices ──

/** A fan-out parent's slices, by index, each with its child's status, the step it is at (`Done` once completed, `Not
 *  started` before its run exists, else its status) and its PR. Read from the child's own run when it is listed, else from the parent's
 *  child entry. Empty for a run without slices. */
export function sliceRows(run, runs) {
  if (run.status === 'unreadable') return [];
  return (run.children ?? [])
    .filter((c) => c.slice)
    .sort((a, b) => a.slice.index - b.slice.index)
    .map((c) => {
      const r = runs.find((x) => x.id === c.id && x.status !== 'unreadable');
      const status = r?.status ?? c.status;
      const stepLabel = status === 'completed' ? 'Done' : (r?.currentStep ?? (status === 'pending' ? 'Not started' : sentence(status)));
      const prUrl = r?.pr?.url;
      return { index: c.slice.index, title: c.slice.title, id: c.id, status, stepLabel, ...(prUrl ? { prUrl } : {}) };
    });
}

/** The pipeline row a fan-out parent's slices hang under: its last stage row, where the fan-out step sits (-1 when
 *  there is none). */
export function fanOutRow(rows) {
  return rows.findLastIndex((r) => r.type === 'stage');
}

/** A pipeline row's label: the stage of a `<stage>.<n>` step (the router's `route.3` reads `route`), else the step id. */
export function stageName(step) {
  const m = /^(.+)\.\d+$/.exec(step.id);
  return m && m[1] === step.stage ? step.stage : step.id;
}

const TRIGGER_WORDS = {
  schedule: 'schedule',
  label: 'label',
  pr_opened: 'PR',
  dependabot: 'Dependabot PR',
  check_failed: 'failed check on',
};

/** The header's line for a run a trigger started ("Started by label ready"); null for a manual run. */
export function triggerLine(run) {
  const t = run?.trigger;
  const words = t ? TRIGGER_WORDS[t.kind] : undefined;
  if (!words) return null;
  const head = t.kind === 'check_failed' && !t.detail ? 'failed check' : words;
  return t.detail ? `Started by ${head} ${t.detail}` : `Started by ${head}`;
}

/** The history's rows for the run's inputs, in input order: the name, the value on one line, the full value on hover. */
export function inputRows(run) {
  return Object.entries(run?.inputs ?? {}).map(([name, value]) => ({
    key: `input:${name}`,
    mark: '·',
    tone: 'dim',
    step: name,
    round: '',
    status: '',
    started: '',
    took: '',
    note: value.replace(/\s*[\r\n]+\s*/g, ' '),
    title: value,
  }));
}
