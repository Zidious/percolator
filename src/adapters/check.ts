import { BUILTIN_NAMES } from '../tracker/index.ts';
import { locate } from '../config/locate.ts';
import type { Problem } from '../config/locate.ts';
import { effectiveKind } from '../config/schema.ts';
import { stepKey } from '../graph/build.ts';
import type { Graph } from '../graph/build.ts';
import { mappingsFor, throwProblems } from '../grounds/mappings.ts';
import type { ResolvedMapping } from '../grounds/mappings.ts';
import { findSkill } from '../workspace/run-dir.ts';
import { ADAPTERS } from './index.ts';

/**
 * Checks every agent step against its adapter before any agent starts; one ConfigError listing all
 * problems, each at the step's or mapping's own file and line (`configFile` when it has none).
 */
export async function checkAgents(graph: Graph, mappings: ResolvedMapping[], configFile: string): Promise<void> {
  const problems: Problem[] = [];
  const known = Object.keys(ADAPTERS);
  for (const step of graph.steps) {
    const kind = effectiveKind(step.def);
    const target = stepKey(step);
    const report = (message: string, key?: string) =>
      problems.push({ ...locate(step.locator, configFile, key === undefined ? target : `${target}.${key}`), message });
    if (kind === 'builtin') {
      const name = step.def.builtin!;
      if (!(BUILTIN_NAMES as readonly string[]).includes(name)) {
        report(`unknown builtin "${name}" (known: ${BUILTIN_NAMES.join(', ')}); use one of those`, 'builtin');
      }
      continue;
    }
    if (kind !== 'agent') continue;
    const agent = step.def.agent!;
    if (!Object.hasOwn(ADAPTERS, agent)) {
      report(`unknown agent "${agent}" (known: ${known.join(', ')}); use one of those`, 'agent');
      continue;
    }
    const adapter = ADAPTERS[agent as keyof typeof ADAPTERS];
    for (const p of adapter.check?.(step.def) ?? []) report(p.message, p.key);
    if (!adapter.effort && step.def.effort !== undefined) {
      report(`agent "${agent}" does not take "effort"; remove it or use agent "claude"`, 'effort');
    }
    const applying = mappingsFor(step, mappings);
    if (!adapter.plugins) {
      for (const m of applying) {
        if (m.as === 'plugins') {
          report(
            `agent "${agent}" cannot load plugins, but mapping ${m.from}:${m.file ?? m.dir} (plugins) applies to it; narrow that mapping's applies_to or use agent "claude"`,
          );
        }
      }
    }
    if (!adapter.nativeSkills) {
      const skills = [
        ...(step.def.skill !== undefined ? [[step.def.skill, 'skill'] as const] : []),
        ...(step.def.skills ?? []).map((s, i) => [s, `skills.${i}`] as const),
      ];
      for (const [skill, key] of skills) {
        if ((await findSkill(skill, applying)) === undefined) {
          report(
            `skill "${skill}" not found in the skills or plugins mapped to it (agent "${agent}" loads skills from files); map a skills dir that has it, or remove the skill`,
            key,
          );
        }
      }
    }
  }
  for (const m of mappings) {
    if (m.as === 'skills' && m.dir === undefined) {
      problems.push({
        ...locate(m.locator, configFile, `${m.path ?? 'use'}.file`),
        message: 'skills mappings must use dir; replace file: with dir:',
      });
    }
  }
  throwProblems(problems);
}
