/** Names of the builtin nodes Percolator handles itself; the single source for validation and drive. */
export const BUILTIN_NAMES = ['github.intake', 'github.open_pr'] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/** How a pipeline ends: each exit kind is run by one builtin on the pipeline's last stage. */
export const EXIT_KINDS = ['pr'] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];
export const EXIT_BUILTIN: Readonly<Record<ExitKind, BuiltinName>> = Object.freeze({ pr: 'github.open_pr' });
