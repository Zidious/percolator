import { createHash } from 'node:crypto';
import type { PipelineSpec } from '../config/pipelines.ts';
import type { Trigger } from '../config/schema.ts';
import { ISSUE_LIST_LIMIT } from '../tracker/gh.ts';
import type { Gh, PrRef } from '../tracker/gh.ts';
import { latestTick, parseCron } from '../util/cron.ts';
import type { Ledger } from './ledger.ts';

/** One run a trigger asks for; `key` is what the ledger records so it fires once. */
export type Firing = { key: string; pipeline: string; ticket?: string; inputs: Record<string, string> };

const DEPENDABOT = new Set(['dependabot[bot]', 'app/dependabot']);

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

const KINDS = ['schedule', 'label', 'pr_opened', 'dependabot', 'check_failed'] as const;

/**
 * A trigger's identity in the ledger: its kind and a short hash of its config (JSON with sorted keys), so
 * reordering triggers keeps each one's marks and editing one makes it a new trigger, polled for the first time.
 */
export function triggerId(trigger: Trigger): string {
  const kind = KINDS.find((k) => k in trigger) ?? 'trigger';
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
    let labelled: Set<number> | undefined = (spec.triggers ?? []).some((t) => 'label' in t) ? new Set() : undefined;
    for (const trigger of spec.triggers ?? []) {
      const id = triggerId(trigger);
      const mark = `${repo}:${pipeline}:${id}`;
      const firstPoll = o.first === true || ledger.lastPoll[mark] === undefined;
      // a PR or check trigger's first poll (ever, or since the watcher started) records what is already
      // there as seen (runId ''), so a watcher starts nothing for PRs opened or checks failed before it ran
      const seen = (f: Firing): void => {
        if (!firstPoll) return add(f);
        if (!Object.hasOwn(ledger.fired, f.key)) ledger.fired[f.key] = { runId: '', at: o.now.toISOString() };
      };
      if ('schedule' in trigger) {
        const after = ledger.lastPoll[mark];
        ledger.lastPoll[mark] = o.now.toISOString();
        if (after === undefined) continue;
        const tick = latestTick(parseCron(trigger.schedule), new Date(after), o.now, trigger.timezone);
        if (tick) add({ key: `schedule:${repo}:${pipeline}:${id}:${tick.key}`, pipeline, inputs: { ...trigger.inputs } });
      } else if ('label' in trigger) {
        // no first-poll seeding here: labelling an issue is asking for a run, and the label stays on
        // the issue, so one labelled before the watcher started is still a request to answer
        const issues = await gh.listIssues(repo, { label: trigger.label });
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
          add({ key, pipeline, ticket: issue.url, inputs: {} });
        }
      } else if ('pr_opened' in trigger || 'dependabot' in trigger) {
        const wanted =
          'dependabot' in trigger
            ? (pr: PrRef) => DEPENDABOT.has(pr.author)
            : (pr: PrRef) => trigger.pr_opened === true || !(trigger.pr_opened.not_author ?? []).includes(pr.author);
        for (const pr of await openPrs()) {
          if (wanted(pr)) seen({ key: `pr:${repo}:${pipeline}:${pr.number}`, pipeline, inputs: { pr: pr.url } });
        }
        ledger.lastPoll[mark] = o.now.toISOString();
      } else {
        const { branch, workflow } = trigger.check_failed;
        const runs = await gh.failedRuns(repo, workflow === undefined ? { branch } : { branch, workflow });
        for (const run of runs) {
          // a re-run keeps its id: a later attempt that fails again is a new failure (attempt 1 keeps the bare id)
          const attempt = run.attempt > 1 ? `${run.databaseId}.${run.attempt}` : `${run.databaseId}`;
          seen({ key: `check:${repo}:${pipeline}:${attempt}`, pipeline, inputs: { branch, run_url: run.url } });
        }
        ledger.lastPoll[mark] = o.now.toISOString();
      }
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
