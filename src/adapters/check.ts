import { BUILTIN_NAMES } from '../tracker/index.ts';
import { effectiveKind } from '../config/schema.ts';
import type { Graph } from '../graph/build.ts';
import { mappingsFor, throwProblems } from '../grounds/mappings.ts';
import type { ResolvedMapping } from '../grounds/mappings.ts';
import { findSkill } from '../workspace/run-dir.ts';
import { ADAPTERS } from './index.ts';

/** Checks every agent step against its adapter before any agent starts; one ConfigError listing all problems. */
export async function checkAgents(graph: Graph, mappings: ResolvedMapping[], configFile: string): Promise<void> {
  const problems: string[] = [];
  const known = Object.keys(ADAPTERS);
  for (const step of graph.steps) {
    const kind = effectiveKind(step.def);
    const target = `${step.role === 'slot' ? 'bindings' : 'nodes'}.${step.id}`;
    if (kind === 'builtin') {
      const name = step.def.builtin!;
      if (!(BUILTIN_NAMES as readonly string[]).includes(name)) {
        problems.push(`${target}: unknown builtin "${name}" (known: ${BUILTIN_NAMES.join(', ')})`);
      }
      continue;
    }
    if (kind !== 'agent') continue;
    const agent = step.def.agent!;
    if (!Object.hasOwn(ADAPTERS, agent)) {
      problems.push(`${target}: unknown agent "${agent}" (known: ${known.join(', ')})`);
      continue;
    }
    const adapter = ADAPTERS[agent as keyof typeof ADAPTERS];
    if (agent === 'command') {
      const command = step.def.command;
      if (command === undefined || command.length === 0) {
        problems.push(`${target}: agent "command" needs "command" (the program to run)`);
      } else if (command[0]!.startsWith('-')) {
        problems.push(`${target}: command must not start with "-"`);
      }
    }
    if (!adapter.effort && step.def.effort !== undefined) {
      problems.push(`${target}: agent "${agent}" does not take "effort"; remove it or use agent "claude"`);
    }
    const applying = mappingsFor(step, mappings);
    if (!adapter.plugins) {
      for (const m of applying) {
        if (m.as === 'plugins') {
          problems.push(`${target}: agent "${agent}" cannot load plugins, but mapping ${m.from}:${m.file ?? m.dir} (plugins) applies to it`);
        }
      }
    }
    if (!adapter.nativeSkills) {
      for (const skill of [...(step.def.skill !== undefined ? [step.def.skill] : []), ...(step.def.skills ?? [])]) {
        if ((await findSkill(skill, applying)) === undefined) {
          problems.push(
            `${target}: skill "${skill}" not found in the skills or plugins mapped to it (agent "${agent}" loads skills from files)`,
          );
        }
      }
    }
  }
  for (const m of mappings) {
    if (m.as === 'skills' && m.dir === undefined) problems.push(`mapping ${m.from}:${m.file}: skills mappings must use dir`);
  }
  throwProblems(problems, configFile);
}
