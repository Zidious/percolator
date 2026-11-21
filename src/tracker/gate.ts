import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { NodeOutcome, RunContext } from '../engine/runtime.ts';
import type { Step } from '../graph/build.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { exists, writeFileAtomic } from '../util/fs.ts';
import { toPosix } from '../util/paths.ts';
import { commentIdOf } from './gh.ts';
import type { Gh, IssueComment } from './gh.ts';
import { parseGateComment, renderGateComment } from './gate-comment.ts';
import type { GateComment } from './gate-comment.ts';
import { readIssueMeta } from './intake.ts';
import { decisionNote, parseCommand } from './prior-groom.ts';

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
  const file = waitingFile(runDir);
  const invalid = (why: string) => new Error(`Waiting file ${file} is invalid: ${why}; delete it and resume the run`);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (err) {
    if (err instanceof SyntaxError) throw invalid(err.message);
    throw err;
  }
  if (raw === undefined) return undefined;
  const r = WaitingSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw invalid(`${i.path.join('.') || 'value'}: ${i.message}`);
  }
  return r.data;
}

/** The gh login of whoever decides locally; the OS user (as one handle) when gh cannot say. */
export async function deciderLogin(gh: Gh, username: () => string = () => os.userInfo().username): Promise<string> {
  try {
    const login = await gh.user();
    if (login !== '') return login;
  } catch {
    // gh not logged in or unreachable: fall back to the OS user
  }
  return username().replace(/\s+/g, '-');
}

export async function writeDecision(
  runDir: string,
  d: { decision: 'approve' | 'reject'; feedback?: string; by: string },
): Promise<Waiting> {
  const waiting = await readWaiting(runDir);
  if (!waiting) throw new Error('run is not waiting at a gate');
  const full: Decision = { ...d, via: 'local' };
  await writeFileAtomic(path.join(waiting.stepDir, 'decision.json'), `${JSON.stringify(full, null, 2)}\n`);
  return waiting;
}

export { parseCommand } from './prior-groom.ts';

