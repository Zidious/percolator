import fs from 'node:fs/promises';
import path from 'node:path';
import type { PipelineSpec } from '../config/pipelines.ts';
import { isFinished, loadState } from '../engine/state.ts';
import type { RunState } from '../engine/state.ts';
import type { StepHandler } from '../runtime/herdr-runtime.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { errText, escalate, latestOutput } from '../tracker/exits/latest.ts';
import { exists, writeFileAtomic } from '../util/fs.ts';
import { splitSections } from '../util/sections.ts';
import { runDir as runDirOf } from '../workspace/run-dir.ts';
import { startLinkedRun } from './child.ts';
import { prUrl } from './outputs.ts';
import type { RunMeta } from './meta.ts';
import type { DriverDeps } from './prepare.ts';

/** `<parent run dir>/fanout.json`: the slices a fan-out split, in order, with their child run ids. Written once. */
export type FanOutFile = { children: { index: number; id: string; title: string }[] };

const fanOutFile = (runDir: string) => path.join(runDir, 'fanout.json');

export async function readFanOut(runDir: string): Promise<FanOutFile | undefined> {
  try {
    return JSON.parse(await fs.readFile(fanOutFile(runDir), 'utf8')) as FanOutFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** The latest file of each output key over a run's history (later records win). */
function latestOutputs(state: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of state.history) Object.assign(out, h.outputs);
  return out;
}

/**
 * A slice's intake: copies the parent's latest outputs (every key, `ticket` included) and its `issue.json`
 * into this run, and writes `slice.md` (`# <title>`, then the slice's section of the parent's `output`).
 */
export function percolatorSeed(o: { runDir: string; meta: RunMeta; home: string; output: string }): StepHandler {
  return async (_step, _ctx, io) => {
    try {
      const fan = o.meta.fanOut;
      if (fan === undefined) return escalate(`percolator.seed: run ${o.meta.runId} is not a fan-out slice; start it from its parent's fan-out`);
      const parentDir = runDirOf(o.home, fan.parent);
      const outputs = latestOutputs(await loadState(parentDir));
      await fs.mkdir(io.outputsDir, { recursive: true });
      for (const rel of Object.values(outputs)) {
        const text = await fs.readFile(path.join(parentDir, rel), 'utf8');
        await writeFileAtomic(path.join(io.outputsDir, path.basename(rel)), text);
      }
      const issue = path.join(parentDir, 'issue.json');
      if (await exists(issue)) await writeFileAtomic(path.join(o.runDir, 'issue.json'), await fs.readFile(issue, 'utf8'));
      const slicesRel = outputs[o.output];
      const sections = slicesRel === undefined ? [] : splitSections(await fs.readFile(path.join(parentDir, slicesRel), 'utf8'));
      const body = sections[fan.slice - 1]?.body ?? '';
      await writeFileAtomic(path.join(io.outputsDir, 'slice.md'), `# ${fan.title}\n\n${body}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`percolator.seed: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`percolator.seed: ${errText(err)}`);
    }
  };
}

/**
 * The fan-out step: splits the slices output into `fanout.json` (once; a resume reuses it), keeps at most
 * `max_parallel` slice runs unfinished at a time, and waits for them all. Each slice is a linked run
 * `<runId>-s<i>` of this pipeline from the fanned stage on. Every slice completed passes with `slices_done`.
 */
export function fanOut(o: {
  deps: DriverDeps;
  meta: RunMeta;
  spec: PipelineSpec;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): StepHandler {
  const runId = o.meta.runId;
  const runDir = runDirOf(o.deps.home, runId);
  const sleep = o.sleep ?? o.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (step, ctx, io) => {
    try {
      const fan = o.spec.fan_out;
      if (fan === undefined) return escalate(`percolator.fan_out: pipeline "${o.spec.name}" has no fan_out; set fan_out or bind ${step.stage} to another node`);
      let file = await readFanOut(runDir);
      if (file === undefined) {
        const sections = splitSections((await latestOutput(ctx, runDir, fan.slices.output)) ?? '');
        if (sections.length === 0) {
          return escalate(
            `percolator.fan_out: ${fan.slices.from} wrote no slices (## <title> sections in ${fan.slices.output}.md); fix the output and resume`,
          );
        }
        const untitled = sections.findIndex((s) => s.title === '');
        if (untitled >= 0) {
          return escalate(
            `percolator.fan_out: slice ${untitled + 1} in ${fan.slices.output}.md has no title (a bare "## " heading); give it a title and resume`,
          );
        }
        file = { children: sections.map((s, i) => ({ index: i + 1, id: `${runId}-s${i + 1}`, title: s.title })) };
        await writeFileAtomic(fanOutFile(runDir), `${JSON.stringify(file, null, 2)}\n`);
      }
      const children = file.children;
      const max = fan.max_parallel ?? 3;
      // started (or relaunched) by this drive: a slice is launched at most once per drive
      const launched = new Set<string>();
      const start = (c: FanOutFile['children'][number]) =>
        startLinkedRun(
          {
            parent: o.meta,
            pipeline: o.meta.pipeline,
            ...(o.meta.ticket !== undefined ? { ticket: o.meta.ticket } : {}),
            inputs: o.meta.inputs,
            runId: c.id,
            fanOut: { parent: runId, slice: c.index, from: fan.stage, title: c.title },
          },
          o.deps,
        );
      for (;;) {
        const status: Record<string, RunState['status'] | undefined> = {};
        for (const c of children) {
          const dir = runDirOf(o.deps.home, c.id);
          status[c.id] = (await exists(path.join(dir, 'run.json'))) ? (await loadState(dir)).status : undefined;
        }
        let active = children.filter((c) => status[c.id] !== undefined && !isFinished(status[c.id])).length;
        // an unfinished slice from an earlier drive: relaunched when its driver is gone
        for (const c of children) {
          if (status[c.id] !== undefined && !isFinished(status[c.id]) && !launched.has(c.id)) {
            await start(c);
            launched.add(c.id);
          }
        }
        for (const c of children) {
          if (active >= max) break;
          // launched by this drive and since gone: deleted while running (perc delete); not recreated
          if (status[c.id] !== undefined || launched.has(c.id)) continue;
          await start(c);
          launched.add(c.id);
          status[c.id] = 'running';
          active++;
        }
        if (children.every((c) => isFinished(status[c.id]) || (status[c.id] === undefined && launched.has(c.id)))) break;
        // a paused slice waits for its owner: once none is running, nothing moves until they answer it
        const paused = children.filter((c) => status[c.id] === 'paused').map((c) => c.id);
        if (paused.length > 0 && !children.some((c) => status[c.id] === 'running')) {
          return escalate(`percolator.fan_out: slice(s) ${paused.join(', ')} paused; answer each (perc status <id>), then perc resume ${runId}`);
        }
        await sleep(o.pollMs ?? 5000);
      }
      const lines: string[] = [];
      const failed: string[] = [];
      const deleted: string[] = [];
      for (const c of children) {
        const dir = runDirOf(o.deps.home, c.id);
        if (!(await exists(path.join(dir, 'run.json')))) {
          deleted.push(c.id);
          continue;
        }
        const state = await loadState(dir);
        if (state.status === 'failed') failed.push(c.id);
        lines.push(`${c.index}. ${c.title} → ${(await prUrl(dir, state)) ?? state.status}`);
      }
      if (failed.length > 0) {
        return escalate(`percolator.fan_out: slice(s) ${failed.join(', ')} failed; perc delete each (its branch stays), then perc resume ${runId} to run it again`);
      }
      if (deleted.length > 0) {
        return escalate(`percolator.fan_out: slice(s) ${deleted.join(', ')} deleted while running; perc resume ${runId} to start it again`);
      }
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'slices_done.md'), `${lines.join('\n')}\n`);
      const collected = await collectOutputs(io.outputsDir, runDir);
      if ('error' in collected) return escalate(`percolator.fan_out: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`percolator.fan_out: ${errText(err)}`);
    }
  };
}
