import type { StepRecord } from '../engine/state.ts';
import type { RunGraphLoop, RunGraphStep } from './graph-file.ts';
import type { RunTrigger } from './meta.ts';

// The `perc status --json` contract; its only readers are herdr/mods/percolator/status.js and model.js.

export type AttentionKind = 'gate' | 'cap' | 'paused' | 'questions' | 'findings' | 'failed' | 'stalled' | 'agent';
export type Action = 'approve' | 'pick' | 'reject' | 'grant' | 'resume' | 'answer' | 'clean' | 'open-pane' | 'run-again';
export type ReviewItem = { step: string; key: string; path: string };
export type AttentionJson = {
  kind: AttentionKind;
  since: string;
  message: string;
  detail?: string;
  commentUrl?: string;
  review?: ReviewItem[];
  actions: Action[];
  commands?: string[];
  terminal?: string;
  agentState?: string;
  /** paused only: the agent's saved screen (an absolute path) when the pause reason names it; `detail` keeps it in its text */
  transcript?: string;
  /** a pick-pipeline gate only: the pipelines `pick` may name (`perc approve <id> --pipeline <name>`) */
  choices?: string[];
  /** questions or findings only: what the run asks, item by item (`perc answer <id>` numbers them from 1) */
  asked?: { step: string; attempt: number; items: string[] };
};
export type StepJson = RunGraphStep & {
  status: 'pending' | 'running' | 'waiting' | StepRecord['status'];
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  outputs: Record<string, string>;
};
export type DecisionJson = { decision: 'approve' | 'reject'; by?: string };
export type AttemptJson = {
  kind: 'attempt';
  step: string;
  attempt: number;
  /** `running` or `waiting` only on the live entry, which is always last */
  status: Exclude<StepJson['status'], 'pending'>;
  startedAt?: string;
  /** absent on the live entry */
  endedAt?: string;
  outputs: Record<string, string>;
  /** gate attempts only: pass is approve, fail is reject */
  decision?: DecisionJson;
};
export type CapJson = { kind: 'cap'; loop: string; from: string; to: string; max: number; at: string };
export type TimelineJson = AttemptJson | CapJson;
export type LoopJson = RunGraphLoop & { round: number };
export type TicketJson = { ref: string; number: number; title?: string; url?: string };
/** A run this one started (route or fan-out child); `slice` only on a fan-out child. */
export type ChildJson = { id: string; pipeline: string; status: RunStatusJson['status'] | 'pending'; slice?: { index: number; title: string } };
export type RunStatusJson =
  | {
      id: string;
      /** the pipeline the run was started on (`feature` for a run from before pipelines) */
      pipeline: string;
      /** the `--input` values the run was started with */
      inputs: Record<string, string>;
      /** the profile the run was started with */
      profile: string;
      /** the config file the run was started with, null when it is perc's default (`~/.percolator/config.yaml`) */
      config: string | null;
      /** null on a ticketless run */
      ticket: TicketJson | null;
      /** the run that started this one, else null */
      parent: string | null;
      /** fan-out slices by index (pending until started), then listed runs whose parent is this run, in listing order */
      children: ChildJson[];
      /** the issues the run's exit opened, from its latest `issue_urls` output */
      opened: { ref: string; url: string }[];
      repo: string;
      branch: string;
      worktree: string;
      createdAt: string;
      status: 'running' | 'waiting' | 'paused' | 'failed' | 'completed';
      /** the step the run is at; before any step has run, its first step; absent once completed */
      currentStep?: string;
      driver: { alive: boolean | null; terminal: string; space?: string; shown: boolean };
      attention?: AttentionJson;
      steps: StepJson[];
      loops: LoopJson[];
      /** every attempt in execution order, oldest first; the live attempt (if any) is last */
      timeline: TimelineJson[];
      terminals: Record<string, string>;
      pr: { url: string } | null;
      graph: 'full' | 'history';
      /** the `perc watch` trigger that started the run, null on a manual run (or one from before triggers were recorded) */
      trigger: RunTrigger | null;
      /** the comment the run's exit posted, from its latest `comment_url` output */
      comment: { url: string } | null;
    }
  | { id: string; status: 'unreadable'; error: string };
/** Whether `perc watch` runs (same host, live pid, fresh heartbeat), since when, and the repos it watches. */
export type WatcherJson = { alive: boolean; since?: string; repos: string[] };
export type StatusJson = { schema: 2; runs: RunStatusJson[]; watcher: WatcherJson };
