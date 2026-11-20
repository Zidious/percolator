import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedMapping } from '../grounds/mappings.ts';
import type { ResolvedGround } from '../grounds/resolve.ts';
import { copyContained } from '../util/copy.ts';
import { exists, renameRetry, writeFileAtomic } from '../util/fs.ts';
import { toPosix } from '../util/paths.ts';

export type MaterializedMapping = ResolvedMapping & { runPath: string };

/** `~/.percolator/runs/<runId>` */
export function runDir(home: string, runId: string): string {
  return path.join(home, '.percolator', 'runs', runId);
}

/** `<runDir>/steps/<stepId>/<attempt>` */
export function stepDir(dir: string, stepId: string, attempt: number): string {
  return path.join(dir, 'steps', stepId, String(attempt));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

function groundOf(m: ResolvedMapping, grounds: Record<string, ResolvedGround>): ResolvedGround {
  const g = grounds[m.ground];
  if (!g) throw new Error(`ground "${m.ground}": unknown ground`);
  return g;
}

/**
 * Copy every policy/context mapping into `<runDir>/grounds/<ground>/…`, the run record. Copies are
 * atomic, so an existing one is complete and is reused. Other kinds are used where they are.
 * `dir` mappings are copied before `file` mappings: a file inside a copied dir is the same content
 * from the same pinned ground and is reused, whereas a file copied first would hide the rest of its dir.
 * Dirs go parents first (by depth, stable) for the same reason.
 * The result keeps the mappings' order.
 */
export async function materializeGrounds(
  dir: string,
  mappings: ResolvedMapping[],
  grounds: Record<string, ResolvedGround>,
): Promise<MaterializedMapping[]> {
  const out: MaterializedMapping[] = mappings.map((m) => ({ ...m, runPath: m.absPath }));
  const copied = out.filter((m) => m.as === 'policy' || m.as === 'context');
  const depth = (m: ResolvedMapping): number => toPosix(m.dir!).split('/').filter(Boolean).length;
  const dirs = copied.filter((m) => m.dir !== undefined).sort((a, b) => depth(a) - depth(b));
  for (const m of [...dirs, ...copied.filter((m) => m.dir === undefined)]) {
    m.runPath = path.join(dir, 'grounds', m.ground, (m.file ?? m.dir)!);
    if (await exists(m.runPath)) continue;
    try {
      await copyContained(m.absPath, m.runPath, groundOf(m, grounds).dir);
    } catch (err) {
      // a concurrent materialization finished first; its copy is complete
      if (!(await exists(m.runPath))) throw err;
    }
  }
  return out;
}

/** Skill directories (absolute) provided by one `skills` mapping. */
async function skillDirs(m: ResolvedMapping): Promise<string[]> {
  if (await isFile(path.join(m.absPath, 'SKILL.md'))) return [m.absPath];
  const found: string[] = [];
  for (const e of (await fs.readdir(m.absPath, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const sub = path.join(m.absPath, e.name);
    if (await isFile(path.join(sub, 'SKILL.md'))) found.push(sub);
  }
  return found;
}

/**
 * One Claude Code plugin per ground that maps `skills`, built under `<dir>/plugins/<ground>`, plus
 * every `plugins` mapping as it is. Returns the plugin roots in mapping order. Existing output is reused.
 */
export async function buildSkillPlugins(
  dir: string,
  mappings: ResolvedMapping[],
  grounds: Record<string, ResolvedGround>,
): Promise<string[]> {
  const roots: string[] = [];
  const built = new Set<string>();
  for (const m of mappings) {
    if (m.as === 'plugins') {
      roots.push(m.absPath);
      continue;
    }
    if (m.as !== 'skills' || built.has(m.ground)) continue;
    built.add(m.ground);
    const pluginRoot = path.join(dir, 'plugins', m.ground);
    roots.push(pluginRoot);
    if (await exists(pluginRoot)) continue;

    const ground = groundOf(m, grounds);
    const tmp = `${pluginRoot}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await fs.mkdir(path.join(tmp, '.claude-plugin'), { recursive: true });
      await writeFileAtomic(
        path.join(tmp, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: m.ground, version: '0.0.0' }),
      );
      const seen = new Set<string>();
      for (const sm of mappings) {
        if (sm.as !== 'skills' || sm.ground !== m.ground) continue;
        for (const skill of await skillDirs(sm)) {
          const name = path.basename(skill);
          if (seen.has(name)) throw new Error(`skill "${name}" is mapped twice from ground "${m.ground}"`);
          seen.add(name);
          await copyContained(skill, path.join(tmp, 'skills', name), ground.dir);
        }
      }
      try {
        await renameRetry(tmp, pluginRoot);
      } catch (err) {
        if (!(await exists(pluginRoot))) throw err;
        await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
      }
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
      throw err;
    }
  }
  return roots;
}

async function pluginName(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof manifest?.name === 'string' && manifest.name !== '') return manifest.name;
  } catch {
    // no manifest: fall back to the directory name
  }
  return path.basename(root);
}

/**
 * The absolute SKILL.md for `ns:name` or a bare `name`, for adapters without native skills.
 * `ns` is the ground of a `skills` mapping or the name of a `plugins` mapping.
 */
export async function findSkill(ref: string, mappings: ResolvedMapping[]): Promise<string | undefined> {
  const colon = ref.indexOf(':');
  const ns = colon === -1 ? undefined : ref.slice(0, colon);
  const name = colon === -1 ? ref : ref.slice(colon + 1);
  // names are joined into paths: never let one climb out of the skills dir
  const unsafe = (s: string) => s.includes('/') || s.includes('\\') || s.includes('..');
  if (unsafe(name) || (ns !== undefined && unsafe(ns))) return undefined;
  for (const m of mappings) {
    if (m.as === 'skills') {
      if (ns !== undefined && m.ground !== ns) continue;
      for (const skill of await skillDirs(m).catch(() => [])) {
        if (path.basename(skill) === name) return path.join(skill, 'SKILL.md');
      }
    } else if (m.as === 'plugins') {
      if (ns !== undefined && (await pluginName(m.absPath)) !== ns) continue;
      const candidate = path.join(m.absPath, 'skills', name, 'SKILL.md');
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
