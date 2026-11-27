import { createHash } from 'node:crypto';
import type { PipelineSpec } from '../config/pipelines.ts';
import type { Trigger } from '../config/schema.ts';
import { onTrigger, triggerKind } from '../config/triggers.ts';
import type { TriggerKind } from '../config/triggers.ts';
import { ISSUE_LIST_LIMIT, PR_LIST_LIMIT } from '../tracker/gh.ts';
import type { Gh, PrRef } from '../tracker/gh.ts';
import type { RunTrigger } from '../run/meta.ts';
import { latestTick, parseCron } from '../util/cron.ts';
import type { Ledger } from './ledger.ts';

/**
 * One run a trigger asks for; `key` is what the ledger records so it fires once. `trigger` names the trigger
 * that asked (a poll always sets it; a firing recovered from a ledger entry older than it has none).
 */
export type Firing = { key: string; pipeline: string; ticket?: string; inputs: Record<string, string>; trigger?: RunTrigger };

const DEPENDABOT = new Set(['dependabot[bot]', 'app/dependabot']);

/** How long a PR or check key the lists no longer show is kept before it is dropped from the ledger. */
const DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/**
 * A trigger's identity in the ledger: its kind and a short hash of its config (JSON with sorted keys), so
 * reordering triggers keeps each one's marks and editing one makes it a new trigger, polled for the first time.
 */
export function triggerId(trigger: Trigger): string {
  const kind = triggerKind(trigger);
  const hash = createHash('sha1').update(JSON.stringify(canonical(trigger))).digest('hex').slice(0, 8);
  return `${kind}-${hash}`;
}

/**
 * What the triggers of `specs` ask to start now in `repo` (host/owner/repo). Keys already in
 * `ledger.fired` are left out, so a caller firing each result through `fire` starts it once.
 * Schedule, PR and check triggers move `ledger.lastPoll` to `now` in memory (the caller saves it); a
 * schedule with no mark yet only seeds it, so a new watcher never backfills. On `first` (the first poll
 * since the watcher started) and on a trigger's first poll ever, a PR or check trigger records every
 * PR or failure it sees in `ledger.fired` as seen instead of firing it, so nothing that appeared while
 * the watcher was stopped is made up later.
 */
