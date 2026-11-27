import { ConfigError } from '../config/load.ts';
import { locate, slotKey } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import { effectiveKind } from '../config/schema.ts';
import type { NodeDef, Stage } from '../config/schema.ts';
import { EXITS, EXIT_KINDS } from '../tracker/index.ts';
import type { ExitKind } from '../tracker/index.ts';
import { CORE_GROOM_GATE, DEFAULT_MAX_ROUNDS, FEATURE, PICK_GATE, ROUTE_CHOOSE, STAGE_CONTRACTS } from './core.ts';
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
  /** a router's pick-pipeline gate: the pipelines it may pick (not fingerprinted) */
  choices?: string[];
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
  /**
   * `continue`: a stage loop (review, `max_rounds`); at its cap the run pauses and asks the owner which findings to fix.
   * The name predates that and is kept so the graph fingerprints of runs in flight still match.
   * `escalate`: an `on_fail` back-edge; at its cap the run pauses until the owner grants a round.
   */
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

/** What each input an exit needs is, for the error that asks for it. */
const NEEDED_INPUT: Record<string, string> = { pr: 'the pull request to review', advisory: 'the GHSA id' };

/**
 * Output keys each stage of a pipeline must write. feature keeps the core contracts; other pipelines
 * take their `outputs`, falling back to the core contract of a stage named like a feature stage, and
 * the exit's own output on the exit stage.
 */
export function contractsFor(header: PipelineHeader, name: string): Record<string, string[]> {
  const stages = header.stages ?? [];
  const out: Record<string, string[]> = {};
  stages.forEach((stage, i) => {
    const core = (STAGE_CONTRACTS as Record<string, { requiredOutputs: readonly string[] }>)[stage]?.requiredOutputs;
    if (name === 'feature') {
      out[stage] = [...(core ?? [])];
      return;
    }
    const own = header.outputs?.[stage];
    if (stage === 'intake') out[stage] = [...new Set(['ticket', ...(own ?? [])])];
    else if (i === stages.length - 1 && header.router === true) out[stage] = [...new Set(['route', ...(own ?? [])])];
    else if (i === stages.length - 1 && header.exit !== undefined) out[stage] = [...new Set([...exitOutputs(header.exit), ...(own ?? [])])];
    else out[stage] = [...(own ?? core ?? [])];
  });
  return out;
}

