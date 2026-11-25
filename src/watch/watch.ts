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
/** `<home>/.percolator/watch/stop.json`: `perc watch stop` asks the watcher with this pid to stop. */
export const stopFile = (home: string): string => path.join(percDir(home), 'watch', 'stop.json');

/** How long `perc watch stop` waits for the watcher to exit before ending its terminal. */
export const WATCH_STOP_TIMEOUT_S = 30;

/** Asks the watcher `pid` to stop once it has finished the repo it is polling. */
export async function requestStop(home: string, pid: number, at: Date): Promise<void> {
  const file = stopFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify({ pid, at: at.toISOString() })}\n`);
}

/** Whether `stop.json` asks `pid` to stop (a stop meant for an earlier watcher never stops a later one). */
async function stopRequested(home: string, pid: number): Promise<boolean> {
  try {
    return (JSON.parse(await fs.readFile(stopFile(home), 'utf8')) as { pid?: unknown }).pid === pid;
  } catch {
    return false;
  }
}

/** Waits up to `timeoutS` for the watcher `pid` to exit (its `watch.json` gone, or the pid dead), polling every 500ms. */
export async function waitForWatcherExit(
  home: string,
  pid: number,
  d: { now: () => Date; sleep: (ms: number) => Promise<void>; pidAlive: (pid: number) => boolean },
  timeoutS: number,
): Promise<boolean> {
  const until = d.now().getTime() + timeoutS * 1000;
  const exited = async (): Promise<boolean> => !d.pidAlive(pid) || !(await exists(watchFile(home)));
  while (!(await exited())) {
    if (d.now().getTime() >= until) return false;
    await d.sleep(500);
  }
  return true;
}

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Poll every repo's triggers each `intervalS` until `deps.signal` aborts, starting one run per firing
 * through the ledger (recorded before it starts, so a restart never starts it twice).
 */
export async function watchLoop(o: WatchOptions, deps: DriverDeps & { signal?: AbortSignal }): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const pid = deps.pid ?? process.pid;
  const asked = (): Promise<boolean> => stopRequested(deps.home, pid);
  // in slices, so a stop request wakes it within a second
  const sleep =
    deps.sleep ??
    (async (ms: number) => {
      for (let left = ms; left > 0 && !deps.signal?.aborted && !(await asked()); left -= 1000) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(left, 1000)));
      }
    });
  const ledgerHome = percDir(deps.home);
  const ledger = await loadLedger(ledgerHome);
  const startedAt = now().toISOString();
  let byRequest = false;
  // a repo's poll, and every run it fires, always finishes: a stop is honoured only between repos
  const stopped = async (): Promise<boolean> => deps.signal?.aborted === true || (byRequest = await asked());
  // repos not yet recovered after the restart, and not yet polled once since it: kept per repo, so a repo
  // whose first poll fails (validate, origin, gh) still gets both on its first poll that gets that far
  const fresh = { recover: new Set(o.repos), seed: new Set(o.repos) };
  // beat before the first pass and after each repo, so a long pass (recovery, slow grounds) never looks dead
  const beat = (): Promise<void> => writeHeartbeat(deps, o, startedAt, now());
  await beat();
  pass: while (!(await stopped())) {
    pruneLedger(ledger, now());
    for (const repoDir of o.repos) {
      if (await stopped()) break pass;
      await pollRepo(repoDir, o, deps, ledger, fresh);
      await beat();
    }
    if (await stopped()) break;
    await sleep(o.intervalS * 1000);
  }
  if (byRequest) {
    await fs.rm(stopFile(deps.home), { force: true });
    if ((await readWatch(deps.home, now(), () => true))?.w.pid === pid) await fs.rm(watchFile(deps.home), { force: true });
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

async function pollRepo(
  repoDir: string,
  o: WatchOptions,
  deps: DriverDeps,
  ledger: Ledger,
  fresh: { recover: Set<string>; seed: Set<string> },
): Promise<void> {
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
  if (fresh.recover.delete(repoDir)) {
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
      first: fresh.seed.has(repoDir),
      liveRunOn: async (ref) => (await liveRunOn(deps.home, formatTicket(parseTicket(ref, repo)))) !== undefined,
    });
  } catch (err) {
    ledger.lastPoll = marks;
    log(`${repoDir}: ${messageOf(err)}`);
    return;
  }
  fresh.seed.delete(repoDir);

  for (const f of firings) {
    const issue = f.ticket === undefined ? undefined : parseTicket(f.ticket, repo).number;
    const r = await fire(ledgerHome, ledger, f, (id) => start(f, id), () => newRunId({ ...(issue !== undefined ? { issue } : {}), pipeline: f.pipeline }, now), () => now);
    if ('skipped' in r) continue;
    log(r.error === undefined ? `${f.key} → run ${r.runId}` : `${f.key} → run ${r.runId} failed: ${r.error}`);
  }
  await saveLedger(ledgerHome, ledger);
}

/** `watch.json`, and whether it is a live watcher: written on this host by a live pid, with a heartbeat no older than three intervals. */
async function readWatch(home: string, now: Date, isPidAlive: (pid: number) => boolean): Promise<{ w: Partial<WatchFile>; alive: boolean } | undefined> {
  let w: Partial<WatchFile>;
  try {
    w = JSON.parse(await fs.readFile(watchFile(home), 'utf8')) as Partial<WatchFile>;
  } catch {
    return undefined;
  }
  const beat = typeof w.heartbeatAt === 'string' ? Date.parse(w.heartbeatAt) : NaN;
  const alive =
    w.host === os.hostname() &&
    typeof w.pid === 'number' &&
    typeof w.intervalS === 'number' &&
    now.getTime() - beat <= 3 * w.intervalS * 1000 &&
    isPidAlive(w.pid);
  return { w, alive };
}

/** Whether a watcher is running, as `watch.json` tells. */
export async function watcherStatus(
  home: string,
  now: Date,
  isPidAlive: (pid: number) => boolean,
): Promise<{ alive: boolean; since?: string; repos: string[] }> {
  const r = await readWatch(home, now, isPidAlive);
  if (r === undefined) return { alive: false, repos: [] };
  const { w, alive } = r;
  const repos = Array.isArray(w.repos) ? w.repos.filter((x): x is string => typeof x === 'string') : [];
  return alive && typeof w.startedAt === 'string' ? { alive, since: w.startedAt, repos } : { alive: false, repos };
}

/** The pid of a live watcher in `watch.json` other than `selfPid` (a pid reused by this process is not another). */
export async function otherWatcher(home: string, now: Date, isPidAlive: (pid: number) => boolean, selfPid: number): Promise<number | undefined> {
  const r = await readWatch(home, now, isPidAlive);
  return r?.alive === true && r.w.pid !== selfPid ? r.w.pid : undefined;
}
