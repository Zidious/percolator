import { ConfigError } from '../config/load.ts';
import { locate, slotKey } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import type { NodeDef, Stage } from '../config/schema.ts';
import { CORE_GROOM_GATE, CORE_STAGES } from './core.ts';
import type { Merged } from './merge.ts';

export type Step = {
  id: string;
  name: string;
  stage: Stage | 'before-all' | 'after-all';
  role: 'hook' | 'slot';
  def: NodeDef;
  /** last node of a stage slot: the stage contract is checked here */
  slotLast: boolean;
  /** layer source of the binding or node this step came from (`core` for the groom gate) */
  source: string;
  /** the binding or node is a `required: true` lock */
  locked: boolean;
  /** where the binding or node was written, for errors */
  locator?: Locator;
  /** key path of this step's node in its layer (`bindings.review.0`, `nodes.audit`); see stepKey */
  key?: string;
};

/** Key path of the step's node, for errors: its recorded key, else `bindings.<id>` / `nodes.<id>`. */
export function stepKey(step: Step): string {
  return step.key ?? `${step.role === 'hook' ? 'nodes' : 'bindings'}.${step.id}`;
}

export type BackEdge = {
  id: string;
  fromStepId: string;
  toStepIndex: number;
  /** the engine performs the jump after running the step at this index */
  jumpAfterIndex: number;
  maxRounds: number;
  onCap: 'continue' | 'escalate';
};

export type Graph = {
  steps: Step[];
  regionStart: Record<Stage, number>;
  backEdges: Record<string, BackEdge>;
  /** stepId → id of the back-edge its `fail` triggers; a step with no route fails the run */
  failRoutes: Record<string, string>;
};

/** A graph that cannot be built; reported at `where` (the offending key), or `config` when that is unknown. */
export class GraphError extends ConfigError {
  constructor(message: string, where?: Where) {
    super(message, where?.file ?? 'config', where?.line, where?.path);
    this.name = 'GraphError';
  }
}

/**
 * Builds the run graph from merged layers. `home` is the selected profile and where it is written:
 * unbound stages are reported there, because that is where a binding is added.
 */
