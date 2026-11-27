import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { githubComment } from '../tracker/exits/comment.ts';
import { githubOpenIssues } from '../tracker/exits/issues.ts';
import { githubPrivateForkPr } from '../tracker/exits/private-fork.ts';
import { githubRelease } from '../tracker/exits/release.ts';
import { percolatorReport } from '../tracker/exits/report.ts';
import { githubPrReview } from '../tracker/exits/review.ts';
import type { BuiltinName } from '../tracker/index.ts';
import { githubIntake } from '../tracker/intake.ts';
import { githubOpenPr } from '../tracker/pr.ts';
import { parseTicket } from '../tracker/ticket.ts';
import type { ValidateResult } from '../validate.ts';
import { startLinkedRun } from './child.ts';
import { fanOut, percolatorSeed } from './fan-out.ts';
import { newRunId } from './meta.ts';
import type { RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { routeHandoff, routeRules } from './route.ts';

/** A handler for every builtin; `percolator.seed` only in a fan-out pipeline, so a seed step elsewhere escalates. */
export type BuiltinHandlers = Record<Exclude<BuiltinName, 'percolator.seed'>, StepHandler> &
  Partial<Record<'percolator.seed', StepHandler>>;

/** The builtin handlers of run `runId`, wired to its meta, its validated config and the driver deps. */
export function builtinHandlers({
  deps,
  meta,
  v,
  dir,
  runId,
  now,
}: {
  deps: DriverDeps;
  meta: RunMeta;
  v: ValidateResult;
  dir: string;
  runId: string;
  now: () => Date;
}): BuiltinHandlers {
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
  return {
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
  };
}
