import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../config/load.ts';
import { formatIssue, locate } from '../config/locate.ts';
import type { Locator, Problem, Where } from '../config/locate.ts';
import { STAGES } from '../config/schema.ts';
import type { GraphFragment, Mapping } from '../config/schema.ts';
import { stepKey } from '../graph/build.ts';
import type { Graph, Step } from '../graph/build.ts';
import { samePath } from '../util/paths.ts';
import type { ResolvedGround } from './resolve.ts';

/** A mapping resolved in its ground; `locator` and `path` (`use.<i>`, relative to the layer) say where it was declared. */
export type ResolvedMapping = Mapping & {
  absPath: string;
  ground: string;
  commit: string;
  source: string;
  locator?: Locator;
  path?: string;
};

/** One merge layer; `locator` says which file (and key prefix) its keys came from, for errors. */
export type Layer = { source: string; fragment: GraphFragment; locator?: Locator };

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
 * Returns the absolute path, or a problem line `ground "<name>": ...` and the fix for it.
 */
export async function resolveInGround(
  ground: ResolvedGround,
  rel: string,
  expect: 'file' | 'dir',
): Promise<{ absPath: string } | { problem: string; fix: string }> {
  const fail = (msg: string, fix: string) => ({ problem: `ground "${ground.name}": ${rel} ${msg}`, fix });
  if (escapesGround(rel)) return fail('is outside the ground', 'use a path inside the ground');
  if (rel.includes(':')) return fail('must not contain ":"', 'remove the ":"');
  const absPath = path.resolve(ground.dir, rel);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return fail('does not exist', 'fix the path or add it to the ground');
  }
  if (expect === 'file' && !stat.isFile()) return fail('is not a file', 'point it at a file');
  if (expect === 'dir' && !stat.isDirectory()) return fail('is not a directory', 'point it at a directory');
  if (!isInside(await fs.realpath(ground.dir), await fs.realpath(absPath))) {
    return fail('resolves outside the ground (through a symlink)', 'point it at a path inside the ground');
  }
  return { absPath };
}

/** Throws one ConfigError listing every problem, one located line each; no-op when there are none. */
export function throwProblems(problems: Problem[]): void {
  const first = problems[0];
  if (first === undefined) return;
  throw new ConfigError(
    first.message,
    first.file,
    first.line,
    first.path,
    problems.map((p) => formatIssue(p.message, p.file, p.line, p.path)).join('\n'),
  );
}

/** `ground "<name>" is not declared`, with where to declare it: the user config, named when the key is in another file. */
function undeclared(name: string, at: Where, configFile: string): Problem {
  const where = samePath(at.file, configFile) ? '' : ` in ${configFile}`;
  return { ...at, message: `ground "${name}" is not declared; add it under grounds:${where}` };
}

/**
 * Resolve each mapping to an absolute path without throwing: the resolved ones plus every problem.
 * `source` is the layer that declared them and `locator` where its keys are; without one, problems
 * are reported against `configFile`, which is also where an undeclared ground must be added.
 */
export async function resolveEach(
  use: Mapping[],
  grounds: Record<string, ResolvedGround>,
  o: { source: string; configFile: string; locator?: Locator },
): Promise<{ mappings: ResolvedMapping[]; problems: Problem[] }> {
  const problems: Problem[] = [];
  const out: ResolvedMapping[] = [];
  const at = (p: string) => locate(o.locator, o.configFile, p);
  for (const [i, m] of use.entries()) {
    const rel = (m.file ?? m.dir)!;
    const key = m.file !== undefined ? 'file' : 'dir';
    const ground = grounds[m.from];
    if (!ground) {
      problems.push(undeclared(m.from, at(`use.${i}.from`), o.configFile));
      continue;
    }
    if (m.as === 'graph' && m.file === undefined && !escapesGround(rel)) {
      problems.push({
        ...at(`use.${i}.dir`),
        message: `ground "${m.from}": ${rel} is a graph mapping and must use file, not dir; replace dir: with file:`,
      });
      continue;
    }
    const r = await resolveInGround(ground, rel, key);
    if ('problem' in r) {
      problems.push({ ...at(`use.${i}.${key}`), message: `${r.problem}; ${r.fix}` });
      continue;
    }
    out.push({
      ...m,
      absPath: r.absPath,
      ground: ground.name,
      commit: ground.commit,
      source: o.source,
      ...(o.locator ? { locator: o.locator } : {}),
      path: `use.${i}`,
    });
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
  throwProblems(problems);
  return mappings;
}

/**
 * Checks what only the built graph can tell: every node `prompt: { from, file }` resolves to a file
 * inside its ground (same rules as a mapping), and every mapping `applies_to` names "*", a core
 * stage or a step in the graph. Throws one ConfigError listing all problems, each at the step's or
 * mapping's own file and line (`configFile` when it has no locator).
 */
export async function checkGraphReferences(
  graph: Graph,
  mappings: ResolvedMapping[],
  grounds: Record<string, ResolvedGround>,
  configFile: string,
): Promise<void> {
  const problems: Problem[] = [];
  for (const step of graph.steps) {
    const prompt = step.def.prompt;
    if (prompt === undefined || typeof prompt === 'string') continue;
    const target = `${stepKey(step)}.prompt`;
    const at = (key: string) => locate(step.locator, configFile, `${target}.${key}`);
    const ground = grounds[prompt.from];
    if (!ground) {
      problems.push(undeclared(prompt.from, at('from'), configFile));
      continue;
    }
    const r = await resolveInGround(ground, prompt.file, 'file');
    if ('problem' in r) problems.push({ ...at('file'), message: `${r.problem}; ${r.fix}` });
  }
  const known = new Set<string>(['*', ...STAGES, ...graph.steps.flatMap((s) => [s.name, s.id])]);
  for (const m of mappings) {
    m.applies_to.forEach((entry, i) => {
      if (known.has(entry)) return;
      problems.push({
        ...locate(m.locator, configFile, `${m.path ?? 'use'}.applies_to.${i}`),
        message: `"${entry}" names no stage or node; use "*", a stage or a node name`,
      });
    });
  }
  throwProblems(problems);
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

/** Sorted JSON keys `[as, ground, file ?? dir, required, applies_to]`: what a run's mappings are, for resume checks. */
export function mappingKeys(mappings: readonly ResolvedMapping[]): string[] {
  return mappings
    .map((m) => JSON.stringify([m.as, m.ground, m.file ?? m.dir, m.required ?? false, m.applies_to]))
    .sort();
}

export function mappingsFingerprint(keys: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}
