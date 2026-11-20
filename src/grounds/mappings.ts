import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadFragment } from '../config/load.ts';
import type { GraphFragment, Mapping } from '../config/schema.ts';
import type { ResolvedGround } from './resolve.ts';

export type ResolvedMapping = Mapping & { absPath: string; ground: string; commit: string };

export type Layer = { source: string; fragment: GraphFragment };

// A mapping path must stay inside its ground. Both separators count, so `..\x` is caught on POSIX too.
function escapesGround(rel: string): boolean {
  const norm = rel.replaceAll('\\', '/');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || norm.startsWith('/')) return true;
  const resolved = path.posix.normalize(norm);
  return resolved === '..' || resolved.startsWith('../');
}

/** Resolve every mapping to an absolute path; throws one ConfigError listing all problems. */
export async function resolveMappings(
  use: Mapping[],
  grounds: Record<string, ResolvedGround>,
  opts?: { configFile?: string },
): Promise<ResolvedMapping[]> {
  const problems: string[] = [];
  const out: ResolvedMapping[] = [];
  for (const m of use) {
    const rel = (m.file ?? m.dir)!;
    const ground = grounds[m.from];
    if (!ground) {
      problems.push(`ground "${m.from}": unknown ground (mapping ${rel})`);
      continue;
    }
    if (escapesGround(rel)) {
      problems.push(`ground "${m.from}": ${rel} is outside the ground`);
      continue;
    }
    if (m.as === 'graph' && m.file === undefined) {
      problems.push(`ground "${m.from}": ${rel} is a graph mapping and must use file, not dir`);
      continue;
    }
    const absPath = path.resolve(ground.dir, rel);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      problems.push(`ground "${m.from}": ${rel} does not exist`);
      continue;
    }
    if (m.file !== undefined && !stat.isFile()) {
      problems.push(`ground "${m.from}": ${rel} is not a file`);
      continue;
    }
    if (m.dir !== undefined && !stat.isDirectory()) {
      problems.push(`ground "${m.from}": ${rel} is not a directory`);
      continue;
    }
    out.push({ ...m, absPath, ground: ground.name, commit: ground.commit });
  }
  if (problems.length > 0) {
    const file = opts?.configFile ?? 'config';
    throw new ConfigError(problems[0]!, file, undefined, undefined, problems.map((p) => `${file}: ${p}`).join('\n'));
  }
  return out;
}

/** `as: graph` mappings, in order, loaded as config layers. loadFragment's ConfigErrors propagate. */
export async function fragmentLayers(mappings: ResolvedMapping[]): Promise<Layer[]> {
  const layers: Layer[] = [];
  for (const m of mappings) {
    if (m.as !== 'graph') continue;
    layers.push({
      source: `ground:${m.ground}/${m.file}@${m.commit.slice(0, 12)}`,
      fragment: await loadFragment(m.absPath),
    });
  }
  return layers;
}
