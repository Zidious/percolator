/**
 * The hidden HTML markers Percolator puts in what it posts on the tracker, so a resume finds an earlier
 * attempt's comment, issue, review or release instead of posting it twice. Their text must not change.
 */

/** Starts every approval gate comment; intake leaves such comments out of the ticket. */
export const GATE_MARKER = '<!-- percolator:gate';
/** Starts the legacy local-decision notes (nothing writes them any more; old comments still carry them). */
export const DECISION_MARKER = '<!-- percolator:decision';

export const gateMarker = (runId: string, stepId: string): string => `${GATE_MARKER} run=${runId} step=${stepId} -->`;
export const exitMarker = (runId: string, stepId: string): string => `<!-- percolator:exit run=${runId} step=${stepId} -->`;
export const issueMarker = (runId: string, n: string): string => `<!-- percolator:issue run=${runId} n=${n} -->`;
export const releaseMarker = (runId: string): string => `<!-- percolator:release run=${runId} -->`;
export const reviewMarker = (runId: string): string => `<!-- percolator:review run=${runId} -->`;
