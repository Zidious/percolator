import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../engine/runtime.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh, Issue } from './gh.ts';
import type { TicketRef } from './ticket.ts';

export type IssueMeta = { repo: string; number: number; title: string; url: string };

/** Gate comments start with this marker; intake leaves them out of `ticket.md`. */
export const GATE_MARKER = '<!-- percolator:gate';

export async function readIssueMeta(runDir: string): Promise<IssueMeta> {
  let text: string;
  try {
    text = await fs.readFile(path.join(runDir, 'issue.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`run ${runDir} has no issue.json (intake has not run)`);
    }
    throw err;
  }
  return JSON.parse(text) as IssueMeta;
}

function renderTicket(repo: string, issue: Issue): string {
  const comments = issue.comments.filter((c) => !c.body.includes(GATE_MARKER));
  const parts = [
    `# ${issue.title}`,
    `${issue.url} (${repo}#${issue.number}, opened by @${issue.author})`,
    '## Body',
    issue.body.trim() === '' ? '_No description._' : issue.body,
    '## Comments',
    ...(comments.length === 0
      ? ['_No comments._']
      : comments.flatMap((c) => [`### @${c.author} at ${c.createdAt}`, c.body])),
  ];
  return `${parts.join('\n\n')}\n`;
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

export function githubIntake(o: { gh: Gh; runDir: string; ticket: TicketRef }): StepHandler {
  return async (_step, _ctx, io) => {
    try {
      const issue = await o.gh.issue(o.ticket.repo, o.ticket.number);
      if (issue.state.toUpperCase() !== 'OPEN') {
        return escalate(
          `github.intake: ${o.ticket.repo}#${issue.number} is ${issue.state.toLowerCase()}; reopen it or pick another ticket`,
        );
      }
      const meta: IssueMeta = { repo: o.ticket.repo, number: issue.number, title: issue.title, url: issue.url };
      await writeFileAtomic(path.join(o.runDir, 'issue.json'), `${JSON.stringify(meta, null, 2)}\n`);
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'ticket.md'), renderTicket(o.ticket.repo, issue));
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`github.intake: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`github.intake: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
