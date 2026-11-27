// Types for model.js, so `pnpm typecheck` covers tests/herdr/model.test.ts. The run shape is the
// `perc status --json` contract (src/run/status.ts).
import type { Action, RunStatusJson, StatusJson } from '../../../src/run/status-json.ts';

type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
export type Step = Readable['steps'][number];
export type Stage = 'intake' | 'groom' | 'plan' | 'implement' | 'review' | 'deliver';
export type TimelineEntry = Readable['timeline'][number];
export type Attempt = Extract<TimelineEntry, { kind: 'attempt' }>;
export type Tone = 'blocked' | 'working' | 'muted';

export declare const STAGES: readonly Stage[];
export declare function parseStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function sortRuns(runs: RunStatusJson[]): RunStatusJson[];
export declare function visibleRuns(runs: RunStatusJson[], filter: 'active' | 'all'): RunStatusJson[];
export declare function rowState(run: RunStatusJson): { tone: Tone; text: string; round?: string };
export declare function outcomeOf(run: RunStatusJson): { tag: 'DELIVERED' | 'ROUTED' | 'DONE' | 'COMMENTED'; text: string; url?: string };
export declare function newlyNeeding(prev: RunStatusJson[] | null, next: RunStatusJson[]): RunStatusJson[];
/** `feedback` is the reject feedback, or the picked pipeline for `pick`. */
/** `run-again` on an unreadable run: null (it has no pipeline or repo to start again). */
export declare const ACTIONS: Record<string, { label: string; style: string; key?: string }>;
export declare function actionForKey(key: string, offered: string[]): string | undefined;
export declare const ATTENTION: Record<string, { tag: string; row: (step: string | undefined, a: NonNullable<RunStatusJson['attention']>) => string; asks?: true; driver?: true }>;
export declare function actionArgv(action: Action, run: RunStatusJson, feedback?: string): string[] | null;
export declare function runAgainArgv(run: Readable): string[];
export type AskItem = { n: number; label: string; text: string };
export type Ask = { kind: 'questions' | 'findings'; step: string; attempt: number; key: string; items: AskItem[] };
export declare function itemLabel(text: string, n: number, kind: 'questions' | 'findings'): string;
export declare function askOf(run: RunStatusJson | null | undefined): Ask | null;
/** questions: per question its text or null (N/A); findings: per finding whether it is ticked */
export declare function answerArgv(run: RunStatusJson, values: (string | null)[] | boolean[]): string[];
export declare function linkedLine(run: RunStatusJson, runs: RunStatusJson[]): { text: string; run: string | null } | null;
export declare function parentLink(run: RunStatusJson, runs: RunStatusJson[]): { text: string; run: string } | null;
export declare function keyHints(run: RunStatusJson | null, runs: RunStatusJson[]): string;
export type SliceRow = { index: number; title: string; id: string; status: RunStatusJson['status'] | 'pending'; stepLabel: string; prUrl?: string };
export declare function sliceRows(run: RunStatusJson, runs: RunStatusJson[]): SliceRow[];
export declare function fanOutRow(rows: PipeRow[]): number;
export declare function watcherState(
  status: StatusJson,
  o?: { startedAt: number | null; now: number; live: { address: string; name?: string }[] },
): { alive: boolean; label: string; argv: string[] | null };
export declare function needsYou(run: RunStatusJson): boolean;
export declare function nowTone(run: RunStatusJson): 'blocked' | 'working';
export declare function needsCount(runs: RunStatusJson[]): number;
export declare function runningCount(runs: RunStatusJson[]): number;
export type Loop = Readable['loops'][number];
export declare function readStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function duration(seconds: number): string;
export declare function ago(iso: string | undefined, now: number): string;
export declare function took(step: { startedAt?: string; endedAt?: string; status: string }, now: number): string;
export declare function stepTone(status: string): 'done' | 'working' | 'blocked' | null;
export declare function resolvePath(base: string, p: string): string;
export declare function attentionTag(kind: string): string;
export declare function roundOf(loop: Loop): { n: number; max: number; taken: boolean; atCap: boolean };
export declare function stageName(step: { id: string; stage: string }): string;
export declare function roundPill(run: RunStatusJson, stepId: string): { text: string; tone: 'dim' | 'working' | 'blocked' } | null;
export declare function loopSpans(run: RunStatusJson): { id: string; from: string; to: string; tone: 'dim' | 'working' | 'blocked' }[];
export declare function canPick(step: { status: string }): boolean;
export type RowState = 'past' | 'active' | 'future' | 'failed';
export type PipeRow =
  | { type: 'stage'; step: Step; gate: boolean; state: RowState; round: { text: string; tone: string } | null; folded: Step[] }
  | { type: 'hook'; step: Step; where: 'before-all' | 'before' | 'after' | 'after-all'; gate: boolean; state: RowState };
