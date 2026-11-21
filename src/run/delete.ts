import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadState } from '../engine/state.ts';
import type { Terminal } from '../herdr/hc.ts';
import type { RunState } from '../engine/state.ts';
import { runGit } from '../grounds/git.ts';
import { sweepTerminals } from '../runtime/herdr-runtime.ts';
import { runDir } from '../workspace/run-dir.ts';
import { WORKTREES_DIR, removeWorktree, worktreeDirty } from '../workspace/worktree.ts';
import { liveness } from './drive.ts';
import { lockIsLive, readDriverLock } from './lock.ts';
import type { DriverLock } from './lock.ts';
import { readRunMeta } from './meta.ts';
import type { RunListing, RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';
import { runStatusJson } from './status.ts';
import type { RunStatusJson } from './status.ts';

export type DeletePlan = {
  id: string;
  dir: string;
  /** absent when `run.json` can't be read */
  meta?: RunMeta;
  /** `unreadable` when either `run.json` or the state can't be read */
  status: RunStatusJson['status'];
  ticket?: { ref: string; title?: string };
  worktree?: { path: string; state: 'dirty' | 'clean' | 'gone' | 'unknown' };
};

/** Test seams: the worktree removal and the waits between its retries. */
export type DeleteOptions = { removeWorktree?: typeof removeWorktree; retryDelaysMs?: number[] };

const RETRY_DELAYS_MS = [200, 400, 800, 1600];
// a file still held open (an agent process still exiting, mostly on Windows)
const HELD = /Permission denied|resource busy|EBUSY|EPERM|being used by another process|Directory not empty|Invalid argument/i;

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

export function isFinished(status: RunStatusJson['status']): boolean {
  return status === 'completed' || status === 'failed';
}

async function worktreeState(dir: string): Promise<'dirty' | 'clean' | 'gone' | 'unknown'> {
  try {
    const dirty = await worktreeDirty(dir);
    return dirty === undefined ? 'gone' : dirty ? 'dirty' : 'clean';
  } catch {
    return 'unknown';
  }
}

/** What `deleteRun` will remove; throws when there is no such run dir. */
export async function planDelete(runId: string, deps: DriverDeps): Promise<DeletePlan> {
  const dir = runDir(deps.home, runId);
  if (!(await exists(dir))) throw new Error(`no run ${runId}; perc status lists runs`);
  let listing: RunListing = { dir };
  let meta: RunMeta | undefined;
  try {
    meta = await readRunMeta(dir);
    listing = { dir, meta };
    if (await exists(path.join(dir, 'state.json'))) {
      let state: RunState;
      try {
        state = await loadState(dir);
        listing = { dir, meta, state };
      } catch (err) {
        listing = { dir, meta, error: (err as Error).message };
      }
    }
  } catch (err) {
    listing = { dir, error: (err as Error).message };
  }
  const run = await runStatusJson(listing, deps);
  const ticket =
    run.status !== 'unreadable'
      ? { ref: run.ticket.ref, ...(run.ticket.title !== undefined ? { title: run.ticket.title } : {}) }
      : meta !== undefined
        ? { ref: meta.ticket }
        : undefined;
  return {
    id: runId,
    dir,
    ...(meta !== undefined ? { meta } : {}),
    status: run.status,
    ...(ticket !== undefined ? { ticket } : {}),
    ...(meta !== undefined ? { worktree: { path: meta.worktree, state: await worktreeState(meta.worktree) } } : {}),
  };
}

function drivenBy(id: string, lock: DriverLock): string {
  if (lock.host === os.hostname()) {
    return `run ${id} is being driven by process ${lock.pid}; stop it (Ctrl-C) and run perc delete ${id} again`;
  }
  return `run ${id} is being driven by process ${lock.pid} on ${lock.host}; stop it there and run perc delete ${id} again`;
}

/** A live `driver.json` lock: a foreground drive, one on another host, or the drive inside the driver terminal. */
async function liveLock(dir: string, deps: DriverDeps): Promise<DriverLock | undefined> {
  const lock = await readDriverLock(dir);
  return lock !== undefined && lockIsLive(lock, liveness(deps)) ? lock : undefined;
}

/** The live driver terminal, only when it is labelled for this run; a terminal merely named like it is never ours. */
async function ownDriver(meta: RunMeta, deps: DriverDeps): Promise<Terminal | undefined> {
  const t = await deps.hc.get(meta.driver);
  return t?.state === 'live' && t.labels['percolator.run'] === meta.runId ? t : undefined;
}

async function removeHeld(meta: RunMeta, deps: DriverDeps, o: DeleteOptions): Promise<void> {
  const remove = o.removeWorktree ?? removeWorktree;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let i = 0; ; i++) {
    try {
      // a dir git no longer lists (its entry pruned, or .git gone) is still the run's: remove it too
      if (!(await remove({ repoRoot: meta.repoRoot, dir: meta.worktree, force: true }))) {
        await fs.rm(meta.worktree, { recursive: true, force: true });
      }
      return;
    } catch (err) {
      const message = (err as Error).message;
      if (!HELD.test(message)) throw new Error(`run ${meta.runId}: ${message}`);
      if (i >= delays.length) {
        throw new Error(
          `run ${meta.runId}: worktree ${meta.worktree} is still in use; close what holds it and run perc delete ${meta.runId} again`,
        );
      }
      await sleep(delays[i]!);
    }
  }
}

