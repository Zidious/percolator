/** A mistake in how perc was called: the CLI prints the message with its usage and exits 2. Subclass it for new ones. */
export class UsageError extends Error {}