async function renderOutputs(runDir: string, runId: string, outputs: Record<string, string>): Promise<string> {
  const parts: string[] = [];
  let budget = OUTPUT_CAP;
  for (const key of Object.keys(outputs).sort()) {
    const rel = outputs[key]!;
    if (!rel.toLowerCase().endsWith('.md')) continue;
    const abs = path.resolve(runDir, rel);
    const text = (await fs.readFile(abs, 'utf8')).trim();
    if (text.length > budget) {
      // run-relative: a local absolute path would leak into a public comment
      parts.push(`### ${key}\n\n${text.slice(0, budget)}\n… (truncated; full text in ${toPosix(rel)} of run ${runId})`);
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

/** `<stepDir>/gate.json`: where this round's comment is and when its text went up. */
type SavedGate = { commentUrl: string; commentId: number; round?: number; postedAt: string };

const gateJson = (g: SavedGate) => `${JSON.stringify(g, null, 2)}\n`;

async function readGate(file: string): Promise<SavedGate | undefined> {
  const raw = (await readJson(file)) as Partial<SavedGate> | undefined;
  if (!raw) return undefined;
  // a gate.json from before the upgrade has only commentUrl and postedAt
  return { ...raw, commentId: raw.commentId ?? commentIdOf(raw.commentUrl ?? '') } as SavedGate;
}

/** This round's gate.json in an earlier attempt dir of the step, newest attempt first. */
async function earlierGate(stepDir: string, round: number): Promise<SavedGate | undefined> {
  const parent = path.dirname(stepDir);
  const self = path.basename(stepDir);
  const attempts = (await fs.readdir(parent, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name !== self)
    .map((d) => d.name)
    .sort((a, b) => Number(b) - Number(a));
  for (const a of attempts) {
    const g = await readGate(path.join(parent, a, 'gate.json'));
    if (g?.round === round) return g;
  }
  return undefined;
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

/** A rejected `sleep` means the driver is being stopped: it propagates instead of escalating. */
class Aborted {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

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
  /** called once the gate is waiting, with its comment url */
  onWaiting?: (stepId: string, commentUrl: string) => void;
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
      // keyed on the round, not the attempt: an escalation after posting re-runs the gate in a new
      // attempt dir, and that attempt must find (not re-post) this round's comment
      const round = ctx.state.history.filter((h) => h.stepId === step.id && (h.status === 'pass' || h.status === 'fail')).length + 1;
      const gateFile = path.join(io.stepDir, 'gate.json');

      let commentUrl: string;
      let postedAt: string;
      try {
        let saved = await readGate(gateFile);
        if (!saved) {
          // an earlier attempt of this round (an escalation, then a resume) already put the text up:
          // no gh write, and replies since then still count
          saved = await earlierGate(io.stepDir, round);
          if (saved) await writeFileAtomic(gateFile, gateJson(saved));
        }
        if (saved) {
          ({ commentUrl, postedAt } = saved);
        } else {
          const self = (await o.gh.user()).toLowerCase();
          let found: { c: IssueComment; g: GateComment } | undefined;
          for (const c of (await o.gh.issue(meta.repo, meta.number)).comments) {
            if (c.author.toLowerCase() !== self) continue;
            const g = parseGateComment(c.body);
            if (g?.runId === o.runId && g.stepId === step.id) {
              found = { c, g };
              break;
            }
          }
          const outputs = await renderOutputs(o.runDir, o.runId, previousStepOutputs(step, ctx));
          const body = renderGateComment({ runId: o.runId, stepId: step.id, round, outputs, rejected: found?.g.rejected ?? [] });
          const bodyFile = path.join(io.stepDir, 'gate-comment.md');
          await writeFileAtomic(bodyFile, body);
          if (found) {
            // replies to earlier rounds came before this edit, so the poll below never counts them
            const editedAt = await o.gh.editComment(meta.repo, found.c.id, bodyFile);
            saved = { commentUrl: found.c.url, commentId: found.c.id, round, postedAt: editedAt };
          } else {
            const before = new Date(now()).toISOString();
            const url = await o.gh.comment(meta.repo, meta.number, bodyFile);
            // the comment exists now: a failed lookup must not escalate, or the resume would search again
            const posted = await o.gh
              .issue(meta.repo, meta.number)
              .then((i) => i.comments.find((c) => c.url === url))
              .catch(() => undefined);
            saved = { commentUrl: url, commentId: commentIdOf(url), round, postedAt: posted?.createdAt ?? before };
          }
          await writeFileAtomic(gateFile, gateJson(saved));
          ({ commentUrl, postedAt } = saved);
        }
      } catch (err) {
        return escalate(`gate ${step.id}: ${msg(err)}`);
      }

      const waiting: Waiting = { stepId: step.id, stepDir: io.stepDir, since: new Date(now()).toISOString(), commentUrl };
      await writeFileAtomic(waitingPath, `${JSON.stringify(waiting, null, 2)}\n`);
      wroteWaiting = true;
      o.onWaiting?.(step.id, commentUrl);

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
        await sleep(pollMs).catch((err: unknown) => {
          throw new Aborted(err);
        });
      }

      if (decision.via === 'local') {
        // best-effort: the issue records the decision so a later run can reuse this round's groomed ticket
        const note = decisionNote({
          runId: o.runId,
          stepId: step.id,
          round,
          decision: decision.decision,
          by: decision.by,
          ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
        });
        const marker = note.split('\n')[0]!;
        try {
          const noted = (await o.gh.issue(meta.repo, meta.number)).comments.some((c) => c.body.startsWith(marker));
          if (!noted) {
            const noteFile = path.join(io.stepDir, 'decision-note.md');
            await writeFileAtomic(noteFile, note);
            await o.gh.comment(meta.repo, meta.number, noteFile);
          }
        } catch {
          // the run goes on: only a later run's reuse of this groomed ticket depends on the note
        }
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
      if (err instanceof Aborted) throw err.cause;
      return escalate(`gate ${step.id}: ${msg(err)}`);
    } finally {
      if (wroteWaiting) await fs.rm(waitingPath, { force: true }).catch(() => {});
    }
  };
}
