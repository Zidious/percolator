import { graphFingerprint } from '../engine/engine.ts';
import { loadState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import { mappingKeys, mappingsFingerprint } from '../grounds/mappings.ts';
import { validate } from '../validate.ts';
import type { ValidateResult } from '../validate.ts';
import { runDir } from '../workspace/run-dir.ts';
import { drivenByProcess, liveness, otherLiveLock } from './lock.ts';
import { readRunMeta } from './meta.ts';
import type { RunMeta } from './meta.ts';
import { prUrl } from './outputs.ts';
import type { DriverDeps } from './prepare.ts';

/** `<name> <old> → <new>` for every ground whose version differs (absent shown as `none`). */
function groundChanges(was: Record<string, string>, now: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
  return names.filter((n) => was[n] !== now[n]).map((n) => `${n} ${was[n] ?? 'none'} → ${now[n] ?? 'none'}`);
}

/** `+<as> <ground>:<path>` for each added key, then `-…` for each removed one (tracker and runtime are not mappings). */
function mappingChanges(was: readonly string[], now: readonly string[]): string[] {
  const label = (k: string): string => {
    const [as, ground, p] = JSON.parse(k) as [string, string, string];
    return `${as} ${ground}:${p}`;
  };
  const before = new Set(was);
  const after = new Set(now);
  return [
    ...now.filter((k) => !before.has(k)).map((k) => `+${label(k)}`),
    ...was.filter((k) => !after.has(k)).map((k) => `-${label(k)}`),
  ];
}

/**
 * The checks a run must pass before it is driven again: not completed or failed, not driven by another
 * live terminal (`selfTerminal` is this process's own), and the same graph and ground versions it started with.
 * `drive` runs them, and so does `perc resume` before it launches a driver, so errors reach the owner's terminal.
 * A run waiting for answers is refused unless `opts.answering` (`perc answer`, which records them first).
 */
export async function checkResumable(
  runId: string,
  deps: Pick<DriverDeps, 'hc' | 'home' | 'selfTerminal' | 'pid' | 'pidAlive'>,
  opts: { answering?: boolean } = {},
): Promise<{ dir: string; meta: RunMeta; state: RunState; v: ValidateResult }> {
  const dir = runDir(deps.home, runId);
  const meta = await readRunMeta(dir);
  const state = await loadState(dir);
  if (state.status === 'completed') {
    const url = await prUrl(dir, state);
    throw new Error(`run ${runId} already completed${url === undefined ? '' : `: ${url}`}`);
  }
  if (state.status === 'failed') throw new Error(`run ${runId} failed at ${state.currentStep}; start a new run`);
  if (state.asking !== undefined && opts.answering !== true) {
    throw new Error(
      `run ${runId} is waiting for answers to ${state.asking.kind} from ${state.asking.stepId}; answer with perc answer ${runId} (perc status ${runId} lists them)`,
    );
  }

  const driver = await deps.hc.get(meta.driver);
  if (driver?.state === 'live' && driver.address !== deps.selfTerminal) {
    throw new Error(`run ${runId} is already being driven by terminal ${meta.driver}`);
  }
  // a foreground drive has no driver terminal: driver.json is its only trace
  const lock = await otherLiveLock(dir, liveness(deps));
  if (lock !== undefined) throw new Error(drivenByProcess(runId, lock));

  const v = await validate({
    configFile: meta.configFile,
    cwd: meta.repoRoot,
    home: deps.home,
    profile: meta.profile,
    pipeline: meta.pipeline,
    // a fan-out slice runs its slice's graph
    ...(meta.fanOut !== undefined ? { sliceFrom: meta.fanOut.from } : {}),
  });
  if (state.graphFingerprint !== undefined && state.graphFingerprint !== graphFingerprint(v.graph)) {
    throw new Error(`run ${runId} was started with a different graph (its config or the Percolator version changed since); start a new run`);
  }
  const changed = groundChanges(state.groundVersions, v.groundVersions);
  if (changed.length > 0) {
    throw new Error(`grounds changed since run ${runId} started: ${changed.join(', ')}; start a new run`);
  }
  if (state.mappingsFingerprint !== undefined) {
    const keys = mappingKeys(v.mappings);
    if (mappingsFingerprint(keys) !== state.mappingsFingerprint) {
      throw new Error(`mappings changed since run ${runId} started: ${mappingChanges(state.mappingKeys ?? [], keys).join(', ')}; start a new run`);
    }
  }
  return { dir, meta, state, v };
}
