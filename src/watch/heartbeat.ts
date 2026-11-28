import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DriverDeps } from '../run/prepare.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { WatchOptions } from './watch.ts';

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

export const percDir = (home: string): string => path.join(home, '.percolator');
export const watchFile = (home: string): string => path.join(percDir(home), 'watch', 'watch.json');

export async function writeHeartbeat(deps: DriverDeps, o: WatchOptions, startedAt: string, at: Date): Promise<void> {
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

/** `watch.json`, and whether it is a live watcher: written on this host by a live pid, with a heartbeat no older than three intervals. */
export async function readWatch(home: string, now: Date, isPidAlive: (pid: number) => boolean): Promise<{ w: Partial<WatchFile>; alive: boolean } | undefined> {
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

/**
 * The watcher in `watch.json` if it was written on this host by a live pid other than `selfPid`, however old its
 * heartbeat (`fresh` tells): a watcher in a long poll beats late but can still be asked to stop.
 */
export async function stoppableWatcher(
  home: string,
  now: Date,
  isPidAlive: (pid: number) => boolean,
  selfPid: number,
): Promise<{ pid: number; fresh: boolean; terminal?: string } | undefined> {
  const r = await readWatch(home, now, isPidAlive);
  const w = r?.w;
  if (w?.host !== os.hostname() || typeof w.pid !== 'number' || w.pid === selfPid || !isPidAlive(w.pid)) return undefined;
  return { pid: w.pid, fresh: r?.alive === true, ...(typeof w.terminal === 'string' ? { terminal: w.terminal } : {}) };
}

/** The pid of a live watcher in `watch.json` other than `selfPid` (a pid reused by this process is not another). */
export async function otherWatcher(home: string, now: Date, isPidAlive: (pid: number) => boolean, selfPid: number): Promise<number | undefined> {
  const r = await readWatch(home, now, isPidAlive);
  return r?.alive === true && r.w.pid !== selfPid ? r.w.pid : undefined;
}
