import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** `<runDir>/driver.json`: which process drives the run, so a foreground drive (no driver terminal) is seen too. */
export type DriverLock = { pid: number; host: string; terminal: string | null; startedAt: string };

/** How liveness is judged; injectable for tests. */
export type Liveness = { pid?: number; pidAlive?: (pid: number) => boolean };

const lockFile = (dir: string) => path.join(dir, 'driver.json');

/** `process.kill(pid, 0)`: only ESRCH means dead (EPERM is a live process of another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The lock, or undefined when absent or unreadable (a crash between create and write leaves it empty). */
export async function readDriverLock(dir: string): Promise<DriverLock | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(lockFile(dir), 'utf8'));
  } catch {
    return undefined;
  }
  const l = raw as Partial<DriverLock> | null;
  if (l === null || typeof l !== 'object' || !Number.isInteger(l.pid) || typeof l.host !== 'string') return undefined;
  return l as DriverLock;
}

/** A lock from another host counts as live: its pid cannot be checked from here. */
export function lockIsLive(lock: DriverLock, l: Liveness = {}): boolean {
  return lock.host !== os.hostname() || (l.pidAlive ?? pidAlive)(lock.pid);
}

/** The live lock held by a process other than this one (`l.pid`, default `process.pid`), if any. */
export async function otherLiveLock(dir: string, l: Liveness = {}): Promise<DriverLock | undefined> {
  const lock = await readDriverLock(dir);
  if (lock === undefined || !lockIsLive(lock, l)) return undefined;
  if (lock.host === os.hostname() && lock.pid === (l.pid ?? process.pid)) return undefined;
  return lock;
}

export function drivenByProcess(runId: string, lock: DriverLock): string {
  const where = lock.host === os.hostname() ? '' : ` on ${lock.host}`;
  return `run ${runId} is already being driven by process ${lock.pid}${where}`;
}

/**
 * Create `driver.json` exclusively (`wx`); a lock whose pid is dead on this host (or unreadable) is replaced,
 * a live one held by another process throws `drivenByProcess`. Returns the release function (call it in `finally`).
 */
export async function acquireDriverLock(
  dir: string,
  runId: string,
  o: Liveness & { terminal?: string; now: () => Date },
): Promise<() => Promise<void>> {
  const pid = o.pid ?? process.pid;
  const lock: DriverLock = { pid, host: os.hostname(), terminal: o.terminal ?? null, startedAt: o.now().toISOString() };
  const file = lockFile(dir);
  for (;;) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const other = await otherLiveLock(dir, o);
      if (other !== undefined) throw new Error(drivenByProcess(runId, other));
      await fs.rm(file, { force: true });
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return async () => {
      const now = await readDriverLock(dir);
      if (now !== undefined && now.pid === pid && now.host === lock.host) await fs.rm(file, { force: true });
    };
  }
}
