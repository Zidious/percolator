import { createHash } from 'node:crypto';
import type { BackEdge, Graph, Step } from '../graph/build.ts';
import type { LoopRound, NodeOutcome, RunContext, Runtime } from './runtime.ts';
import type { FindingSource, RunState } from './state.ts';

export type RunDeps = {
  runtime: Runtime;
  save: (s: RunState) => Promise<void>;
  now?: () => string;
};

/**
 * Walk `graph` from `state.cursor` until the run completes, fails or pauses.
 * Mutates and returns `state`; saves after every recorded step. Never mutates `graph`.
 *
 * The caller owns `RunState`. A run paused at an escalating cap stays at the cap: to grant
 * another round, the caller calls `grantRound(state)` (lowers `rounds[pausedCap]`), sets
 * `status = 'running'` and calls `runGraph` again.
 */
export async function runGraph(graph: Graph, state: RunState, deps: RunDeps): Promise<RunState> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { steps } = graph;
  // a resume against another graph would map cursor/rounds onto the wrong steps (and could skip a gate)
  const fingerprint = graphFingerprint(graph);
  if (state.graphFingerprint !== undefined && state.graphFingerprint !== fingerprint) {
    throw new Error('run state was recorded against a different graph (config changed since this run started); start a new run');
  }
  if (state.pendingJump && !graph.backEdges[state.pendingJump.edgeId]) {
    throw new Error(`run state has a pending jump on back-edge "${state.pendingJump.edgeId}", which is not in this graph`);
  }
  if (state.grantedRound !== undefined && !graph.backEdges[state.grantedRound]) {
    throw new Error(`run state has a granted round on back-edge "${state.grantedRound}", which is not in this graph`);
  }
  state.graphFingerprint = fingerprint;
  const indexOf = (stepId: string) => steps.findIndex((s) => s.id === stepId);
  // per visit, not persisted: still bounded, since each fresh budget needs an owner resume
  let contractRetried = false;
  if (state.status === 'running') {
    delete state.pausedReason;
    delete state.pausedCap;
    if (state.grantedRound !== undefined) {
      // the granted round starts at the loop start; the cap step is not re-run and rounds are already lowered
      jumpBack(graph.backEdges[state.grantedRound]!);
      delete state.grantedRound;
      voidOvertakenJump();
    }
  }
  const persist = async (): Promise<void> => {
    const current = steps[state.cursor];
    if (current) state.currentStep = current.id;
    else delete state.currentStep;
    await deps.save(state);
  };

  while (state.status === 'running' && state.cursor < steps.length) {
    const i = state.cursor;
    const step = steps[i]!;

    // a once hook is done only after it has passed; a fail or escalate must run it again
    if (step.role === 'hook' && step.def.once === true && state.history.some((h) => h.stepId === step.id && h.status === 'pass')) {
      state.cursor = i + 1;
      settle(i);
      // saved because the skipped hook can be the jump point, which changes cursor and rounds
      await persist();
      continue;
    }

    const ctx: RunContext = { state, graph, ...roundAt(i), previousOutputs: latestOutputs(state) };
    const startedAt = now();
    const outcome = await deps.runtime.executeStep(step, ctx);
    const endedAt = now();
    const attempt = (state.executed[step.id] ?? 0) + 1;
    state.executed[step.id] = attempt;
    const missing = missingOutputs(step, outcome, graph);
    // the owner's answers to this step are spent once it passes or fails: a contract error or an escalate (a timeout,
    // a crash, new questions, whose answers are added to these) re-runs it, and the re-run still needs them
    const unfinished = missing.length > 0 || outcome.status === 'escalate';
    if (!unfinished && state.answered?.[step.id] !== undefined) {
      delete state.answered[step.id];
      if (Object.keys(state.answered).length === 0) delete state.answered;
    }
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
      await persist();
      continue;
    }
    contractRetried = false;

    if (outcome.status === 'escalate') {
      // cursor stays on the step: resume re-runs it
      state.status = 'paused';
      if (outcome.questions !== undefined) {
        const reason = outcome.reason === undefined ? '' : `; ${outcome.reason}`;
        state.pausedReason = `questions: ${step.id} asks ${outcome.questions.length}${reason}`;
        state.asking = { kind: 'questions', stepId: step.id, attempt, items: outcome.questions };
      } else {
        state.pausedReason = outcome.reason ?? `escalate: ${step.id}`;
      }
    } else if (outcome.status === 'fail') {
      const route = graph.failRoutes[step.id];
      const edge = route === undefined ? undefined : graph.backEdges[route];
      if (!edge) {
        state.status = 'failed';
      } else if (edge.jumpAfterIndex === i) {
        // this fail decides the round; an earlier trigger on the same edge is folded into it
        if (state.pendingJump?.edgeId === edge.id) delete state.pendingJump;
        state.cursor = i + 1;
        decide(edge, i, outcome.outputs['findings'], step.id);
      } else {
        // triggered now, decided once the step at jumpAfterIndex has run (hooks run every round);
        // a later trigger on the same edge overwrites, so the latest findings win
        state.pendingJump = { edgeId: edge.id, stepId: step.id, findings: outcome.outputs['findings'] };
        state.cursor = i + 1;
      }
    } else {
      if (step.slotLast && graph.loopStages.includes(step.stage)) delete state.unresolvedFindings;
      state.cursor = i + 1;
    }
    settle(i);
    await persist();
  }
  // an answer that moves past a loop at the end of the graph leaves nothing to run
  if (state.status === 'running' && state.cursor >= steps.length) {
    state.status = 'completed';
    await persist();
  }
  return state;

  /**
   * Round and cap of the smallest back-edge span containing step `i`; 1 of 1 outside any loop.
   * The round is clamped: a resume at the cap re-runs the step in the last round, not past it.
   * `loops` lists every loop containing `i`, outermost first, counting rounds granted past a cap.
   */
  function roundAt(i: number): { round: number; maxRounds: number; loops: LoopRound[] } {
    const span = (e: BackEdge) => e.jumpAfterIndex - e.toStepIndex;
    const containing = Object.values(graph.backEdges).filter((e) => e.toStepIndex <= i && i <= e.jumpAfterIndex);
    const around = [...containing].sort((a, b) => span(b) - span(a) || a.toStepIndex - b.toStepIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const clamped = (e: BackEdge) => Math.min(1 + (state.rounds[e.id] ?? 0), e.maxRounds);
    const loops = around.map((e) => {
      const granted = state.granted?.[e.id] ?? 0;
      return { from: e.fromStepId, round: clamped(e) + granted, maxRounds: e.maxRounds, granted };
    });
    let inner: BackEdge | undefined;
    for (const e of containing) if (!inner || span(e) < span(inner)) inner = e;
    if (!inner) return { round: 1, maxRounds: 1, loops };
    return { round: clamped(inner), maxRounds: inner.maxRounds, loops };
  }

  /** After the step at `i`: resolve a pending jump that is due or overtaken, and detect completion. */
  function settle(i: number): void {
    if (state.status === 'running') {
      voidOvertakenJump();
      const pending = state.pendingJump;
      if (pending) {
        const edge = graph.backEdges[pending.edgeId]!;
        if (edge.jumpAfterIndex === i) {
          delete state.pendingJump;
          // older states have no stepId: their trigger was the edge's own step
          decide(edge, i, pending.findings, pending.stepId ?? edge.fromStepId);
        }
      }
    }
    if (state.status === 'running' && state.cursor >= steps.length) state.status = 'completed';
  }

  /** A jump back to or before a pending jump's trigger step voids the pending round. */
  function voidOvertakenJump(): void {
    const pending = state.pendingJump;
    if (!pending) return;
    // older states have no stepId: their trigger was the edge's own step
    const trigger = pending.stepId ?? graph.backEdges[pending.edgeId]!.fromStepId;
    if (state.cursor <= indexOf(trigger)) delete state.pendingJump;
  }

  /** Move the cursor to the start of `edge`'s loop; loops nested inside the re-run span start fresh. */
  function jumpBack(edge: BackEdge): void {
    state.cursor = edge.toStepIndex;
    const from = indexOf(edge.fromStepId);
    for (const other of Object.values(graph.backEdges)) {
      const t = indexOf(other.fromStepId);
      if (other.id !== edge.id && t >= edge.toStepIndex && t < from) {
        delete state.rounds[other.id];
        if (state.granted?.[other.id] !== undefined) delete state.granted[other.id];
      }
    }
  }

  /** Steps up to `i` in `edge`'s loop that route their fail to it and failed with findings in this round, in step order. */
  function failedInRound(edge: BackEdge, i: number): FindingSource[] {
    const out: FindingSource[] = [];
    // each step of the span ran this round before the cursor reached `i`, so its latest record is this round's
    for (const s of steps.slice(edge.toStepIndex, i + 1)) {
      if (graph.failRoutes[s.id] !== edge.id) continue;
      const last = state.history.findLast((h) => h.stepId === s.id && h.status !== 'contract_error');
      const f = last?.outputs['findings'];
      if (last?.status === 'fail' && typeof f === 'string') out.push({ stepId: s.id, attempt: last.attempt, findings: f });
    }
    return out;
  }

  /** Count a round on `edge` after the step at `i` (`fromStep` failed with `findings`): jump back, or apply the cap. */
  function decide(edge: BackEdge, i: number, findings: string | undefined, fromStep: string): void {
    // clamped: failing again after resuming at a cap does not count past it
    const n = Math.min((state.rounds[edge.id] ?? 0) + 1, edge.maxRounds);
    state.rounds[edge.id] = n;
    if (n < edge.maxRounds) {
      jumpBack(edge);
    } else if (edge.onCap === 'continue') {
      // a stage loop at its cap asks the owner which findings to fix; the cursor stays on the step that decided
      state.cursor = i;
      state.status = 'paused';
      state.pausedReason = `findings: ${edge.id} reached ${edge.maxRounds} rounds`;
      const also = failedInRound(edge, i).filter((f) => f.stepId !== fromStep);
      state.asking = {
        kind: 'findings',
        stepId: fromStep,
        attempt: state.executed[fromStep] ?? 0,
        edgeId: edge.id,
        ...(findings === undefined ? {} : { findings }),
        ...(also.length === 0 ? {} : { also }),
      };
    } else {
      // cursor stays on the step: resume re-runs it
      state.cursor = i;
      state.status = 'paused';
      state.pausedReason = `cap: ${edge.id} reached ${edge.maxRounds} rounds`;
      state.pausedCap = edge.id;
    }
  }
}

export function graphFingerprint(graph: Graph): string {
  const { steps, backEdges } = graph;
  return createHash('sha256')
    .update(JSON.stringify({ steps: steps.map((s) => [s.id, s.def]), backEdges }))
    .digest('hex');
}

/** Required outputs absent from a stage's last slot node (on pass; loop stages also on fail; escalate is exempt). */
function missingOutputs(step: Step, outcome: NodeOutcome, graph: Graph): string[] {
  if (!step.slotLast || step.stage === 'before-all' || step.stage === 'after-all') return [];
  if (outcome.status === 'escalate') return [];
  if (outcome.status === 'fail' && !graph.loopStages.includes(step.stage)) return [];
  return (graph.contracts[step.stage] ?? []).filter((k) => typeof outcome.outputs[k] !== 'string');
}

/** Copies of each step's latest valid (non-contract_error) outputs: a runtime cannot alter history. */
function latestOutputs(state: RunState): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const h of state.history) if (h.status !== 'contract_error') out[h.stepId] = h.outputs;
  // the owner's answers override the outputs of the step they answer
  for (const [stepId, answers] of Object.entries(state.answered ?? {})) out[stepId] = { ...out[stepId], ...answers };
  return structuredClone(out);
}
