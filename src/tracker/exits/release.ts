import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../../engine/runtime.ts';
import { runGit } from '../../grounds/git.ts';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { releaseMarker } from '../markers.ts';
import { errText, latestOutput } from './latest.ts';

const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A tag name git takes (`git check-ref-format`): no `..`, and no part empty, starting with `.` or ending with `.` or `.lock`. */
const validTag = (tag: string): boolean =>
  TAG.test(tag) && !tag.includes('..') && tag.split('/').every((p) => p !== '' && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));

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
      if (!validTag(tag)) return escalate(`tag "${tag}" is not a valid tag name`);
      await (o.push ?? defaultPush)(o.worktree, o.branch);
      // a crash after createRelease leaves the release but no saved release_url: look it up first,
      // and take it only when its notes carry this run's marker
      const marker = releaseMarker(ctx.state.runId);
      const existing = await o.gh.release(o.repo, tag);
      if (existing !== undefined && !existing.body.includes(marker)) {
        return escalate(`tag "${tag}" already has a release (${existing.url}); pick another tag and resume`);
      }
      let url = existing?.url;
      if (url === undefined) {
        const target = await (o.head ?? defaultHead)(o.worktree);
        const notesFile = path.join(io.stepDir, 'release-notes.md');
        const notes = ((await latestOutput(ctx, o.runDir, 'release_notes')) ?? '').trimEnd();
        await writeFileAtomic(notesFile, `${notes === '' ? '' : `${notes}\n\n`}${marker}\n`);
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