function exitOutputs(kind: ExitKind): string[] {
  const output = EXITS[kind].output;
  return output === undefined ? [] : [output];
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
export type BuildOptions = {
  /** pipeline name → description, for the choose agent's default prompt of a router */
  descriptions?: Readonly<Record<string, string | undefined>>;
  /**
   * Which part of a fan-out pipeline to build: `parent` (the default when fan_out is set) runs up to the
   * fanned stage and ends in its fan-out step; `{ sliceFrom }` is one slice's run, from that stage on.
   */
  part?: 'parent' | { sliceFrom: string };
};

/** The default task of a router's choose agent. */
function pickPrompt(from: readonly string[], descriptions: BuildOptions['descriptions']): string {
  const list = from.map((p) => (descriptions?.[p] !== undefined ? `${p}: ${descriptions[p]}` : p)).join('; ');
  return `Pick the pipeline for this ticket from: ${list}. Write pick.md: first line "pipeline: <name>", second line "unsure: true" or "unsure: false", then your reasons. Feedback from an earlier pick, if any, is in the inputs.`;
}

/** The step id of a router's pick gate; perc status shows it by this name. */

export function buildGraph(
  merged: Readonly<Merged | MergedPipeline>,
  home?: { profile: string; locator: Locator },
  o: BuildOptions = {},
): Graph {
  const { graph, fanStage } = buildWhole(merged, home, o);
  if (typeof o.part === 'object') return sliceChild(graph, o.part.sliceFrom);
  if (fanStage === undefined) return graph;
  // a slice's loops are checked whichever part is built, so validate refuses them before any run starts
  sliceChild(graph, fanStage);
  return sliceParent(graph, fanStage);
}

/** The whole pipeline's graph, and the stage it fans out at (if any). */
function buildWhole(
  merged: Readonly<Merged | MergedPipeline>,
  home: { profile: string; locator: Locator } | undefined,
  o: BuildOptions,
): { graph: Graph; fanStage?: string } {
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
  const fan = header.fan_out;
  if (fan !== undefined) {
    if (!stages.includes(fan.stage)) {
      throw new GraphError(
        `fan_out.stage "${fan.stage}" is not a stage of pipeline "${name}"; use one of ${stages.join(', ')}`,
        at('.fan_out.stage'),
      );
    }
    if (fan.stage === 'intake' || fan.stage === exitStage) {
      throw new GraphError('fan_out.stage cannot be intake or the exit stage', at('.fan_out.stage'));
    }
    const from = stages.indexOf(fan.slices.from);
    if (from < 0 || from >= stages.indexOf(fan.stage)) {
      throw new GraphError(`fan_out.slices.from must be a stage before ${fan.stage}`, at('.fan_out.slices.from'));
    }
  }
  const router = header.router === true;
  if (router) {
    if (exitStage !== 'route') {
      throw new GraphError(`router pipeline "${name}" must end with stage route; make route its last stage`, at('.stages'));
    }
    if (header.exit !== undefined) {
      throw new GraphError(
        `router pipeline "${name}" cannot set exit: its route stage hands the ticket to another pipeline; remove exit`,
        at('.exit'),
      );
    }
    const bound = merged.bindings.route;
    if (bound !== undefined) {
      throw new GraphError(
        'stage "route" of a router is built in; configure it with routes, choose and fallback',
        locate(bound.locator, 'config', 'bindings.route'),
      );
    }
  }

  // what runs each stage: the merged bindings, plus the defaults a named pipeline gets
  const bindings: Record<string, Sourced<NodeDef[]>> = { ...merged.bindings };
  let exit: ExitKind | undefined = header.exit;
  if (!isFeature) {
    bindings.intake ??= { value: [{ builtin: 'github.intake' }], source: 'core', locked: false };
    const bound = bindings[exitStage];
    if (bound === undefined && exit !== undefined) {
      bindings[exitStage] = { value: [{ builtin: EXITS[exit].builtin }], source: 'core', locked: false };
    }
  }

  const unbound = stages.filter((s) => bindings[s] === undefined && !(router && s === exitStage));
  if (!isFeature && unbound.includes(exitStage) && exit === undefined) {
    throw new GraphError(
      `pipeline "${name}" has no exit: bind its last stage "${exitStage}" to one of ${EXIT_KINDS.map((k) => EXITS[k].builtin).join(', ')} or set exit:`,
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
  if (!router) {
    const exitBinding = bindings[exitStage]!;
    const exitAt = () => locate(exitBinding.locator, 'config', `bindings.${exitStage}`);
    if (exitBinding.value.some((d) => d.kind === 'agent' || d.agent !== undefined)) {
      const kind = exit ?? 'pr';
      throw new GraphError(
        `${exitStage} cannot be an agent node: Percolator ${EXITS[kind].verb} itself (use { builtin: ${EXITS[kind].builtin} })`,
        exitAt(),
      );
    }
    if (!isFeature) {
      const only = exitBinding.value.length === 1 ? exitBinding.value[0]! : undefined;
      if (exit === undefined) {
        exit = EXIT_KINDS.find((k) => only?.builtin === EXITS[k].builtin);
        if (exit === undefined) {
          throw new GraphError(
            `pipeline "${name}" has no exit: bind its last stage "${exitStage}" to one of ${EXIT_KINDS.map((k) => EXITS[k].builtin).join(', ')} or set exit:`,
            at(''),
          );
        }
      } else if (only?.builtin !== EXITS[exit].builtin) {
        const wrong = exitBinding.value.find((d) => d.builtin !== EXITS[exit!].builtin) ?? exitBinding.value[0]!;
        throw new GraphError(
          `exit ${exit} runs ${EXITS[exit].builtin}, but stage "${exitStage}" is bound to ${describeNode(wrong)}; bind it to { builtin: ${EXITS[exit].builtin} } or change exit`,
          exitAt(),
        );
      }
      // what the exit needs from the pipeline: a ticket, an input, or (release) a tag
      const needs = EXITS[exit].needs;
      if (needs?.ticket && header.ticket !== undefined && header.ticket !== 'required') {
        throw new GraphError(
          `exit ${exit} posts on the run's issue, but pipeline "${name}" has ticket: ${header.ticket}; set ticket: required or pick another exit`,
          at(''),
        );
      }
      if (needs?.input !== undefined && header.inputs?.[needs.input] === undefined) {
        throw new GraphError(
          `exit ${exit} needs input "${needs.input}" (${NEEDED_INPUT[needs.input]}); declare it under pipelines.${name}.inputs`,
          at(''),
        );
      }
      if (needs?.input !== undefined && header.inputs?.[needs.input]?.required !== true) {
        throw new GraphError(
          `exit ${exit} needs input "${needs.input}" (${NEEDED_INPUT[needs.input]}) on every run, but pipeline "${name}" makes it optional; set required: true on pipelines.${name}.inputs.${needs.input}`,
          at(''),
        );
      }
      if (exit === 'release' && header.inputs?.tag === undefined && !stages.slice(0, -1).some((s) => header.outputs?.[s]?.includes('tag'))) {
        throw new GraphError('exit release needs a tag: declare input "tag" or list "tag" under outputs of an earlier stage', at(''));
      }
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
    if (router && stage === exitStage) {
      steps.push(...routeSlot());
      for (const h of hooks.filter((h) => h.def.after === stage)) pushHook(h, stage);
      continue;
    }
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

  /** A router's route stage: label rules, the choose agent and its pick gate (when choose is set), then the handoff. */
  function routeSlot(): Step[] {
    const { choose } = header;
    const where = { source: headerSourced.source, locked: headerSourced.locked, ...(headerSourced.locator ? { locator: headerSourced.locator } : {}) };
    // ids keep their place whether or not choose is set, so route.3 is always the handoff
    const defs: { id: string; def: NodeDef; key: string }[] = [{ id: 'route.0', def: { builtin: 'percolator.route_rules' }, key: 'router' }];
    if (choose !== undefined) {
      const { from, confirm: _c, prompt, ...agent } = choose;
      defs.push({ id: ROUTE_CHOOSE, def: { ...agent, prompt: prompt ?? pickPrompt(from, o.descriptions) }, key: 'choose' });
      defs.push({ id: PICK_GATE, def: { kind: 'gate', on_fail: { back_to: 'route', max_rounds: 3 } }, key: 'choose' });
    }
    defs.push({ id: 'route.3', def: { builtin: 'percolator.route' }, key: 'router' });
    return defs.map((d, i) => ({
      id: d.id,
      name: d.id === PICK_GATE ? PICK_GATE : 'route',
      stage: 'route',
      role: 'slot' as const,
      def: d.def,
      slotLast: i === defs.length - 1,
      ...where,
      key: `pipelines.${name}.${d.key}`,
      ...(d.id === PICK_GATE && choose !== undefined ? { choices: [...choose.from] } : {}),
    }));
  }

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

  // the user cannot change these gates' caps, so the rules' ceiling clamps them here
  const builtInGate = (step: Step) =>
    (step.role === 'hook' && step.id === CORE_GROOM_GATE.name) || (router && step.role === 'slot' && step.id === PICK_GATE);
  const ceiling = Math.min(...merged.rules.map((r) => r.value.max_rounds_ceiling ?? Infinity));
  const backEdges: Record<string, BackEdge> = {};
  for (const step of steps) {
    const onFail = step.def.on_fail;
    if (!onFail) {
      if (!loopLast.has(step) && isImplicitGate(step, loopStages, steps)) {
        const to = implicitBackTo(step, stages, steps);
        backEdges[step.id] = {
          id: step.id,
          fromStepId: step.id,
          toStepIndex: regionStart[to]!,
          jumpAfterIndex: steps.indexOf(step),
          maxRounds: Math.min(3, ceiling),
          onCap: 'escalate',
        };
      }
      continue;
    }
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
      maxRounds: builtInGate(step) ? Math.min(onFail.max_rounds, ceiling) : onFail.max_rounds,
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
      maxRounds: last.def.max_rounds ?? DEFAULT_MAX_ROUNDS,
      onCap: 'continue',
    };
    // any slot node's fail in a loop stage is a round of it; a step's own on_fail is more specific
    for (const s of steps) if (s.role === 'slot' && s.stage === stage) failRoutes[s.id] = last.id;
    // so is a reject of a gate without on_fail after a node of it (one opening the stage has its own edge)
    for (const s of steps) {
      if (s.stage !== stage || s === last || s.def.on_fail !== undefined || s.def.kind !== 'gate' || !followsOwnStage(s, steps)) continue;
      // its reject is a round of the loop, so the stage the loop goes back to must have an agent to act on it
      if (!hasAgent(previous, steps)) {
        throw new GraphError(
          `gate "${s.id}" runs after ${stage}, whose loop goes back to ${previous}, a stage with no agent to act on a reject; give it on_fail: { back_to: <stage>, max_rounds: <n> }, or attach it before ${stage}`,
          locate(s.locator, 'config', s.role === 'hook' ? `${stepKey(s)}.after` : stepKey(s)),
        );
      }
      failRoutes[s.id] = last.id;
    }
  }
  for (const id of Object.keys(backEdges)) failRoutes[id] = id;

  const contracts = contractsFor({ ...header, stages, ...(exit !== undefined ? { exit } : {}) }, name);
  if (fan !== undefined) contracts[fan.slices.from] = [...new Set([...contracts[fan.slices.from]!, fan.slices.output])];
  const graph: Graph = {
    pipeline: name,
    stages,
    contracts,
    exit: router ? 'route' : (exit ?? 'pr'),
    loopStages,
    steps,
    regionStart,
    backEdges,
    failRoutes,
  };
  return fan === undefined ? { graph } : { graph, fanStage: fan.stage };
}

/**
 * A gate with no on_fail that gets its own edge: a reject sends the run back to the stage it follows. One after a
 * node of a loop stage counts as a round of that loop instead; one opening a loop stage goes back at once, so a
 * rejected round does not run the stage first.
 */
function isImplicitGate(step: Step, loopStages: readonly string[], steps: readonly Step[]): boolean {
  if (step.def.on_fail !== undefined || step.def.kind !== 'gate') return false;
  return !loopStages.includes(step.stage) || !followsOwnStage(step, steps);
}

/** The gate runs after its stage's work: `after: <stage>`, or a slot gate after another node of its slot. */
function followsOwnStage(step: Step, steps: readonly Step[]): boolean {
  if (step.role === 'hook') return step.def.after === step.stage;
  return steps.some((s) => s.role === 'slot' && s.stage === step.stage && steps.indexOf(s) < steps.indexOf(step));
}

/**
 * The stage a gate without on_fail goes back to on reject: the stage it runs after (`after: X`, or a slot
 * gate after another node of its slot), else the stage before the one it opens. A stage with no agent
 * (intake, a script-only stage) could not act on the feedback, so the reject goes back to the nearest
 * earlier stage that has one. Refused when there is none.
 */
function implicitBackTo(step: Step, stages: readonly string[], steps: readonly Step[]): string {
  const target = followedStage(step, stages, steps);
  const back = stages.slice(0, stages.indexOf(target) + 1).findLast((stage) => hasAgent(stage, steps));
  if (back !== undefined) return back;
  const first = stages.find((stage) => hasAgent(stage, steps));
  const followsOwn = followsOwnStage(step, steps);
  const key = step.role === 'slot' ? stepKey(step) : `${stepKey(step)}.${followsOwn ? 'after' : 'before'}`;
  throw new GraphError(
    `gate "${step.id}" runs ${followsOwn ? 'after' : 'before'} ${step.stage}, so a reject has no earlier stage with an agent to go back to; ${first === undefined ? 'give it on_fail: { back_to: <stage>, max_rounds: <n> }' : `attach it after ${first} or a later stage`}, or remove it`,
    locate(step.locator, 'config', key),
  );
}

/** The stage has an agent slot node, which can act on a reject's feedback. */
function hasAgent(stage: string, steps: readonly Step[]): boolean {
  return steps.some((s) => s.role === 'slot' && s.stage === stage && effectiveKind(s.def) === 'agent');
}

/** The stage a gate without on_fail follows: see implicitBackTo. */
function followedStage(step: Step, stages: readonly string[], steps: readonly Step[]): string {
  const where = (key: string) => locate(step.locator, 'config', key);
  if (step.stage === 'before-all') {
    throw new GraphError(
      `gate "${step.id}" runs before all stages, so a reject has no stage to go back to; attach it before or after a stage, or remove it`,
      where(`${stepKey(step)}.before`),
    );
  }
  if (step.stage === 'after-all') {
    throw new GraphError(
      `gate "${step.id}" runs after all stages, so a reject has no stage to go back to; attach it after a stage, or give it on_fail: { back_to: <stage>, max_rounds: <n> }`,
      where(`${stepKey(step)}.after`),
    );
  }
  const stage = step.stage;
  const followsOwn = followsOwnStage(step, steps);
  if (followsOwn && stage === stages.at(-1)) {
    throw new GraphError(
      `gate "${step.id}" runs after ${stage}, the exit stage, so a reject would deliver again; attach it before ${stage}, or give it on_fail: { back_to: <stage>, max_rounds: <n> }`,
      where(step.role === 'hook' ? `${stepKey(step)}.after` : stepKey(step)),
    );
  }
  if (followsOwn) return stage;
  const previous = stages[stages.indexOf(stage) - 1];
  if (previous === undefined) {
    throw new GraphError(
      `gate "${step.id}" runs before ${stage}, so a reject has no earlier stage to go back to; attach it after ${stage} or a later stage, or remove it`,
      where(step.role === 'hook' ? `${stepKey(step)}.before` : stepKey(step)),
    );
  }
  return previous;
}

/** A built-in step standing in for a stage's slot. */
function builtStep(id: string, stage: string, builtin: string): Step {
  return { id, name: id, stage, role: 'slot', def: { builtin }, slotLast: true, source: 'core', locked: false };
}

function refuseClash(steps: readonly Step[], id: string): void {
  const clash = steps.find((s) => s.id === id);
  if (clash !== undefined) {
    throw new GraphError(`node "${id}" clashes with a core step id; rename it`, locate(clash.locator, 'config', stepKey(clash)));
  }
}

/** Keeps the edges (and the fail routes to them) the kept steps use, with step indexes moved by `shift`. */
function keepEdges(g: Graph, keep: (e: BackEdge) => boolean, ids: Set<string>, shift: number) {
  const backEdges: Record<string, BackEdge> = {};
  for (const [id, e] of Object.entries(g.backEdges)) {
    if (keep(e)) backEdges[id] = { ...e, toStepIndex: e.toStepIndex - shift, jumpAfterIndex: e.jumpAfterIndex - shift };
  }
  const failRoutes = Object.fromEntries(Object.entries(g.failRoutes).filter(([step, edge]) => ids.has(step) && edge in backEdges));
  return { backEdges, failRoutes };
}

/** A fan-out run: every step before the fanned stage, then the fan-out step that starts and waits for the slices. */
function sliceParent(g: Graph, fanStage: string): Graph {
  const cut = g.regionStart[fanStage]!;
  const before = g.steps.slice(0, cut);
  refuseClash(before, fanStage);
  const steps = [...before, builtStep(fanStage, fanStage, 'percolator.fan_out')];
  const stages = g.stages.slice(0, g.stages.indexOf(fanStage) + 1);
  const earlier = stages.slice(0, -1);
  return {
    ...g,
    stages,
    contracts: { ...Object.fromEntries(earlier.map((s) => [s, g.contracts[s]!])), [fanStage]: ['slices_done'] },
    loopStages: g.loopStages.filter((s) => earlier.includes(s)),
    steps,
    regionStart: Object.fromEntries(stages.map((s) => [s, g.regionStart[s]!])),
    ...keepEdges(g, (e) => e.jumpAfterIndex < cut, new Set(steps.map((s) => s.id)), 0),
  };
}

/**
 * One slice's run: a seed step as its intake (the parent's outputs plus the slice), then every step from
 * `sliceFrom` on, with loop indexes moved onto the shorter step list. A loop back before `sliceFrom` is refused.
 */
function sliceChild(g: Graph, sliceFrom: string): Graph {
  if (!g.stages.includes(sliceFrom) || sliceFrom === 'intake') {
    throw new GraphError(
      `stage "${sliceFrom}" of pipeline "${g.pipeline}" cannot start a fan-out slice; set fan_out.stage to a stage after intake`,
    );
  }
  const cut = g.regionStart[sliceFrom]!;
  for (const e of Object.values(g.backEdges)) {
    if (e.jumpAfterIndex < cut || e.toStepIndex >= cut) continue;
    const step = g.steps.find((s) => s.id === e.fromStepId)!;
    const target = g.stages.find((s) => g.regionStart[s] === e.toStepIndex)!;
    const key = step.def.on_fail !== undefined ? `${stepKey(step)}.on_fail.back_to` : stepKey(step);
    if (step.def.on_fail === undefined && g.loopStages.includes(step.stage)) {
      // a stage loop always returns to the stage before it, so only an earlier fan-out stage can hold it
      throw new GraphError(
        `${step.stage} loops back to ${target} every round, so it cannot start a fan-out slice; set fan_out.stage to ${target} or an earlier stage`,
        locate(step.locator, 'config', key),
      );
    }
    if (isImplicitGate(step, g.loopStages, g.steps)) {
      throw new GraphError(
        `${step.id} goes back to ${target} on reject (a gate without on_fail returns to the stage it follows), which runs before the fan-out at ${sliceFrom}; attach it after ${sliceFrom} or later, or give it on_fail with back_to ${sliceFrom} or later`,
        locate(step.locator, 'config', key),
      );
    }
    throw new GraphError(
      `${step.id} loops back to ${target}, which runs before the fan-out at ${sliceFrom}; loop back to ${sliceFrom} or later`,
      locate(step.locator, 'config', key),
    );
  }
  const after = g.steps.slice(cut);
  refuseClash(after, 'intake');
  const steps = [builtStep('intake', 'intake', 'percolator.seed'), ...after];
  const stages = ['intake', ...g.stages.slice(g.stages.indexOf(sliceFrom))];
  const shift = cut - 1;
  return {
    ...g,
    stages,
    contracts: { intake: ['ticket', 'slice'], ...Object.fromEntries(stages.slice(1).map((s) => [s, g.contracts[s]!])) },
    loopStages: g.loopStages.filter((s) => stages.includes(s)),
    steps,
    regionStart: { intake: 0, ...Object.fromEntries(stages.slice(1).map((s) => [s, g.regionStart[s]! - shift])) },
    ...keepEdges(g, (e) => e.jumpAfterIndex >= cut, new Set(steps.map((s) => s.id)), shift),
  };
}
