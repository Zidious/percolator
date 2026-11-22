import { isDeepStrictEqual } from 'node:util';
import { ConfigError } from '../config/load.ts';
import { locate, place } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import type { NodeDef, Rules, Stage } from '../config/schema.ts';
import type { Layer } from '../grounds/mappings.ts';
import { CORE_GROOM_GATE } from './core.ts';

export type Sourced<T> = { value: T; source: string; locked: boolean; locator?: Locator };

export type Merged = {
  bindings: Record<Stage, Sourced<NodeDef[]>>;
  nodes: Record<string, Sourced<NodeDef>>;
  rules: Sourced<Rules>[];
};

/** A later layer tried to change a `required: true` target. Reported at the attempt; the message names the lock's place. */
export class LockViolation extends ConfigError {
  target: string;
  lockedBy: string;
  attemptedBy: string;

  constructor(o: {
    target: string;
    noun: 'binding' | 'node' | 'mapping';
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

export function mergeLayers(layers: Layer[]): Merged {
  const merged: Merged = {
    bindings: {},
    nodes: { [CORE_GROOM_GATE.name]: { value: structuredClone(CORE_GROOM_GATE.def) as NodeDef, source: 'core', locked: true } },
    rules: [],
  };
  for (const { source, fragment, locator } of layers) {
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
    for (const [stage, binding] of Object.entries(fragment.bindings ?? {}) as [Stage, NodeDef | NodeDef[]][]) {
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
    if (fragment.rules) merged.rules.push({ value: structuredClone(fragment.rules), source, locked: false, ...at });
  }
  return merged;
}
