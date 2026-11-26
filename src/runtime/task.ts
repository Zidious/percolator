import path from 'node:path';
import { STAGES } from '../config/schema.ts';
import type { FeatureStage } from '../config/schema.ts';
import type { LoopRound, RunContext } from '../engine/runtime.ts';
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

export const STAGE_BRIEFS: Readonly<Record<Exclude<FeatureStage, 'deliver'>, string>> = Object.freeze({
  intake: 'Read ticket {{ticket}} and write its title, body and existing comments to ticket.md.',
  groom:
    'Groom the ticket in the inputs into a ready-to-plan ticket and write it to groomed_ticket.md. Percolator posts it on the issue for approval. If the inputs include findings from an approval gate, revise the groomed ticket to address them. If the inputs include a previous groomed ticket (previous_groom), start from it: keep what still holds, change what the ticket, its comments or the feedback changed; don\'t start over. Record in groomed_ticket.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
  plan: 'Write an implementation plan for the approved groomed ticket to plan.md. Record in plan.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
  implement:
    'Implement the plan in the worktree and commit on the current branch. If the inputs include review findings, address them. Write a short summary of your changes to summary.md.',
  review:
    'Review the branch diff (git diff {{base}}...HEAD) against the plan. Write your findings to findings.md, one "## <title>" section per finding, with its detail under it; keep this format even when a skill suggests another, so Percolator can number the findings. If there are none, write "No findings." and finish with status pass; otherwise finish with status fail.',
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
  /** the run's pipeline: the feature stages of `feature` get their own brief */
  pipeline: string;
  /** run inputs, available to prompts as {{input_<name>}} */
  inputs: Record<string, string>;
  /** the inputs the pipeline declares: one the run was not given renders as '' */
  declaredInputs?: readonly string[];
};

const bullets = (items: string[]): string => items.map((i) => `- ${i}`).join('\n');

const hasBrief = (pipeline: string, stage: string): stage is Exclude<FeatureStage, 'deliver'> =>
  pipeline === 'feature' && stage !== 'deliver' && (STAGES as readonly string[]).includes(stage);

function customBrief(stage: string, pipeline: string, required: string[]): string {
  const brief = `Carry out the "${stage}" stage of pipeline ${pipeline}.`;
  if (required.length === 0) return brief;
  return `${brief} Write ${required.map((k) => `${k}.md`).join(', ')} to the outputs directory.`;
}

/**
 * The header's round: `round r/cap` (`round r (g granted after cap cap)` past it) of the one loop around the step;
 * with nested loops the outermost's, named by its step, then each inner one past round 1.
 */
export function roundLabel(ctx: Pick<RunContext, 'round' | 'maxRounds' | 'loops'>): string {
  const loops = ctx.loops ?? [];
  const of = (l: LoopRound) => (l.granted > 0 ? `round ${l.round} (${l.granted} granted after cap ${l.maxRounds})` : `round ${l.round}/${l.maxRounds}`);
  const [outer, ...inner] = loops;
  if (outer === undefined) return `round ${ctx.round}/${ctx.maxRounds}`;
  if (inner.length === 0) return of(outer);
  return [outer, ...inner.filter((l) => l.round > 1)].map((l) => `${l.from} ${of(l)}`).join(', ');
}

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
    pipeline: t.pipeline,
    ...Object.fromEntries((t.declaredInputs ?? []).map((k) => [`input_${k}`, ''])),
    ...Object.fromEntries(Object.entries(t.inputs).map(([k, v]) => [`input_${k}`, v])),
  };
  const required = ctx.graph.contracts[step.stage] ?? [];

  const sections: string[] = [
    `# Percolator task: ${step.id} (${step.stage}, ${roundLabel(ctx)})\n\n` +
      'You are one node in a Percolator run. Work only on this task. Do not start other agents. Do not push, open pull requests or comment on the tracker; Percolator does that.',
  ];

  if (isSlot) {
    const brief = hasBrief(t.pipeline, step.stage)
      ? renderTemplate(STAGE_BRIEFS[step.stage], vars)
      : customBrief(step.stage, t.pipeline, required);
    sections.push(`## Stage contract\n\n${brief}`);
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
        ? ' Check the change against each one: each breach is a finding, its own "## " section naming the policy; write nothing about the policies the change keeps.'
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

  // gates whose latest record is a reject that sent the run back to this stage; a reject back to a stage
  // with no agent (intake's builtin) is for the first agent after it
  const rejectedBy = isSlot
    ? ctx.graph.steps.filter((g) => {
        if (g.def?.kind !== 'gate' || typeof ctx.previousOutputs[g.id]?.findings !== 'string') return false;
        const route = ctx.graph.failRoutes?.[g.id];
        const edge = route === undefined ? undefined : ctx.graph.backEdges?.[route];
        if (edge === undefined) return false;
        const agent = ctx.graph.steps.slice(edge.toStepIndex).find((s) => s.role === 'slot' && s.def?.builtin === undefined);
        return agent?.stage === step.stage;
      })
    : [];
  if (rejectedBy.length > 0) {
    const lines = rejectedBy.map((g) => `Gate ${g.id} rejected the last round. Address its feedback: findings (from ${g.id}) in the inputs.`);
    sections.push(`## Feedback\n\n${lines.join('\n')}`);
  }

  sections.push(`## Workspace\n\nWorktree: ${t.worktree} (branch ${t.branch}, base ${t.base}).`);

  let outputs = `## Outputs\n\nWrite each output as a Markdown file in ${t.outputsDir}, named <key>.md.`;
  if (step.slotLast && isSlot && required.length > 0) {
    outputs += `\n\nRequired: ${required.map((k) => `${k}.md`).join(', ')}`;
  }
  sections.push(outputs);

  let finish =
    `## When you finish\n\nWrite ${t.doneFile} last, as one JSON object: {"status":"pass"}, {"status":"fail"} (review findings, or the step failed) or {"status":"escalate","reason":"…"} when a person is needed. If you have questions only the owner can answer, don't guess: escalate with them, {"status":"escalate","questions":["…","…"]}, and this step runs again with their answers as input answers.`;
  if (t.parentTerminal !== undefined) finish += ` Then run: hc send ${t.parentTerminal} "${step.id} done"`;
  sections.push(finish);

  return `${sections.join('\n\n')}\n`;
}
