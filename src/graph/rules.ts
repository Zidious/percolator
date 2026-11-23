import { ConfigError } from '../config/load.ts';
import { formatIssue, locate, place, slotKey } from '../config/locate.ts';
import type { Locator, Where } from '../config/locate.ts';
import { effectiveKind } from '../config/schema.ts';
import type { NodeDef, Stage } from '../config/schema.ts';
import { CORE_GROOM_GATE, CORE_STAGES } from './core.ts';
import type { Merged, MergedPipeline } from './merge.ts';

/** `message` is the body only; `where` is the offending key's file, line and path (see formatIssue). */
export type Violation = { rule: string; source: string; target: string; message: string; where: Where };

const DEFAULT_REVIEW_ROUNDS = 3;

type Entry = {
  target: string;
  node: NodeDef;
  stage?: Stage;
  core?: boolean;
  /** the last slot node of its stage: where a stage loop's max_rounds is read */
  last?: boolean;
  source: string;
  locator?: Locator;
};

/** Every node in deterministic order: bindings in stage order, then extension nodes by name. */
function entries(merged: Merged | MergedPipeline, stages: readonly string[]): Entry[] {
  const out: Entry[] = [];
  for (const stage of stages) {
    const binding = merged.bindings[stage];
    const nodes = binding?.value ?? [];
    nodes.forEach((node, i) => {
      out.push({
        target: slotKey(binding!.locator, stage, i, nodes.length),
        node,
        stage,
        last: i === nodes.length - 1,
        source: binding!.source,
        ...(binding!.locator ? { locator: binding!.locator } : {}),
      });
    });
  }
  for (const name of Object.keys(merged.nodes).sort()) {
    const { value, source, locator } = merged.nodes[name]!;
    out.push({ target: `nodes.${name}`, node: value, core: source === 'core', source, ...(locator ? { locator } : {}) });
  }
  // a router's choose agent is an agent node too, run in its route stage
  if ('header' in merged && merged.header.value.choose !== undefined) {
    const { from: _f, confirm: _c, prompt: _p, ...agent } = merged.header.value.choose;
    const { source, locator } = merged.header;
    out.push({ target: `pipelines.${merged.name}.choose`, node: agent, stage: 'route', source, ...(locator ? { locator } : {}) });
  }
  return out;
}

/** `before <stage>` / `after <stage>`, or `unattached` for a node with no hook position. */
function position(p: { before?: string; after?: string }): string {
  if (p.before !== undefined) return `before ${p.before}`;
  if (p.after !== undefined) return `after ${p.after}`;
  return 'unattached';
}

const isAgent = (n: NodeDef) => effectiveKind(n) === 'agent';

/**
 * Whether a top-level required_nodes entry concerns a pipeline with these stages: not when it names the
 * core groom gate (only feature with a groom stage has it) or attaches to a stage the pipeline lacks.
 * Entries that concern no pipeline of the profile are reported once, by checkGlobalStages.
 */
export function appliesTo(req: string | { name: string; before?: string; after?: string }, stages: readonly string[]): boolean {
  const name = typeof req === 'string' ? req : req.name;
  if (name === CORE_GROOM_GATE.name) return false;
  if (typeof req === 'string') return true;
  const at = req.before ?? req.after;
  return at === undefined || at === 'all' || stages.includes(at);
}

/**
 * Checks every rule set against the merged config. Pure. Violations come in layer order of the
 * rule set, then stage order, then node name. allowed_* and max_rounds_ceiling are enforced as an
 * intersection / minimum across rule sets; each offending node is reported once, against the first
 * rule set (in layer order) that excludes it. `stages` are the pipeline's: require_skills naming a
 * stage outside them is a violation for a pipeline's own rules and skipped for top-level ones.
 */
