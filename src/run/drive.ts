import fs from 'node:fs/promises';
import path from 'node:path';
import { graphFingerprint, runGraph } from '../engine/engine.ts';
import { grantRound, loadState, saveState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import { HerdrRuntime, sweepTerminals } from '../runtime/herdr-runtime.ts';
import type { Attention } from '../runtime/herdr-runtime.ts';
import { githubGate } from '../tracker/gate.ts';
import { githubIntake } from '../tracker/intake.ts';
import { githubOpenPr } from '../tracker/pr.ts';
import { parseTicket } from '../tracker/ticket.ts';
import { sweepLeftovers, writeFileAtomic } from '../util/fs.ts';
import { validate } from '../validate.ts';
import type { ValidateResult } from '../validate.ts';
import { materializeGrounds, runDir } from '../workspace/run-dir.ts';
import { ensureWorktree } from '../workspace/worktree.ts';
import { readRunMeta } from './meta.ts';
import type { RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';

/** The PR url the deliver step recorded, if any. */
export async function prUrl(dir: string, state: RunState): Promise<string | undefined> {
  const rel = state.history.findLast((h) => h.outputs['pr_url'] !== undefined)?.outputs['pr_url'];
  if (rel === undefined) return undefined;
  return (await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '')).trim() || undefined;
}

/** `<name> <old> → <new>` for every ground whose version differs (absent shown as `none`). */
function groundChanges(was: Record<string, string>, now: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
  return names.filter((n) => was[n] !== now[n]).map((n) => `${n} ${was[n] ?? 'none'} → ${now[n] ?? 'none'}`);
}

/**
 * The checks a run must pass before it is driven again: not completed or failed, not driven by another
 * live terminal (`selfTerminal` is this process's own), and the same graph and ground versions it started with.
 * `drive` runs them, and so does `perc resume` before it launches a driver, so errors reach the owner's terminal.
 */
export async function checkResumable(
  runId: string,
  deps: Pick<DriverDeps, 'hc' | 'home' | 'selfTerminal'>,
): Promise<{ dir: string; meta: RunMeta; state: RunState; v: ValidateResult }> {
  const dir = runDir(deps.home, runId);
  const meta = await readRunMeta(dir);
  const state = await loadState(dir);
  if (state.status === 'completed') {
    const url = await prUrl(dir, state);
    throw new Error(`run ${runId} already completed${url === undefined ? '' : `: ${url}`}`);
  }
  if (state.status === 'failed') throw new Error(`run ${runId} failed at ${state.currentStep}; start a new run`);

  const driver = await deps.hc.get(meta.driver);
  if (driver?.state === 'live' && driver.address !== deps.selfTerminal) {
    throw new Error(`run ${runId} is already being driven by terminal ${meta.driver}`);
  }

  const v = await validate({ configFile: meta.configFile, cwd: meta.repoRoot, home: deps.home, profile: meta.profile });
  if (state.graphFingerprint !== undefined && state.graphFingerprint !== graphFingerprint(v.graph)) {
    throw new Error(`run ${runId} was started with a different graph (config changed since); start a new run`);
  }
  const changed = groundChanges(state.groundVersions, v.groundVersions);
  if (changed.length > 0) {
    throw new Error(`grounds changed since run ${runId} started: ${changed.join(', ')}; start a new run`);
  }
  return { dir, meta, state, v };
}

/**
 * Drive run `runId` from its saved state until it completes, fails or pauses, after `checkResumable`.
 */
export async function drive(runId: string, deps: DriverDeps): Promise<RunState> {
  const { dir, meta, state, v } = await checkResumable(runId, deps);

  await sweepLeftovers(dir, { recursive: true });
  await ensureWorktree({ repoRoot: meta.repoRoot, dir: meta.worktree, branch: meta.branch, base: meta.base });
  const mappings = await materializeGrounds(dir, v.mappings, v.grounds);

  const now = deps.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const sleep = deps.sleep;
  const attentionFile = path.join(dir, 'attention.json');
  // best-effort: perc status reads it, and a failed write must not stop the run; save awaits it before deleting
  let attentionWrite: Promise<void> = Promise.resolve();
  const onAttention = (a: Attention): void => {
    deps.out(`${a.stepId}: ${a.kind} — attend terminal ${a.terminal}`);
    const body = `${JSON.stringify({ ...a, at: now().toISOString() }, null, 2)}\n`;
    attentionWrite = attentionWrite.then(() => writeFileAtomic(attentionFile, body)).catch(() => {});
  };
  const ticket = parseTicket(meta.ticket);
  const runtime = new HerdrRuntime({
    hc: deps.hc,
    runId,
    ticket: meta.ticket,
    runDir: dir,
    worktree: meta.worktree,
    branch: meta.branch,
    base: meta.base,
    mappings,
    grounds: v.grounds,
    ...(meta.space !== undefined ? { space: meta.space } : {}),
    keepTerminals: meta.keepTerminals,
    outliveParent: true,
    builtins: {
      'github.intake': githubIntake({ gh: deps.gh, runDir: dir, ticket }),
      'github.open_pr': githubOpenPr({ gh: deps.gh, runDir: dir, worktree: meta.worktree, branch: meta.branch, base: meta.base }),
    },
    gate: githubGate({
      gh: deps.gh,
      runDir: dir,
      runId,
      ...(v.tracker?.approvers !== undefined ? { approvers: v.tracker.approvers } : {}),
      ...(sleep !== undefined ? { sleep } : {}),
      now: nowMs,
    }),
    onAttention,
    ...(sleep !== undefined ? { sleep } : {}),
    now: nowMs,
  });

  const granted = grantRound(state);
  if (granted !== undefined) deps.out(`granted one more round on ${granted}`);
  state.status = 'running';
  const save = async (s: RunState): Promise<void> => {
    await saveState(dir, s);
    await attentionWrite;
    await fs.rm(attentionFile, { force: true });
  };
  await save(state);
  const end = await runGraph(v.graph, state, { runtime, save, now: () => now().toISOString() });

  if (end.status === 'paused') {
    deps.out(`run ${runId} paused at ${end.currentStep}: ${end.pausedReason}`);
    deps.out(`resume with: perc resume ${runId}`);
    return end;
  }
  await sweepTerminals(deps.hc, runId, { exceptRole: 'driver' });
  if (end.status === 'completed') {
    const url = await prUrl(dir, end);
    deps.out(`run ${runId} completed${url === undefined ? '' : `: ${url}`}`);
  } else {
    deps.out(`run ${runId} failed at ${end.currentStep}`);
  }
  return end;
}
