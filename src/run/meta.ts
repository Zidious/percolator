import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import { runGit } from '../grounds/git.ts';
import { terminalName } from '../runtime/herdr-runtime.ts';
import { writeFileAtomic } from '../util/fs.ts';

export type RunMeta = {
  version: 1;
  runId: string;
  /** formatTicket form, `<repo>#<n>` */
  ticket: string;
  repo: string;
  issue: number;
  repoRoot: string;
  configFile: string;
  profile: string;
  worktree: string;
  branch: string;
  base: string;
  space?: string;
  keepTerminals: boolean;
  driver: string;
  createdAt: string;
};

const META_FILE = 'run.json';
const STRINGS = [
  'runId',
  'ticket',
  'repo',
  'repoRoot',
  'configFile',
  'profile',
  'worktree',
  'branch',
  'base',
  'driver',
  'createdAt',
];

function invalidField(r: Record<string, unknown>): string | undefined {
  if (r.version !== 1) return 'version';
  for (const k of STRINGS) if (typeof r[k] !== 'string') return k;
  if (typeof r.issue !== 'number' || !Number.isInteger(r.issue)) return 'issue';
  if (typeof r.keepTerminals !== 'boolean') return 'keepTerminals';
  if (r.space !== undefined && typeof r.space !== 'string') return 'space';
  return undefined;
}

export async function writeRunMeta(dir: string, m: RunMeta): Promise<void> {
  await writeFileAtomic(path.join(dir, META_FILE), JSON.stringify(m, null, 2));
}

export async function readRunMeta(dir: string): Promise<RunMeta> {
  const file = path.join(dir, META_FILE);
  const bad = (field: string) => new Error(`Run metadata ${file} is missing or invalid: ${field}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw bad((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad('not an object');
  const field = invalidField(parsed as Record<string, unknown>);
  if (field !== undefined) throw bad(field);
  return parsed as RunMeta;
}

/** `t<issue>-<YYYYMMDD>-<HHMMSS>-<rand>` in UTC. */
export function newRunId(issue: number, now: Date, rand: string = randomBytes(2).toString('hex')): string {
  const iso = now.toISOString(); // 2026-03-04T05:06:07.000Z
  const date = iso.slice(0, 10).replaceAll('-', '');
  const time = iso.slice(11, 19).replaceAll(':', '');
  return `t${issue}-${date}-${time}-${rand}`;
}

export function driverName(runId: string, ticket: string): string {
  return terminalName(runId, ticket, '@driver', 0);
}

export type RunListing = { dir: string; meta?: RunMeta; state?: RunState; error?: string };

/** Every dir under `<home>/.percolator/runs`, newest first; broken runs come last with their error. */
export async function listRuns(home: string): Promise<RunListing[]> {
  const root = path.join(home, '.percolator', 'runs');
  let names: string[];
  try {
    names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const valid: (RunListing & { meta: RunMeta })[] = [];
  const broken: RunListing[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let meta: RunMeta;
    try {
      meta = await readRunMeta(dir);
    } catch (err) {
      broken.push({ dir, error: (err as Error).message });
      continue;
    }
    let state: RunState | undefined;
    try {
      await fs.stat(path.join(dir, 'state.json'));
      state = await loadState(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        broken.push({ dir, meta, error: (err as Error).message });
        continue;
      }
    }
    valid.push({ dir, meta, ...(state ? { state } : {}) });
  }
  valid.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  broken.sort((a, b) => a.dir.localeCompare(b.dir));
  return [...valid, ...broken];
}

/** `origin/HEAD` (e.g. `origin/main`), else the current branch. */
export async function detectBase(repoRoot: string): Promise<string> {
  try {
    return await runGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoRoot);
  } catch {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  }
}
