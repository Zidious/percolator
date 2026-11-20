import { STAGES } from '../config/schema.ts';
import type { NodeDef, Stage } from '../config/schema.ts';

export const CORE_STAGES: readonly Stage[] = STAGES;

export const STAGE_CONTRACTS: Record<Stage, { requiredOutputs: string[] }> = {
  intake: { requiredOutputs: ['ticket'] },
  groom: { requiredOutputs: ['groomed_ticket'] },
  plan: { requiredOutputs: ['plan'] },
  implement: { requiredOutputs: ['summary'] },
  review: { requiredOutputs: ['findings'] },
  deliver: { requiredOutputs: ['pr_url'] },
};

export const CORE_GROOM_GATE: { name: 'approve-groom'; def: NodeDef } = {
  name: 'approve-groom',
  def: { kind: 'gate', after: 'groom', required: true, on_fail: { back_to: 'groom', max_rounds: 3 } },
};
