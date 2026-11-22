import { isDeepStrictEqual } from 'node:util';
import { ConfigError } from '../config/load.ts';
import { locate, place } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import type { NodeDef, Pipeline, Rules, Stage } from '../config/schema.ts';
import type { Layer } from '../grounds/mappings.ts';
import { CORE_GROOM_GATE, FEATURE } from './core.ts';
import type { PipelineHeader } from './core.ts';

export type Sourced<T> = { value: T; source: string; locked: boolean; locator?: Locator };

/** A rule set; `scope` says whether it came from the top level (applies to every pipeline) or from `pipelines.<p>.rules`. */
export type RuleSet = Sourced<Rules> & { scope?: 'global' | 'pipeline' };

export type Merged = {
  bindings: Record<Stage, Sourced<NodeDef[]>>;
  nodes: Record<string, Sourced<NodeDef>>;
  rules: RuleSet[];
};

/** A later layer tried to change a `required: true` target. Reported at the attempt; the message names the lock's place. */
export class LockViolation extends ConfigError {
  target: string;
  lockedBy: string;
  attemptedBy: string;

  constructor(o: {
    target: string;
    noun: 'binding' | 'node' | 'mapping' | 'pipeline';
    lockedBy: string;
    attemptedBy: string;
    attempt: Where;
    lock: Where;
  }) {
    const subject = o.noun === 'mapping' ? `mapping ${o.target} is ` : '';
    const message =
      o.lockedBy === 'core'
        ? `${subject}locked by Percolator core (required: true); remove this ${o.noun}: ${o.target.replace(/^nodes\./, '')} is built in`
        : `${subject}locked by ${place(o.lock)} (required: true); remove this ${o.noun} or restate it exactly`;
    super(message, o.attempt.file, o.attempt.line, o.attempt.path);
    this.name = 'LockViolation';
    this.target = o.target;
    this.lockedBy = o.lockedBy;
    this.attemptedBy = o.attemptedBy;
  }
}

/** One pipeline after every layer merged: what runs its stages, plus its header (stages, exit, ticket, inputs…). */
export type MergedPipeline = Merged & { name: string; header: Sourced<PipelineHeader> };

const HEADER_KEYS = ['default', 'description', 'stages', 'outputs', 'exit', 'ticket', 'inputs', 'router', 'routes', 'choose', 'fallback', 'next', 'triggers', 'fan_out'] as const;

function headerOf(p: Pipeline): PipelineHeader {
  const h: Record<string, unknown> = {};
  for (const k of HEADER_KEYS) if (p[k] !== undefined) h[k] = structuredClone(p[k]);
  return h as PipelineHeader;
}

function withPrefix(locator: Locator | undefined, name: string): Locator | undefined {
  if (locator === undefined) return undefined;
  return { ...locator, prefix: [locator.prefix, 'pipelines', name].filter((x) => x !== undefined && x !== '').join('.') };
}

/**
 * Merges layers into one entry per pipeline. Top-level bindings and nodes belong to feature; top-level
 * rules apply to every pipeline; `pipelines.<p>` merges per pipeline. The core groom gate is seeded into
 * feature only, and kept only while feature has a groom stage.
 */
export function mergePipelines(layers: Layer[]): Record<string, MergedPipeline> {
  const { name: _n, ...featureHeader } = FEATURE;
  const out: Record<string, MergedPipeline> = {};
  const pipeline = (name: string): MergedPipeline =>
    (out[name] ??= {
      name,
      bindings: {},
      nodes:
        name === 'feature'
          ? { [CORE_GROOM_GATE.name]: { value: structuredClone(CORE_GROOM_GATE.def) as NodeDef, source: 'core', locked: true } }
          : {},
      rules: [],
      header: { value: name === 'feature' ? (structuredClone(featureHeader) as PipelineHeader) : {}, source: 'core', locked: false },
    });
  pipeline('feature');
  const globalRules: RuleSet[] = [];

  for (const { source, fragment, locator } of layers) {
    mergeInto(pipeline('feature'), { bindings: fragment.bindings, nodes: fragment.nodes }, source, locator);
    if (fragment.rules) globalRules.push({ value: structuredClone(fragment.rules), source, locked: false, scope: 'global', ...(locator ? { locator } : {}) });
    for (const [name, def] of Object.entries(fragment.pipelines ?? {})) {
      const target = pipeline(name);
      // errors about the pipeline as a whole point at the first layer that names it
      if (target.header.locator === undefined && locator !== undefined) target.header.locator = locator;
      const header = headerOf(def);
      if (Object.keys(header).length > 0 || def.required === true) {
        const existing = target.header;
        if (existing.locked) {
          if (!isDeepStrictEqual(existing.value, header)) {
            throw new LockViolation({
              target: `pipelines.${name}`,
              noun: 'pipeline',
              lockedBy: existing.source,
              attemptedBy: source,
              attempt: locate(locator, source, `pipelines.${name}`),
              lock: locate(existing.locator, existing.source, `pipelines.${name}`),
            });
          }
        } else {
          target.header = {
            value: def.required === true ? header : { ...existing.value, ...header },
            source,
            locked: def.required === true,
            ...(locator ? { locator } : {}),
          };
        }
      }
      const inner = withPrefix(locator, name);
      mergeInto(target, { bindings: def.bindings, nodes: def.nodes }, source, inner);
      if (def.rules) target.rules.push({ value: structuredClone(def.rules), source, locked: false, scope: 'pipeline', ...(inner ? { locator: inner } : {}) });
    }
  }
  for (const p of Object.values(out)) p.rules.unshift(...structuredClone(globalRules));
  const feature = out.feature!;
  if (!(feature.header.value.stages ?? []).includes('groom')) delete feature.nodes[CORE_GROOM_GATE.name];
  return out;
}

function mergeInto(
  merged: Merged,
  fragment: { bindings?: Record<string, NodeDef | NodeDef[]> | undefined; nodes?: Record<string, NodeDef> | undefined },
  source: string,
  locator: Locator | undefined,
): void {
  const violation = (target: string, noun: 'binding' | 'node', existing: Sourced<unknown>) =>
    new LockViolation({
      target,
      noun,
      lockedBy: existing.source,
      attemptedBy: source,
      attempt: locate(locator, source, target),
      lock: locate(existing.locator, existing.source, target),
    });
  const at = locator !== undefined ? { locator } : {};
  for (const [stage, binding] of Object.entries(fragment.bindings ?? {})) {
    const value = structuredClone(Array.isArray(binding) ? binding : [binding]);
    const existing = merged.bindings[stage];
    if (existing?.locked) {
      if (isDeepStrictEqual(existing.value, value)) continue;
      throw violation(`bindings.${stage}`, 'binding', existing);
    }
    merged.bindings[stage] = { value, source, locked: value.some((n) => n.required === true), ...at };
  }
  for (const [name, def] of Object.entries(fragment.nodes ?? {})) {
    const existing = merged.nodes[name];
    if (existing?.locked) {
      if (isDeepStrictEqual(existing.value, def)) continue;
      throw violation(`nodes.${name}`, 'node', existing);
    }
    merged.nodes[name] = { value: structuredClone(def), source, locked: def.required === true, ...at };
  }
}

/** The feature pipeline of the merged layers (the shape every pre-pipeline caller expects). */
export function mergeLayers(layers: Layer[]): MergedPipeline {
  return mergePipelines(layers).feature!;
}
