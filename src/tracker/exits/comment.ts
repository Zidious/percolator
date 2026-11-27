import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { readIssueMeta } from '../intake.ts';
import { exitMarker } from '../markers.ts';
import { escalate, latestOutput } from './latest.ts';
import { noticedNotes } from './notes.ts';

/** The `comment` exit: posts the latest `comment` output, then the verify rounds' notes, on the run's issue, once per run and step. */
export function githubComment(o: { gh: Gh; runDir: string; runId: string }): StepHandler {
  return async (step, ctx, io) => {
    try {
      const text = await latestOutput(ctx, o.runDir, 'comment');
      if (text === undefined) {
        return escalate('github.comment: no step wrote a comment output; write comment.md in the stage before the exit');
      }
      const issue = await readIssueMeta(o.runDir);
      const marker = exitMarker(o.runId, step.id);
      await fs.mkdir(io.outputsDir, { recursive: true });
      const bodyFile = path.join(io.stepDir, 'comment-body.md');
      const notes = await noticedNotes(ctx, o.runDir);
      await writeFileAtomic(bodyFile, `${[text.trimEnd(), ...(notes ? [notes] : []), marker].join('\n\n')}\n`);

      // a crash after posting leaves the comment but no saved comment_url: find it by its marker and edit it
      const existing = await o.gh.findComment(issue.repo, issue.number, marker);
      let url: string;
      if (existing) {
        await o.gh.editComment(issue.repo, existing.id, bodyFile);
        url = existing.url;
      } else {
        url = await o.gh.comment(issue.repo, issue.number, bodyFile);
      }
      await writeFileAtomic(path.join(io.outputsDir, 'comment_url.md'), `${url}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`github.comment: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`github.comment: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
