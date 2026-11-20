import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NodeOutcome, RunContext } from '../engine/runtime.ts';
import type { Step } from '../graph/build.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { exists, writeFileAtomic } from '../util/fs.ts';
import type { Gh, IssueComment } from './gh.ts';
import { GATE_MARKER, readIssueMeta } from './intake.ts';

export type Decision = {
  decision: 'approve' | 'reject';
  feedback?: string;
  by: string;
  via: 'comment' | 'local';
  url?: string;
};
export type Waiting = { stepId: string; stepDir: string; since: string; commentUrl: string };

const DecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    feedback: z.string().optional(),
    by: z.string(),
    via: z.enum(['comment', 'local']),
    url: z.string().optional(),
  })
  .passthrough();

const WaitingSchema = z.object({
  stepId: z.string(),
  stepDir: z.string(),
  since: z.string(),
  commentUrl: z.string(),
});

const OUTPUT_CAP = 60000;

const waitingFile = (runDir: string) => path.join(runDir, 'waiting.json');

async function readJson(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

export async function readWaiting(runDir: string): Promise<Waiting | undefined> {
  const raw = await readJson(waitingFile(runDir));
  return raw === undefined ? undefined : WaitingSchema.parse(raw);
}

export async function writeDecision(
  runDir: string,
  d: { decision: 'approve' | 'reject'; feedback?: string },
): Promise<Waiting> {
  const waiting = await readWaiting(runDir);
  if (!waiting) throw new Error('run is not waiting at a gate');
  const full: Decision = { ...d, by: os.userInfo().username, via: 'local' };
  await writeFileAtomic(path.join(waiting.stepDir, 'decision.json'), `${JSON.stringify(full, null, 2)}\n`);
  return waiting;
}

const COMMAND = /^\/percolator\s+(approve|reject)\b\s*(.*)$/;

/** The decision a comment makes, if its first line is a command. */
export function parseCommand(body: string): { decision: 'approve' | 'reject'; feedback: string } | undefined {
  const lines = body.split(/\r?\n/);
  const m = COMMAND.exec(lines[0] ?? '');
  if (!m) return undefined;
  const feedback = [m[2]!.trim(), ...lines.slice(1)].join('\n').trim();
  return { decision: m[1] as 'approve' | 'reject', feedback };
}

async function renderOutputs(runDir: string, outputs: Record<string, string>): Promise<string> {
  const parts: string[] = [];
  let budget = OUTPUT_CAP;
  for (const key of Object.keys(outputs).sort()) {
    const rel = outputs[key]!;
    if (!rel.toLowerCase().endsWith('.md')) continue;
    const abs = path.resolve(runDir, rel);
    const text = (await fs.readFile(abs, 'utf8')).trim();
    if (text.length > budget) {
      parts.push(`### ${key}\n\n${text.slice(0, budget)}\n… (truncated; full text in ${abs})`);
      break;
    }
    budget -= text.length;
    parts.push(`### ${key}\n\n${text}`);
  }
  return parts.join('\n\n');
}

function previousStepOutputs(step: Step, ctx: RunContext): Record<string, string> {
  const steps = ctx.graph.steps;
  const at = steps.findIndex((s) => s.id === step.id);
  for (let i = (at < 0 ? steps.length : at) - 1; i >= 0; i--) {
    const out = ctx.previousOutputs[steps[i]!.id];
    if (out && Object.keys(out).length > 0) return out;
  }
  return {};
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function githubGate(o: {
  gh: Gh;
  runDir: string;
  runId: string;
  approvers?: string[];
  pollMs?: number;
  trackerPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): StepHandler {
  const pollMs = o.pollMs ?? 2000;
  const trackerPollMs = o.trackerPollMs ?? 30000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;

  return async (step, ctx, io) => {
    const waitingPath = waitingFile(o.runDir);
    let wroteWaiting = false;
    try {
      const meta = await readIssueMeta(o.runDir);
      const approvers = (o.approvers ?? [await o.gh.user()]).map((a) => a.toLowerCase());
      const attempt = path.basename(io.stepDir);
      const marker = `${GATE_MARKER} run=${o.runId} step=${step.id} attempt=${attempt} -->`;
      const gateFile = path.join(io.stepDir, 'gate.json');

      let commentUrl: string;
      let postedAt: string;
      try {
        const saved = (await readJson(gateFile)) as { commentUrl: string; postedAt: string } | undefined;
        if (saved) {
          ({ commentUrl, postedAt } = saved);
        } else {
          const found = (await o.gh.issue(meta.repo, meta.number)).comments.find((c) => c.body.includes(marker));
          let comment: { url: string; createdAt: string };
          if (found) {
            comment = found;
          } else {
            const outputs = await renderOutputs(o.runDir, previousStepOutputs(step, ctx));
            const body = [
              marker,
              `**Percolator** needs approval to continue run \`${o.runId}\` (step \`${step.id}\`).`,
              '',
              ...(outputs === '' ? [] : [outputs, '']),
              'Reply `/percolator approve` to continue, or `/percolator reject <what to change>` to send it back.',
              `Locally: \`perc approve ${o.runId}\` or \`perc reject ${o.runId} "<what to change>"\`.`,
              '',
            ].join('\n');
            const bodyFile = path.join(io.stepDir, 'gate-comment.md');
            await writeFileAtomic(bodyFile, body);
            const before = new Date().toISOString();
            const url = await o.gh.comment(meta.repo, meta.number, bodyFile);
            const posted = (await o.gh.issue(meta.repo, meta.number)).comments.find((c) => c.url === url);
            comment = { url, createdAt: posted?.createdAt ?? before };
          }
          commentUrl = comment.url;
          postedAt = comment.createdAt;
          await writeFileAtomic(gateFile, `${JSON.stringify({ commentUrl, postedAt }, null, 2)}\n`);
        }
      } catch (err) {
        return escalate(`gate ${step.id}: ${msg(err)}`);
      }

      const waiting: Waiting = { stepId: step.id, stepDir: io.stepDir, since: new Date(now()).toISOString(), commentUrl };
      await writeFileAtomic(waitingPath, `${JSON.stringify(waiting, null, 2)}\n`);
      wroteWaiting = true;

      const decisionFile = path.join(io.stepDir, 'decision.json');
      const postedMs = Date.parse(postedAt);
      let decision: Decision | undefined;
      let lastPoll: number | undefined;
      while (!decision) {
        if (await exists(decisionFile)) {
          const parsed = DecisionSchema.safeParse(await readJson(decisionFile).catch((e) => `unreadable: ${msg(e)}`));
          if (!parsed.success) {
            return escalate(`${decisionFile} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
          }
          decision = parsed.data as Decision;
          break;
        }
        if (lastPoll === undefined || now() - lastPoll >= trackerPollMs) {
          lastPoll = now();
          try {
            const issue = await o.gh.issue(meta.repo, meta.number);
            const candidates: IssueComment[] = issue.comments
              .filter((c) => Date.parse(c.createdAt) > postedMs && approvers.includes(c.author.toLowerCase()))
              .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            for (const c of candidates) {
              const cmd = parseCommand(c.body);
              if (!cmd) continue;
              decision = {
                decision: cmd.decision,
                ...(cmd.feedback === '' ? {} : { feedback: cmd.feedback }),
                by: c.author,
                via: 'comment',
                url: c.url,
              };
              break;
            }
          } catch {
            // retried on the next tracker poll
          }
          if (decision) break;
        }
        await sleep(pollMs);
      }

      await fs.rm(waitingPath, { force: true });
      wroteWaiting = false;
      await fs.mkdir(io.outputsDir, { recursive: true });
      let status: 'pass' | 'fail';
      if (decision.decision === 'approve') {
        const via = decision.via === 'comment' ? `comment ${decision.url}` : 'perc approve';
        await writeFileAtomic(path.join(io.outputsDir, 'approval.md'), `Approved by @${decision.by} via ${via}.\n`);
        status = 'pass';
      } else {
        const why = decision.feedback && decision.feedback !== '' ? decision.feedback : '(no feedback given)';
        await writeFileAtomic(path.join(io.outputsDir, 'findings.md'), `Rejected by @${decision.by}: ${why}\n`);
        status = 'fail';
      }
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`gate ${step.id}: ${collected.error}`);
      return { status, outputs: collected.outputs };
    } catch (err) {
      return escalate(`gate ${step.id}: ${msg(err)}`);
    } finally {
      if (wroteWaiting) await fs.rm(waitingPath, { force: true }).catch(() => {});
    }
  };
}
