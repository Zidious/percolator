import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../../engine/runtime.ts';
import { runGit } from '../../grounds/git.ts';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import { checkGhsa } from '../gh.ts';
import type { AdvisoryFork, Gh } from '../gh.ts';
import { prBody } from '../pr.ts';
import { errText, latestOutput } from './latest.ts';
import { noticedNotes } from './notes.ts';

/** `<stepDir>/fork.json`: the temporary private fork this step created for the advisory. */
type SavedFork = AdvisoryFork & { advisory: string };

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason: `github.private_fork_pr: ${reason}` });

const defaultPush = async (worktree: string, cloneUrl: string, branch: string): Promise<void> => {
  // runGit redacts credentials in the url from its error
  await runGit(['push', '--', cloneUrl, branch], worktree);
};

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readFork(file: string): Promise<SavedFork | undefined> {
  const text = await readOptional(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as SavedFork;
  } catch (err) {
    throw new Error(`fork file ${file} is invalid: ${errText(err)}; delete it and resume the run`);
  }
}

/** The fork of `advisory` recorded by this attempt of the step or an earlier one, newest attempt first. */
async function savedFork(stepDir: string, advisory: string): Promise<SavedFork | undefined> {
  const parent = path.dirname(stepDir);
  const attempts = (await fs.readdir(parent, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => Number(b) - Number(a));
  for (const a of attempts) {
    const f = await readFork(path.join(parent, a, 'fork.json'));
    if (f?.advisory === advisory) return f;
  }
  return undefined;
}

/**
 * The `private_fork_pr` exit: opens the run's PR in the temporary private fork of a security advisory
 * (`inputs.advisory`), so the fix stays private until the advisory is published. `push` is a test hook.
 */
export function githubPrivateForkPr(o: {
  gh: Gh;
  runDir: string;
  worktree: string;
  branch: string;
  base: string;
  repo: string;
  inputs: Record<string, string>;
  push?: (worktree: string, cloneUrl: string, branch: string) => Promise<void>;
}): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const advisory = o.inputs['advisory'] ?? '';
      checkGhsa(advisory);
      // recorded before the push: a crash after advisoryFork must not ask GitHub for a second fork
      let fork = await savedFork(io.stepDir, advisory);
      if (!fork) {
        fork = { advisory, ...(await o.gh.advisoryFork(o.repo, advisory)) };
        await writeFileAtomic(path.join(io.stepDir, 'fork.json'), `${JSON.stringify(fork, null, 2)}\n`);
      }
      if (fork.cloneUrl.startsWith('-')) throw new Error(`fork clone url must not start with "-": ${fork.cloneUrl}`);
      await (o.push ?? defaultPush)(o.worktree, fork.cloneUrl, o.branch);

      const parts = o.repo.split('/');
      const forkRepo = parts.length === 3 ? `${parts[0]}/${fork.fullName}` : fork.fullName;
      let url = (await o.gh.findPr(forkRepo, o.branch))?.url;
      if (url === undefined) {
        const issue = await readOptional(path.join(o.runDir, 'issue.json'));
        const issueTitle = issue === undefined ? undefined : (JSON.parse(issue) as { title?: unknown }).title;
        // a pr_title the run wrote wins: the public issue's title may describe the vulnerability
        const title =
          (await latestOutput(ctx, o.runDir, 'pr_title'))?.trim() ||
          (typeof issueTitle === 'string' && issueTitle.trim() !== '' ? issueTitle : `Fix for ${advisory}`);
        // no "Closes #n": a PR in the advisory fork must not close (or point at) the public issue
        const bodyFile = path.join(io.stepDir, 'pr-body.md');
        const notes = await noticedNotes(ctx, o.runDir);
        await writeFileAtomic(bodyFile, prBody(undefined, await latestOutput(ctx, o.runDir, 'pr_body'), notes ? { notes } : {}));
        url = await o.gh.createPr(forkRepo, { base: o.base.replace(/^origin\//, ''), head: o.branch, title, bodyFile });
      }
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'pr_url.md'), `${url}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(collected.error);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(errText(err));
    }
  };
}
