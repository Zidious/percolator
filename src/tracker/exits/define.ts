import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeOutcome, RunContext } from '../../engine/runtime.ts';
import type { Step } from '../../graph/build.ts';
import type { StepHandler, StepIo } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import type { BuiltinName } from '../index.ts';
import { errText } from './latest.ts';

/** What an exit's body ends with: its outputs (key → one line of text, none to pass with no outputs), or why to escalate. */
export type ExitResult = { write: Record<string, string> } | { escalate: string };

/**
 * An exit's handler from its body. The body does the exit's own work; the handler creates the outputs dir
 * first, writes each output as `outputs/<key>.md`, collects them, and escalates (on the body's reason, a thrown
 * error, or a bad output) with `<builtin>: ` before the reason.
 */
export function defineExit(
  builtin: BuiltinName,
  runDir: string,
  body: (step: Step, ctx: RunContext, io: StepIo) => Promise<ExitResult>,
): StepHandler {
  const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason: `${builtin}: ${reason}` });
  return async (step, ctx, io) => {
    try {
      await fs.mkdir(io.outputsDir, { recursive: true });
      const result = await body(step, ctx, io);
      if ('escalate' in result) return escalate(result.escalate);
      const outputs = Object.entries(result.write);
      if (outputs.length === 0) return { status: 'pass', outputs: {} };
      for (const [key, text] of outputs) await writeFileAtomic(path.join(io.outputsDir, `${key}.md`), `${text}\n`);
      const collected = await collectOutputs(io.outputsDir, runDir);
      if ('error' in collected) return escalate(collected.error);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(errText(err));
    }
  };
}
