import fs from 'node:fs/promises';
import path from 'node:path';
import { graphFingerprint, runGraph } from '../engine/engine.ts';
import { grantRound, loadState, saveState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import type { Runtime } from '../engine/runtime.ts';
import { mappingKeys, mappingsFingerprint } from '../grounds/mappings.ts';
import { HerdrRuntime, sweepTerminals } from '../runtime/herdr-runtime.ts';
import type { Attention } from '../runtime/herdr-runtime.ts';
import { githubComment } from '../tracker/exits/comment.ts';
import { githubOpenIssues } from '../tracker/exits/issues.ts';
import { githubPrivateForkPr } from '../tracker/exits/private-fork.ts';
import { githubRelease } from '../tracker/exits/release.ts';
import { percolatorReport } from '../tracker/exits/report.ts';
import { githubPrReview } from '../tracker/exits/review.ts';
import { githubGate } from '../tracker/gate.ts';
import { githubIntake } from '../tracker/intake.ts';
import { githubOpenPr } from '../tracker/pr.ts';
import { parseTicket } from '../tracker/ticket.ts';
import { sweepLeftovers, writeFileAtomic } from '../util/fs.ts';
import { validate } from '../validate.ts';
import type { ValidateResult } from '../validate.ts';
import { materializeGrounds, runDir } from '../workspace/run-dir.ts';
import { ensureWorktree } from '../workspace/worktree.ts';
import { acquireDriverLock, drivenByProcess, otherLiveLock } from './lock.ts';
import type { Liveness } from './lock.ts';
import { startLinkedRun } from './child.ts';
import { newRunId, readRunMeta } from './meta.ts';
import type { RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { reusePriorGroom } from './reuse-groom.ts';
import { routeHandoff, routeRules, skipDecidedRoute } from './route.ts';

/** The PR url the deliver step recorded, if any. */
export async function prUrl(dir: string, state: RunState): Promise<string | undefined> {
  const rel = state.history.findLast((h) => h.outputs['pr_url'] !== undefined)?.outputs['pr_url'];
  if (rel === undefined) return undefined;
  return (await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '')).trim() || undefined;
}

/** `<name> <old> → <new>` for every ground whose version differs (absent shown as `none`). */
function groundChanges(was: Record<string, string>, now: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
  return names.filter((n) => was[n] !== now[n]).map((n) => `${n} ${was[n] ?? 'none'} → ${now[n] ?? 'none'}`);
}

/** `+<as> <ground>:<path>` for each added key, then `-…` for each removed one (tracker and runtime are not mappings). */
function mappingChanges(was: readonly string[], now: readonly string[]): string[] {
  const label = (k: string): string => {
    const [as, ground, p] = JSON.parse(k) as [string, string, string];
    return `${as} ${ground}:${p}`;
  };
  const before = new Set(was);
  const after = new Set(now);
  return [
    ...now.filter((k) => !before.has(k)).map((k) => `+${label(k)}`),
    ...was.filter((k) => !after.has(k)).map((k) => `-${label(k)}`),
  ];
}

/**
 * The checks a run must pass before it is driven again: not completed or failed, not driven by another
 * live terminal (`selfTerminal` is this process's own), and the same graph and ground versions it started with.
 * `drive` runs them, and so does `perc resume` before it launches a driver, so errors reach the owner's terminal.
 */
export async function checkResumable(
  runId: string,
  deps: Pick<DriverDeps, 'hc' | 'home' | 'selfTerminal' | 'pid' | 'pidAlive'>,
): Promise<{ dir: string; meta: RunMeta; state: RunState; v: ValidateResult }> {
  const dir = runDir(deps.home, runId);
  const meta = await readRunMeta(dir);
  const state = await loadState(dir);
  if (state.status === 'completed') {
    const url = await prUrl(dir, state);
    throw new Error(`run ${runId} already completed${url === undefined ? '' : `: ${url}`}`);
  }
  if (state.status === 'failed') throw new Error(`run ${runId} failed at ${state.currentStep}; start a new run`);

  const driver = await deps.hc.get(meta.driver);
  if (driver?.state === 'live' && driver.address !== deps.selfTerminal) {
    throw new Error(`run ${runId} is already being driven by terminal ${meta.driver}`);
  }
  // a foreground drive has no driver terminal: driver.json is its only trace
  const lock = await otherLiveLock(dir, liveness(deps));
  if (lock !== undefined) throw new Error(drivenByProcess(runId, lock));

  const v = await validate({ configFile: meta.configFile, cwd: meta.repoRoot, home: deps.home, profile: meta.profile, pipeline: meta.pipeline });
  if (state.graphFingerprint !== undefined && state.graphFingerprint !== graphFingerprint(v.graph)) {
    throw new Error(`run ${runId} was started with a different graph (config changed since); start a new run`);
  }
  const changed = groundChanges(state.groundVersions, v.groundVersions);
  if (changed.length > 0) {
    throw new Error(`grounds changed since run ${runId} started: ${changed.join(', ')}; start a new run`);
  }
  if (state.mappingsFingerprint !== undefined) {
    const keys = mappingKeys(v.mappings);
    if (mappingsFingerprint(keys) !== state.mappingsFingerprint) {
      throw new Error(`mappings changed since run ${runId} started: ${mappingChanges(state.mappingKeys ?? [], keys).join(', ')}; start a new run`);
    }
  }
  return { dir, meta, state, v };
}

/**
 * Drive run `runId` from its saved state until it completes, fails or pauses, after `checkResumable`.
 */
export async function drive(runId: string, deps: DriverDeps): Promise<RunState> {
  const { dir, meta, state, v } = await checkResumable(runId, deps);
  const now = deps.now ?? (() => new Date());
  const release = await acquireDriverLock(dir, runId, {
    ...liveness(deps),
    ...(deps.selfTerminal !== undefined ? { terminal: deps.selfTerminal } : {}),
    now,
  });
  try {
    return await driveHeld(runId, deps, { dir, meta, state, v, now });
  } finally {
    await release();
  }
}

/** `pid`/`pidAlive` from the deps, without undefined keys. */
export function liveness(deps: Pick<DriverDeps, 'pid' | 'pidAlive'>): Liveness {
  return {
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.pidAlive !== undefined ? { pidAlive: deps.pidAlive } : {}),
  };
}

