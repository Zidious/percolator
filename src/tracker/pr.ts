import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../engine/runtime.ts';
import { runGit } from '../grounds/git.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh } from './gh.ts';
import { readIssueMeta } from './intake.ts';

export function prBody(issueNumber: number, description?: string): string {
  const text = description?.trim();
  return text ? `Closes #${issueNumber}\n\n${text}\n` : `Closes #${issueNumber}\n`;
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
      const { graph } = ctx;
      const lastBody = graph.steps.findLast((s) => ctx.previousOutputs[s.id]?.['pr_body']);
      const bodyRel = lastBody ? ctx.previousOutputs[lastBody.id]?.['pr_body'] : undefined;
      const description = bodyRel ? await readOptional(path.join(o.runDir, bodyRel)) : undefined;
      const body = prBody(issue.number, description);

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
