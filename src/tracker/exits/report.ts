import type { StepHandler } from '../../runtime/herdr-runtime.ts';

/** The `none` exit: the run's outputs stay in the run dir, where the panel shows them. */
export function percolatorReport(): StepHandler {
  return async () => ({ status: 'pass', outputs: {} });
}
