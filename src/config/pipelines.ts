import { FEATURE } from '../graph/core.ts';
import type { PipelineHeader } from '../graph/core.ts';
import type { MergedPipeline } from '../graph/merge.ts';
import type { Violation } from '../graph/rules.ts';
import { EXITS, EXIT_KINDS } from '../tracker/index.ts';
import type { ExitKind } from '../tracker/index.ts';
import { ConfigError } from './load.ts';
import { locate } from './locate.ts';
import type { Where } from './locate.ts';

/** A pipeline's header with every default filled in: what a run request is checked against. */
export type PipelineSpec = PipelineHeader & {
  name: string;
  ticket: 'required' | 'optional' | 'none';
  inputs: Record<string, { required: boolean; description?: string }>;
  default: boolean;
};

const fail = (message: string, where: Where): ConfigError => new ConfigError(message, where.file, where.line, where.path);

/** The profile's default pipeline: the one marked `default: true`, else feature. */
export function defaultPipeline(specs: Record<string, PipelineSpec>, profile: string, where: Where): string {
  const marked = Object.values(specs).filter((s) => s.default);
  if (marked.length > 1) {
    throw fail(`profile "${profile}" marks more than one default pipeline (${marked.map((s) => s.name).join(', ')}); keep default: true on one`, where);
  }
  if (marked.length === 1) return marked[0]!.name;
  if (specs.feature !== undefined) return 'feature';
  throw fail(`profile "${profile}" has no default pipeline; mark one with default: true`, where);
}

/** The pipeline named `name`, or the profile's default when no name is given. */
export function pickPipeline(specs: Record<string, PipelineSpec>, name: string | undefined, profile: string, where: Where): PipelineSpec {
  const picked = specs[name ?? defaultPipeline(specs, profile, where)];
  if (picked === undefined) {
    throw fail(
      `unknown pipeline "${name}" in profile "${profile}" (pipelines: ${Object.keys(specs).join(', ')}); pass one of those to --pipeline`,
      where,
    );
  }
  return picked;
}

/**
 * Top-level require_skills entries naming a stage that no pipeline of the profile has. checkRules skips
 * those per pipeline (a global rule need not fit every pipeline), so this catches the typo across them.
 */
export function checkGlobalStages(merged: Record<string, MergedPipeline>, specs: Record<string, PipelineSpec>, profile: string): Violation[] {
  const stages = new Set(Object.values(specs).flatMap((s) => s.stages ?? []));
  const out: Violation[] = [];
  // every pipeline carries the same copy of the top-level rule sets; feature always exists
  for (const { value, source, locator, scope } of merged.feature?.rules ?? []) {
    if (scope !== 'global') continue;
    for (const [k, req] of (value.require_skills ?? []).entries()) {
      if (req.stage === '*' || stages.has(req.stage)) continue;
      out.push({
        rule: 'require_skills',
        source,
        target: `rules.require_skills.${k}`,
        message: `names stage "${req.stage}", which no pipeline in profile "${profile}" has; use one of their stages or *`,
        where: locate(locator, source, `rules.require_skills.${k}.stage`),
      });
    }
  }
  return out;
}

/**
 * The specs of the merged pipelines, defaults filled in and the default pipeline marked. feature is
 * listed only when it has bindings or some layer defines it under `pipelines:`.
 */
export function pipelineSpecs(merged: Record<string, MergedPipeline>, profile: string, where: Where): Record<string, PipelineSpec> {
  const specs: Record<string, PipelineSpec> = {};
  for (const [name, p] of Object.entries(merged)) {
    const h = p.header;
    const defined = Object.keys(p.bindings).length > 0 || h.source !== 'core' || h.locator !== undefined;
    if (name === 'feature' && !defined) continue;
    const base: PipelineHeader = name === 'feature' ? { ...FEATURE } : {};
    const { name: _n, ...header } = { ...base, ...h.value } as PipelineHeader & { name?: string };
    specs[name] = {
      ...structuredClone(header),
      name,
      ticket: header.ticket ?? 'required',
      inputs: structuredClone(header.inputs ?? {}),
      default: header.default === true,
    };
  }
  const def = defaultPipeline(specs, profile, where);
  specs[def]!.default = true;
  // a router's fallback: the profile default, or feature when the default is a router (checkPipelines refuses none)
  const fallback = specs[def]!.router === true ? (specs.feature !== undefined ? 'feature' : undefined) : def;
  for (const s of Object.values(specs)) {
    if (s.router === true && s.fallback === undefined && fallback !== undefined) s.fallback = fallback;
  }
  return specs;
}

/** The pipeline's exit: as written, else the one its last stage's single builtin runs. */
function exitKind(spec: PipelineSpec, merged: MergedPipeline): ExitKind | undefined {
  if (spec.exit !== undefined) return spec.exit;
  const nodes = merged.bindings[spec.stages?.at(-1) ?? '']?.value ?? [];
  return nodes.length === 1 ? EXIT_KINDS.find((k) => EXITS[k].builtin === nodes[0]!.builtin) : undefined;
}

/**
 * Checks that span pipelines: where a router may hand its ticket. Every routes `to`, choose `from` entry
 * and fallback must name a pipeline of the profile that is not a router and takes a ticket. Throws the
 * first problem, located at the offending key of `merged`.
 */
export function checkPipelines(merged: Record<string, MergedPipeline>, specs: Record<string, PipelineSpec>, profile: string): void {
  for (const spec of Object.values(specs)) {
    const p = spec.name;
    const h = merged[p]!.header;
    const at = (key: string): Where => locate(h.locator, h.source, `pipelines.${p}${key}`);
    const target = (x: string, where: Where): void => {
      const t = specs[x];
      if (t === undefined) {
        throw fail(`route to "${x}" names no pipeline in profile "${profile}" (pipelines: ${Object.keys(specs).join(', ')}); use one of those`, where);
      }
      if (spec.router === true && t.router === true) {
        throw fail(`router "${p}" cannot route to router "${x}"; route to a pipeline that does the work`, where);
      }
      if (t.ticket === 'none') {
        const self = spec.router === true ? 'router' : 'pipeline';
        throw fail(`${self} "${p}" routes tickets, but pipeline "${x}" has ticket: none; route to a pipeline that takes a ticket`, where);
      }
    };
    if (spec.next !== undefined) {
      if (exitKind(spec, merged[p]!) !== 'issue') throw fail('next only applies to an issue exit; remove it or set exit: issue', at('.next'));
      target(spec.next, at('.next'));
    }
    if (spec.router !== true) continue;
    if (spec.ticket !== 'required') {
      throw fail(`router "${p}" hands its ticket to another pipeline, so it needs one; set ticket: required or remove ticket`, at('.ticket'));
    }
    (spec.routes ?? []).forEach((r, i) => target(r.to, at(`.routes.${i}.to`)));
    (spec.choose?.from ?? []).forEach((x, i) => target(x, at(`.choose.from.${i}`)));
    const written = h.value.fallback !== undefined;
    if (spec.fallback === undefined) {
      const def = Object.values(specs).find((s) => s.default)?.name;
      throw fail(
        `router "${p}" has no fallback: the profile default "${def}" is a router and there is no feature pipeline; set fallback to a pipeline that does the work`,
        at(''),
      );
    }
    target(spec.fallback, at(written ? '.fallback' : ''));
  }
}
