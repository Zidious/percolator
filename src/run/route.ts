import fs from 'node:fs/promises';
import path from 'node:path';
import type { PipelineSpec } from '../config/pipelines.ts';
import type { NodeOutcome, RunContext, Runtime } from '../engine/runtime.ts';
import type { Step } from '../graph/build.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { errText, escalate } from '../tracker/exits/latest.ts';
import type { Decision } from '../tracker/gate.ts';
import type { Gh } from '../tracker/gh.ts';
import { readIssueMeta } from '../tracker/intake.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { runDir as runDirOf } from '../workspace/run-dir.ts';
import { startLinkedRun } from './child.ts';
import { newRunId } from './meta.ts';
import type { RunMeta } from './meta.ts';
import { pipelineFor } from './pick-pipeline.ts';
import type { DriverDeps } from './prepare.ts';

/** `<run dir>/route.json`: where the router sent the ticket, why, and (once started) the child run. */
export type Route = { pipeline: string; by: 'named' | 'rule' | 'agent' | 'gate' | 'fallback'; detail: string; child?: string };

const CHOOSE = 'route.1';
const PICK_GATE = 'pick-pipeline';

const routeFile = (runDir: string) => path.join(runDir, 'route.json');

export async function readRoute(runDir: string): Promise<Route | undefined> {
  try {
    return JSON.parse(await fs.readFile(routeFile(runDir), 'utf8')) as Route;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const writeRoute = (runDir: string, r: Route): Promise<void> => writeFileAtomic(routeFile(runDir), `${JSON.stringify(r, null, 2)}\n`);

/** The choose agent's pick.md: `pipeline: <name>` and `unsure: true|false`; a pipeline outside `from` (or none) is unsure. */
export function parsePick(text: string, from: readonly string[]): { pipeline?: string; unsure: boolean } {
  const pipeline = /^pipeline:\s*(\S+)\s*$/m.exec(text.replace(/\r\n/g, '\n'))?.[1];
  if (pipeline === undefined || !from.includes(pipeline)) return { unsure: true };
  const unsure = /^unsure:\s*(true|false)\s*$/m.exec(text.replace(/\r\n/g, '\n'))?.[1];
  return { pipeline, unsure: unsure !== 'false' };
}

/** The latest pick of the choose agent, if it ran. */
async function latestPick(ctx: RunContext, runDir: string, spec: PipelineSpec): Promise<{ pipeline?: string; unsure: boolean } | undefined> {
  const rel = ctx.previousOutputs[CHOOSE]?.['pick'];
  if (rel === undefined || spec.choose === undefined) return undefined;
  const text = await fs.readFile(path.join(runDir, rel), 'utf8').catch(() => '');
  return parsePick(text, spec.choose.from);
}

/**
 * `route.0`: a pipeline the issue names (a `pipeline:<name>` label or an approver's `/percolator run <name>`
 * comment), else the first `routes` rule whose label the issue has, decides the route (route.json without
 * child). It passes either way; the choose agent and the handoff come next.
 */
export function routeRules(o: { gh: Gh; runDir: string; spec: PipelineSpec; specs: Record<string, PipelineSpec>; approvers?: string[]; profile: string }): StepHandler {
  return async () => {
    try {
      if ((await readRoute(o.runDir)) !== undefined) return { status: 'pass', outputs: {} };
      const meta = await readIssueMeta(o.runDir);
      const fetched = await o.gh.issue(meta.repo, meta.number);
      const issue = { ...fetched, labels: meta.labels ?? fetched.labels };
      const named = pipelineFor({
        issue,
        ref: `${meta.repo}#${meta.number}`,
        approvers: o.approvers ?? [await o.gh.user()],
        specs: o.specs,
        defaultName: o.spec.name,
        profile: o.profile,
      });
      // a router never routes to a router (itself included: its own label is how it was started)
      if (named.by !== 'default' && o.specs[named.name]?.router !== true) {
        const detail = named.by === 'label' ? `label pipeline:${named.name}` : `comment /percolator run ${named.name}`;
        await writeRoute(o.runDir, { pipeline: named.name, by: 'named', detail });
        return { status: 'pass', outputs: {} };
      }
      const rule = o.spec.routes?.find((r) => issue.labels.includes(r.label));
      if (rule !== undefined) await writeRoute(o.runDir, { pipeline: rule.to, by: 'rule', detail: `label ${rule.label}` });
      return { status: 'pass', outputs: {} };
    } catch (err) {
      return escalate(`percolator.route_rules: ${errText(err)}`);
    }
  };
}

/**
 * Skips the choose agent and the pick-pipeline gate once route.json decided the route, and the gate when
 * `confirm` is `unsure` (the default) and the agent made a valid pick it is sure of.
 */
export function skipDecidedRoute(inner: Runtime, runDir: string, spec: PipelineSpec): Runtime {
  return {
    async executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome> {
      if (step.stage !== 'route' || (step.id !== CHOOSE && step.id !== PICK_GATE)) return inner.executeStep(step, ctx);
      if ((await readRoute(runDir)) !== undefined) return { status: 'pass', outputs: {} };
      if (step.id === PICK_GATE && (spec.choose?.confirm ?? 'unsure') === 'unsure') {
        const pick = await latestPick(ctx, runDir, spec);
        if (pick?.pipeline !== undefined && !pick.unsure) return { status: 'pass', outputs: {} };
      }
      return inner.executeStep(step, ctx);
    },
  };
}

/** The pick-pipeline gate's local decision of this round, when it approved. */
async function gateDecision(ctx: RunContext, runDir: string): Promise<Decision | undefined> {
  const rel = ctx.previousOutputs[PICK_GATE]?.['approval'];
  if (rel === undefined) return undefined;
  const file = path.join(runDir, path.dirname(path.dirname(rel)), 'decision.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Decision;
  } catch {
    // approved by a comment: no decision.json, so no pipeline either
    return undefined;
  }
}

/** The route in decision order: route.json (named or rule), the gate's --pipeline, the agent's valid pick, the fallback. */
async function decide(ctx: RunContext, runDir: string, spec: PipelineSpec): Promise<Route | undefined> {
  const saved = await readRoute(runDir);
  if (saved !== undefined) return saved;
  const from = spec.choose?.from ?? [];
  const decision = await gateDecision(ctx, runDir);
  if (decision?.pipeline !== undefined && from.includes(decision.pipeline)) {
    return { pipeline: decision.pipeline, by: 'gate', detail: `perc approve --pipeline by @${decision.by}` };
  }
  const pick = await latestPick(ctx, runDir, spec);
  if (pick?.pipeline !== undefined) {
    // an unsure pick reaches here only through the gate's approve
    return { pipeline: pick.pipeline, by: 'agent', detail: decision !== undefined ? `picked, approved by @${decision.by}` : 'picked, sure' };
  }
  if (spec.fallback !== undefined) return { pipeline: spec.fallback, by: 'fallback', detail: 'no pipeline picked' };
  return undefined;
}

/**
 * `route.3`: decides the route, records it with a pre-generated child id in route.json, then starts the
 * linked child run. A route.json that already names its child is reused, so a resume starts no second child.
 */
export function routeHandoff(o: { deps: DriverDeps; meta: RunMeta; spec: PipelineSpec; specs: Record<string, PipelineSpec> }): StepHandler {
  const runDir = runDirOf(o.deps.home, o.meta.runId);
  return async (_step, ctx, io) => {
    try {
      let route = await decide(ctx, runDir, o.spec);
      if (route === undefined) {
        return escalate(`router "${o.spec.name}" has no pipeline to route run ${o.meta.runId} to; set fallback or answer with perc approve ${o.meta.runId} --pipeline <name>`);
      }
      if (route.child === undefined) {
        const now = (o.deps.now ?? (() => new Date()))();
        const child = newRunId({ ...(o.meta.issue !== undefined ? { issue: o.meta.issue } : {}), pipeline: route.pipeline }, now);
        route = { ...route, child };
        await writeRoute(runDir, route);
      }
      const child = await startLinkedRun(
        { parent: o.meta, pipeline: route.pipeline, ...(o.meta.ticket !== undefined ? { ticket: o.meta.ticket } : {}), runId: route.child! },
        o.deps,
      );
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'route.md'), `Routed to ${route.pipeline} (${route.by}: ${route.detail}) → run ${child.runId}\n`);
      await writeFileAtomic(path.join(io.outputsDir, 'child_run.md'), `${child.runId}\n`);
      const collected = await collectOutputs(io.outputsDir, runDir);
      if ('error' in collected) return escalate(`percolator.route: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`percolator.route: ${errText(err)}`);
    }
  };
}
