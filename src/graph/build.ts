import { ConfigError } from '../config/load.ts';
import { locate, slotKey } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import type { NodeDef, Stage } from '../config/schema.ts';
import { EXIT_BUILTIN, EXIT_KINDS } from '../tracker/index.ts';
import type { ExitKind } from '../tracker/index.ts';
import { CORE_GROOM_GATE, FEATURE, STAGE_CONTRACTS } from './core.ts';
import type { PipelineHeader } from './core.ts';
import type { Merged, MergedPipeline, Sourced } from './merge.ts';

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
  /** the pipeline this graph runs */
  pipeline: string;
  /** the pipeline's stages, in order; the last one is the exit stage */
  stages: string[];
  /** stage → output keys its last slot node must write */
  contracts: Record<string, string[]>;
  exit: ExitKind | 'route';
  /** stages whose last slot loops back to the stage before them (review, and any with max_rounds) */
  loopStages: string[];
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

const EXIT_VERB: Record<ExitKind, string> = { pr: 'opens the PR' };

/**
 * Output keys each stage of a pipeline must write. feature keeps the core contracts; other pipelines
 * take their `outputs`, falling back to the core contract of a stage named like a feature stage, and
 * the exit's own output on the exit stage.
 */
export function contractsFor(header: PipelineHeader, name: string): Record<string, string[]> {
  const stages = header.stages ?? [];
  const exitOutputs: Record<ExitKind, string[]> = { pr: ['pr_url'] };
  const out: Record<string, string[]> = {};
  stages.forEach((stage, i) => {
    const core = (STAGE_CONTRACTS as Record<string, { requiredOutputs: readonly string[] }>)[stage]?.requiredOutputs;
    if (name === 'feature') {
      out[stage] = [...(core ?? [])];
      return;
    }
    const own = header.outputs?.[stage];
    if (stage === 'intake') out[stage] = [...new Set(['ticket', ...(own ?? [])])];
    else if (i === stages.length - 1 && header.exit !== undefined) out[stage] = [...new Set([...exitOutputs[header.exit], ...(own ?? [])])];
    else out[stage] = [...(own ?? core ?? [])];
  });
  return out;
}

function describeNode(d: NodeDef): string {
  if (d.builtin !== undefined) return `builtin ${d.builtin}`;
  if (d.kind === 'gate') return 'a gate';
  if (d.agent !== undefined) return `agent ${d.agent}`;
  return 'a command';
}

/**
 * Builds the run graph of one pipeline from merged layers (a plain Merged is the feature pipeline).
 * `home` is the selected profile and where it is written: unbound stages are reported there, because
 * that is where a binding is added.
 */
