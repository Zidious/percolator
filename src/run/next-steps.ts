import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunState } from '../engine/state.ts';
import { ROUTE_CHOOSE } from '../graph/core.ts';
import { latest } from './outputs.ts';
import { parsePick } from './route.ts';
import type { AttentionJson, AttentionKind } from './status-json.ts';

export type YourTurnInput = {
  kind: AttentionKind;
  runId: string;
  step: string;
  /** absent on a ticketless run */
  ticket?: string;
  /** the run's pipeline and inputs, so "start it again" starts the same kind of run */
  pipeline?: string;
  inputs?: Record<string, string>;
  repoRoot: string;
  /** the run's profile and (unless the default) config file, so it starts under the same config */
  profile?: string;
  config?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  terminal?: string;
  agentState?: string;
  /** a failed fan-out slice: its parent run, which starts the slice again once it is deleted */
  sliceOf?: string;
  /** a pick-pipeline gate: the pipelines `perc approve --pipeline` may name */
  choices?: string[];
  /** findings: the stage a granted round goes back to; gate: the stage a reject goes back to (none: a reject ends the run) */
  backTo?: string;
  /** gate: its loop is on its last round, so a reject pauses at this cap of rounds (asking which findings to fix, for a stage loop) */
  capRounds?: number;
  capAsksFindings?: boolean;
  /** findings: the failing step wrote none, so the only answer is to move on */
  nothingToTick?: boolean;
};

/**
 * A value as typed (the repo, an input after `--input k=`), backslashes kept as they are. A blank or a `'`:
 * double-quoted, which sh, PowerShell and cmd read alike. A `"`, `$` or backtick: single-quoted, which sh and
 * PowerShell take as typed (no shell reads a `\"` escape alike). Both kinds of quote: PowerShell's `''`, as
 * Windows is the owner's OS.
 */
