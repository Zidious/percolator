import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome, RunContext, Runtime } from '../engine/runtime.ts';
import type { Step } from '../graph/build.ts';
import { CORE_GROOM_GATE } from '../graph/core.ts';
import { collectOutputs } from '../runtime/outcome.ts';
import { priorGroomFile } from '../tracker/intake.ts';
import type { PriorGroom } from '../tracker/prior-groom.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { stepDir } from '../workspace/run-dir.ts';

async function readPrior(runDir: string): Promise<PriorGroom | undefined> {
  try {
    return JSON.parse(await fs.readFile(priorGroomFile(runDir), 'utf8')) as PriorGroom;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * When intake found an approved groomed ticket from an earlier run (`prior-groom.json`), groom's slot steps
 * pass without an agent (the last one outputs that ticket) and the groom gate passes with the earlier
 * approval, posting nothing. Every other step goes to `inner`.
 */
export function reusePriorGroom(inner: Runtime, runDir: string): Runtime {
  return {
    async executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome> {
      const isGroomSlot = step.stage === 'groom' && step.role === 'slot';
      const isGate = step.id === CORE_GROOM_GATE.name;
      if (!isGroomSlot && !isGate) return inner.executeStep(step, ctx);
      const prior = await readPrior(runDir);
      if (prior?.decision?.decision !== 'approve') return inner.executeStep(step, ctx);

      const outputsDir = path.join(stepDir(runDir, step.id, (ctx.state.executed[step.id] ?? 0) + 1), 'outputs');
      await fs.mkdir(outputsDir, { recursive: true });
      if (isGate) {
        const d = prior.decision;
        await writeFileAtomic(path.join(outputsDir, 'approval.md'), `Approved earlier by @${d.by}: ${d.url} (groomed ticket ${prior.gateUrl}).\n`);
      } else if (step.slotLast) {
        await writeFileAtomic(path.join(outputsDir, 'groomed_ticket.md'), `${prior.text}\n`);
      }
      const collected = await collectOutputs(outputsDir, runDir);
      if ('error' in collected) return { status: 'escalate', outputs: {}, reason: `${step.id}: ${collected.error}` };
      return { status: 'pass', outputs: collected.outputs };
    },
  };
}
