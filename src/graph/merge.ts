import { isDeepStrictEqual } from 'node:util';
import { ConfigError } from '../config/load.ts';
import type { NodeDef, Rules, Stage } from '../config/schema.ts';
import type { Layer } from '../grounds/mappings.ts';
import { CORE_GROOM_GATE } from './core.ts';

export type Sourced<T> = { value: T; source: string; locked: boolean };

export type Merged = {
  bindings: Partial<Record<Stage, Sourced<NodeDef[]>>>;
  nodes: Record<string, Sourced<NodeDef>>;
  rules: Sourced<Rules>[];
};

export class LockViolation extends ConfigError {
  target: string;
  lockedBy: string;
  attemptedBy: string;

  constructor(target: string, lockedBy: string, attemptedBy: string) {
    super(
      `${target} is locked by ${lockedBy}; ${attemptedBy} cannot change it`,
      attemptedBy,
      undefined,
      target,
      `${target} is locked by ${lockedBy}; ${attemptedBy} cannot change it`,
    );
    this.name = 'LockViolation';
    this.target = target;
    this.lockedBy = lockedBy;
    this.attemptedBy = attemptedBy;
  }
}

export function mergeLayers(layers: Layer[]): Merged {
  const merged: Merged = {
    bindings: {},
    nodes: { [CORE_GROOM_GATE.name]: { value: structuredClone(CORE_GROOM_GATE.def) as NodeDef, source: 'core', locked: true } },
    rules: [],
  };
  for (const { source, fragment } of layers) {
    for (const [stage, binding] of Object.entries(fragment.bindings ?? {}) as [Stage, NodeDef | NodeDef[]][]) {
      const value = structuredClone(Array.isArray(binding) ? binding : [binding]);
      const existing = merged.bindings[stage];
      if (existing?.locked) {
        if (isDeepStrictEqual(existing.value, value)) continue;
        throw new LockViolation(`bindings.${stage}`, existing.source, source);
      }
      merged.bindings[stage] = { value, source, locked: value.some((n) => n.required === true) };
    }
    for (const [name, def] of Object.entries(fragment.nodes ?? {})) {
      const existing = merged.nodes[name];
      if (existing?.locked) {
        if (isDeepStrictEqual(existing.value, def)) continue;
        throw new LockViolation(`nodes.${name}`, existing.source, source);
      }
      merged.nodes[name] = { value: structuredClone(def), source, locked: def.required === true };
    }
    if (fragment.rules) merged.rules.push({ value: structuredClone(fragment.rules), source, locked: false });
  }
  return merged;
}