export function checkRules(merged: Merged | MergedPipeline, stages: readonly string[] = CORE_STAGES): Violation[] {
  const out: Violation[] = [];
  const all = entries(merged, stages);
  const sets = merged.rules;
  const pipeline = 'name' in merged ? merged.name : 'feature';

  sets.forEach(({ value: rules, source, locator: ruleLocator, scope }, idx) => {
    // where the rule is written: `file:line`, or the layer source without a locator
    const from = (rule: string) => place(locate(ruleLocator, source, `rules.${rule}`));
    const at = (e: { source: string; locator?: Locator }, target: string) => locate(e.locator, e.source, target);
    for (const [k, req] of (rules.require_skills ?? []).entries()) {
      if (req.stage !== '*' && !stages.includes(req.stage)) {
        // a top-level rule applies to every pipeline, so one this pipeline lacks the stage for is not its concern
        if (scope === 'global') continue;
        out.push({
          rule: 'require_skills',
          source,
          target: `rules.require_skills.${k}`,
          message: `names stage "${req.stage}", which pipeline "${pipeline}" does not have (stages: ${stages.join(', ')}); use one of those or *`,
          where: locate(ruleLocator, source, `rules.require_skills.${k}.stage`),
        });
        continue;
      }
      if (req.stage !== '*') {
        const binding = merged.bindings[req.stage];
        if (binding !== undefined && !binding.value.some(isAgent)) {
          out.push({
            rule: 'require_skills',
            source,
            target: `bindings.${req.stage}`,
            message: `has no agent node, but require_skills (from ${from('require_skills')}) requires skill(s) ${req.skills.join(', ')} there; bind an agent node there or remove the rule`,
            where: at(binding, `bindings.${req.stage}`),
          });
        }
      }
      for (const e of all) {
        const { target, node, stage } = e;
        if (!isAgent(node)) continue;
        if (req.stage !== '*' && stage !== req.stage) continue;
        const have = [...(node.skills ?? []), ...(node.skill !== undefined ? [node.skill] : [])];
        const missing = req.skills.filter((s) => !have.includes(s));
        if (missing.length > 0) {
          out.push({
            rule: 'require_skills',
            source,
            target,
            message: `missing required skill(s) ${missing.join(', ')}, required by require_skills (from ${from('require_skills')}); add them to its skills:`,
            where: at(e, target),
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
      const list = allowed.join(', ');
      // an empty list admits no agent node at all, so naming a value to pick would be advice no one can follow
      const none = `${rule} (from ${from(rule)}) allows no ${field}s; use a non-agent node here or change that rule`;
      for (const e of all) {
        const { target, node } = e;
        if (!isAgent(node)) continue;
        const value = node[field];
        if (value === undefined) {
          // fail closed: an unset model is not an allowed one (agent is required by the schema)
          if (sets.slice(0, idx).some((s) => s.value[rule] !== undefined)) continue;
          out.push({
            rule,
            source,
            target,
            message: allowed.length === 0 ? `has no ${field}, but ${none}` : `has no ${field}, but ${rule} (from ${from(rule)}) requires one of: ${list}; set ${field}: to one of them`,
            where: at(e, target),
          });
          continue;
        }
        if (allowed.includes(value)) continue;
        const excludedEarlier = sets.slice(0, idx).some((s) => s.value[rule] !== undefined && !s.value[rule]!.includes(value));
        if (excludedEarlier) continue;
        out.push({
          rule,
          source,
          target,
          message: allowed.length === 0 ? `uses ${field} "${value}", but ${none}` : `uses ${field} "${value}", but ${rule} (from ${from(rule)}) allows: ${list}; use one of those`,
          where: at(e, target),
        });
      }
    }

    const ceiling = rules.max_rounds_ceiling;
    if (ceiling !== undefined) {
      const exceededEarlier = (rounds: number) =>
        sets.slice(0, idx).some((s) => s.value.max_rounds_ceiling !== undefined && rounds > s.value.max_rounds_ceiling);
      for (const e of all) {
        const { target, node, stage, core, last } = e;
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
              message: `allows ${rounds} review rounds, over max_rounds_ceiling ${ceiling} (from ${from('max_rounds_ceiling')}); set max_rounds to ${ceiling} or less`,
              where: at(e, target),
            });
          }
        } else if (last === true && node.max_rounds !== undefined) {
          // any stage whose last slot node sets max_rounds loops (see buildGraph)
          const rounds = node.max_rounds;
          if (rounds > ceiling && !exceededEarlier(rounds)) {
            out.push({
              rule: 'max_rounds_ceiling',
              source,
              target,
              message: `allows ${rounds} ${stage} rounds, over max_rounds_ceiling ${ceiling} (from ${from('max_rounds_ceiling')}); set max_rounds to ${ceiling} or less`,
              where: at(e, target),
            });
          }
        }
        const back = node.on_fail?.max_rounds;
        if (back !== undefined && back > ceiling && !exceededEarlier(back)) {
          out.push({
            rule: 'max_rounds_ceiling',
            source,
            target: `${target}.on_fail`,
            message: `allows ${back} rounds, over max_rounds_ceiling ${ceiling} (from ${from('max_rounds_ceiling')}); set on_fail.max_rounds to ${ceiling} or less`,
            where: at(e, `${target}.on_fail`),
          });
        }
      }
    }

    for (const [k, req] of (rules.required_nodes ?? []).entries()) {
      const name = typeof req === 'string' ? req : req.name;
      const have = merged.nodes[name];
      if (have === undefined && scope === 'global' && !appliesTo(req, stages)) continue;
      if (have === undefined) {
        out.push({
          rule: 'required_nodes',
          source,
          target: `nodes.${name}`,
          message: `node "${name}" is required by required_nodes but is not defined; add it under nodes:`,
          where: locate(ruleLocator, source, `rules.required_nodes.${k}`),
        });
        continue;
      }
      if (typeof req === 'string') continue;
      const want = position(req);
      const got = position(have.value);
      if (want !== got && have.source === 'core') {
        // a built-in node is locked, so the only thing the user can change is this rule entry
        out.push({
          rule: 'required_nodes',
          source,
          target: `nodes.${name}`,
          message: `requires ${name} ${want}, but it is built in and attached ${got}; change or remove this required_nodes entry`,
          where: locate(ruleLocator, source, `rules.required_nodes.${k}`),
        });
      } else if (want !== got) {
        out.push({
          rule: 'required_nodes',
          source,
          target: `nodes.${name}`,
          message: `required ${want} by required_nodes (from ${from('required_nodes')}), but it is attached ${got}; attach it ${want}`,
          where: at(have, `nodes.${name}`),
        });
      }
    }
  });
  return out;
}

/** Rule violations found by `validate`: one located line per violation; file, line and path are the first one's. */
export class RuleViolationError extends ConfigError {
  violations: Violation[];

  constructor(violations: Violation[], file: string) {
    const first = violations[0];
    const lines = violations.map((v) => formatIssue(v.message, v.where.file, v.where.line, v.where.path));
    super(first?.message ?? 'rule violations', first?.where.file || file, first?.where.line, first?.where.path, lines.join('\n'));
    this.name = 'RuleViolationError';
    this.violations = violations;
  }
}
