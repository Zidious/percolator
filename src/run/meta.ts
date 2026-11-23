import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import { runGit } from '../grounds/git.ts';
import { terminalName } from '../runtime/herdr-runtime.ts';
import { writeFileAtomic } from '../util/fs.ts';

export type RunMeta = {
  version: 2;
  runId: string;
  /** the pipeline the run was started on; a version 1 run.json reads as `feature` */
  pipeline: string;
  /** `--input` values the run was started with */
  inputs: Record<string, string>;
  /** formatTicket form, `<repo>#<n>`; absent on a ticketless run */
  ticket?: string;
  /** normalized origin, lower-case `host/owner/repo` (the ticket's repo when there is one) */
  repo: string;
  /** the ticket's issue number; absent on a ticketless run */
  issue?: number;
  /** run id of the run that started this one (route or fan-out child) */
  parent?: string;
  /** a fan-out slice: the parent run, the slice's 1-based index, the stage it starts from and its title */
  fanOut?: FanOutMeta;
  /** local clone the run was started from (status JSON's `repo`) */
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

export type FanOutMeta = { parent: string; slice: number; from: string; title: string };

/**
 * The Herdr space name: repo, issue (or the pipeline of a ticketless run), and the run id's suffix,
 * so two runs of one issue stay apart.
 */
export const spaceName = (m: Pick<RunMeta, 'repo' | 'issue' | 'pipeline' | 'runId'>): string =>
  `${m.repo.split('/').at(-1)} ${m.issue !== undefined ? `#${m.issue}` : m.pipeline} · ${m.runId.slice(-4)}`;

const META_FILE = 'run.json';
const STRINGS = [
  'runId',
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

const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v);
const isStringRecord = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

function isFanOut(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  return typeof f.parent === 'string' && isInt(f.slice) && typeof f.from === 'string' && typeof f.title === 'string';
}

function invalidField(r: Record<string, unknown>): string | undefined {
  if (r.version !== 1 && r.version !== 2) return 'version';
  for (const k of STRINGS) if (typeof r[k] !== 'string') return k;
  if (r.version === 1) {
    // every version 1 run had a ticket
    if (typeof r.ticket !== 'string') return 'ticket';
    if (!isInt(r.issue)) return 'issue';
  } else {
    if (typeof r.pipeline !== 'string') return 'pipeline';
    if (!isStringRecord(r.inputs)) return 'inputs';
    if (r.ticket !== undefined && typeof r.ticket !== 'string') return 'ticket';
    if (r.issue !== undefined && !isInt(r.issue)) return 'issue';
    if ((r.ticket === undefined) !== (r.issue === undefined)) return r.ticket === undefined ? 'ticket' : 'issue';
    if (r.parent !== undefined && typeof r.parent !== 'string') return 'parent';
    if (r.fanOut !== undefined && !isFanOut(r.fanOut)) return 'fanOut';
  }
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
  const r = parsed as Record<string, unknown>;
  // the file is never rewritten: a version 1 run reads as feature with no inputs
  return (r.version === 1 ? { ...r, pipeline: 'feature', inputs: {} } : r) as RunMeta;
}

/**
 * In UTC: `t<issue>-<YYYYMMDD>-<HHMMSS>-<rand>` for feature on a ticket, `t<issue>-<pipeline>-...` for
 * another pipeline on a ticket, `<pipeline>-...` for a ticketless run.
 */
export function newRunId(
  o: { issue?: number; pipeline: string },
  now: Date,
  rand: string = randomBytes(2).toString('hex'),
): string {
  const iso = now.toISOString(); // 2026-03-04T05:06:07.000Z
  const date = iso.slice(0, 10).replaceAll('-', '');
  const time = iso.slice(11, 19).replaceAll(':', '');
  const head = o.issue === undefined ? o.pipeline : o.pipeline === 'feature' ? `t${o.issue}` : `t${o.issue}-${o.pipeline}`;
  return `${head}-${date}-${time}-${rand}`;
}

/** The driver's terminal; `ticket` is the run's ticket, or its pipeline when it has none. */
export function driverName(runId: string, ticket: string): string {
  return terminalName(runId, ticket, '@driver', 0);
}

/**
 * The live (`running` or `paused`) run on `ticket`, if any. With `except.parent`, that parent and its
 * other children are not counted: a linked child is exempt from its own parent and siblings.
 */
export async function liveRunOn(
  home: string,
  ticket: string,
  except: { parent?: string } = {},
): Promise<{ runId: string; pipeline: string; status: 'running' | 'paused' } | undefined> {
  for (const l of await listRuns(home)) {
    const m = l.meta;
    const status = l.state?.status;
    if (m === undefined || m.ticket !== ticket || (status !== 'running' && status !== 'paused')) continue;
    if (except.parent !== undefined && (m.runId === except.parent || m.parent === except.parent)) continue;
    return { runId: m.runId, pipeline: m.pipeline, status };
  }
  return undefined;
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
