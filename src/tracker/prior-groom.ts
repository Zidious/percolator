import type { IssueComment } from './gh.ts';

const COMMAND = /^\/percolator\s+(approve|reject)\b\s*(.*)$/;

/** The decision a comment makes, if its first line is a command. */
export function parseCommand(body: string): { decision: 'approve' | 'reject'; feedback: string } | undefined {
  const lines = body.split(/\r?\n/);
  const m = COMMAND.exec(lines[0] ?? '');
  if (!m) return undefined;
  const feedback = [m[2]!.trim(), ...lines.slice(1)].join('\n').trim();
  return { decision: m[1] as 'approve' | 'reject', feedback };
}

export type PriorDecision = { decision: 'approve' | 'reject'; by: string; url: string; feedback?: string };
export type PriorGroom = { text: string; gateUrl: string; decision?: PriorDecision };

/** Decision notes start with this marker; intake leaves them out of `ticket.md`. */
export const DECISION_MARKER = '<!-- percolator:decision';

const GROOM_GATE = /^<!-- percolator:gate run=(\S+) step=approve-groom round=(\d+) -->/;
const NOTE = /^<!-- percolator:decision run=(\S+) step=(\S+) round=(\d+) decision=(approve|reject) -->\n(?:Approved|Rejected) locally by @(\S+) via `perc (?:approve|reject)`(?:: ([\s\S]*?))?\.?\n?$/;
const SECTION = '### groomed_ticket\n\n';
const END = /\n\n(?:### |Reply `\/percolator approve`)/;

/** The note a gate posts for a `perc approve`/`perc reject` decision, so the issue records it. Not a command. */
export function decisionNote(d: {
  runId: string;
  stepId: string;
  round: number;
  decision: 'approve' | 'reject';
  by: string;
  feedback?: string;
}): string {
  const marker = `${DECISION_MARKER} run=${d.runId} step=${d.stepId} round=${d.round} decision=${d.decision} -->`;
  const line =
    d.decision === 'approve'
      ? `Approved locally by @${d.by} via \`perc approve\`.`
      : `Rejected locally by @${d.by} via \`perc reject\`${d.feedback ? `: ${d.feedback}` : '.'}`;
  return `${marker}\n${line}\n`;
}

function groomedText(body: string): string | undefined {
  const at = body.indexOf(SECTION);
  if (at < 0) return undefined;
  const rest = body.slice(at + SECTION.length);
  const end = END.exec(rest);
  const text = (end ? rest.slice(0, end.index) : rest).trim();
  // a truncated ticket is not the whole ticket: not worth reusing
  return text === '' || /\n… \(truncated; /.test(`\n${text}`) ? undefined : text;
}

/**
 * The newest groomed ticket an earlier run posted on the issue (comments oldest first), with the decision
 * on it: the first `/percolator approve|reject` by an approver after it, or the gate's own note of a local
 * decision. A decision posted after a newer gate comment belongs to that newer one.
 */
export function findPriorGroom(comments: readonly IssueComment[], approvers: readonly string[]): PriorGroom | undefined {
  const allowed = new Set(approvers.map((a) => a.toLowerCase()));
  let current: (PriorGroom & { run: string; round: string }) | undefined;
  for (const c of comments) {
    const body = c.body.replace(/\r\n/g, '\n');
    const g = GROOM_GATE.exec(body);
    if (g) {
      const text = groomedText(body);
      current = text === undefined ? undefined : { text, gateUrl: c.url, run: g[1]!, round: g[2]! };
      continue;
    }
    if (current === undefined || current.decision !== undefined) continue;
    const note = NOTE.exec(body);
    if (note) {
      if (note[1] === current.run && note[2] === 'approve-groom' && note[3] === current.round) {
        current.decision = {
          decision: note[4] as 'approve' | 'reject',
          by: note[5]!,
          url: c.url,
          ...(note[6] ? { feedback: note[6] } : {}),
        };
      }
      continue;
    }
    if (!allowed.has(c.author.toLowerCase())) continue;
    const cmd = parseCommand(body);
    if (cmd) {
      current.decision = { decision: cmd.decision, by: c.author, url: c.url, ...(cmd.feedback ? { feedback: cmd.feedback } : {}) };
    }
  }
  if (current === undefined) return undefined;
  const { run: _run, round: _round, ...prior } = current;
  return prior;
}
