// Types for status.js, so `pnpm typecheck` covers the tests that import it. The run shape is the
// `perc status --json` contract (src/run/status-json.ts); the pipelines shape is model.d.ts's.
import type { RunStatusJson, StatusJson } from '../../../src/run/status-json.ts';
import type { PipelinesJson } from './model.js';

export declare function parseStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function newlyNeeding(prev: RunStatusJson[] | null, next: RunStatusJson[]): RunStatusJson[];
export declare function needsYou(run: RunStatusJson): boolean;
export declare function needsCount(runs: RunStatusJson[]): number;
export declare function runningCount(runs: RunStatusJson[]): number;
export declare function readStatus(stdout: string): { ok: true; data: StatusJson } | { ok: false; error: string };
export declare function resolvePath(base: string, p: string): string;
export declare function runLabel(run: RunStatusJson): string;
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
export declare function readPipelines(stdout: string): { ok: true; data: PipelinesJson } | { ok: false; error: string };
export declare function pipelinesFixture(statusFixture: string): string;
