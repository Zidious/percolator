import type { BackEdge, Graph, Step } from '../graph/build.ts';
import { STAGE_CONTRACTS } from '../graph/core.ts';
import type { NodeOutcome, RunContext, Runtime } from './runtime.ts';
import type { RunState } from './state.ts';

export type RunDeps = {
  runtime: Runtime;
  save: (s: RunState) => Promise<void>;
  now?: () => string;
};

/**
 * Walk `graph` from `state.cursor` until the run completes, fails or pauses.
 * Mutates and returns `state`; saves after every recorded step. Never mutates `graph`.
 */
export async function runGraph(graph: Graph, state: RunState, deps: RunDeps): Promise<RunState> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { steps } = graph;
  const indexOf = (stepId: string) => steps.findIndex((s) => s.id === stepId);
  let contractRetried = false;

  while (state.status === 'running' && state.cursor < steps.length) {
    const i = state.cursor;
    const step = steps[i]!;

    if (step.role === 'hook' && step.def.once === true && (state.executed[step.id] ?? 0) > 0) {
      state.cursor = i + 1;
      settle(i);
      await deps.save(state);
      continue;
    }

    const ctx: RunContext = { state, graph, round: roundAt(i), previousOutputs: latestOutputs(state) };
    const startedAt = now();
    const outcome = await deps.runtime.executeStep(step, ctx);
    const endedAt = now();
    const attempt = (state.executed[step.id] ?? 0) + 1;
    state.executed[step.id] = attempt;
    const missing = missingOutputs(step, outcome);
    state.history.push({
      stepId: step.id,
      attempt,
      startedAt,
      endedAt,
      status: missing.length > 0 ? 'contract_error' : outcome.status,
      outputs: outcome.outputs,
    });

    if (missing.length > 0) {
      // never a back-edge: retry the same step once, then pause for the owner
      if (contractRetried) {
        state.status = 'paused';
        state.pausedReason = `contract: ${step.stage} missing ${missing.join(', ')}`;
      } else {
        contractRetried = true;
      }
      await deps.save(state);
      continue;
    }
    contractRetried = false;

    if (outcome.status === 'escalate') {
      // cursor stays on the step: resume re-runs it
      state.status = 'paused';
      state.pausedReason = outcome.reason ?? `escalate: ${step.id}`;
    } else if (outcome.status === 'fail') {
      const edge = graph.backEdges[step.id];
      if (!edge) {
        state.status = 'failed';
      } else if (edge.jumpAfterIndex === i) {
        state.cursor = i + 1;
        decide(edge, i, outcome.outputs['findings']);
      } else {
        // triggered now, decided once the step at jumpAfterIndex has run (hooks run every round)
        state.pendingJump = { edgeId: edge.id, findings: outcome.outputs['findings'] };
        state.cursor = i + 1;
      }
    } else {
      if (step.slotLast && step.stage === 'review') delete state.unresolvedFindings;
      state.cursor = i + 1;
    }
    settle(i);
    await deps.save(state);
  }
  return state;

  /** 1 + rounds of the smallest back-edge span containing step `i`; 1 outside any loop. */
  function roundAt(i: number): number {
    let inner: BackEdge | undefined;
    for (const e of Object.values(graph.backEdges)) {
      if (e.toStepIndex > i || i > e.jumpAfterIndex) continue;
      if (!inner || e.jumpAfterIndex - e.toStepIndex < inner.jumpAfterIndex - inner.toStepIndex) inner = e;
    }
    return inner ? 1 + (state.rounds[inner.id] ?? 0) : 1;
  }

  /** After the step at `i`: resolve a pending jump that is due or overtaken, and detect completion. */
  function settle(i: number): void {
    const pending = state.pendingJump;
    if (state.status === 'running' && pending) {
      const edge = graph.backEdges[pending.edgeId]!;
      if (state.cursor <= indexOf(edge.fromStepId)) {
        // a later step's own edge jumped back before the trigger: the pending round is void
        delete state.pendingJump;
      } else if (edge.jumpAfterIndex === i) {
        delete state.pendingJump;
        decide(edge, i, pending.findings);
      }
    }
    if (state.status === 'running' && state.cursor >= steps.length) state.status = 'completed';
  }

  /** Count a round on `edge` after the step at `i`: jump back, or apply the cap. */
  function decide(edge: BackEdge, i: number, findings: string | undefined): void {
    const n = (state.rounds[edge.id] ?? 0) + 1;
    state.rounds[edge.id] = n;
    if (n < edge.maxRounds) {
      state.cursor = edge.toStepIndex;
      // loops nested inside the re-run span start fresh
      const from = indexOf(edge.fromStepId);
      for (const other of Object.values(graph.backEdges)) {
        const t = indexOf(other.fromStepId);
        if (other.id !== edge.id && t >= edge.toStepIndex && t < from) delete state.rounds[other.id];
      }
    } else if (edge.onCap === 'continue') {
      state.unresolvedFindings = findings;
      state.cursor = i + 1;
    } else {
      // cursor stays on the step: resume re-runs it
      state.cursor = i;
      state.status = 'paused';
      state.pausedReason = `cap: ${edge.id} reached ${n} rounds`;
    }
  }
}

/** Required outputs absent from a stage's last slot node (on pass; review on any status). */
function missingOutputs(step: Step, outcome: NodeOutcome): string[] {
  if (!step.slotLast || step.stage === 'before-all' || step.stage === 'after-all') return [];
  if (outcome.status !== 'pass' && step.stage !== 'review') return [];
  return STAGE_CONTRACTS[step.stage].requiredOutputs.filter((k) => !Object.hasOwn(outcome.outputs, k));
}

/** Outputs of each step's latest valid (non-contract_error) record. */
function latestOutputs(state: RunState): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const h of state.history) if (h.status !== 'contract_error') out[h.stepId] = h.outputs;
  return out;
}
