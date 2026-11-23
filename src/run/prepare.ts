import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRemote } from '../config/profile.ts';
import { graphFingerprint } from '../engine/engine.ts';
import { newState, saveState } from '../engine/state.ts';
import { cliGit, runGit } from '../grounds/git.ts';
import { ghRepo, sshHostname } from '../tracker/remote.ts';
import type { SshHostname } from '../tracker/remote.ts';
import { mappingKeys, mappingsFingerprint } from '../grounds/mappings.ts';
import type { HerdrApp } from '../herdr/app.ts';
import type { Hc } from '../herdr/hc.ts';
import { foreignTerminal } from '../runtime/herdr-runtime.ts';
import type { Gh } from '../tracker/gh.ts';
import { formatTicket, parseTicket } from '../tracker/ticket.ts';
import { expandHome } from '../util/paths.ts';
import { validate } from '../validate.ts';
import { materializeGrounds, runDir } from '../workspace/run-dir.ts';
import { defaultWorktreeDir, ensureWorktree, excludeWorktreesDir, removeWorktree } from '../workspace/worktree.ts';
import { writeRunGraph } from './graph-file.ts';
import { checkRequest } from './request.ts';
import { detectBase, driverName, liveRunOn, newRunId, spaceName, writeRunMeta } from './meta.ts';
import { pipelineFor } from './pick-pipeline.ts';
import type { FanOutMeta, RunMeta } from './meta.ts';

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
  /** asks the owner one question and returns the answer; `null` when stdin is not a terminal */
  ask?: ((question: string) => Promise<string>) | null;
  /** the host an ssh origin's host or alias connects to (default `ssh -G`); injectable for tests */
  sshHostname?: SshHostname;
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
 * Validate, then create the run: worktree, Herdr space, materialized grounds, `state.json`, `graph.json`, and
 * `run.json` last (it marks the run dir complete).
 * Every check that can fail cheaply (config, ticket, base) runs before anything is created.
 */
