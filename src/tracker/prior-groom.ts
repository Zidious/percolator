import { parseGateComment } from './gate-comment.ts';
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
 * decision. A decision posted after a newer gate comment belongs to that newer one. A gate comment edited in
 * place records its own decision (approval line, rejected round); a later `/percolator approve` is only a
 * fallback for a gate that died before recording, and a later reject is already in its history.
 */
export function findPriorGroom(comments: readonly IssueComment[], approvers: readonly string[]): PriorGroom | undefined {
  const allowed = new Set(approvers.map((a) => a.toLowerCase()));
  let current: (PriorGroom & { run: string; round: string; edited: boolean }) | undefined;
  for (const c of comments) {
    const body = c.body.replace(/\r\n/g, '\n');
    const gc = parseGateComment(body);
    if (gc) {
      if (gc.stepId !== 'approve-groom') continue;
      const text = groomedText(body);
      if (text === undefined) {
        current = undefined;
        continue;
      }
      const rejected = gc.rejected.find((r) => r.round === gc.round);
      const decision: PriorDecision | undefined =
        gc.approvedBy !== undefined
          ? { decision: 'approve', by: gc.approvedBy, url: c.url }
          : rejected
            ? { decision: 'reject', by: rejected.by, url: c.url, ...(rejected.feedback ? { feedback: rejected.feedback } : {}) }
            : undefined;
      current = { text, gateUrl: c.url, run: gc.runId, round: String(gc.round), edited: true, ...(decision ? { decision } : {}) };
      continue;
    }
    const g = GROOM_GATE.exec(body);
    if (g) {
      const text = groomedText(body);
      current = text === undefined ? undefined : { text, gateUrl: c.url, run: g[1]!, round: g[2]!, edited: false };
      continue;
    }
    if (current === undefined || current.decision !== undefined) continue;
    const note = NOTE.exec(body);
    if (note) {
      if (!current.edited && note[1] === current.run && note[2] === 'approve-groom' && note[3] === current.round) {
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
    if (cmd && !(current.edited && cmd.decision === 'reject')) {
      current.decision = { decision: cmd.decision, by: c.author, url: c.url, ...(cmd.feedback ? { feedback: cmd.feedback } : {}) };
    }
  }
  if (current === undefined) return undefined;
  const { run: _run, round: _round, edited: _edited, ...prior } = current;
  return prior;
}
