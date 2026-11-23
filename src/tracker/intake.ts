import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome } from '../engine/runtime.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { Gh, Issue } from './gh.ts';
import { DECISION_MARKER, findPriorGroom } from './prior-groom.ts';
import type { PriorGroom } from './prior-groom.ts';
import type { TicketRef } from './ticket.ts';

/** `issue.json`: the run's issue; absent on a ticketless run. `labels` is absent in runs from before pipelines. */
export type IssueMeta = { repo: string; number: number; title: string; url: string; labels?: string[] };

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

/** `readIssueMeta`, or undefined when the run has no issue (a ticketless run). */
export async function issueMetaIfAny(runDir: string): Promise<IssueMeta | undefined> {
  try {
    await fs.access(path.join(runDir, 'issue.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return readIssueMeta(runDir);
}

/** The `## Inputs` section: one `- key: value` line per input, keys sorted. */
function renderInputs(inputs: Record<string, string>): string {
  const keys = Object.keys(inputs).sort();
  return `## Inputs\n\n${keys.length === 0 ? '_No inputs._' : keys.map((k) => `- ${k}: ${inputs[k]}`).join('\n')}\n`;
}

function renderTicket(repo: string, issue: Issue): string {
  const comments = issue.comments.filter((c) => !c.body.includes(GATE_MARKER) && !c.body.includes(DECISION_MARKER));
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

/** Where intake saves an approved earlier groomed ticket, for the run to reuse instead of grooming again. */
export const priorGroomFile = (runDir: string): string => path.join(runDir, 'prior-groom.json');

/** The input groom refines: an earlier groomed ticket that was not approved, and why. */
function previousGroom(p: PriorGroom): string {
  const d = p.decision;
  const head =
    d === undefined
      ? `An earlier run groomed this ticket (${p.gateUrl}); it was not approved. Refine it, don't start over.`
      : `An earlier run groomed this ticket (${p.gateUrl}); @${d.by} rejected it (${d.url})${d.feedback ? `: ${d.feedback}` : '.'}

Refine it, don't start over.`;
  return `${head}

${p.text}
`;
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

export function githubIntake(o: {
  gh: Gh;
  runDir: string;
  /** absent on a ticketless run: the inputs are the ticket */
  ticket?: TicketRef;
  pipeline: string;
  runId: string;
  inputs: Record<string, string>;
  approvers?: string[];
}): StepHandler {
  return async (_step, _ctx, io) => {
    try {
      if (o.ticket === undefined) {
        await fs.mkdir(io.outputsDir, { recursive: true });
        await writeFileAtomic(path.join(io.outputsDir, 'ticket.md'), `# ${o.pipeline} run ${o.runId}\n\n${renderInputs(o.inputs)}`);
        const collected = await collectOutputs(io.outputsDir, o.runDir);
        if ('error' in collected) return escalate(`github.intake: ${collected.error}`);
        return { status: 'pass', outputs: collected.outputs };
      }
      const issue = await o.gh.issue(o.ticket.repo, o.ticket.number);
      if (issue.state.toUpperCase() !== 'OPEN') {
        return escalate(
          `github.intake: ${o.ticket.repo}#${issue.number} is ${issue.state.toLowerCase()}; reopen it or pick another ticket`,
        );
      }
      const meta: IssueMeta = { repo: o.ticket.repo, number: issue.number, title: issue.title, url: issue.url, labels: issue.labels };
      await writeFileAtomic(path.join(o.runDir, 'issue.json'), `${JSON.stringify(meta, null, 2)}\n`);
      await fs.mkdir(io.outputsDir, { recursive: true });
      const inputs = Object.keys(o.inputs).length > 0 ? `\n${renderInputs(o.inputs)}` : '';
      await writeFileAtomic(path.join(io.outputsDir, 'ticket.md'), `${renderTicket(o.ticket.repo, issue)}${inputs}`);
      const prior = findPriorGroom(issue.comments, o.approvers ?? [await o.gh.user()]);
      if (prior?.decision?.decision === 'approve') {
        await writeFileAtomic(priorGroomFile(o.runDir), `${JSON.stringify(prior, null, 2)}
`);
      } else if (prior !== undefined) {
        await writeFileAtomic(path.join(io.outputsDir, 'previous_groom.md'), previousGroom(prior));
      }
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`github.intake: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`github.intake: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