/**
 * Removes the run: driver terminal, other labelled terminals, worktree (forced), then the run dir last,
 * so an interrupted delete is still listed and a re-run finishes it. Keeps the branch. Returns the one-line report.
 */
export async function deleteRun(plan: DeletePlan, deps: DriverDeps, o: DeleteOptions = {}): Promise<string> {
  const { id, meta } = plan;
  const herdr = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      throw new Error(`run ${id}: ${(err as Error).message}; start herdr and run perc delete ${id} again`);
    });

  const driver = meta !== undefined ? await herdr(ownDriver(meta, deps)) : undefined;
  // with a labelled live driver terminal the lock is its drive, which killing the terminal stops
  if (driver === undefined) {
    const lock = await liveLock(plan.dir, deps);
    if (lock !== undefined) throw new Error(drivenBy(id, lock));
  }
  const labelled = await herdr(deps.hc.list({ labels: { 'percolator.run': id }, all: true }));
  const self = deps.selfTerminal;
  if (self !== undefined && [driver, ...labelled].some((t) => t !== undefined && (t.address === self || t.name === self))) {
    throw new Error(`run ${id}: this terminal belongs to the run; run perc delete ${id} from another terminal`);
  }

  let n = 0;
  if (driver !== undefined && meta !== undefined) {
    await herdr(deps.hc.kill(meta.driver));
    await herdr(deps.hc.rm(meta.driver));
    n = 1;
  }
  n += (await herdr(sweepTerminals(deps.hc, id))).length;

  let line: string;
  if (meta === undefined) {
    line = `deleted run ${id}: ${n} terminal(s); its worktree is unknown, check <repo>/${WORKTREES_DIR}/${id}; kept branch percolator/${id}`;
  } else if (!(await exists(meta.repoRoot))) {
    line = `deleted run ${id}: ${n} terminal(s); repo ${meta.repoRoot} not found, worktree ${meta.worktree} left as is; kept branch ${meta.branch}`;
  } else if (!(await exists(meta.worktree))) {
    // removed by hand leaves a stale entry; after perc clean prune finds nothing
    let pruned = true;
    try {
      await runGit(['worktree', 'prune'], meta.repoRoot);
    } catch {
      pruned = false;
    }
    const note = pruned ? '' : `; repo ${meta.repoRoot} is not a git repo, nothing to prune`;
    line = `deleted run ${id}: ${n} terminal(s), worktree already removed${note}; kept branch ${meta.branch}`;
  } else {
    await removeHeld(meta, deps, o);
    line = `deleted run ${id}: ${n} terminal(s), worktree ${meta.worktree}; kept branch ${meta.branch}`;
  }

  await fs.rm(plan.dir, { recursive: true, force: true, maxRetries: 5 });
  return line;
}
