# Groomed ticket — SAMPLE

Replace the hand-written `node:util` `parseArgs` wrapper in `src/cli.ts` with `meow`.

## Acceptance

1. Every command keeps its flags and exit codes.
2. Usage errors still exit 2 with the same one-line messages.
3. No new runtime dependency beyond `meow` (needs the owner's agreement).
