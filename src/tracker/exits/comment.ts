import path from 'node:path';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { readIssueMeta } from '../intake.ts';
import { exitMarker } from '../markers.ts';
import { defineExit } from './define.ts';
import { latestOutput } from './latest.ts';
import { noticedNotes } from './notes.ts';

/** The `comment` exit: posts the latest `comment` output, then the verify rounds' notes, on the run's issue, once per run and step. */
export function githubComment(o: { gh: Gh; runDir: string; runId: string }): StepHandler {
  return defineExit('github.comment', o.runDir, async (step, ctx, io) => {
    const text = await latestOutput(ctx, o.runDir, 'comment');
    if (text === undefined) return { escalate: 'no step wrote a comment output; write comment.md in the stage before the exit' };
    const issue = await readIssueMeta(o.runDir);
    const marker = exitMarker(o.runId, step.id);
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
    return { write: { comment_url: url } };
  });
}