export declare function pipelineRows(run: RunStatusJson, o: { narrow: boolean; unfolded: string[] }): PipeRow[];
export declare function pipelineSpans(rows: PipeRow[], run: RunStatusJson): { from: number; to: number; tone: string }[];
export declare function pipelineMarks(rows: PipeRow[], stopSel: string | null): { active: number; reached: number; stripAt: number };
export declare function roundNote(run: RunStatusJson, stepId: string, now: number): string;
export declare function hookNote(run: RunStatusJson, row: { step: Step; where?: string }, now: number): string;
export declare function unfoldAfterPick(run: RunStatusJson, o: { narrow: boolean; unfolded: string[] }, from: string | null, to: string | null): string[];
export declare function moveStop(run: RunStatusJson, selected: string | null, dir: number, unfolded?: string[], narrow?: boolean): string | null;
export declare function moveRow(rows: RunStatusJson[], selId: string | null, dir: number): string | null;
export type RoundView = {
  attempt: Attempt;
  n: number;
  of: number;
  mark: 'running' | 'waiting' | 'latest' | null;
  prev: number | null;
  next: number | null;
};
export declare function timelineOf(run: RunStatusJson): TimelineEntry[];
export declare function stepAttempts(run: RunStatusJson, stepId: string): Attempt[];
export declare function roundView(run: RunStatusJson, stepId: string, roundSel: number | null): RoundView | null;
export type TimelineRow = {
  key: string;
  mark: string;
  tone: 'done' | 'working' | 'blocked' | 'dim' | null;
  step: string;
  round: string;
  status: string;
  started: string;
  took: string;
  note: string;
};
export declare function clock(iso?: string): string;
export declare function timelineRows(run: RunStatusJson, now: number): TimelineRow[];
export declare function inputRows(run: RunStatusJson): (TimelineRow & { title: string })[];
export declare function triggerLine(run: RunStatusJson): string | null;
export declare function cupLabel(runs: RunStatusJson[]): { text: string; tone: 'blocked' | 'working' | 'muted' };
export declare function notice(run: RunStatusJson): {
  title: string;
  body: string;
  level: 'warning';
  action: { name: string };
};
export declare function findNode(node: unknown, id: string): any;
export type CupMove = 'show-panel' | 'hide-panel' | 'open-window' | 'close-window';
export declare function cupMoves(
  place: unknown,
  open: { panel: boolean; window: boolean },
  why: 'click' | 'open',
): CupMove[];
export declare function ownsCommands(place: unknown, inWindow: boolean): boolean;
export declare const BOARD_RATIO: number;
export declare function boardHeight(ratio: number, area: number, min: number): number;
export declare function dragBoard(startPx: number, dy: number, area: number, min: number): number;
export declare function readRatio(stored: unknown): number;
export declare function titleLayout(width: number): { chip: 'long' | 'short'; newRun: 'icon' | 'text' };
export declare function showsHere(place: unknown, inWindow: boolean, blockShown: boolean): boolean;
export declare function readerText(path: string, text: string): string;
export declare function reasonParts(detail: string | undefined, transcript: string | undefined): { before: string; after: string } | null;
export declare function fileUrl(path: string): string;
export declare function catchUpStep(wasShown: boolean | undefined, now: boolean): { refresh: boolean; wasShown: boolean };
export declare function terminalAddress(live: { address: string; name?: string | null }[], term: string | null | undefined): string | null;
export declare function activeBox(run: RunStatusJson): 'agent' | 'gate' | 'cap' | 'paused' | 'questions' | 'findings' | 'failed' | 'stalled' | null;
export declare function agentCard(
  run: RunStatusJson,
  live: { address: string; name?: string | null }[],
  agents: { address: string; status: string; program?: { name: string } }[],
  now: number,
): { address: string | null; name: string; status: string; program: string; since: string } | null;
export declare function driverPeek(run: RunStatusJson | null | undefined): { terminal: string; label: 'Driver pane ↗' } | null;
export declare function ticketTitle(run: Readable): string;
export declare function runLabel(run: RunStatusJson): string;
export declare function pipelineChip(run: { pipeline?: string }): string | null;
export declare function deleteArgv(ids: string[]): string[];
export declare function deleteCommand(ids: string[]): string;
export declare function deleteCommandIds(command: string): string[] | null;
export declare function isFinished(run: RunStatusJson): boolean;
export declare function deleteConfirm(run: RunStatusJson): { title: string; detail: string };
export declare function deleteFinishedConfirm(runs: RunStatusJson[]): { title: string; detail: string; ids: string[] } | null;
export declare function finishedNotice(notice: string | null, runs: RunStatusJson[], asked: boolean): string | null;
export declare function deleteBusyError(busy: string | null): string | null;
export declare function selectAfterDelete(rows: { id: string }[], deletedIds: string[], selId: string | null): string | null;
export declare function selectAfterRefresh(
  rows: { id: string }[],
  selId: string | null,
  pending: { ids: string[]; next: string | null } | null,
): string | null;
export declare function agentTone(status: string): 'blocked' | 'working' | 'muted';
/** The theme colour for text in a model tone: dim (and no tone) read as muted; any other tone stays. */
export declare function textTone<T extends string>(tone: T | null | undefined): Exclude<T, 'dim'> | 'muted';
export declare function agentAddress(run: RunStatusJson, live: { address: string; name?: string | null }[]): string | null;
export declare function openAgentAt(
  run: RunStatusJson | null | undefined,
  live: { address: string; name?: string | null }[],
  fixtures: boolean,
): { address: string } | { said: string } | { error: string } | null;
export declare function boxActions(run: RunStatusJson): Action[];
export declare function readerFiles(
  run: RunStatusJson,
  stopSel: string | null,
  roundSel: number | null,
  outPick: string | null,
  boxPick?: string | null,
): { box: string | null; strip: string | null };
export declare function boxFiles(run: RunStatusJson): { path: string; label: string }[];
export declare function readerMax(area: number): number;
export declare function readFullShown(inWindow: boolean): boolean;
export declare function boxOutside(run: RunStatusJson, o: { narrow: boolean; unfolded: string[] }): boolean;
export declare function slotOpensAgent(run: RunStatusJson, live: { address: string; name?: string | null }[]): boolean;
export declare function boxAsks(run: RunStatusJson): boolean;
export declare function showsOutcome(run: RunStatusJson): boolean;
export declare function programInitial(program: string): string;
export declare function agentNote(card: ReturnType<typeof agentCard>): string | null;
export declare function boxDriver(run: RunStatusJson): { terminal: string; label: 'Driver pane ↗' } | null;
export declare function historyLabel(run: RunStatusJson, open: boolean): string;
export type Columns = 'one' | 'two';
export declare function columns(width: number): Columns;
export declare function panelShape(width: number, zoom: number): { narrow: boolean; cols: Columns; fold: boolean };
export declare function detailParts(
  run: RunStatusJson,
  o: { cols: Columns; narrow: boolean; unfolded: string[]; stopSel: string | null },
): { under: boolean; side: ('box' | 'outcome' | 'strip')[] };

