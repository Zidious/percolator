import path from 'node:path';
import { runGit } from '../grounds/git.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh } from './gh.ts';
import { defineExit } from './exits/define.ts';
import type { ExitResult } from './exits/define.ts';
import { latestOutput } from './exits/latest.ts';
import { noticedNotes } from './exits/notes.ts';
import { issueMetaIfAny } from './intake.ts';

/**
 * `Closes #<n>` (none without an issue), then the trimmed description, then the notes of the verify rounds. A fan-out slice's PR is one of several
 * for the issue: it says `Part of #<n>`, so merging it leaves the issue open for the other slices.
 */
export function prBody(issueNumber: number | undefined, description?: string, o: { slice?: boolean; notes?: string } = {}): string {
  const text = description?.trim();
  const ref = o.slice === true ? 'Part of' : 'Closes';
  const parts = [
    ...(issueNumber !== undefined ? [`${ref} #${issueNumber}`] : []),
    ...(text ? [text] : []),
    ...(o.notes ? [o.notes] : []),
  ];
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
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
  /** a fan-out slice run: its PR is titled `<issue title or pipeline>: <slice title>` and closes nothing */
  slice?: { title: string };
  push?: (worktree: string, branch: string) => Promise<void>;
}): StepHandler {
  return defineExit('github.open_pr', o.runDir, async (_step, ctx, io): Promise<ExitResult> => {
    const issue = await issueMetaIfAny(o.runDir);
    const repo = issue?.repo ?? o.repo;
    if (repo === undefined) return { escalate: 'the run has no issue and no repository to open the PR in' };
    const description = await latestOutput(ctx, o.runDir, 'pr_body');
    const notes = await noticedNotes(ctx, o.runDir);
    const body = prBody(issue?.number, description, { slice: o.slice !== undefined, ...(notes ? { notes } : {}) });
    const fallback =
      o.slice !== undefined ? `${issue?.title ?? o.pipeline}: ${o.slice.title}` : (issue?.title ?? `${o.pipeline}: ${o.runId}`);
    const title = (await latestOutput(ctx, o.runDir, 'pr_title'))?.trim() || fallback;

    await (o.push ?? defaultPush)(o.worktree, o.branch);
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
    return { write: { pr_url: url } };
  });
}
