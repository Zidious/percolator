import type { Step } from '../../src/graph/build.ts';
import { STAGE_CONTRACTS } from '../../src/graph/core.ts';
import type { NodeOutcome, RunContext, Runtime } from '../../src/engine/runtime.ts';

export const pass = (outputs: Record<string, string> = {}): NodeOutcome => ({ status: 'pass', outputs });
export const fail = (findings: string): NodeOutcome => ({ status: 'fail', outputs: { findings } });
export const esc = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

/** Returns scripted outcomes per stepId in order; unscripted or exhausted steps pass with a valid contract. */
export class FakeRuntime implements Runtime {
  calls: string[] = [];
  rounds: number[] = [];
  previous: Record<string, Record<string, string>>[] = [];
  readonly #script: Record<string, NodeOutcome[]>;
  readonly #used = new Map<string, number>();

  constructor(script: Record<string, NodeOutcome[]> = {}) {
    this.#script = script;
  }

  async executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome> {
    this.calls.push(step.id);
    this.rounds.push(ctx.round);
    this.previous.push(structuredClone(ctx.previousOutputs));
    const n = this.#used.get(step.id) ?? 0;
    this.#used.set(step.id, n + 1);
    const scripted = this.#script[step.id]?.[n];
    if (scripted) return structuredClone(scripted);
    return pass(defaultOutputs(step));
  }

  /** ctx.round seen by each call of `stepId`, in order */
  roundsOf(stepId: string): number[] {
    return this.rounds.filter((_, i) => this.calls[i] === stepId);
  }
}

function defaultOutputs(step: Step): Record<string, string> {
  if (!step.slotLast || step.stage === 'before-all' || step.stage === 'after-all') return {};
  // an explicit review pass reports no findings
  if (step.stage === 'review') return { findings: '' };
  return Object.fromEntries(STAGE_CONTRACTS[step.stage].requiredOutputs.map((k) => [k, 'x']));
}
