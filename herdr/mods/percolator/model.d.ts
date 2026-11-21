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
