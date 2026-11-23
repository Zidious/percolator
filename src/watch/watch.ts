import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState } from '../engine/state.ts';
import { cliGit } from '../grounds/git.ts';
import { liveRunOn, newRunId, readRunMeta } from '../run/meta.ts';
import { launchDriver, prepareRun } from '../run/prepare.ts';
import type { DriverDeps } from '../run/prepare.ts';
import { ghRepo, sshHostname } from '../tracker/remote.ts';
import { formatTicket, parseTicket } from '../tracker/ticket.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { validate } from '../validate.ts';
import { runDir } from '../workspace/run-dir.ts';
import { fire, loadLedger, markPrepared, pruneLedger, saveLedger } from './ledger.ts';
import type { Ledger } from './ledger.ts';
import { pollTriggers } from './poll.ts';
import type { Firing } from './poll.ts';

/** The hc terminal `perc watch` runs the watcher in. */
export const WATCH_TERMINAL = 'percolator-watch';
/** The label that marks the watcher terminal: the only terminal perc removes that is not a run's. */
export const WATCHER_LABELS = { 'percolator.role': 'watcher' } as const;

/** `<home>/.percolator/watch/watch.json`: who is watching, and its last heartbeat. */
export type WatchFile = {
  pid: number;
  host: string;
  terminal?: string;
  startedAt: string;
  heartbeatAt: string;
  repos: string[];
  intervalS: number;
};

export type WatchOptions = { repos: string[]; configFile: string; profile?: string; intervalS: number };

const percDir = (home: string): string => path.join(home, '.percolator');
export const watchFile = (home: string): string => path.join(percDir(home), 'watch', 'watch.json');

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Poll every repo's triggers each `intervalS` until `deps.signal` aborts, starting one run per firing
 * through the ledger (recorded before it starts, so a restart never starts it twice).
 */
export async function watchLoop(o: WatchOptions, deps: DriverDeps & { signal?: AbortSignal }): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ledgerHome = percDir(deps.home);
  const ledger = await loadLedger(ledgerHome);
  const startedAt = now().toISOString();
  const stopped = (): boolean => deps.signal?.aborted === true;
  let first = true;
  while (!stopped()) {
    pruneLedger(ledger, now());
    for (const repoDir of o.repos) await pollRepo(repoDir, o, deps, ledger, first);
    first = false;
    await writeHeartbeat(deps, o, startedAt, now());
    if (stopped()) break;
    await sleep(o.intervalS * 1000);
  }
}

