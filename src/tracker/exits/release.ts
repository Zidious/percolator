import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../../engine/runtime.ts';
import { runGit } from '../../grounds/git.ts';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { errText, latestOutput } from './latest-output.ts';

const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason: `github.release: ${reason}` });

const defaultPush = async (worktree: string, branch: string): Promise<void> => {
  await runGit(['push', '--set-upstream', 'origin', '--', branch], worktree);
};

const defaultHead = (worktree: string): Promise<string> => runGit(['rev-parse', 'HEAD'], worktree);

/**
 * The `release` exit: tags the pushed head of the run branch and publishes a GitHub release.
 * `push` and `head` are test hooks (defaults: `git push --set-upstream origin -- <branch>`, `git rev-parse HEAD`).
 */
export function githubRelease(o: {
  gh: Gh;
  runDir: string;
  worktree: string;
  branch: string;
  repo: string;
  inputs: Record<string, string>;
  push?: (worktree: string, branch: string) => Promise<void>;
  head?: (worktree: string) => Promise<string>;
}): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const tag = (await latestOutput(ctx, o.runDir, 'tag'))?.trim() || (o.inputs['tag'] ?? '').trim();
      if (!TAG.test(tag)) return escalate(`tag "${tag}" is not a valid tag name`);
      await (o.push ?? defaultPush)(o.worktree, o.branch);
      // a crash after createRelease leaves the release but no saved release_url: look it up first
      let url = await o.gh.releaseUrl(o.repo, tag);
      if (url === undefined) {
        const target = await (o.head ?? defaultHead)(o.worktree);
        const notesFile = path.join(io.stepDir, 'release-notes.md');
        await writeFileAtomic(notesFile, (await latestOutput(ctx, o.runDir, 'release_notes')) ?? '');
        url = await o.gh.createRelease(o.repo, { tag, target, notesFile });
      }
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'release_url.md'), `${url}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(collected.error);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(errText(err));
    }
  };
}
