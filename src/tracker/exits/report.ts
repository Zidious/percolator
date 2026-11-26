import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import { errText, escalate } from './latest.ts';
import { noticedNotes } from './notes.ts';

/** The `none` exit: the run's outputs stay in the run dir, where the panel shows them; the verify rounds' notes become its `notes` output. */
export function percolatorReport(o: { runDir: string }): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const notes = await noticedNotes(ctx, o.runDir);
      if (notes === undefined) return { status: 'pass', outputs: {} };
      await fs.mkdir(io.outputsDir, { recursive: true });
      await writeFileAtomic(path.join(io.outputsDir, 'notes.md'), `${notes}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`percolator.report: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`percolator.report: ${errText(err)}`);
    }
  };
}
