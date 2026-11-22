import { STAGES } from '../config/schema.ts';
import type { NodeDef, Pipeline, Stage } from '../config/schema.ts';

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const CORE_STAGES: readonly Stage[] = Object.freeze([...STAGES]);

export const STAGE_CONTRACTS: Readonly<Record<Stage, { readonly requiredOutputs: readonly string[] }>> = deepFreeze({
  intake: { requiredOutputs: ['ticket'] },
  groom: { requiredOutputs: ['groomed_ticket'] },
  plan: { requiredOutputs: ['plan'] },
  implement: { requiredOutputs: ['summary'] },
  review: { requiredOutputs: ['findings'] },
  deliver: { requiredOutputs: ['pr_url'] },
});

/** Frozen: mergeLayers clones it per call, so callers can never mutate the core lock. */
export const CORE_GROOM_GATE: Readonly<{ name: 'approve-groom'; def: Readonly<NodeDef> }> = deepFreeze({
  name: 'approve-groom' as const,
  def: { kind: 'gate', after: 'groom', required: true, on_fail: { back_to: 'groom', max_rounds: 3 } } as NodeDef,
});

/** A pipeline's own settings: everything but what runs its stages (bindings, nodes, rules, use) and its lock flag. */
export type PipelineHeader = Omit<Pipeline, 'bindings' | 'nodes' | 'rules' | 'use' | 'required'>;

/** The built-in feature pipeline: today's six stages, ending in a PR. */
export const FEATURE: Readonly<PipelineHeader & { name: 'feature' }> = deepFreeze({
  name: 'feature' as const,
  stages: [...STAGES],
  exit: 'pr' as const,
  ticket: 'required' as const,
  inputs: {},
});
