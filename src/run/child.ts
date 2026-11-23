import path from 'node:path';
import { loadState } from '../engine/state.ts';
import { foreignTerminal } from '../runtime/herdr-runtime.ts';
import { exists } from '../util/fs.ts';
import { runDir } from '../workspace/run-dir.ts';
import { checkResumable } from './drive.ts';
import { listRuns, readRunMeta } from './meta.ts';
import type { FanOutMeta, RunListing, RunMeta } from './meta.ts';
import { launchDriver, prepareRun } from './prepare.ts';
import type { DriverDeps } from './prepare.ts';

/**
 * Start run `runId` of `pipeline`, linked to `parent` (same clone, config and profile), in its own driver
 * terminal. Resume-safe: a child that already has `run.json` is not prepared again; its driver is
 * relaunched only when the run is running (a paused one waits for perc resume <child>), no driver is live and
 * it passes `checkResumable`; any of those errors is thrown naming the child. A dir without `run.json` (a
 * prepare that stopped early) is prepared again.
 */
export async function startLinkedRun(
  o: { parent: RunMeta; pipeline: string; ticket?: string; inputs?: Record<string, string>; runId: string; fanOut?: FanOutMeta },
  deps: DriverDeps,
): Promise<RunMeta> {
  const dir = runDir(deps.home, o.runId);
  if (await exists(path.join(dir, 'run.json'))) {
    const meta = await readRunMeta(dir);
    // a paused child waits for its owner (perc resume <child>); a finished one is done
    if ((await loadState(dir)).status !== 'running') return meta;
    try {
      const driver = await deps.hc.get(meta.driver);
      if (driver !== undefined) {
        const foreign = foreignTerminal(driver, meta.driver, meta.runId);
        if (foreign !== undefined) throw new Error(foreign);
        if (driver.state === 'live') return meta;
      }
      // the checks its driver would run, so their errors reach the parent instead of the child's terminal
      await checkResumable(meta.runId, deps);
    } catch (err) {
      throw new Error(`linked run ${meta.runId} cannot be resumed: ${(err as Error).message}`);
    }
    await launchDriver(meta, deps);
    return meta;
  }
  const meta = await prepareRun(
    {
      ...(o.ticket !== undefined ? { ticket: o.ticket } : {}),
      repoDir: o.parent.repoRoot,
      configFile: o.parent.configFile,
      profile: o.parent.profile,
      pipeline: o.pipeline,
      ...(o.inputs !== undefined ? { inputs: o.inputs } : {}),
      parent: o.parent.runId,
      runId: o.runId,
      // a slice runs from its stage on, based where its parent is
      ...(o.fanOut !== undefined ? { fanOut: o.fanOut, base: o.parent.base } : {}),
    },
    deps,
  );
  await launchDriver(meta, deps);
  return meta;
}

/** The runs `runId` started (route or fan-out children), newest first. */
export async function childrenOf(home: string, runId: string): Promise<RunListing[]> {
  return (await listRuns(home)).filter((l) => l.meta?.parent === runId);
}