const quoted = (v: string): string => {
  if (!/[\s"'$`]/.test(v)) return v;
  if (!/["$`]/.test(v)) return `"${v}"`;
  return `'${v.replace(/'/g, "''")}'`;
};

/**
 * The `perc run` that starts the same kind of run again: its ticket, its pipeline (named even when feature, as a
 * profile may mark another pipeline default), its inputs, its repo, then its config file (unless the default) and profile.
 */
export function runAgain(a: Pick<YourTurnInput, 'ticket' | 'pipeline' | 'inputs' | 'repoRoot' | 'profile' | 'config'>): string {
  const pipeline = a.pipeline !== undefined ? [`--pipeline ${a.pipeline}`] : [];
  const inputs = Object.entries(a.inputs ?? {}).map(([k, v]) => `--input ${k}=${quoted(v)}`);
  const config = a.config !== undefined ? [`--config ${quoted(a.config)}`] : [];
  const profile = a.profile !== undefined ? [`--profile ${a.profile}`] : [];
  return ['perc run', ...(a.ticket ? [a.ticket] : []), ...pipeline, ...inputs, `--repo ${quoted(a.repoRoot)}`, ...config, ...profile].join(' ');
}

/** Where a reject of a gate sends the run: back with the feedback, else to the cap of its loop on the last round. */
function gateDetail(a: Pick<YourTurnInput, 'backTo' | 'capRounds' | 'capAsksFindings'>): string {
  if (a.backTo === undefined) return "Rejecting ends the run; a failed run can't be resumed.";
  if (a.capRounds !== undefined) {
    return a.capAsksFindings === true
      ? `Rejecting pauses the run at its cap (${a.capRounds} rounds) to ask which findings to fix.`
      : `Rejecting pauses the run at its cap (${a.capRounds} rounds); perc resume grants one more.`;
  }
  return `Rejecting sends the run back to ${a.backTo} with your feedback.`;
}

/** A failed step, with why it failed when the run recorded it (`lint failed (exit code 1)`). */
export function failedText(step: string, reason: string | undefined): string {
  return reason === undefined ? `${step} failed` : `${step} failed (${reason})`;
}

/** What the owner has to do next, as one sentence plus the exact commands to type. Shared by `perc status` and the JSON. */
export function yourTurn(a: YourTurnInput): { message: string; detail?: string; next: string[] } {
  const resume = [`perc resume ${a.runId}`];
  switch (a.kind) {
    case 'gate':
      return {
        // a ticketless run has no issue for the gate to comment on
        message: a.ticket ? `${a.step} is waiting for approval` : 'approve or reject here (no issue to comment on)',
        detail: gateDetail(a),
        next: [
          ...(a.choices !== undefined ? a.choices.map((c) => `perc approve ${a.runId} --pipeline ${c}`) : [`perc approve ${a.runId}`]),
          `perc reject ${a.runId} "<what to change>"`,
        ],
      };
    case 'cap':
      return {
        message: `${a.step} hit its cap (${a.reason})`,
        detail: 'Grant one more round and the run goes back with the open findings.',
        next: resume,
      };
    case 'paused': {
      // the runtime's reasons start with the step, which the message already names
      const reason = a.reason ?? ''; // attentionNext asks for the commands only
      const why = reason.startsWith(`${a.step}: `) ? reason.slice(a.step.length + 2) : reason;
      return { message: `${a.step} paused`, ...(why.trim() !== '' ? { detail: why } : {}), next: resume };
    }
    case 'questions':
      return {
        message: `${a.step} has questions for you`,
        detail: `Answer each one or mark it N/A; ${a.step} then runs again with your answers.`,
        next: [`perc answer ${a.runId} --answer <n>="<text>" --na <n> …`],
      };
    case 'findings':
      if (a.nothingToTick === true) {
        return { message: `${a.step} hit its cap and wrote no findings to tick`, detail: 'The only answer is to move on past it.', next: [`perc answer ${a.runId}`] };
      }
      return {
        message: `${a.step} hit its cap with findings left`,
        detail: `Tick the findings to fix: the run goes back${a.backTo === undefined ? '' : ` to ${a.backTo}`} for one more round with only those. With none ticked, it moves on.`,
        next: [`perc answer ${a.runId} --agree <n>[,<n>…]`, `perc answer ${a.runId}`],
      };
    case 'failed':
      if (a.sliceOf !== undefined) {
        return {
          message: `${a.step} failed`,
          detail: `Delete this slice (its branch stays), then resume ${a.sliceOf} to run it again`,
          next: [`perc delete ${a.runId}`, `perc resume ${a.sliceOf}`],
        };
      }
      return {
        message: failedText(a.step, a.reason),
        detail: `A failed run can't be resumed. Start a new run ${a.ticket ? 'for the ticket' : `of pipeline ${a.pipeline ?? 'feature'}`}, then delete this one (or clean it up to keep its record).`,
        next: [runAgain(a), `perc delete ${a.runId}`, `perc clean ${a.runId}`],
      };
    case 'stalled':
      if (a.decision !== undefined) return { message: `${a.decision === 'approve' ? 'approved' : 'rejected'}; resume to continue`, next: resume };
      return {
        message: `the driver stopped while ${a.step} was running`,
        detail: `Nothing is driving this run. Resume picks up at ${a.step}.`,
        next: resume,
      };
    case 'agent':
      return { message: `${a.step}'s agent is ${a.agentState} in terminal ${a.terminal}`, detail: "Attend the agent's terminal.", next: [] };
  }
}

/**
 * The commands `yourTurn` gives for an attention record (they depend on its kind and the run, not on its reason).
 * A failed run with a parent and no `commands` is a fan-out slice (attentionOf gives a slice none).
 */
export function attentionNext(
  a: AttentionJson,
  run: {
    id: string;
    ticket: { ref: string } | null;
    pipeline: string;
    inputs: Record<string, string>;
    repo: string;
    parent?: string | null;
    profile?: string;
    config?: string | null;
  },
): string[] {
  const again = {
    ticket: run.ticket?.ref,
    pipeline: run.pipeline,
    inputs: run.inputs,
    repoRoot: run.repo,
    ...(run.profile !== undefined ? { profile: run.profile } : {}),
    ...(typeof run.config === 'string' ? { config: run.config } : {}),
  };
  const slice = a.kind === 'failed' && a.commands === undefined && typeof run.parent === 'string' ? { sliceOf: run.parent } : {};
  const choices = a.choices !== undefined ? { choices: a.choices } : {};
  const none = a.kind === 'findings' && a.asked?.items.length === 0 ? { nothingToTick: true } : {};
  return yourTurn({ kind: a.kind, runId: run.id, step: '', ...again, ...slice, ...choices, ...none }).next;
}

/** A pick gate's reject has the choose agent pick again, or pauses at its cap on the last round. */
export function pickDetail(g: Pick<YourTurnInput, 'backTo' | 'capRounds'>): { detail?: string } {
  if (g.backTo === undefined) return {};
  if (g.capRounds !== undefined) return { detail: gateDetail(g) };
  return { detail: 'Rejecting has the agent pick again with your feedback.' };
}

/** The choose agent's latest valid pick among `choices`, if it made one (sure or not). */
export async function suggestion(dir: string, state: RunState, choices: string[]): Promise<string | undefined> {
  const rel = latest(state, ROUTE_CHOOSE)?.outputs['pick'];
  if (rel === undefined) return undefined;
  const text = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
  return parsePick(text, choices).pipeline;
}