export async function pollTriggers(o: {
  home: string;
  repoRoot: string;
  repo: string;
  specs: Record<string, PipelineSpec>;
  gh: Gh;
  now: Date;
  ledger: Ledger;
  liveRunOn: (ticketRef: string) => Promise<boolean>;
  /** the first poll since the watcher started */
  first?: boolean;
}): Promise<Firing[]> {
  const { repo, gh, ledger } = o;
  const out: Firing[] = [];
  const add = (f: Firing): void => {
    if (!Object.hasOwn(ledger.fired, f.key)) out.push(f);
  };
  let prs: Promise<PrRef[]> | undefined;
  const openPrs = (): Promise<PrRef[]> => (prs ??= gh.listPrs(repo));

  for (const spec of Object.values(o.specs)) {
    const pipeline = spec.name;
    // the issues every label trigger of this pipeline sees, or undefined once a list may be cut short
    let labelled: Set<number> | undefined = (spec.triggers ?? []).some((t) => triggerKind(t) === 'label') ? new Set() : undefined;
    // keys a first poll saw, recorded once every trigger of the pipeline polled: triggers share PR and check
    // keys, so a key another trigger fires in this poll is not seen, whichever trigger comes first
    const seeds = new Set<string>();
    // the PR and check keys this poll's lists show: undefined if no trigger listed them, or a list may be cut short
    let prKeys: Set<string> | undefined;
    let checkKeys: Set<string> | undefined;
    for (const trigger of spec.triggers ?? []) {
      const id = triggerId(trigger);
      const mark = `${repo}:${pipeline}:${id}`;
      const firstPoll = o.first === true || ledger.lastPoll[mark] === undefined;
      // a PR or check trigger's first poll (ever, or since the watcher started) records what is already
      // there as seen (runId ''), so a watcher starts nothing for PRs opened or checks failed before it ran
      const seen = (f: Firing): void => {
        if (!firstPoll) return add(f);
        seeds.add(f.key);
      };
      // a PR trigger (pr_opened or dependabot): every open PR it wants, as input pr
      const pollPrs = async (kind: TriggerKind, wanted: (pr: PrRef) => boolean): Promise<void> => {
        const open = await openPrs();
        prKeys ??= open.length >= PR_LIST_LIMIT ? undefined : new Set(open.map((pr) => `pr:${repo}:${pipeline}:${pr.number}`));
        for (const pr of open) {
          if (wanted(pr)) {
            seen({ key: `pr:${repo}:${pipeline}:${pr.number}`, pipeline, inputs: { pr: pr.url }, trigger: { kind, detail: `#${pr.number}` } });
          }
        }
        ledger.lastPoll[mark] = o.now.toISOString();
      };
      await onTrigger<Promise<void>>(trigger, {
        schedule: async (t) => {
          const after = ledger.lastPoll[mark];
          ledger.lastPoll[mark] = o.now.toISOString();
          if (after === undefined) return;
          const tick = latestTick(parseCron(t.schedule), new Date(after), o.now, t.timezone);
          const detail = t.timezone === undefined ? t.schedule : `${t.schedule} ${t.timezone}`;
          if (tick) {
            add({
              key: `schedule:${repo}:${pipeline}:${id}:${tick.key}`,
              pipeline,
              inputs: { ...t.inputs },
              trigger: { kind: 'schedule', detail },
            });
          }
        },
        label: async (t) => {
          // no first-poll seeding here: labelling an issue is asking for a run, and the label stays on
          // the issue, so one labelled before the watcher started is still a request to answer
          const issues = await gh.listIssues(repo, { label: t.label });
          if (issues.length >= ISSUE_LIST_LIMIT) labelled = undefined;
          for (const issue of issues) {
            labelled?.add(issue.number);
            const key = `label:${repo}:${pipeline}:${issue.number}`;
            if (Object.hasOwn(ledger.fired, key)) continue;
            // a live run already answers the label: record it as seen, so the issue does not fire again
            // once that run finishes
            if (await o.liveRunOn(issue.url)) {
              ledger.fired[key] = { runId: '', at: o.now.toISOString() };
              continue;
            }
            add({ key, pipeline, ticket: issue.url, inputs: {}, trigger: { kind: 'label', detail: t.label } });
          }
        },
        pr_opened: (t) => pollPrs('pr_opened', (pr) => t.pr_opened === true || !(t.pr_opened.not_author ?? []).includes(pr.author)),
        dependabot: () => pollPrs('dependabot', (pr) => DEPENDABOT.has(pr.author)),
        check_failed: async (t) => {
          const { branch, workflow } = t.check_failed;
          const runs = await gh.failedRuns(repo, workflow === undefined ? { branch } : { branch, workflow });
          checkKeys ??= new Set();
          for (const run of runs) {
            // a re-run keeps its id: a later attempt that fails again is a new failure (attempt 1 keeps the bare id)
            const attempt = run.attempt > 1 ? `${run.databaseId}.${run.attempt}` : `${run.databaseId}`;
            checkKeys.add(`check:${repo}:${pipeline}:${attempt}`);
            seen({
              key: `check:${repo}:${pipeline}:${attempt}`,
              pipeline,
              inputs: { branch, run_url: run.url },
              trigger: { kind: 'check_failed', detail: branch },
            });
          }
          ledger.lastPoll[mark] = o.now.toISOString();
        },
      });
    }
    for (const key of seeds) {
      if (!Object.hasOwn(ledger.fired, key) && !out.some((f) => f.key === key)) ledger.fired[key] = { runId: '', at: o.now.toISOString() };
    }
    // a PR closed, or a failure off the run list, for a week can never fire again: drop its key, unless it
    // was recorded but never prepared (a restarted watcher starts it)
    for (const [key, f] of Object.entries(ledger.fired)) {
      const shown = key.startsWith(`pr:${repo}:${pipeline}:`) ? prKeys : key.startsWith(`check:${repo}:${pipeline}:`) ? checkKeys : undefined;
      if (shown === undefined || shown.has(key) || (f.runId !== '' && f.prepared !== true)) continue;
      if (o.now.getTime() - Date.parse(f.at) > DROP_AFTER_MS) delete ledger.fired[key];
    }
    // an issue no label trigger sees any more (label removed, or issue closed) is re-armed, so labelling it
    // again asks for a new run; a firing recorded but never prepared stays for a restarted watcher to start
    if (labelled !== undefined) {
      const prefix = `label:${repo}:${pipeline}:`;
      for (const [key, f] of Object.entries(ledger.fired)) {
        if (!key.startsWith(prefix) || labelled.has(Number(key.slice(prefix.length)))) continue;
        if (f.runId === '' || f.prepared === true) delete ledger.fired[key];
      }
    }
  }
  return out;
}
