// Types for model.js, so `pnpm typecheck` covers tests/herdr/model.test.ts. The run shape is the
// `perc status --json` contract (src/run/status.ts).
import type { Action, RunStatusJson, StatusJson } from '../../../src/run/status.ts';

type Readable = Exclude<RunStatusJson, { status: 'unreadable' }>;
export type Step = Readable['steps'][number];
export type Stage = 'intake' | 'groom' | 'plan' | 'implement' | 'review' | 'deliver';
export type Zone = { stage: Stage; shown: Step[]; hidden: Step[] };
export type Tone = 'blocked' | 'working' | 'dim' | 'muted';

export declare const STAGES: readonly Stage[];
export declare function parseStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function sortRuns(runs: RunStatusJson[]): RunStatusJson[];
export declare function visibleRuns(runs: RunStatusJson[], filter: 'active' | 'all'): RunStatusJson[];
export declare function rowState(run: RunStatusJson): { tone: Tone; text: string };
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
export declare function took(step: Step, now: number): string;
export declare function stepTone(status: string): 'done' | 'working' | 'blocked' | null;
export declare function resolvePath(base: string, p: string): string;
export declare function cliLines(run: RunStatusJson): string[];
export declare function attentionTag(kind: string): string;
export declare function shownLoops(run: RunStatusJson): Loop[];
export declare function loopAtCap(loop: Loop): boolean;
export declare function loopLabel(loop: Loop, narrow: boolean): string;
export declare function moveStop(run: RunStatusJson, selected: string | null, dir: number): string | null;
export declare function moveRow(rows: RunStatusJson[], selId: string | null, dir: number): string | null;
export declare function readerPath(run: RunStatusJson, stopSel: string | null): string | null;
