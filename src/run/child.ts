import path from 'node:path';
import { loadState } from '../engine/state.ts';
import { exists } from '../util/fs.ts';
import { runDir } from '../workspace/run-dir.ts';
import { listRuns, readRunMeta } from './meta.ts';
import type { RunListing, RunMeta } from './meta.ts';
import { launchDriver, prepareRun } from './prepare.ts';
import type { DriverDeps } from './prepare.ts';

/**
 * Start run `runId` of `pipeline`, linked to `parent` (same clone, config and profile), in its own driver
 * terminal. Resume-safe: a child that already has `run.json` is not prepared again; its driver is
 * relaunched only when the run is unfinished and no driver is live.
 */
export async function startLinkedRun(
  o: { parent: RunMeta; pipeline: string; ticket?: string; inputs?: Record<string, string>; runId: string },
  deps: DriverDeps,
): Promise<RunMeta> {
  const dir = runDir(deps.home, o.runId);
  if (await exists(path.join(dir, 'run.json'))) {
    const meta = await readRunMeta(dir);
    const status = (await loadState(dir)).status;
    if (status === 'completed' || status === 'failed') return meta;
    if ((await deps.hc.get(meta.driver))?.state === 'live') return meta;
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
