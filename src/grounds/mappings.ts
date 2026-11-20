import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../config/load.ts';
import { STAGES } from '../config/schema.ts';
import type { GraphFragment, Mapping } from '../config/schema.ts';
import type { Graph, Step } from '../graph/build.ts';
import type { ResolvedGround } from './resolve.ts';

export type ResolvedMapping = Mapping & { absPath: string; ground: string; commit: string; source: string };

export type Layer = { source: string; fragment: GraphFragment };

// A path must stay inside its ground. Both separators count, so `..\x` is caught on POSIX too.
function escapesGround(rel: string): boolean {
  const norm = rel.replaceAll('\\', '/');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || norm.startsWith('/')) return true;
  const resolved = path.posix.normalize(norm);
  return resolved === '..' || resolved.startsWith('../');
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve `rel` (a mapping or prompt path) inside `ground`: no ":" (drive-relative paths, NTFS
 * streams), no escaping through `..`, an absolute path or a symlink, and it must exist as `expect`.
 * Returns the absolute path, or a problem line `ground "<name>": ...`.
 */
export async function resolveInGround(
  ground: ResolvedGround,
  rel: string,
  expect: 'file' | 'dir',
): Promise<{ absPath: string } | { problem: string }> {
  const fail = (msg: string) => ({ problem: `ground "${ground.name}": ${rel} ${msg}` });
  if (escapesGround(rel)) return fail('is outside the ground');
  if (rel.includes(':')) return fail('must not contain ":"');
  const absPath = path.resolve(ground.dir, rel);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return fail('does not exist');
  }
  if (expect === 'file' && !stat.isFile()) return fail('is not a file');
  if (expect === 'dir' && !stat.isDirectory()) return fail('is not a directory');
  if (!isInside(await fs.realpath(ground.dir), await fs.realpath(absPath))) {
    return fail('resolves outside the ground (through a symlink)');
  }
  return { absPath };
}

/** Throws one ConfigError against `file` listing every problem, one per line; no-op when there are none. */
export function throwProblems(problems: string[], file: string): void {
  if (problems.length === 0) return;
  throw new ConfigError(problems[0]!, file, undefined, undefined, problems.map((p) => `${file}: ${p}`).join('\n'));
}

/**
 * Resolve each mapping to an absolute path without throwing: the resolved ones plus every problem
 * line. `source` is the layer that declared them; with `usedBy` set (a fragment's `use`) an unknown
 * ground gets the longer hint, since fragments may only use grounds declared in the user config.
 */
export async function resolveEach(
  use: Mapping[],
  grounds: Record<string, ResolvedGround>,
  o: { source: string; usedBy?: string; configFile: string },
): Promise<{ mappings: ResolvedMapping[]; problems: string[] }> {
  const problems: string[] = [];
  const out: ResolvedMapping[] = [];
  for (const m of use) {
    const rel = (m.file ?? m.dir)!;
    const ground = grounds[m.from];
    if (!ground) {
      problems.push(
        o.usedBy === undefined
          ? `ground "${m.from}": unknown ground (mapping ${rel})`
          : `ground "${m.from}": unknown ground (mapping ${rel}, used by ${o.usedBy}); declare it under grounds: in ${o.configFile}`,
      );
      continue;
    }
    if (m.as === 'graph' && m.file === undefined && !escapesGround(rel)) {
      problems.push(`ground "${m.from}": ${rel} is a graph mapping and must use file, not dir`);
      continue;
    }
    const r = await resolveInGround(ground, rel, m.file !== undefined ? 'file' : 'dir');
    if ('problem' in r) {
      problems.push(r.problem);
      continue;
    }
    out.push({ ...m, absPath: r.absPath, ground: ground.name, commit: ground.commit, source: o.source });
  }
  return { mappings: out, problems };
}

/** Resolve every mapping to an absolute path; throws one ConfigError listing all problems. */
export async function resolveMappings(
  use: Mapping[],
  grounds: Record<string, ResolvedGround>,
  opts?: { configFile?: string; source?: string },
): Promise<ResolvedMapping[]> {
  const configFile = opts?.configFile ?? 'config';
  const { mappings, problems } = await resolveEach(use, grounds, { source: opts?.source ?? 'config', configFile });
  throwProblems(problems, configFile);
  return mappings;
}

/**
 * Checks what only the built graph can tell: every node `prompt: { from, file }` resolves to a file
 * inside its ground (same rules as a mapping), and every mapping `applies_to` names "*", a core
 * stage or a step in the graph. Throws one ConfigError against `configFile` listing all problems.
 */
export async function checkGraphReferences(
  graph: Graph,
  mappings: ResolvedMapping[],
  grounds: Record<string, ResolvedGround>,
  configFile: string,
): Promise<void> {
  const problems: string[] = [];
  for (const step of graph.steps) {
    const prompt = step.def.prompt;
    if (prompt === undefined || typeof prompt === 'string') continue;
    const target = `${step.role === 'slot' ? 'bindings' : 'nodes'}.${step.id}.prompt`;
    const ground = grounds[prompt.from];
    if (!ground) {
      problems.push(`${target}: ground "${prompt.from}": unknown ground (prompt ${prompt.file})`);
      continue;
    }
    const r = await resolveInGround(ground, prompt.file, 'file');
    if ('problem' in r) problems.push(`${target}: ${r.problem}`);
  }
  const known = new Set<string>(['*', ...STAGES, ...graph.steps.flatMap((s) => [s.name, s.id])]);
  for (const m of mappings) {
    for (const entry of m.applies_to) {
      if (!known.has(entry)) {
        problems.push(`mapping ${m.from}:${m.file ?? m.dir} applies_to "${entry}": no such stage or node`);
      }
    }
  }
  throwProblems(problems, configFile);
}

/**
 * The mappings that apply to `step`, in mapping order: `*`, its step id, its node name (hooks) or
 * its stage (slots only: a hook attached to a stage is not matched by that stage's name).
 */
export function mappingsFor<M extends Mapping>(step: Step, mappings: M[]): M[] {
  return mappings.filter((m) =>
    m.applies_to.some(
      (a) => a === '*' || a === step.id || (step.role === 'hook' && a === step.name) || (step.role === 'slot' && a === step.stage),
    ),
  );
}
