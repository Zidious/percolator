import path from 'node:path';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { reviewMarker } from '../markers.ts';
import { parsePr } from '../ticket.ts';
import { defineExit } from './define.ts';
import { latestOutput } from './latest.ts';

/** The `pr_review` exit: posts the latest `review` output as an `event=COMMENT` review on `inputs.pr`. */
export function githubPrReview(o: {
  gh: Gh;
  runDir: string;
  runId: string;
  inputs: Record<string, string>;
  repo: string;
}): StepHandler {
  return defineExit('github.pr_review', o.runDir, async (_step, ctx, io) => {
    const pr = parsePr(o.inputs['pr'] ?? '', o.repo);
    const text = await latestOutput(ctx, o.runDir, 'review');
    if (text === undefined) return { escalate: 'no step wrote a review output; write review.md in the stage before the exit' };
    const marker = reviewMarker(o.runId);
    // a crash after postReview leaves the review but no saved review_url: look for the marker first
    let url = (await o.gh.prReviews(pr.repo, pr.number)).find((r) => r.body.includes(marker))?.url;
    if (url === undefined) {
      const bodyFile = path.join(io.stepDir, 'review-body.md');
      await writeFileAtomic(bodyFile, `${text.trim()}\n\n${marker}\n`);
      url = await o.gh.postReview(pr.repo, pr.number, bodyFile);
    }
    return { write: { review_url: url } };
  });
}
