/** Names of the builtin nodes Percolator handles itself; the single source for validation and drive. */
export const BUILTIN_NAMES = ['github.intake', 'github.open_pr'] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];