async function writeHeartbeat(deps: DriverDeps, o: WatchOptions, startedAt: string, at: Date): Promise<void> {
  const w: WatchFile = {
    pid: deps.pid ?? process.pid,
    host: os.hostname(),
    ...(deps.selfTerminal !== undefined ? { terminal: deps.selfTerminal } : {}),
    startedAt,
    heartbeatAt: at.toISOString(),
    repos: o.repos,
    intervalS: o.intervalS,
  };
  const file = watchFile(deps.home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(w, null, 2)}\n`);
}

/** Ledger keys are `<kind>:<repo>:<pipeline>:…`. */
const keyRepo = (key: string): string | undefined => key.split(':')[1];

async function pollRepo(repoDir: string, o: WatchOptions, deps: DriverDeps, ledger: Ledger, first: boolean): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const ledgerHome = percDir(deps.home);
  const log = (s: string) => deps.out(`watch: ${s}`);
  let repo: string;
  let specs;
  try {
    const v = await validate({
      configFile: o.configFile,
      cwd: repoDir,
      home: deps.home,
      ...(o.profile !== undefined ? { profile: o.profile } : {}),
    });
    specs = v.pipelines;
    const root = await cliGit.toplevel(repoDir);
    const origin = root === undefined ? undefined : await cliGit.remoteUrl(root);
    if (origin === undefined) throw new Error(`${root ?? repoDir} has no origin to watch; add one (git remote add origin <url>)`);
    repo = await ghRepo(origin, deps.sshHostname ?? sshHostname());
  } catch (err) {
    log(`${repoDir}: ${messageOf(err)}`);
    return;
  }

  const start = async (f: Firing, runId: string): Promise<void> => {
    const meta = await prepareRun(
      {
        ...(f.ticket !== undefined ? { ticket: f.ticket } : {}),
        pipeline: f.pipeline,
        inputs: f.inputs,
        runId,
        repoDir,
        configFile: o.configFile,
        ...(o.profile !== undefined ? { profile: o.profile } : {}),
      },
      deps,
    );
    // from here a missing run dir means the user deleted the run: a restart must not start it again
    await markPrepared(ledgerHome, ledger, f.key);
    await launchDriver(meta, deps);
  };

  // after a restart, each recorded firing of this repo once: one never prepared, or whose prepare stopped
  // before run.json (written last), is started from the ledger with its id (its trigger may never ask
  // again: a schedule tick is behind the mark); one prepared but never launched is relaunched; one
  // prepared whose dir is gone was deleted and stays done
  if (first) {
    for (const [key, entry] of Object.entries(ledger.fired)) {
      const { runId } = entry;
      if (keyRepo(key) !== repo || runId === '') continue;
      const dir = runDir(deps.home, runId);
      try {
        const dirExists = await exists(dir);
        if (!dirExists && entry.prepared) continue;
        if (!dirExists || !(await exists(path.join(dir, 'run.json')))) {
          if (entry.pipeline === undefined) continue;
          const f: Firing = {
            key,
            pipeline: entry.pipeline,
            ...(entry.ticket !== undefined ? { ticket: entry.ticket } : {}),
            inputs: entry.inputs ?? {},
          };
          await start(f, runId);
          log(`${key} → run ${runId}`);
          continue;
        }
        await markPrepared(ledgerHome, ledger, key);
        const meta = await readRunMeta(dir);
        const state = await loadState(dir);
        if (state.history.length > 0 || (await deps.hc.get(meta.driver)) !== undefined) continue;
        await launchDriver(meta, deps);
        log(`${key} → run ${runId} (relaunched)`);
      } catch (err) {
        log(`${key} → run ${runId} failed: ${messageOf(err)}`);
      }
    }
  }

  // a poll that throws has moved schedule marks in memory: put them back so no tick is lost
  const marks = { ...ledger.lastPoll };
  let firings: Firing[];
  try {
    firings = await pollTriggers({
      home: ledgerHome,
      repoRoot: repoDir,
      repo,
      specs,
      gh: deps.gh,
      now,
      ledger,
      first,
      liveRunOn: async (ref) => (await liveRunOn(deps.home, formatTicket(parseTicket(ref, repo)))) !== undefined,
    });
  } catch (err) {
    ledger.lastPoll = marks;
    log(`${repoDir}: ${messageOf(err)}`);
    return;
  }

  for (const f of firings) {
    const issue = f.ticket === undefined ? undefined : parseTicket(f.ticket, repo).number;
    const r = await fire(ledgerHome, ledger, f, (id) => start(f, id), () => newRunId({ ...(issue !== undefined ? { issue } : {}), pipeline: f.pipeline }, now), () => now);
    if ('skipped' in r) continue;
    log(r.error === undefined ? `${f.key} → run ${r.runId}` : `${f.key} → run ${r.runId} failed: ${r.error}`);
  }
  await saveLedger(ledgerHome, ledger);
}

/**
 * Whether a watcher is running: `watch.json` written on this host by a live pid, with a heartbeat
 * no older than three intervals.
 */
export async function watcherStatus(
  home: string,
  now: Date,
  isPidAlive: (pid: number) => boolean,
): Promise<{ alive: boolean; since?: string; repos: string[] }> {
  let w: Partial<WatchFile>;
  try {
    w = JSON.parse(await fs.readFile(watchFile(home), 'utf8')) as Partial<WatchFile>;
  } catch {
    return { alive: false, repos: [] };
  }
  const repos = Array.isArray(w.repos) ? w.repos.filter((r): r is string => typeof r === 'string') : [];
  const beat = typeof w.heartbeatAt === 'string' ? Date.parse(w.heartbeatAt) : NaN;
  const alive =
    w.host === os.hostname() &&
    typeof w.pid === 'number' &&
    typeof w.intervalS === 'number' &&
    now.getTime() - beat <= 3 * w.intervalS * 1000 &&
    isPidAlive(w.pid);
  return alive && typeof w.startedAt === 'string' ? { alive, since: w.startedAt, repos } : { alive: false, repos };
}
