import type { PipelineSpec } from '../config/pipelines.ts';
import type { Gh, PrRef } from '../tracker/gh.ts';
import { latestTick, parseCron } from '../util/cron.ts';
import type { Ledger } from './ledger.ts';

/** One run a trigger asks for; `key` is what the ledger records so it fires once. */
export type Firing = { key: string; pipeline: string; ticket?: string; inputs: Record<string, string> };

const DEPENDABOT = new Set(['dependabot[bot]', 'app/dependabot']);

/**
 * What the triggers of `specs` ask to start now in `repo` (host/owner/repo). Keys already in
 * `ledger.fired` are left out, so a caller firing each result through `fire` starts it once.
 * Schedule, PR and check triggers move `ledger.lastPoll` to `now` in memory (the caller saves it); one
 * with no mark yet only seeds it (and a PR or check trigger records what it sees in `ledger.fired`), so a
 * new or long-stopped watcher never backfills.
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
    for (const [i, trigger] of (spec.triggers ?? []).entries()) {
      const mark = `${repo}:${pipeline}:${i}`;
      const firstPoll = ledger.lastPoll[mark] === undefined;
      // a PR or check trigger's first poll records what is already there as seen (runId ''), so a new
      // watcher starts nothing for PRs opened or checks failed before it ran
      const seen = (f: Firing): void => {
        if (!firstPoll) return add(f);
        if (!Object.hasOwn(ledger.fired, f.key)) ledger.fired[f.key] = { runId: '', at: o.now.toISOString() };
      };
      if ('schedule' in trigger) {
        const after = ledger.lastPoll[mark];
        ledger.lastPoll[mark] = o.now.toISOString();
        if (after === undefined) continue;
        const tick = latestTick(parseCron(trigger.schedule), new Date(after), o.now, trigger.timezone);
        if (tick) add({ key: `schedule:${repo}:${pipeline}:${i}:${tick.key}`, pipeline, inputs: { ...trigger.inputs } });
      } else if ('label' in trigger) {
        // no first-poll seeding here: labelling an issue is asking for a run, and the label stays on
        // the issue, so one labelled before the watcher started is still a request to answer
        for (const issue of await gh.listIssues(repo, { label: trigger.label })) {
          const key = `label:${repo}:${pipeline}:${issue.number}`;
          if (Object.hasOwn(ledger.fired, key) || (await o.liveRunOn(issue.url))) continue;
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
          seen({ key: `check:${repo}:${pipeline}:${run.databaseId}`, pipeline, inputs: { branch, run_url: run.url } });
        }
        ledger.lastPoll[mark] = o.now.toISOString();
      }
    }
  }
  return out;
}
