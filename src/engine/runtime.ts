import type { Graph, Step } from '../graph/build.ts';
import type { RunState } from './state.ts';

export type NodeOutcome = {
  status: 'pass' | 'fail' | 'escalate';
  outputs: Record<string, string>;
  reason?: string;
  /** escalate only: what the step asks the owner */
  questions?: string[];
};

/** One back-edge loop containing a step: its round counts the rounds granted past the cap (`round` > `maxRounds` then). */
export type LoopRound = { from: string; round: number; maxRounds: number; granted: number };

/** A step running in a round the owner granted at a findings loop's cap: `round` is `maxRounds` plus the rounds granted. */
export type VerifyRound = { edgeId: string; round: number; maxRounds: number };

export type RunContext = {
  state: RunState;
  graph: Graph;
  /** round of the innermost back-edge loop containing the step, 1-based, at most `maxRounds` */
  round: number;
  /** `maxRounds` of the innermost back-edge loop containing the step; 1 outside any loop */
  maxRounds: number;
  /** every back-edge loop containing the step, outermost first; absent or empty outside loops */
  loops?: LoopRound[];
  /** set only when the step runs in a round granted at the cap of the findings loop its fail routes to */
  verify?: VerifyRound;
  /** latest outputs per stepId */
  previousOutputs: Record<string, Record<string, string>>;
};

export interface Runtime {
  executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome>;
}
