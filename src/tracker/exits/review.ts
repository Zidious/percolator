import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../../engine/runtime.ts';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { Gh } from '../gh.ts';
import { parsePr } from '../ticket.ts';
import { errText, latestOutput } from './latest.ts';

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason: `github.pr_review: ${reason}` });

/** The `pr_review` exit: posts the latest `review` output as an `event=COMMENT` review on `inputs.pr`. */
export function githubPrReview(o: {
  gh: Gh;
  runDir: string;
  runId: string;
  inputs: Record<string, string>;
  repo: string;
}): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const pr = parsePr(o.inputs['pr'] ?? '', o.repo);
      const text = await latestOutput(ctx, o.runDir, 'review');
      if (text === undefined) return escalate('no step wrote a review output; write review.md in the stage before the exit');
      const marker = `<!-- percolator:review run=${o.runId} -->`;
      // a crash after postReview leaves the review but no saved review_url: look for the marker first
      let url = (await o.gh.prReviews(pr.repo, pr.number)).find((r) => r.body.includes(marker))?.url;
      if (url === undefined) {
        const bodyFile = path.join(io.stepDir, 'review-body.md');
        await writeFileAtomic(bodyFile, `${text.trim()}\n\n${marker}\n`);
        url = await o.gh.postReview(pr.repo, pr.number, bodyFile);
      }
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'review_url.md'), `${url}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(collected.error);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(errText(err));
    }
  };
}
