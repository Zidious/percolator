import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../../engine/runtime.ts';

/**
 * The notes of every verify round (history entries with `verifyRound` and a `notes` output), one
 * `## Noticed in <stage>, not fixed` section per stage in order of first appearance, one `### Round <n>` per round.
 * Undefined when no verify round wrote notes; a missing or blank notes file is skipped.
 */
export async function noticedNotes(ctx: RunContext, runDir: string): Promise<string | undefined> {
  const byStage = new Map<string, string[]>();
  for (const h of ctx.state.history) {
    const rel = h.outputs['notes'];
    if (h.verifyRound === undefined || h.status === 'contract_error' || typeof rel !== 'string') continue;
    let text: string;
    try {
      text = await fs.readFile(path.join(runDir, rel), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (text.trim() === '') continue;
    const stage = ctx.graph.steps.find((s) => s.id === h.stepId)?.stage ?? h.stepId;
    const heading = h.stepId === stage ? `### Round ${h.verifyRound}` : `### ${h.stepId}, round ${h.verifyRound}`;
    const parts = byStage.get(stage) ?? [];
    parts.push(`${heading}\n\n${demoteHeadings(text.trim())}`);
    byStage.set(stage, parts);
  }
  if (byStage.size === 0) return undefined;
  return [...byStage].map(([stage, parts]) => [`## Noticed in ${stage}, not fixed`, ...parts].join('\n\n')).join('\n\n');
}

/** Push `#`…`####` headings outside code fences down two levels, so a note cannot start a top-level section. */
function demoteHeadings(text: string): string {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (open) {
        const mark = open[1]!;
        if (fence === undefined) fence = mark[0]!.repeat(mark.length);
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
        return line;
      }
      if (fence !== undefined) return line;
      return /^#{1,4}\s/.test(line) ? `##${line}` : line;
    })
    .join('\n');
}
