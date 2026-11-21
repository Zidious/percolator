// Types for model.js, so `pnpm typecheck` covers tests/herdr/model.test.ts. The run shape is the
// `perc status --json` contract (src/run/status.ts).
import type { Action, RunStatusJson, StatusJson } from '../../../src/run/status.ts';

type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
export type Step = Readable['steps'][number];
export type Stage = 'intake' | 'groom' | 'plan' | 'implement' | 'review' | 'deliver';
export type TimelineEntry = Readable['timeline'][number];
export type Attempt = Extract<TimelineEntry, { kind: 'attempt' }>;
export type Zone = { stage: Stage; shown: Step[]; hidden: Step[] };
export type Tone = 'blocked' | 'working' | 'dim' | 'muted';

export declare const STAGES: readonly Stage[];
export declare function parseStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function sortRuns(runs: RunStatusJson[]): RunStatusJson[];
export declare function visibleRuns(runs: RunStatusJson[], filter: 'active' | 'all'): RunStatusJson[];
export declare function rowState(run: RunStatusJson): { tone: Tone; text: string; round?: string };
export declare function trainLayout(run: RunStatusJson, narrow: boolean): Zone[];
export declare function xOf(zones: Zone[], stepId: string): number | null;
export declare function newlyNeeding(prev: RunStatusJson[] | null, next: RunStatusJson[]): RunStatusJson[];
export declare function actionArgv(action: Action, run: { id: string }, feedback?: string): string[] | null;
export declare function needsCount(runs: RunStatusJson[]): number;
export declare function runningCount(runs: RunStatusJson[]): number;
export type Loop = Readable['loops'][number];
export declare function readStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function duration(seconds: number): string;
export declare function ago(iso: string | undefined, now: number): string;
export declare function took(step: { startedAt?: string; endedAt?: string; status: string }, now: number): string;
export declare function stepTone(status: string): 'done' | 'working' | 'blocked' | null;
export declare function resolvePath(base: string, p: string): string;
export declare function cliLines(run: RunStatusJson): string[];
export declare function terminalCommands(run: RunStatusJson): string[];
export declare function attentionTag(kind: string): string;
export declare function shownLoops(run: RunStatusJson): Loop[];
export declare function loopAtCap(loop: Loop): boolean;
export declare function loopLabelAlign(a: number, b: number): 'start' | 'end';
export declare function loopLabel(loop: Loop, narrow: boolean): string;
export declare function canPick(step: { status: string }): boolean;
export declare function moveStop(run: RunStatusJson, selected: string | null, dir: number): string | null;
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
export declare const COFFEE_LINES: readonly string[];
export declare function coffeeLine(runId: string, stepId: string): string;
export declare function runningText(run: RunStatusJson, now: number): string;
export declare function roundView(run: RunStatusJson, stepId: string, roundSel: number | null): RoundView | null;
export type TimelineRow = {
  key: string;
  mark: string;
  tone: 'done' | 'working' | 'blocked' | null;
  step: string;
  round: string;
  status: string;
  started: string;
  took: string;
  note: string;
};
export declare function clock(iso?: string): string;
export declare function timelineRows(run: RunStatusJson, now: number): TimelineRow[];
export declare function readerPath(run: RunStatusJson, stopSel: string | null, roundSel?: number | null): string | null;
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
export declare function fillHeight(view: number, content: number, box: number, min: number): number;
export declare function titleLayout(width: number, needs: number): { tabs: 'inline' | 'below'; chip: 'long' | 'short' };
export declare function nextBoxH(prev: number, target: number): number;
export declare function showsHere(place: unknown, inWindow: boolean, blockShown: boolean): boolean;
export declare function terminalAddress(live: { address: string; name?: string | null }[], term: string | null | undefined): string | null;
export declare function driverPeek(run: RunStatusJson | null | undefined): { terminal: string; label: 'Driver pane ↗' } | null;
export declare function ticketTitle(run: Readable): string;
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
  runs: { id: string }[],
  rows: { id: string }[],
  selId: string | null,
  pending: { ids: string[]; next: string | null } | null,
): string | null;
