import path from 'node:path';
import type { Stage } from '../config/schema.ts';
import type { RunContext } from '../engine/runtime.ts';
import { STAGE_CONTRACTS } from '../graph/core.ts';
import type { Step } from '../graph/build.ts';
import type { MaterializedMapping } from '../workspace/run-dir.ts';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Replace `{{ name }}` (whitespace allowed inside the braces); unknown names throw `TemplateError`. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  const unknown: string[] = [];
  const out = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!;
    if (!unknown.includes(name)) unknown.push(name);
    return '';
  });
  if (unknown.length > 0) throw new TemplateError(`unknown template variable(s): ${unknown.join(', ')}`);
  return out;
}

export const STAGE_BRIEFS: Readonly<Record<Exclude<Stage, 'deliver'>, string>> = Object.freeze({
  intake: 'Read ticket {{ticket}} and write its title, body and existing comments to ticket.md.',
  groom:
    'Groom the ticket in the inputs into a ready-to-plan ticket and write it to groomed_ticket.md. Percolator posts it on the issue for approval. If the inputs include findings from an approval gate, revise the groomed ticket to address them. If the inputs include a previous groomed ticket (previous_groom), start from it: keep what still holds, change what the ticket, its comments or the feedback changed; don\'t start over. Record in groomed_ticket.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
  plan: 'Write an implementation plan for the approved groomed ticket to plan.md. Record in plan.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
  implement:
    'Implement the plan in the worktree and commit on the current branch. If the inputs include review findings, address them. Write a short summary of your changes to summary.md.',
  review:
    'Review the branch diff (git diff {{base}}...HEAD) against the plan. Write your findings to findings.md as a top-level numbered list (1. …, 2. …), one finding per item; put any detail under its item. If there are none, write "No findings." and finish with status pass; otherwise finish with status fail.',
});

export type TaskInput = {
  step: Step;
  ctx: RunContext;
  runId: string;
  ticket: string;
  worktree: string;
  branch: string;
  base: string;
  runDir: string;
  outputsDir: string;
  doneFile: string;
  prompt?: string;
  mappings: MaterializedMapping[];
  skills: { native: string[] } | { files: string[] };
  parentTerminal?: string;
};

const bullets = (items: string[]): string => items.map((i) => `- ${i}`).join('\n');

export function buildTask(t: TaskInput): string {
  const { step, ctx } = t;
  const isSlot = step.role === 'slot';
  const vars: Record<string, string> = {
    run_id: t.runId,
    ticket: t.ticket,
    step: step.id,
    stage: step.stage,
    round: String(ctx.round),
    max_rounds: String(ctx.maxRounds),
    worktree: t.worktree,
    branch: t.branch,
    base: t.base,
    run_dir: t.runDir,
    outputs_dir: t.outputsDir,
  };

  const sections: string[] = [
    `# Percolator task: ${step.id} (${step.stage}, round ${ctx.round}/${ctx.maxRounds})\n\n` +
      'You are one node in a Percolator run. Work only on this task. Do not start other agents. Do not push, open pull requests or comment on the tracker; Percolator does that.',
  ];

  if (isSlot) {
    sections.push(`## Stage contract\n\n${renderTemplate(STAGE_BRIEFS[step.stage as Exclude<Stage, 'deliver'>], vars)}`);
  }

  const fallback = isSlot ? 'Carry out the stage contract above.' : "Carry out the node's purpose.";
  sections.push(`## Task\n\n${t.prompt !== undefined ? renderTemplate(t.prompt, vars) : fallback}`);

  if ('native' in t.skills) {
    if (t.skills.native.length > 0) sections.push(`## Skills\n\nUse these skills: ${t.skills.native.join(', ')}.`);
  } else if (t.skills.files.length > 0) {
    sections.push(
      `## Skills\n\nRead and follow these skill files before you start:\n\n${bullets(t.skills.files)}`,
    );
  }

  const policies = t.mappings.filter((m) => m.as === 'policy').map((m) => m.runPath);
  if (policies.length > 0) {
    const check =
      step.stage === 'review' && isSlot
        ? ' Check the change against each one and add a "Policy compliance" section to findings.md.'
        : '';
    sections.push(`## Policies (binding)\n\nFollow every policy below.${check}\n\n${bullets(policies)}`);
  }

  const context = t.mappings.filter((m) => m.as === 'context').map((m) => m.runPath);
  if (context.length > 0) sections.push(`## Context (reference)\n\n${bullets(context)}`);

  const inputs: string[] = [];
  for (const s of ctx.graph.steps) {
    const outs = ctx.previousOutputs[s.id];
    if (!outs) continue;
    for (const [key, rel] of Object.entries(outs)) {
      inputs.push(`${key} (from ${s.id}): ${path.join(t.runDir, rel)}`);
    }
  }
  if (inputs.length > 0) sections.push(`## Inputs\n\n${bullets(inputs)}`);

  sections.push(`## Workspace\n\nWorktree: ${t.worktree} (branch ${t.branch}, base ${t.base}).`);

  let outputs = `## Outputs\n\nWrite each output as a Markdown file in ${t.outputsDir}, named <key>.md.`;
  if (step.slotLast && isSlot) {
    const req = STAGE_CONTRACTS[step.stage as Stage].requiredOutputs.map((k) => `${k}.md`);
    outputs += `\n\nRequired: ${req.join(', ')}`;
  }
  sections.push(outputs);

  let finish =
    `## When you finish\n\nWrite ${t.doneFile} last, as one JSON object: {"status":"pass"}, {"status":"fail"} (review findings, or the step failed) or {"status":"escalate","reason":"…"} when a person is needed.`;
  if (t.parentTerminal !== undefined) finish += ` Then run: hc send ${t.parentTerminal} "${step.id} done"`;
  sections.push(finish);

  return `${sections.join('\n\n')}\n`;
}
