import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { defineExit } from './define.ts';
import { noticedNotes } from './notes.ts';

/** The `none` exit: the run's outputs stay in the run dir, where the panel shows them; the verify rounds' notes become its `notes` output. */
export function percolatorReport(o: { runDir: string }): StepHandler {
  return defineExit('percolator.report', o.runDir, async (_step, ctx) => {
    const notes = await noticedNotes(ctx, o.runDir);
    const write: Record<string, string> = notes === undefined ? {} : { notes };
    return { write };
  });
}