export function buildGraph(merged: Readonly<Merged>, home?: { profile: string; locator: Locator }): Graph {
  const unbound = CORE_STAGES.filter((s) => merged.bindings[s] === undefined);
  if (unbound.length > 0) {
    if (home === undefined) throw new GraphError(`stages unbound: ${unbound.join(', ')}; bind each under bindings:`);
    const { path: _path, ...at } = locate(home.locator, 'config', 'bindings');
    throw new GraphError(`profile "${home.profile}" leaves stages unbound: ${unbound.join(', ')}; bind each under bindings:`, at);
  }

  const hooks = Object.entries(merged.nodes).map(([name, sourced]) => {
    const def = sourced.value;
    if (def.before === undefined && def.after === undefined) {
      throw new GraphError(
        `extension node "${name}" needs "before" or "after"; attach it to a stage or all`,
        locate(sourced.locator, 'config', `nodes.${name}`),
      );
    }
    return { name, def, source: sourced.source, locked: sourced.locked, ...(sourced.locator ? { locator: sourced.locator } : {}) };
  });

  const steps: Step[] = [];
  const regionStart = {} as Record<Stage, number>;
  const pushHook = (h: (typeof hooks)[number], stage: Step['stage']) =>
    steps.push({ id: h.name, name: h.name, stage, role: 'hook', def: h.def, slotLast: false, source: h.source, locked: h.locked, ...(h.locator ? { locator: h.locator } : {}) });

  for (const h of hooks.filter((h) => h.def.before === 'all')) pushHook(h, 'before-all');
  for (const stage of CORE_STAGES) {
    const before = hooks.filter((h) => h.def.before === stage);
    regionStart[stage] = steps.length;
    for (const h of before) pushHook(h, stage);
    const binding = merged.bindings[stage]!;
    const slot = binding.value;
    if (stage === 'deliver' && slot.some((d) => d.kind === 'agent' || d.agent !== undefined)) {
      throw new GraphError(
        'deliver cannot be an agent node: Percolator opens the PR itself (use { builtin: github.open_pr })',
        locate(binding.locator, 'config', 'bindings.deliver'),
      );
    }
    slot.forEach((def, i) => {
      steps.push({
        id: slot.length > 1 ? `${stage}.${i}` : stage,
        name: stage,
        stage,
        role: 'slot',
        def,
        slotLast: i === slot.length - 1,
        source: binding.source,
        locked: binding.locked,
        ...(binding.locator ? { locator: binding.locator } : {}),
        key: slotKey(binding.locator, stage, i, slot.length),
      });
    });
    for (const h of hooks.filter((h) => h.def.after === stage)) pushHook(h, stage);
  }
  for (const h of hooks.filter((h) => h.def.after === 'all')) pushHook(h, 'after-all');

  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) {
      // the hook is the one to rename, whichever of the two comes first
      const hook = s.role === 'hook' ? s : steps.find((x) => x.id === s.id && x.role === 'hook');
      throw new GraphError(`node "${s.id}" clashes with a core step id; rename it`, locate(hook?.locator, 'config', `nodes.${s.id}`));
    }
    seen.add(s.id);
  }

  const ceiling = Math.min(...merged.rules.map((r) => r.value.max_rounds_ceiling ?? Infinity));
  const reviewSlot = merged.bindings.review!.value;
  const lastReview = steps.findLast((s) => s.role === 'slot' && s.stage === 'review')!;
  const lastReviewRegion = steps.findLastIndex((s) => s.stage === 'review');

  const backEdges: Record<string, BackEdge> = {};
  for (const step of steps) {
    const onFail = step.def.on_fail;
    if (!onFail) continue;
    const at = (key: string) =>
      locate(step.locator, 'config', `${stepKey(step)}.${key}`);
    if (step === lastReview) {
      throw new GraphError('review loop is core-owned; set max_rounds on the review binding instead', at('on_fail'));
    }
    if (step.stage === 'before-all') {
      throw new GraphError(
        'a before-all hook cannot declare on_fail (no earlier stage to return to); remove on_fail or attach the hook to a stage',
        at('on_fail'),
      );
    }
    // an after-all hook runs past the last stage, so it may target any stage
    const own = step.stage === 'after-all' ? CORE_STAGES.length - 1 : CORE_STAGES.indexOf(step.stage);
    if (CORE_STAGES.indexOf(onFail.back_to) > own) {
      throw new GraphError(
        `back_to must point to an earlier stage (got "${onFail.back_to}" at "${step.id}"); use "${CORE_STAGES[own]}" or an earlier stage`,
        at('on_fail.back_to'),
      );
    }
    backEdges[step.id] = {
      id: step.id,
      fromStepId: step.id,
      toStepIndex: regionStart[onFail.back_to],
      jumpAfterIndex: steps.indexOf(step),
      // rule checks exempt the core gate, so its cap is clamped to the ceiling here
      maxRounds: step.role === 'hook' && step.id === CORE_GROOM_GATE.name ? Math.min(onFail.max_rounds, ceiling) : onFail.max_rounds,
      onCap: 'escalate',
    };
  }

  backEdges[lastReview.id] = {
    id: lastReview.id,
    fromStepId: lastReview.id,
    toStepIndex: regionStart.implement,
    // after:review hooks run every round, so the jump happens after the last review-region step
    jumpAfterIndex: lastReviewRegion,
    maxRounds: reviewSlot[reviewSlot.length - 1]!.max_rounds ?? 3,
    onCap: 'continue',
  };

  const failRoutes: Record<string, string> = {};
  // any review slot node's fail is a review round; a step's own on_fail is more specific
  for (const s of steps) if (s.role === 'slot' && s.stage === 'review') failRoutes[s.id] = lastReview.id;
  for (const id of Object.keys(backEdges)) failRoutes[id] = id;

  return { steps, regionStart, backEdges, failRoutes };
}
