import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../engine/runtime.ts';
import { runGit } from '../grounds/git.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh } from './gh.ts';
import { issueMetaIfAny } from './intake.ts';

/** `Closes #<n>` (none without an issue), then the trimmed description. */
export function prBody(issueNumber: number | undefined, description?: string): string {
  const text = description?.trim();
  const parts = [...(issueNumber !== undefined ? [`Closes #${issueNumber}`] : []), ...(text ? [text] : [])];
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
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
  /** for a run without an issue: the repo (`host/owner/repo`), and the pipeline and run id of its title */
  repo?: string;
  pipeline?: string;
  runId?: string;
  push?: (worktree: string, branch: string) => Promise<void>;
}): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const issue = await issueMetaIfAny(o.runDir);
      const repo = issue?.repo ?? o.repo;
      if (repo === undefined) return escalate('github.open_pr: the run has no issue and no repository to open the PR in');
      // the latest output `key` in graph order, as text
      const latest = async (key: string): Promise<string | undefined> => {
        const last = ctx.graph.steps.findLast((s) => ctx.previousOutputs[s.id]?.[key]);
        const rel = last ? ctx.previousOutputs[last.id]?.[key] : undefined;
        return rel ? readOptional(path.join(o.runDir, rel)) : undefined;
      };
      const description = await latest('pr_body');
      const body = prBody(issue?.number, description);
      const title = (await latest('pr_title'))?.trim() || (issue?.title ?? `${o.pipeline}: ${o.runId}`);

      await (o.push ?? defaultPush)(o.worktree, o.branch);
      await fs.mkdir(io.outputsDir, { recursive: true });
      const bodyFile = path.join(io.stepDir, 'pr-body.md');
      await writeFileAtomic(bodyFile, body);

      // a crash after createPr leaves the PR but no saved pr_url: look it up first, then edit
      const existing = await o.gh.findPr(repo, o.branch);
      let url: string;
      if (existing) {
        await o.gh.editPr(repo, existing.number, bodyFile);
        url = existing.url;
      } else {
        url = await o.gh.createPr(repo, {
          base: o.base.replace(/^origin\//, ''),
          head: o.branch,
          title,
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