export async function prepareRun(
  o: {
    ticket?: string;
    repoDir: string;
    configFile: string;
    profile?: string;
    pipeline?: string;
    inputs?: Record<string, string>;
    /** a pre-generated run id (linked child runs); default a new one */
    runId?: string;
    /** the run that starts this one (route or fan-out); exempts it from that run's live-run check */
    parent?: string;
    /** a fan-out slice: the run builds the slice's graph (from `fanOut.from` on) and records it in run.json */
    fanOut?: FanOutMeta;
    /** the base branch (a fan-out slice uses its parent's); default runtime.base, else detected */
    base?: string;
  },
  deps: DriverDeps,
): Promise<RunMeta> {
  const configFile = path.resolve(o.configFile);
  const validateFor = (pipeline: string | undefined) =>
    validate({
      configFile,
      cwd: o.repoDir,
      home: deps.home,
      ...(o.profile !== undefined ? { profile: o.profile } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(o.fanOut !== undefined ? { sliceFrom: o.fanOut.from } : {}),
    });
  let v = await validateFor(o.pipeline);
  const inputs = o.inputs ?? {};
  // a ticket may name its pipeline only when there is more than one to pick from
  const lookUp = o.ticket !== undefined && o.pipeline === undefined && Object.keys(v.pipelines).length > 1;
  if (!lookUp) checkRequest(v.pipeline, o.ticket, inputs);
  const repoRoot = await cliGit.toplevel(o.repoDir);
  if (repoRoot === undefined) throw new Error(`${o.repoDir} is not inside a git repository`);
  const origin = await cliGit.remoteUrl(repoRoot);
  // the repository as gh knows it: an ssh host alias in origin names its real host
  const originRepo = origin === undefined ? undefined : await ghRepo(origin, deps.sshHostname ?? sshHostname());
  const ref = o.ticket === undefined ? undefined : parseTicket(o.ticket, originRepo);
  const ticket = ref === undefined ? undefined : formatTicket(ref);
  if (ref !== undefined && origin !== undefined) {
    // owner/repo only: an ssh host alias (`git@gh-work:o/r`) still names the same repository
    const want = ref.repo.split('/').slice(-2).join('/');
    const have = normalizeRemote(origin).split('/').slice(-2).join('/');
    if (want.toLowerCase() !== have.toLowerCase()) {
      throw new Error(
        `ticket ${ticket} is in ${want}, but this clone's origin is ${have}; run perc in a clone of ${want} or pass --repo <dir>`,
      );
    }
  }
  if (ref !== undefined && lookUp) {
    let issue;
    try {
      issue = await deps.gh.issue(ref.repo, ref.number);
    } catch (err) {
      throw new Error(`cannot read issue ${ticket} to pick its pipeline: ${(err as Error).message}; pass --pipeline <name>`);
    }
    const picked = pipelineFor({
      issue,
      ref: ticket!,
      approvers: v.tracker?.approvers ?? [await deps.gh.user()],
      specs: v.pipelines,
      defaultName: v.pipeline.name,
      profile: v.profile,
    });
    if (picked.name !== v.pipeline.name) v = await validateFor(picked.name);
    checkRequest(v.pipeline, o.ticket, inputs);
  }
  const pipeline = v.pipeline.name;
  if (ticket !== undefined) {
    const live = await liveRunOn(deps.home, ticket, o.parent !== undefined ? { parent: o.parent } : {});
    if (live !== undefined) {
      throw new Error(
        `ticket ${ticket} already has a live run ${live.runId} (pipeline ${live.pipeline}, ${live.status}); finish or delete it first (perc delete ${live.runId})`,
      );
    }
  }
  if (ref === undefined && origin === undefined) {
    throw new Error(
      `pipeline "${pipeline}" runs without a ticket, so it names its repository from the origin, and ${repoRoot} has none; add one (git remote add origin <url>)`,
    );
  }
  const repo = ref?.repo ?? originRepo!;
  const repoName = repo.split('/').at(-1)!;

  const now = (deps.now ?? (() => new Date()))();
  const runId = o.runId ?? newRunId({ ...(ref !== undefined ? { issue: ref.number } : {}), pipeline }, now);
  const branch = `percolator/${runId}`;
  const base = o.base ?? v.runtime?.base ?? (await detectBase(repoRoot));
  if (base === 'HEAD') {
    throw new Error(`cannot detect a base branch (HEAD is detached); set runtime.base in profile "${v.profile}"`);
  }
  const root = v.runtime?.worktree_root;
  // `expandHome` alone would resolve a relative root against the process cwd
  const rootDir =
    root === undefined ? undefined : root.startsWith('~') ? expandHome(root, deps.home) : path.resolve(path.dirname(configFile), root);
  const worktree = rootDir !== undefined ? worktreeIn(rootDir, repoName, runId) : defaultWorktreeDir(repoRoot, runId);
  if (rootDir === undefined) await excludeWorktreesDir(repoRoot);

  if (base.startsWith('origin/')) await runGit(['fetch', '--quiet', 'origin'], repoRoot);
  const branchExisted = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).then(
    () => true,
    () => false,
  );
  const { created } = await ensureWorktree({ repoRoot, dir: worktree, branch, base });

  let space: string | undefined;
  if (v.runtime?.space !== false) {
    try {
      space = await deps.app.newSpace(spaceName({ repo, ...(ref !== undefined ? { issue: ref.number } : {}), pipeline, runId }), worktree);
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
    version: 2,
    runId,
    pipeline,
    inputs,
    ...(ref !== undefined ? { ticket: ticket!, issue: ref.number } : {}),
    repo,
    ...(o.parent !== undefined ? { parent: o.parent } : {}),
    ...(o.fanOut !== undefined ? { fanOut: o.fanOut } : {}),
    repoRoot,
    configFile,
    profile: v.profile,
    worktree,
    branch,
    base,
    ...(space !== undefined ? { space } : {}),
    keepTerminals: v.runtime?.keep_terminals ?? false,
    driver: driverName(runId, ticket ?? pipeline),
    createdAt: now.toISOString(),
  };
  const dir = runDir(deps.home, runId);
  await fs.mkdir(dir, { recursive: true });
  await materializeGrounds(dir, v.mappings, v.grounds);
  const state = newState({ runId, ...(ticket !== undefined ? { ticket } : {}), profile: v.profile, groundVersions: v.groundVersions });
  state.graphFingerprint = graphFingerprint(v.graph);
  state.mappingKeys = mappingKeys(v.mappings);
  state.mappingsFingerprint = mappingsFingerprint(state.mappingKeys);
  await saveState(dir, state);
  await writeRunGraph(dir, v.graph);
  // run.json last: it marks a complete run dir; a dir without it is prepared again
  await writeRunMeta(dir, meta);
  return meta;
}

/**
 * Start `perc drive <runId>` in an hc terminal that outlives this process. Only a terminal labelled
 * with this run is ever removed: a live one means the run is already driven; a finished one is replaced.
 * The driver carries no `herdr.space` label, so it stays out of the run's space; the panel peeks at it.
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
    },
    outliveParent: true,
  });
  return name;
}
