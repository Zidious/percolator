import type { Graph, Step } from '../graph/build.ts';
import type { RunState } from './state.ts';

export type NodeOutcome = {
  status: 'pass' | 'fail' | 'escalate';
  outputs: Record<string, string>;
  reason?: string;
};

export type RunContext = {
  state: RunState;
  graph: Graph;
  /** round of the innermost back-edge loop containing the step, 1-based, at most `maxRounds` */
  round: number;
  /** `maxRounds` of the innermost back-edge loop containing the step; 1 outside any loop */
  maxRounds: number;
  /** latest outputs per stepId */
  previousOutputs: Record<string, Record<string, string>>;
};

export interface Runtime {
  executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome>;
}
