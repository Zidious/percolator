import fs from 'node:fs/promises';
import type { Terminal } from '../herdr/hc.ts';
import { pidAlive } from '../run/lock.ts';
import type { DriverDeps } from '../run/prepare.ts';
import { otherWatcher, requestStop, stopFile, stoppableWatcher, WATCH_STOP_TIMEOUT_S, WATCH_TERMINAL, WATCHER_LABELS, waitForWatcherExit, watchFile, watchLoop } from './watch.ts';
import type { WatchOptions } from './watch.ts';

/** A terminal labelled as the watcher; one merely named like it is never ours. */
export function isWatcherTerminal(t: Terminal): boolean {
  return t.labels['percolator.role'] === WATCHER_LABELS['percolator.role'];
}

/** `perc watch --foreground`: watches in this terminal, unless another watcher is running. */
export async function watchHere(o: WatchOptions, deps: DriverDeps): Promise<number> {
  const { repos, intervalS } = o;
  const watcher = await deps.hc.get(WATCH_TERMINAL);
  if (watcher?.state === 'live' && isWatcherTerminal(watcher) && watcher.address !== deps.selfTerminal) {
    throw new Error(`perc watch is already running in terminal ${WATCH_TERMINAL}; perc watch stop to stop it`);
  }
  const other = await otherWatcher(deps.home, (deps.now ?? (() => new Date()))(), deps.pidAlive ?? pidAlive, deps.pid ?? process.pid);
  if (other !== undefined) throw new Error(`perc watch is already running as pid ${other}; stop it first (perc watch stop, or end pid ${other})`);
  deps.out(`watching ${repos.join(', ')} every ${intervalS}s`);
  await watchLoop(o, deps);
  return 0;
}

/** `perc watch`: starts the watcher in its own terminal, in place of a finished one. */
export async function startWatch(o: WatchOptions, deps: DriverDeps): Promise<number> {
  const { repos, configFile, intervalS } = o;
  const existing = await deps.hc.get(WATCH_TERMINAL);
  if (existing) {
    if (!isWatcherTerminal(existing)) {
      throw new Error(`terminal ${WATCH_TERMINAL} is not a Percolator watcher; close or rename it, then run perc watch again`);
    }
    if (existing.state === 'live') throw new Error(`perc watch is already running in terminal ${WATCH_TERMINAL}; perc watch stop to stop it`);
    await deps.hc.rm(WATCH_TERMINAL);
  }
  await deps.hc.run({
    name: WATCH_TERMINAL,
    cwd: repos[0]!,
    argv: [
      process.execPath,
      deps.entry,
      'watch',
      '--foreground',
      ...repos.flatMap((r) => ['--repo', r]),
      '--config',
      configFile,
      ...(o.profile !== undefined ? ['--profile', o.profile] : []),
      '--interval',
      String(intervalS),
    ],
    labels: { ...WATCHER_LABELS },
    outliveParent: true,
  });
  deps.out(`watcher started in terminal ${WATCH_TERMINAL}`);
  deps.out(`  repos ${repos.join(', ')}`);
  deps.out('  stop with: perc watch stop');
  return 0;
}

/**
 * Asks a live watcher to stop and waits up to WATCH_STOP_TIMEOUT_S for it, so a firing it is starting
 * gets its driver; then ends every terminal labelled as the watcher (and only those) and forgets its heartbeat.
 * A watcher it could neither stop nor end keeps its stop request and heartbeat.
 */
export async function stopWatch(deps: DriverDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const alive = deps.pidAlive ?? pidAlive;
  const listWatchers = () => deps.hc.list({ labels: { ...WATCHER_LABELS }, all: true });
  const found = await stoppableWatcher(deps.home, now(), alive, deps.pid ?? process.pid);
  // a stale heartbeat counts only while a live watcher terminal backs it: its pid may since belong to another process
  const target = found !== undefined && (found.fresh || (await listWatchers()).some((t) => t.state === 'live')) ? found : undefined;
  const pid = target?.pid;
  let graceful = true;
  if (pid !== undefined) {
    await requestStop(deps.home, pid, now());
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    graceful = await waitForWatcherExit(deps.home, pid, { now, sleep, pidAlive: alive }, WATCH_STOP_TIMEOUT_S);
  }
  const watchers = await listWatchers();
  const ended: string[] = [];
  for (const t of watchers) {
    const id = t.name ?? t.address;
    if (t.state === 'live') {
      await deps.hc.kill(id);
      ended.push(id);
    }
    await deps.hc.rm(id);
  }
  // still running and not ended: keep the stop request for its next repo boundary, and watch.json so it stays visible
  if (!graceful && ended.length === 0) throw new Error(`the watcher (pid ${pid}) did not stop within ${WATCH_STOP_TIMEOUT_S}s; end pid ${pid}`);
  await fs.rm(watchFile(deps.home), { force: true });
  await fs.rm(stopFile(deps.home), { force: true });
  if (ended.length > 0) {
    const names = ended.join(', ');
    deps.out(graceful ? `stopped the watcher in terminal ${names}` : `the watcher in terminal ${names} did not stop within ${WATCH_STOP_TIMEOUT_S}s; ended it`);
    return 0;
  }
  if (target === undefined) {
    deps.out('no watcher running');
    return 0;
  }
  // a finished terminal is named only when the watcher that stopped ran in it
  const inTerminal = target.terminal !== undefined && watchers.some((t) => (t.name ?? t.address) === target.terminal);
  deps.out(inTerminal ? `stopped the watcher in terminal ${target.terminal}` : `stopped the watcher (pid ${pid})`);
  return 0;
}
