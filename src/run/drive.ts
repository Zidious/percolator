import fs from 'node:fs/promises';
import path from 'node:path';
import { runGraph } from '../engine/engine.ts';
import { grantRound, saveState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import type { Runtime } from '../engine/runtime.ts';
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
import type { ValidateResult } from '../validate.ts';
import { materializeGrounds, runDir } from '../workspace/run-dir.ts';
import { ensureWorktree } from '../workspace/worktree.ts';
import { numberFindings } from './answer.ts';
import { acquireDriverLock, liveness } from './lock.ts';
import { startLinkedRun } from './child.ts';
import { fanOut, percolatorSeed } from './fan-out.ts';
import { newRunId } from './meta.ts';
import type { RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { reusePriorGroom } from './reuse-groom.ts';
import { prUrl } from './outputs.ts';
import { checkResumable } from './resumable.ts';
import { routeHandoff, routeRules, skipDecidedRoute } from './route.ts';

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
  const onAttentionCleared = (a: { stepId: string }): void => {
    deps.out(`${a.stepId}: working again`);
    attentionWrite = attentionWrite.then(() => fs.rm(attentionFile, { force: true })).catch(() => {});
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
    declaredInputs: Object.keys(v.pipeline.inputs),
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
        ...(meta.fanOut !== undefined ? { slice: { title: meta.fanOut.title } } : {}),
      }),
      'github.comment': githubComment({ gh: deps.gh, runDir: dir, runId }),
      'percolator.report': percolatorReport({ runDir: dir }),
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
      'percolator.fan_out': fanOut({ deps, meta, spec: v.pipeline }),
      ...(v.pipeline.fan_out !== undefined
        ? { 'percolator.seed': percolatorSeed({ runDir: dir, meta, home: deps.home, output: v.pipeline.fan_out.slices.output }) }
        : {}),
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
    onAttentionCleared,
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
    // the findings file is split once, here, so perc status and perc answer number the same items
    if (await numberFindings(dir, end)) await saveState(dir, end);
    deps.out(`run ${runId} paused at ${end.currentStep}: ${end.pausedReason}`);
    deps.out(
      end.asking !== undefined
        ? `answer with: perc answer ${runId} (perc status ${runId} lists them)`
        : `resume with: perc resume ${runId}`,
    );
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
