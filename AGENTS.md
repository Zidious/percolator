# AGENTS.md — working on Percolator

Deterministic "software factory" engine. The `perc` CLI loads layered YAML config (core → grounds → profile → repo), builds a run graph (six core stages + hooks + bounded back-edges), walks it through pluggable runtimes, and persists run state for resume.

Update this file when you add a convention, module or command the next session needs.

## Commands

```sh
pnpm install --frozen-lockfile   # lockfile is committed; CI does the same
pnpm typecheck                   # tsc -p tsconfig.test.json (src + tests, no emit)
pnpm test                        # node --test "tests/**/*.test.ts"
pnpm test:watch
node --test tests/util/paths.test.ts   # focused run
pnpm build                       # tsc → dist/ (src only)
pnpm schema                      # regenerate schema/percolator.schema.json
```

## Hard rules

- **Node ≥ 24.** CI runs Node 24 on ubuntu, windows, macos.
- **pnpm only.** Never `npm`/`npx`. Install with `pnpm install --frozen-lockfile` locally and in CI. Only `pnpm add`/`pnpm remove`, with the owner's agreement, may change the lockfile.
- **Minimal deps.** Runtime: `zod`, `yaml` only. Dev: `typescript`, `@types/node` only. New deps need the owner's agreement. Prefer Node built-ins (`util.parseArgs`, `child_process`, `path.posix.matchesGlob`, native type stripping).
- **Native TypeScript.** Relative imports use `.ts` (`tsc` rewrites to `.js`). Erasable syntax only: no `enum`, `namespace`, constructor parameter properties. Use `import type` for types (`verbatimModuleSyntax`).
- **Cross-platform.** Windows, Linux, macOS are all first-class (owner is on Windows 11). Use `node:path`, never string-concatenated paths; `expandHome` for `~`; `samePath`/`toPosix` (`src/util/paths.ts`) to compare paths.
- **No shell spawning.** Argv arrays only; never `shell: true` or command strings. Put `--` before config-supplied positionals and reject values starting with `-`.
- **Atomic dirs:** build in a tmp sibling, then rename into place.
- **Atomic files:** crash-critical files (run state, `percolator.lock`) go through `writeFileAtomic`.
- **LF** line endings.
- **Never commit `docs/` or `.superpowers/`** (gitignored; never `git add -f`).
- **Strict TDD for every step**, including bug fixes and review fixes:
  1. RED: write the test, run it, see it fail for the expected reason (not a typo).
  2. GREEN: minimum code to pass; rerun.
  3. Refactor, tests green.

  No production code without a failing test first; if code came first, delete it. Load the `superpowers:test-driven-development` skill before implementing. Reports include RED and GREEN commands with **pasted** output (a prose summary is not evidence); missing RED is a blocking review finding. Tests assert behaviour, including user-facing error message text; no tests that only exercise mocks.
- **Test style:** `node:test` + `node:assert/strict`, no vitest. Translate vitest-style plan sketches (`expect`, `vi`, `test.each`).
- **Test layout:** `tests/` mirrors `src/`; fixtures in `tests/fixtures/`; temp dirs via `fs.mkdtemp(path.join(os.tmpdir(), ...))`, never fixed paths; output must be pristine (no stray warnings).
- **Conventional commits** (`feat(scope): …`, `chore: …`).

## Layout

| Path | Purpose |
|---|---|
| `src/util/paths.ts` | `expandHome` (`~/` and `~\`), `toPosix`, `samePath` |
| `src/util/fs.ts` | `writeFileAtomic`, `readYamlFile` (keeps line info for located errors) |
| `src/config/schema.ts` | zod schemas + inferred types, `STAGES`, `effectiveKind`. All objects strict: new config keys must be added here |
| `src/config/load.ts` | `loadUserConfig`, `loadFragment`, `ConfigError`; reports every YAML/schema issue as `file:line: path: msg`, one per line |
| `src/config/json-schema.ts` | `writeJsonSchema`; rerun `pnpm schema` whenever `schema.ts` changes |
| `src/config/profile.ts` | `normalizeRemote` (→ lower-case `host/owner/repo`), `selectProfile` (override, else first matching `match.remote`/`match.path` glob; `/**` also matches its base dir) |
| `src/grounds/git.ts` | `Git` interface + `cliGit` (argv arrays, `--`, rejects leading `-`) |
| `src/grounds/lock.ts` | `readLock`/`writeLock` for `percolator.lock` (YAML, atomic) |
| `src/grounds/resolve.ts` | `resolveGrounds`; locked commit + cached dir = no git calls; only `update: true` moves a pin; mirror keyed by url |
| `src/grounds/mappings.ts` | `resolveMappings` (validates all mappings up front, one ConfigError, no escaping the ground), `fragmentLayers`, `Layer = { source, fragment }` with source `ground:<name>/<file>@<commit12 or local>` |
| `src/graph/core.ts` | `CORE_STAGES`, `STAGE_CONTRACTS` (required outputs), `CORE_GROOM_GATE` (`approve-groom`, locked by `core`); deep-frozen |
| `src/graph/merge.ts` | `mergeLayers` → `Merged` (`Sourced<T>` = value + source + locked); never aliases inputs or core constants; violations throw `LockViolation` |
| `src/engine/state.ts` | `RunState`, `newState`, `saveState`/`loadState` (`<dir>/state.json`, version 1) |
| `src/index.ts` | public exports |
| `tests/helpers/fake-git.ts` | `FakeGit` (records `calls`); use instead of real git in unit tests |
| `.github/workflows/ci.yml` | test matrix, 3 OSes × Node 24 |

## Design decisions to keep

- **Six core stages, in order:** `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. All must be bound or the engine refuses to start. Percolator ships no bindings for `groom`, `plan`, `implement`, `review`.
- **Review loop:** default cap 3 rounds, then proceed to `deliver` with an unresolved-findings summary.
- **Back-edges** (`on_fail: { back_to, max_rounds }`): at the cap the run escalates (pauses for the owner).
- **Locks:** `required: true` locks always win over merge order. A locked target may only be restated deep-equal; otherwise `LockViolation` (`"<target> is locked by <src>; <attempt> cannot change it"`), naming the locking source.
