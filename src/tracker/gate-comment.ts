import { GATE_MARKER } from './intake.ts';

export type RejectedRound = { round: number; by: string; feedback?: string };
export type GateComment = {
  runId: string;
  stepId: string;
  round: number;
  outputs: string;
  rejected: RejectedRound[];
  approvedBy?: string;
};

const REPLY_PREFIX = 'Reply `/percolator approve`';
const DETAILS_OPEN = '<details><summary>Rejected rounds</summary>';
const DETAILS_CLOSE = '</details>';
const MARKER_RE = new RegExp(`^${GATE_MARKER} run=(\\S+) step=(\\S+) -->$`);
const HEADER_RE = /^\*\*Percolator\*\* needs approval to continue run `(\S+)` \(step `(\S+)`, round (\d+)\)\.$/;
const ENTRY_RE = /^- Round (\d+) rejected by @(\S+?)(?:\.|: (.*))$/;
const APPROVED_RE = /^Approved by @(\S+)$/;

export function gateMarker(runId: string, stepId: string): string {
  return `${GATE_MARKER} run=${runId} step=${stepId} -->`;
}

export function renderGateComment(c: GateComment): string {
  const lines = [
    gateMarker(c.runId, c.stepId),
    `**Percolator** needs approval to continue run \`${c.runId}\` (step \`${c.stepId}\`, round ${c.round}).`,
    '',
  ];
  if (c.outputs !== '') lines.push(c.outputs, '');
  lines.push(
    `${REPLY_PREFIX} to continue, or \`/percolator reject <what to change>\` to send it back.`,
    `Locally: \`perc approve ${c.runId}\` or \`perc reject ${c.runId} "<what to change>"\`.`,
  );
  if (c.rejected.length > 0) {
    lines.push('', DETAILS_OPEN, '');
    for (const r of c.rejected) {
      if (r.feedback) {
        const [first, ...rest] = r.feedback.split('\n');
        lines.push(`- Round ${r.round} rejected by @${r.by}: ${first}`, ...rest.map((l) => `  ${l}`));
      } else {
        lines.push(`- Round ${r.round} rejected by @${r.by}.`);
      }
    }
    lines.push('', DETAILS_CLOSE);
  }
  if (c.approvedBy !== undefined) lines.push('', `Approved by @${c.approvedBy}`);
  return `${lines.join('\n')}\n`;
}

function parseRejected(block: string[]): RejectedRound[] | undefined {
  const out: RejectedRound[] = [];
  for (const line of block) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      const entry: RejectedRound = { round: Number(m[1]), by: m[2]! };
      if (m[3] !== undefined) entry.feedback = m[3];
      out.push(entry);
    } else if (line.startsWith('  ') && out.length > 0) {
      const last = out[out.length - 1]!;
      last.feedback = `${last.feedback ?? ''}\n${line.slice(2)}`;
    } else if (line !== '') {
      return undefined;
    }
  }
  return out;
}

export function parseGateComment(body: string): GateComment | undefined {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const marker = MARKER_RE.exec(lines[0] ?? '');
  const header = HEADER_RE.exec(lines[1] ?? '');
  if (!marker || !header) return undefined;
  const [, runId, stepId] = marker as unknown as [string, string, string];
  if (header[1] !== runId || header[2] !== stepId || lines[2] !== '') return undefined;

  let reply = -1;
  for (let i = lines.length - 1; i >= 3; i--) {
    if (lines[i]!.startsWith(REPLY_PREFIX)) { reply = i; break; }
  }
  if (reply < 0 || (reply > 3 && lines[reply - 1] !== '')) return undefined;
  if (!(lines[reply + 1] ?? '').startsWith('Locally:')) return undefined;
  const outputs = lines.slice(3, Math.max(3, reply - 1)).join('\n').trim();

  let i = reply + 2;
  let rejected: RejectedRound[] = [];
  if (lines[i] === '' && lines[i + 1] === DETAILS_OPEN) {
    const close = lines.indexOf(DETAILS_CLOSE, i + 2);
    if (close < 0) return undefined;
    const parsed = parseRejected(lines.slice(i + 2, close));
    if (!parsed) return undefined;
    rejected = parsed;
    i = close + 1;
  }
  const comment: GateComment = { runId, stepId, round: Number(header[3]), outputs, rejected };
  if (lines[i] === '' && lines[i + 1] !== undefined) {
    const m = APPROVED_RE.exec(lines[i + 1]!);
    if (m) comment.approvedBy = m[1]!;
  }
  return comment;
}

export function withRejection(c: GateComment, r: RejectedRound): GateComment {
  const rejected = [...c.rejected.filter((x) => x.round !== r.round), r].sort((a, b) => a.round - b.round);
  return { ...c, rejected };
}
