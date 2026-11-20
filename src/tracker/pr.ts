import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../engine/runtime.ts';
import { runGit } from '../grounds/git.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh } from './gh.ts';
import { readIssueMeta } from './intake.ts';
import type { IssueMeta } from './intake.ts';

const BODY_CAP = 60000;

export type PrBodyInput = {
  issue: IssueMeta;
  runId: string;
  summary?: string;
  review: { used: number; max: number; unresolved?: string };
  groundVersions: Record<string, string>;
  findingsPath?: string;
};

export function prBody(o: PrBodyInput): string {
  const grounds = Object.keys(o.groundVersions).sort();
  const build = (findings: string | undefined): string => {
    const review =
      findings === undefined
        ? `Self-review passed in round ${o.review.used} of ${o.review.max}.`
        : `Self-review stopped at the cap of ${o.review.max} rounds with unresolved findings:\n\n${findings}`;
    return [
      `Closes #${o.issue.number}`,
      '',
      '## Summary',
      '',
      o.summary === undefined || o.summary.trim() === '' ? '_No summary was written._' : o.summary.trim(),
      '',
      '## Review',
      '',
      review,
      '',
      '## Built under',
      '',
      ...(grounds.length === 0 ? ['- no grounds'] : grounds.map((g) => `- ${g} ${o.groundVersions[g]}`)),
      '',
      `<sub>Percolator run \`${o.runId}\`</sub>`,
      '',
    ].join('\n');
  };
  const findings = o.review.unresolved;
  if (findings === undefined) return build(undefined);
  const full = build(findings.trimEnd());
  if (full.length < BODY_CAP) return full;
  const marker = `… (truncated; full findings in ${o.findingsPath ?? 'the run directory'})`;
  const room = BODY_CAP - 1 - build(`\n${marker}`).length;
  return build(`${findings.slice(0, Math.max(0, room)).trimEnd()}\n${marker}`);
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const defaultPush = async (worktree: string, branch: string): Promise<void> => {
  await runGit(['push', '--set-upstream', 'origin', '--', branch], worktree);
};

export function githubOpenPr(o: {
  gh: Gh;
  runDir: string;
  worktree: string;
  branch: string;
  base: string;
  push?: (worktree: string, branch: string) => Promise<void>;
}): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const issue = await readIssueMeta(o.runDir);
      const { graph, state } = ctx;
      const implLast = graph.steps.findLast((s) => s.role === 'slot' && s.stage === 'implement' && s.slotLast);
      const summaryRel = implLast ? ctx.previousOutputs[implLast.id]?.['summary'] : undefined;
      const summary = summaryRel ? await readOptional(path.join(o.runDir, summaryRel)) : undefined;
      const edge = Object.values(graph.backEdges).find((e) => e.onCap === 'continue');
      const max = edge?.maxRounds ?? 1;
      let unresolved: string | undefined;
      let findingsPath: string | undefined;
      if (state.unresolvedFindings) {
        findingsPath = path.join(o.runDir, state.unresolvedFindings);
        unresolved = (await readOptional(findingsPath)) ?? '_The findings file is missing._';
      }
      const used = unresolved !== undefined ? max : (edge ? (state.rounds[edge.id] ?? 0) : 0) + 1;
      const body = prBody({
        issue,
        runId: state.runId,
        ...(summary !== undefined ? { summary } : {}),
        review: { used, max, ...(unresolved !== undefined ? { unresolved } : {}) },
        groundVersions: state.groundVersions,
        ...(findingsPath !== undefined ? { findingsPath } : {}),
      });

      await (o.push ?? defaultPush)(o.worktree, o.branch);
      await fs.mkdir(io.outputsDir, { recursive: true });
      const bodyFile = path.join(io.stepDir, 'pr-body.md');
      await writeFileAtomic(bodyFile, body);

      // a crash after createPr leaves the PR but no saved pr_url: look it up first, then edit
      const existing = await o.gh.findPr(issue.repo, o.branch);
      let url: string;
      if (existing) {
        await o.gh.editPr(issue.repo, existing.number, bodyFile);
        url = existing.url;
      } else {
        url = await o.gh.createPr(issue.repo, {
          base: o.base.replace(/^origin\//, ''),
          head: o.branch,
          title: issue.title,
          bodyFile,
        });
      }
      await writeFileAtomic(path.join(io.outputsDir, 'pr_url.md'), `${url}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`github.open_pr: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`github.open_pr: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
