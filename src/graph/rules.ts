import { effectiveKind } from '../config/schema.ts';
import type { NodeDef, Stage } from '../config/schema.ts';
import { CORE_STAGES } from './core.ts';
import type { Merged } from './merge.ts';

export type Violation = { rule: string; source: string; target: string; message: string };

const DEFAULT_REVIEW_ROUNDS = 3;

type Entry = { target: string; node: NodeDef; stage?: Stage; core?: boolean };

/** Every node in deterministic order: bindings in stage order, then extension nodes by name. */
function entries(merged: Merged): Entry[] {
  const out: Entry[] = [];
  for (const stage of CORE_STAGES) {
    const nodes = merged.bindings[stage]?.value ?? [];
    nodes.forEach((node, i) => {
      out.push({ target: nodes.length > 1 ? `bindings.${stage}.${i}` : `bindings.${stage}`, node, stage });
    });
  }
  for (const name of Object.keys(merged.nodes).sort()) {
    const { value, source } = merged.nodes[name]!;
    out.push({ target: `nodes.${name}`, node: value, core: source === 'core' });
  }
  return out;
}

const isAgent = (n: NodeDef) => effectiveKind(n) === 'agent';

/**
 * Checks every rule set against the merged config. Pure. Violations come in layer order of the
 * rule set, then stage order, then node name. allowed_* and max_rounds_ceiling are enforced as an
 * intersection / minimum across rule sets; each offending node is reported once, against the first
 * rule set (in layer order) that excludes it.
 */
export function checkRules(merged: Merged): Violation[] {
  const out: Violation[] = [];
  const all = entries(merged);
  const sets = merged.rules;

  sets.forEach(({ value: rules, source }, idx) => {
    for (const req of rules.require_skills ?? []) {
      for (const { target, node, stage } of all) {
        if (!isAgent(node)) continue;
        if (req.stage !== '*' && stage !== req.stage) continue;
        const have = [...(node.skills ?? []), ...(node.skill !== undefined ? [node.skill] : [])];
        const missing = req.skills.filter((s) => !have.includes(s));
        if (missing.length > 0) {
          out.push({
            rule: 'require_skills',
            source,
            target,
            message: `${target} is missing required skill(s) ${missing.join(', ')}, required by require_skills (from ${source})`,
          });
        }
      }
    }

    for (const [rule, field] of [
      ['allowed_agents', 'agent'],
      ['allowed_models', 'model'],
    ] as const) {
      const allowed = rules[rule];
      if (allowed === undefined) continue;
      for (const { target, node } of all) {
        const value = node[field];
        if (!isAgent(node) || value === undefined || allowed.includes(value)) continue;
        const excludedEarlier = sets.slice(0, idx).some((s) => s.value[rule] !== undefined && !s.value[rule]!.includes(value));
        if (excludedEarlier) continue;
        const list = allowed.length > 0 ? allowed.join(', ') : '(nothing)';
        out.push({
          rule,
          source,
          target,
          message: `${target} uses ${field} "${value}", but ${rule} (from ${source}) allows: ${list}`,
        });
      }
    }

    const ceiling = rules.max_rounds_ceiling;
    if (ceiling !== undefined) {
      const exceededEarlier = (rounds: number) =>
        sets.slice(0, idx).some((s) => s.value.max_rounds_ceiling !== undefined && rounds > s.value.max_rounds_ceiling);
      for (const { target, node, stage, core } of all) {
        // Only nodes whose merged source is 'core' (never keyed by name) are exempt. The ceiling is
        // enforced on the core gate by buildGraph clamping its back-edge, not here.
        if (core) continue;
        if (stage === 'review') {
          const rounds = node.max_rounds ?? DEFAULT_REVIEW_ROUNDS;
          if (rounds > ceiling && !exceededEarlier(rounds)) {
            out.push({
              rule: 'max_rounds_ceiling',
              source,
              target,
              message: `${target} allows ${rounds} review rounds, over max_rounds_ceiling ${ceiling} (from ${source})`,
            });
          }
        }
        const back = node.on_fail?.max_rounds;
        if (back !== undefined && back > ceiling && !exceededEarlier(back)) {
          out.push({
            rule: 'max_rounds_ceiling',
            source,
            target: `${target}.on_fail`,
            message: `${target}.on_fail allows ${back} rounds, over max_rounds_ceiling ${ceiling} (from ${source})`,
          });
        }
      }
    }

    for (const name of rules.required_nodes ?? []) {
      if (!(name in merged.nodes)) {
        out.push({
          rule: 'required_nodes',
          source,
          target: `nodes.${name}`,
          message: `node "${name}" is required by required_nodes (from ${source}) but is not defined`,
        });
      }
    }
  });
  return out;
}
