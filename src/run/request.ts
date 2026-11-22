import type { PipelineSpec } from '../config/pipelines.ts';

/** A run request that does not fit its pipeline; the CLI reports it like a usage error (exit 2). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * `--input key=value` pairs → a map. Splits on the first `=` only, so values may hold `=`, spaces,
 * `C:\` paths or a leading `-`: a value is never a positional to a child process.
 */
export function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new InputError(`--input needs key=value, got "${raw}"`);
    const key = raw.slice(0, eq);
    if (Object.hasOwn(out, key)) throw new InputError(`--input ${key} is given twice; give it once`);
    out[key] = raw.slice(eq + 1);
  }
  return out;
}

/** Checks a run request against its pipeline: the ticket, then unknown inputs, then missing required ones. */
export function checkRequest(spec: PipelineSpec, ticket: string | undefined, inputs: Record<string, string>): void {
  const p = spec.name;
  if (ticket !== undefined && spec.ticket === 'none') {
    throw new InputError(`pipeline "${p}" takes no ticket (ticket: none); drop the ticket or pick another pipeline with --pipeline`);
  }
  if (ticket === undefined && spec.ticket === 'required') {
    throw new InputError(`pipeline "${p}" needs a ticket; pass one: perc run <ticket> --pipeline ${p}`);
  }
  const declared = Object.keys(spec.inputs);
  for (const k of Object.keys(inputs)) {
    if (!Object.hasOwn(spec.inputs, k)) {
      throw new InputError(
        `pipeline "${p}" has no input "${k}" (inputs: ${declared.length > 0 ? declared.join(', ') : 'none'}); drop it or declare it under pipelines.${p}.inputs`,
      );
    }
  }
  for (const [k, def] of Object.entries(spec.inputs)) {
    if (def.required && !Object.hasOwn(inputs, k)) throw new InputError(`pipeline "${p}" needs input ${k}; pass --input ${k}=<value>`);
  }
}
