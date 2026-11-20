import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRemote } from '../config/profile.ts';
import { graphFingerprint } from '../engine/engine.ts';
import { newState, saveState } from '../engine/state.ts';
import { cliGit, runGit } from '../grounds/git.ts';
import { mappingKeys, mappingsFingerprint } from '../grounds/mappings.ts';
import type { HerdrApp } from '../herdr/app.ts';
import type { Hc } from '../herdr/hc.ts';
import { foreignTerminal } from '../runtime/herdr-runtime.ts';
import type { Gh } from '../tracker/gh.ts';
import { formatTicket, parseTicket } from '../tracker/ticket.ts';
import { expandHome } from '../util/paths.ts';
import { validate } from '../validate.ts';
import { materializeGrounds, runDir } from '../workspace/run-dir.ts';
import { ensureWorktree, removeWorktree } from '../workspace/worktree.ts';
import { detectBase, driverName, newRunId, writeRunMeta } from './meta.ts';
import type { RunMeta } from './meta.ts';

export type DriverDeps = {
  hc: Hc;
  app: HerdrApp;
  gh: Gh;
  home: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  out: (s: string) => void;
  selfTerminal?: string;
  /** absolute path of the CLI entry the driver terminal runs */
  entry: string;
  /** this process's pid in `driver.json` (default `process.pid`); injectable for tests */
  pid?: number;
  /** liveness of a `driver.json` pid on this host (default `process.kill(pid, 0)`) */
  pidAlive?: (pid: number) => boolean;
};

const SPACE_FAILED = 'herdr-app space.new failed: ';

/** `<root>/<repoName>/<runId>`, refused unless it stays inside `root` (defence in depth behind `parseTicket`). */
export function worktreeIn(root: string, repoName: string, runId: string): string {
  const dir = path.resolve(root, repoName, runId);
  const rel = path.relative(root, dir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`repository name "${repoName}" would put the worktree outside ${root}`);
  }
  return dir;
}

/**
 * Validate, then create the run: worktree, Herdr space, `run.json`, materialized grounds and `state.json`.
 * Every check that can fail cheaply (config, ticket, base) runs before anything is created.
 */
export async function prepareRun(
  o: { ticket: string; repoDir: string; configFile: string; profile?: string },
  deps: DriverDeps,
): Promise<RunMeta> {
  const configFile = path.resolve(o.configFile);
  const v = await validate({
    configFile,
    cwd: o.repoDir,
    home: deps.home,
    ...(o.profile !== undefined ? { profile: o.profile } : {}),
  });
  const repoRoot = await cliGit.toplevel(o.repoDir);
  if (repoRoot === undefined) throw new Error(`${o.repoDir} is not inside a git repository`);
  const origin = await cliGit.remoteUrl(repoRoot);
  const ref = parseTicket(o.ticket, origin === undefined ? undefined : normalizeRemote(origin));
  const ticket = formatTicket(ref);
  if (origin !== undefined) {
    // owner/repo only: an ssh host alias (`git@gh-work:o/r`) still names the same repository
    const want = ref.repo.split('/').slice(-2).join('/');
    const have = normalizeRemote(origin).split('/').slice(-2).join('/');
    if (want.toLowerCase() !== have.toLowerCase()) {
      throw new Error(
        `ticket ${ticket} is in ${want}, but this clone's origin is ${have}; run perc in a clone of ${want} or pass --repo <dir>`,
      );
    }
  }
  const repoName = ref.repo.split('/').at(-1)!;

  const now = (deps.now ?? (() => new Date()))();
  const runId = newRunId(ref.number, now);
  const branch = `percolator/${runId}`;
  const base = v.runtime?.base ?? (await detectBase(repoRoot));
  if (base === 'HEAD') {
    throw new Error(`cannot detect a base branch (HEAD is detached); set runtime.base in profile "${v.profile}"`);
  }
  const root = v.runtime?.worktree_root;
  // `expandHome` alone would resolve a relative root against the process cwd
  const rootDir =
    root === undefined ? undefined : root.startsWith('~') ? expandHome(root, deps.home) : path.resolve(path.dirname(configFile), root);
  const worktree =
    rootDir !== undefined
      ? worktreeIn(rootDir, repoName, runId)
      : worktreeIn(path.join(deps.home, '.percolator', 'worktrees'), repoName, runId);

  if (base.startsWith('origin/')) await runGit(['fetch', '--quiet', 'origin'], repoRoot);
  const branchExisted = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).then(
    () => true,
    () => false,
  );
  const { created } = await ensureWorktree({ repoRoot, dir: worktree, branch, base });

  let space: string | undefined;
  if (v.runtime?.space !== false) {
    try {
      space = await deps.app.newSpace(`${repoName} #${ref.number}`, worktree);
    } catch (err) {
      // no run.json yet, so nothing else would ever find this worktree; best-effort, never masks err
      if (created) {
        await removeWorktree({ repoRoot, dir: worktree, force: true }).catch(() => {});
        if (!branchExisted) await runGit(['branch', '-D', '--', branch], repoRoot).catch(() => {});
      }
      const detail = (err as Error).message.replace(SPACE_FAILED, '');
      throw new Error(
        `${SPACE_FAILED}${detail}; start the Herdr app or set runtime.space: false in profile "${v.profile}"`,
      );
    }
  }

  const meta: RunMeta = {
    version: 1,
    runId,
    ticket,
    repo: ref.repo,
    issue: ref.number,
    repoRoot,
    configFile,
    profile: v.profile,
    worktree,
    branch,
    base,
    ...(space !== undefined ? { space } : {}),
    keepTerminals: v.runtime?.keep_terminals ?? false,
    driver: driverName(runId, ticket),
    createdAt: now.toISOString(),
  };
  const dir = runDir(deps.home, runId);
  await fs.mkdir(dir, { recursive: true });
  await writeRunMeta(dir, meta);
  await materializeGrounds(dir, v.mappings, v.grounds);
  const state = newState({ runId, ticket, profile: v.profile, groundVersions: v.groundVersions });
  state.graphFingerprint = graphFingerprint(v.graph);
  state.mappingKeys = mappingKeys(v.mappings);
  state.mappingsFingerprint = mappingsFingerprint(state.mappingKeys);
  await saveState(dir, state);
  return meta;
}

/**
 * Start `perc drive <runId>` in an hc terminal that outlives this process. Only a terminal labelled
 * with this run is ever removed: a live one means the run is already driven; a finished one is replaced.
 */
export async function launchDriver(meta: RunMeta, deps: DriverDeps): Promise<string> {
  const name = meta.driver;
  const existing = await deps.hc.get(name);
  if (existing) {
    const foreign = foreignTerminal(existing, name, meta.runId);
    if (foreign !== undefined) throw new Error(foreign);
    if (existing.state === 'live') throw new Error(`run ${meta.runId} is already being driven by terminal ${name}`);
    await deps.hc.rm(name);
  }
  await deps.hc.run({
    name,
    cwd: meta.worktree,
    argv: [process.execPath, deps.entry, 'drive', meta.runId],
    labels: {
      'percolator.run': meta.runId,
      'percolator.role': 'driver',
      ...(meta.space !== undefined ? { 'herdr.space': meta.space } : {}),
    },
    outliveParent: true,
  });
  return name;
}