// `perc pipelines --json` (schema 1): steps and loops as a run's, minus the per-run fields.
export type PipelineInput = { name: string; required: boolean; description?: string };
export type Pipeline = {
  name: string;
  default: boolean;
  router: boolean;
  ticket: 'required' | 'optional' | 'none';
  inputs: PipelineInput[];
  exit: string;
  description?: string;
  steps: { id: string; stage: string; role: 'core' | 'node'; kind: 'agent' | 'builtin' | 'script' | 'gate' }[];
  loops: Omit<Loop, 'round'>[];
};
export type BrokenPipeline = { name: string; error: string };
export type PipelinesJson = { schema: 1; repo: string; profile: string; pipelines: (Pipeline | BrokenPipeline)[] };
export type StartChoice = { pipeline: Pipeline; ticket?: string; inputs: Record<string, string>; repo: string | null };
export declare function readPipelines(stdout: string): { ok: true; data: PipelinesJson } | { ok: false; error: string };
export declare function pipelinesFixture(statusFixture: string): string;
export declare function startFields(pipeline: Pipeline): {
  ticket: 'required' | 'optional' | 'hidden';
  inputs: { name: string; required: boolean; description: string }[];
};
export declare function knownRepos(runs: RunStatusJson[]): string[];
export type SpaceInfo = {
  id: string;
  index: number;
  name: string;
  named: boolean;
  folder: string;
  machine: string | null;
  branch: string | null;
  active: boolean;
  status: unknown;
  tabs: unknown[];
};
/** Per space folder: its git toplevel, null when not a repo, 'loading' while asked. */
export type Tops = Record<string, string | null>;
export declare function repoKey(path: string): string;
export declare function sameRepo(a: string | null, b: string | null): boolean;
export declare function mainRepo(top: string): string;
export declare function startRepos(spaces: SpaceInfo[], tops: Tops, runs: RunStatusJson[]): { repo: string; open: boolean }[];
export declare function startRepo(spaces: SpaceInfo[], tops: Tops, runs: RunStatusJson[]): string | null;
export declare function ticketRepo(text: string): string | null;
export declare function guessRepo(ticketText: string, runs: RunStatusJson[]): string | null;
export declare function startArgv(o: StartChoice & { repo: string }): string[];
export declare function commandLine(argv: string[]): string;
export declare function canStart(o: StartChoice): { ok: true } | { ok: false; why: string };
export declare function startPick(pipelines: (Pipeline | BrokenPipeline)[], want: string | null, names?: string[] | null): string | null;
export declare function pipelineOption(p: Pipeline | BrokenPipeline): { name: string; tags: string[]; note: string; error: boolean };
export declare function startedRun(stdout: string): string | null;
export declare function wouldStart(argv: string[]): string;
export declare function runNextChoices(
  run: RunStatusJson,
  pipelines: (Pipeline | BrokenPipeline)[],
  runs: RunStatusJson[],
): { tickets: string[]; pipelines: string[] } | null;
/** Run-shaped (status 'pending', ticket null, plus `pipeline`) so the pipeline functions draw it. */
export declare function previewRun(pipeline: Pipeline): Readable;
export declare function previewSide(width: number): 'below' | 'right';
export declare function deleteView(
  runId: string,
  s: { busy: string | null; deleting: { ids: string[]; doneAt?: number } | null; deleteFailed: Record<string, string> | null },
): { kind: 'deleting' } | { kind: 'failed'; error: string } | null;
export declare function deleteFailures(ids: string[], stderr: string, fallback: string): Record<string, string>;
export declare function trackBackSpace(prev: string | null, spaces: SpaceInfo[], runs: RunStatusJson[]): string | null;
export declare function spaceAfterDelete(
  o: { shown: string | null; back: string | null },
  spaces: SpaceInfo[],
  runs: RunStatusJson[],
  ids: string[],
): string | null;