export function buildGraph(merged: Readonly<Merged | MergedPipeline>, home?: { profile: string; locator: Locator }): Graph {
  const named = 'header' in merged ? (merged as MergedPipeline) : undefined;
  const name = named?.name ?? 'feature';
  const isFeature = name === 'feature';
  const { name: _f, ...featureHeader } = FEATURE;
  const headerSourced: Sourced<PipelineHeader> = named?.header ?? { value: featureHeader as PipelineHeader, source: 'core', locked: false };
  const header = headerSourced.value;
  const at = (key: string) => locate(headerSourced.locator, 'config', `pipelines.${name}${key}`);

  if (header.stages === undefined) {
    if (!isFeature) {
      throw new GraphError(`pipeline "${name}" needs stages: list them, starting with intake and ending with its exit stage`, at(''));
    }
  }
  const stages = [...(header.stages ?? FEATURE.stages ?? [])];
  if (stages[0] !== 'intake') {
    throw new GraphError(`pipeline "${name}" must start with intake; add intake as its first stage`, at('.stages'));
  }
  stages.forEach((s, i) => {
    if (stages.indexOf(s) !== i) {
      throw new GraphError(`stage "${s}" is listed twice in pipeline "${name}"; list each stage once`, at(`.stages.${i}`));
    }
  });
  const exitStage = stages.at(-1)!;

  // what runs each stage: the merged bindings, plus the defaults a named pipeline gets
  const bindings: Record<string, Sourced<NodeDef[]>> = { ...merged.bindings };
  let exit: ExitKind | undefined = header.exit;
  if (!isFeature) {
    bindings.intake ??= { value: [{ builtin: 'github.intake' }], source: 'core', locked: false };
    const bound = bindings[exitStage];
    if (bound === undefined && exit !== undefined) {
      bindings[exitStage] = { value: [{ builtin: EXIT_BUILTIN[exit] }], source: 'core', locked: false };
    }
  }

  const unbound = stages.filter((s) => bindings[s] === undefined);
  if (!isFeature && unbound.includes(exitStage) && exit === undefined) {
    throw new GraphError(
      `pipeline "${name}" has no exit: bind its last stage "${exitStage}" to one of ${EXIT_KINDS.map((k) => EXIT_BUILTIN[k]).join(', ')} or set exit:`,
      at(''),
    );
  }
  if (unbound.length > 0) {
    if (isFeature) {
      if (home === undefined) throw new GraphError(`stages unbound: ${unbound.join(', ')}; bind each under bindings:`);
      const { path: _path, ...where } = locate(home.locator, 'config', 'bindings');
      throw new GraphError(`profile "${home.profile}" leaves stages unbound: ${unbound.join(', ')}; bind each under bindings:`, where);
    }
    const message = `pipeline "${name}" in profile "${home?.profile ?? 'default'}" leaves stages unbound: ${unbound.join(', ')}; bind each under pipelines.${name}.bindings:`;
    if (home === undefined) throw new GraphError(message, at(''));
    const { path: _path, ...where } = locate(home.locator, 'config', `pipelines.${name}.bindings`);
    throw new GraphError(message, where);
  }

  // the exit stage: never an agent; on a named pipeline its binding and exit: agree
  const exitBinding = bindings[exitStage]!;
  const exitAt = () => locate(exitBinding.locator, 'config', `bindings.${exitStage}`);
  if (exitBinding.value.some((d) => d.kind === 'agent' || d.agent !== undefined)) {
    const kind = exit ?? 'pr';
    throw new GraphError(
      `${exitStage} cannot be an agent node: Percolator ${EXIT_VERB[kind]} itself (use { builtin: ${EXIT_BUILTIN[kind]} })`,
      exitAt(),
    );
  }
  if (!isFeature) {
    const only = exitBinding.value.length === 1 ? exitBinding.value[0]! : undefined;
    if (exit === undefined) {
      exit = EXIT_KINDS.find((k) => only?.builtin === EXIT_BUILTIN[k]);
      if (exit === undefined) {
        throw new GraphError(
          `pipeline "${name}" has no exit: bind its last stage "${exitStage}" to one of ${EXIT_KINDS.map((k) => EXIT_BUILTIN[k]).join(', ')} or set exit:`,
          at(''),
        );
      }
    } else if (only?.builtin !== EXIT_BUILTIN[exit]) {
      const wrong = exitBinding.value.find((d) => d.builtin !== EXIT_BUILTIN[exit!]) ?? exitBinding.value[0]!;
      throw new GraphError(
        `exit ${exit} runs ${EXIT_BUILTIN[exit]}, but stage "${exitStage}" is bound to ${describeNode(wrong)}; bind it to { builtin: ${EXIT_BUILTIN[exit]} } or change exit`,
        exitAt(),
      );
    }
  }

  const hooks = Object.entries(merged.nodes).map(([nodeName, sourced]) => {
    const def = sourced.value;
    if (def.before === undefined && def.after === undefined) {
      throw new GraphError(
        `extension node "${nodeName}" needs "before" or "after"; attach it to a stage or all`,
        locate(sourced.locator, 'config', `nodes.${nodeName}`),
      );
    }
    for (const point of ['before', 'after'] as const) {
      const target = def[point];
      if (target !== undefined && target !== 'all' && !stages.includes(target)) {
        throw new GraphError(
          `"${point}: ${target}" names no stage of pipeline "${name}" (stages: ${stages.join(', ')}); attach it to one of those or all`,
          locate(sourced.locator, 'config', `nodes.${nodeName}.${point}`),
        );
      }
    }
    return { name: nodeName, def, source: sourced.source, locked: sourced.locked, ...(sourced.locator ? { locator: sourced.locator } : {}) };
  });

  const steps: Step[] = [];
  const regionStart = {} as Record<Stage, number>;
  const pushHook = (h: (typeof hooks)[number], stage: Step['stage']) =>
    steps.push({ id: h.name, name: h.name, stage, role: 'hook', def: h.def, slotLast: false, source: h.source, locked: h.locked, ...(h.locator ? { locator: h.locator } : {}) });

  for (const h of hooks.filter((h) => h.def.before === 'all')) pushHook(h, 'before-all');
  for (const stage of stages) {
    const before = hooks.filter((h) => h.def.before === stage);
    regionStart[stage] = steps.length;
    for (const h of before) pushHook(h, stage);
    const binding = bindings[stage]!;
    const slot = binding.value;
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

  // loop stages: review always (default 3 rounds), any other stage whose last slot node sets max_rounds
  const lastSlotOf = (stage: string) => steps.findLast((s) => s.role === 'slot' && s.stage === stage)!;
  const loopStages = stages.filter((stage) => stage === 'review' || lastSlotOf(stage).def.max_rounds !== undefined);
  if (loopStages[0] === 'intake') {
    const step = lastSlotOf('intake');
    throw new GraphError(
      'stage "intake" cannot loop: there is no stage before it; remove max_rounds',
      locate(step.locator, 'config', `bindings.intake`),
    );
  }
  const loopLast = new Map(loopStages.map((stage) => [lastSlotOf(stage), stage]));

  const ceiling = Math.min(...merged.rules.map((r) => r.value.max_rounds_ceiling ?? Infinity));
  const backEdges: Record<string, BackEdge> = {};
  for (const step of steps) {
    const onFail = step.def.on_fail;
    if (!onFail) continue;
    const where = (key: string) => locate(step.locator, 'config', `${stepKey(step)}.${key}`);
    const loopStage = loopLast.get(step);
    if (loopStage !== undefined) {
      throw new GraphError(
        loopStage === 'review'
          ? 'review loop is core-owned; set max_rounds on the review binding instead'
          : `${loopStage} loop is set by max_rounds on its binding; remove on_fail from its last node`,
        where('on_fail'),
      );
    }
    if (step.stage === 'before-all') {
      throw new GraphError(
        'a before-all hook cannot declare on_fail (no earlier stage to return to); remove on_fail or attach the hook to a stage',
        where('on_fail'),
      );
    }
    if (!stages.includes(onFail.back_to)) {
      throw new GraphError(
        `back_to "${onFail.back_to}" is not a stage of pipeline "${name}" (stages: ${stages.join(', ')}); use one of those`,
        where('on_fail.back_to'),
      );
    }
    // an after-all hook runs past the last stage, so it may target any stage
    const own = step.stage === 'after-all' ? stages.length - 1 : stages.indexOf(step.stage);
    if (stages.indexOf(onFail.back_to) > own) {
      throw new GraphError(
        `back_to must point to an earlier stage (got "${onFail.back_to}" at "${step.id}"); use "${stages[own]}" or an earlier stage`,
        where('on_fail.back_to'),
      );
    }
    backEdges[step.id] = {
      id: step.id,
      fromStepId: step.id,
      toStepIndex: regionStart[onFail.back_to]!,
      jumpAfterIndex: steps.indexOf(step),
      // rule checks exempt the core gate, so its cap is clamped to the ceiling here
      maxRounds: step.role === 'hook' && step.id === CORE_GROOM_GATE.name ? Math.min(onFail.max_rounds, ceiling) : onFail.max_rounds,
      onCap: 'escalate',
    };
  }

  const failRoutes: Record<string, string> = {};
  for (const stage of loopStages) {
    const last = lastSlotOf(stage);
    const previous = stages[stages.indexOf(stage) - 1]!;
    backEdges[last.id] = {
      id: last.id,
      fromStepId: last.id,
      toStepIndex: regionStart[previous]!,
      // after-hooks of the stage run every round, so the jump happens after the stage's last step
      jumpAfterIndex: steps.findLastIndex((s) => s.stage === stage),
      maxRounds: last.def.max_rounds ?? 3,
      onCap: 'continue',
    };
    // any slot node's fail in a loop stage is a round of it; a step's own on_fail is more specific
    for (const s of steps) if (s.role === 'slot' && s.stage === stage) failRoutes[s.id] = last.id;
  }
  for (const id of Object.keys(backEdges)) failRoutes[id] = id;

  return {
    pipeline: name,
    stages,
    contracts: contractsFor({ ...header, stages, ...(exit !== undefined ? { exit } : {}) }, name),
    exit: exit ?? 'pr',
    loopStages,
    steps,
    regionStart,
    backEdges,
    failRoutes,
  };
}