async function driveHeld(
  runId: string,
  deps: DriverDeps,
  { dir, meta, state, v, now }: { dir: string; meta: RunMeta; state: RunState; v: ValidateResult; now: () => Date },
): Promise<RunState> {
  await sweepLeftovers(dir, { recursive: true });
  await ensureWorktree({ repoRoot: meta.repoRoot, dir: meta.worktree, branch: meta.branch, base: meta.base });
  const mappings = await materializeGrounds(dir, v.mappings, v.grounds);

  const nowMs = () => now().getTime();
  const sleep = deps.sleep;
  const attentionFile = path.join(dir, 'attention.json');
  // best-effort: perc status reads it, and a failed write must not stop the run; save awaits it before deleting
  let attentionWrite: Promise<void> = Promise.resolve();
  const onAttention = (a: Attention): void => {
    deps.out(`${a.stepId}: ${a.kind} — attend terminal ${a.terminal}`);
    const body = `${JSON.stringify({ ...a, at: now().toISOString() }, null, 2)}\n`;
    attentionWrite = attentionWrite.then(() => writeFileAtomic(attentionFile, body)).catch(() => {});
  };
  const ticket = meta.ticket === undefined ? undefined : parseTicket(meta.ticket);
  // an issue exit's `next`: one linked run of that pipeline per issue it opened
  const nextRuns = (next: string | undefined) =>
    next === undefined
      ? {}
      : {
          next: {
            newId: (url: string) => newRunId({ issue: parseTicket(url).number, pipeline: next }, now()),
            start: (url: string, child: string) => startLinkedRun({ parent: meta, pipeline: next, ticket: url, runId: child }, deps),
          },
        };
  const runtime = new HerdrRuntime({
    hc: deps.hc,
    runId,
    // a ticketless run names its terminals after its pipeline
    ticket: meta.ticket ?? meta.pipeline,
    pipeline: meta.pipeline,
    inputs: meta.inputs,
    runDir: dir,
    worktree: meta.worktree,
    branch: meta.branch,
    base: meta.base,
    mappings,
    grounds: v.grounds,
    ...(meta.space !== undefined ? { space: meta.space } : {}),
    keepTerminals: meta.keepTerminals,
    outliveParent: true,
    builtins: {
      'github.intake': githubIntake({
        gh: deps.gh,
        runDir: dir,
        ...(ticket !== undefined ? { ticket } : {}),
        pipeline: meta.pipeline,
        runId,
        inputs: meta.inputs,
        ...(v.tracker?.approvers !== undefined ? { approvers: v.tracker.approvers } : {}),
      }),
      'github.open_pr': githubOpenPr({
        gh: deps.gh,
        runDir: dir,
        worktree: meta.worktree,
        branch: meta.branch,
        base: meta.base,
        repo: meta.repo,
        pipeline: meta.pipeline,
        runId,
      }),
      'github.comment': githubComment({ gh: deps.gh, runDir: dir, runId }),
      'percolator.report': percolatorReport(),
      'github.open_issues': githubOpenIssues({ gh: deps.gh, runDir: dir, runId, repo: meta.repo, ...nextRuns(v.pipeline.next) }),
      'github.release': githubRelease({
        gh: deps.gh,
        runDir: dir,
        worktree: meta.worktree,
        branch: meta.branch,
        repo: meta.repo,
        inputs: meta.inputs,
      }),
      'github.pr_review': githubPrReview({ gh: deps.gh, runDir: dir, runId, inputs: meta.inputs, repo: meta.repo }),
      'percolator.route_rules': routeRules({
        gh: deps.gh,
        runDir: dir,
        spec: v.pipeline,
        specs: v.pipelines,
        profile: v.profile,
        ...(v.tracker?.approvers !== undefined ? { approvers: v.tracker.approvers } : {}),
      }),
      'percolator.route': routeHandoff({ deps, meta, spec: v.pipeline, specs: v.pipelines }),
      'github.private_fork_pr': githubPrivateForkPr({
        gh: deps.gh,
        runDir: dir,
        worktree: meta.worktree,
        branch: meta.branch,
        base: meta.base,
        repo: meta.repo,
        inputs: meta.inputs,
      }),
    },
    gate: githubGate({
      gh: deps.gh,
      runDir: dir,
      runId,
      ...(v.tracker?.approvers !== undefined ? { approvers: v.tracker.approvers } : {}),
      ...(sleep !== undefined ? { sleep } : {}),
      now: nowMs,
      onWaiting: (stepId, url) =>
        deps.out(`${stepId}: waiting for approval: ${url ?? `perc approve ${runId} | perc reject ${runId} <feedback>`}`),
    }),
    onAttention,
    ...(sleep !== undefined ? { sleep } : {}),
    now: nowMs,
  });

  const granted = grantRound(state);
  if (granted !== undefined) deps.out(`granted one more round on ${granted}`);
  state.status = 'running';
  const save = async (s: RunState): Promise<void> => {
    await saveState(dir, s);
    await attentionWrite;
    await fs.rm(attentionFile, { force: true });
  };
  await save(state);
  // one line per step start and end, so the driver's terminal shows where the run is
  // each wrapper answers only its own steps (groom; the router's choose agent and pick gate) and passes the rest on
  const reusing = reusePriorGroom(skipDecidedRoute(runtime, dir, v.pipeline), dir);
  const logged: Runtime = {
    executeStep: async (step, ctx) => {
      deps.out(`${step.id}: started`);
      const outcome = await reusing.executeStep(step, ctx);
      deps.out(`${step.id}: ${outcome.status}${outcome.reason !== undefined ? `: ${outcome.reason}` : ''}`);
      return outcome;
    },
  };
  const end = await runGraph(v.graph, state, { runtime: logged, save, now: () => now().toISOString() });

  if (end.status === 'paused') {
    deps.out(`run ${runId} paused at ${end.currentStep}: ${end.pausedReason}`);
    deps.out(`resume with: perc resume ${runId}`);
    return end;
  }
  await sweepTerminals(deps.hc, runId, { exceptRole: 'driver' });
  if (end.status === 'completed') {
    const url = await prUrl(dir, end);
    deps.out(`run ${runId} completed${url === undefined ? '' : `: ${url}`}`);
  } else {
    deps.out(`run ${runId} failed at ${end.currentStep}`);
  }
  return end;
}
