import { FEATURE } from '../graph/core.ts';
import type { PipelineHeader } from '../graph/core.ts';
import type { MergedPipeline } from '../graph/merge.ts';
import { ConfigError } from './load.ts';
import type { Where } from './locate.ts';

/** A pipeline's header with every default filled in: what a run request is checked against. */
export type PipelineSpec = PipelineHeader & {
  name: string;
  ticket: 'required' | 'optional' | 'none';
  inputs: Record<string, { required: boolean; description?: string }>;
  default: boolean;
};

const fail = (message: string, where: Where): ConfigError => new ConfigError(message, where.file, where.line);

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
  return specs;
}
