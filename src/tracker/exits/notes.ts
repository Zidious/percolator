import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../../engine/runtime.ts';

/**
 * The notes of every verify round (history entries with `verifyRound` and a `notes` output), one
 * `## Noticed in <stage>, not fixed` section per stage in order of first appearance, one `### Round <n>` per round.
 * Only pass and fail entries count, so an escalated attempt is not repeated; a round granted again after an enclosing
 * loop jumped back keeps its place in history order, headed `(pass <n>)`. Line endings are read as LF.
 * Undefined when no verify round wrote notes; a missing or blank notes file is skipped.
 */
export async function noticedNotes(ctx: RunContext, runDir: string): Promise<string | undefined> {
  const byStage = new Map<string, string[]>();
  const passes = new Map<string, number>();
  for (const h of ctx.state.history) {
    if (h.verifyRound === undefined || (h.status !== 'pass' && h.status !== 'fail')) continue;
    const rel = h.outputs['notes'];
    if (typeof rel !== 'string') continue;
    const file = path.join(runDir, rel);
    let text: string;
    try {
      text = (await fs.readFile(file, 'utf8')).replace(/\r\n?/g, '\n');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw new Error(`cannot read the notes of ${h.stepId} (${file}): ${code ?? (err as Error).message}; fix or remove the file, then perc resume`);
    }
    if (text.trim() === '') continue;
    const stage = ctx.graph.steps.find((s) => s.id === h.stepId)?.stage ?? h.stepId;
    const key = `${h.stepId}\n${h.verifyRound}`;
    const pass = (passes.get(key) ?? 0) + 1;
    passes.set(key, pass);
    const round = h.stepId === stage ? `### Round ${h.verifyRound}` : `### ${h.stepId}, round ${h.verifyRound}`;
    const heading = pass === 1 ? round : `${round} (pass ${pass})`;
    const parts = byStage.get(stage) ?? [];
    parts.push(`${heading}\n\n${demoteHeadings(text.trim())}`);
    byStage.set(stage, parts);
  }
  if (byStage.size === 0) return undefined;
  return [...byStage].map(([stage, parts]) => [`## Noticed in ${stage}, not fixed`, ...parts].join('\n\n')).join('\n\n');
}

/** A heading of `level` (1-6) moved below the `### Round <n>` heading: level 4 at least, 6 at most. */
const below = (level: number, text: string) => `${'#'.repeat(Math.min(level + 3, 6))}${text === '' ? '' : ` ${text}`}`;

/**
 * Move every heading of a note (ATX, indented up to three spaces, and setext) below its round heading, as CommonMark
 * reads them, so a note cannot start a section of the body. Fenced code is left as it is.
 */
function demoteHeadings(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let paragraph = 0; // lines of the paragraph that ends `out`, a setext heading's content; -1 in a list item or quote
  for (const line of text.split('\n')) {
    if (fence !== undefined) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    const open = /^ {0,3}(`{3,}(?!.*`)|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      paragraph = 0;
      out.push(line);
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      out.push(below(atx[1]!.length, (atx[2] ?? '').trim()));
      paragraph = 0;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && paragraph > 0) {
      const content = out.splice(out.length - paragraph, paragraph).map((l) => l.trim()).join(' ');
      out.push(below(setext[1]![0] === '=' ? 1 : 2, content));
      paragraph = 0;
      continue;
    }
    if (line.trim() === '') paragraph = 0;
    else if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}>/.test(line)) paragraph = -1;
    else if (paragraph > 0 || (paragraph === 0 && !/^ {4}/.test(line))) paragraph++;
    out.push(line);
  }
  return out.join('\n');
}
