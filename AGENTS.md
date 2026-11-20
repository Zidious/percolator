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
| `src/util/entry.ts` | `isDirectRun` (entry-point check through symlinked bins; used by `cli.ts` and `json-schema.ts`) |
| `src/util/fs.ts` | `writeFileAtomic` (fsync, then `renameRetry`), `renameRetry` (rename retried on EPERM/EBUSY/EACCES, shared), `exists` (lstat-based), `readYamlFile` (keeps line info for located errors) |
| `src/util/exec.ts` | `Exec` (argv-only; non-zero exit resolves with its code; ENOENT rejects `<file> not found on PATH`) and `nodeExec` (`execFile`, no shell) |
| `src/herdr/hc.ts` | `Hc` / `cliHc({ exec, bin })`: client for the herdr-core `hc` CLI (run/get/wait/read/kill/rm, `--json`, `--` before the program); `HcError` carries `kind`/`exitCode`/`hint`; `get` returns undefined on not_found; kill/rm ignore not_found/finished |
| `src/herdr/app.ts` | `HerdrApp` / `cliHerdrApp({ exec, bin })`: `newSpace(name, folder)` runs `herdr-app do space.new <one JSON arg>` and returns the `space` id; `space.close` is deliberately not wrapped (it ends the space's terminals) |
| `src/workspace/worktree.ts` | `defaultWorktreeDir(home, repo, runId)` (`~/.percolator/worktrees/<repo>/<run-id>`); `ensureWorktree({ repoRoot, dir, branch, base })` idempotent (`{ created }`): rejects `-` names/invalid branches, compares `git worktree list --porcelain` with `samePath`, reuses an existing branch; git builds the dir itself (no tmp+rename: renaming breaks worktree metadata) |
| `src/util/copy.ts` | `copyContained(src, dest, root)`: copies a file/tree into a tmp sibling then renames; symlinks are copied as content and must resolve inside `root` (`<rel> links outside the ground`); throws if `dest` exists. |
| `src/workspace/run-dir.ts` | `runDir`/`stepDir`; `materializeGrounds` copies policy/context mappings into `<runDir>/grounds/<ground>/…` (idempotent, the run record); `buildSkillPlugins(dir, mappings, grounds)` makes one Claude plugin per ground with `skills` mappings (call per step attempt with `mappingsFor`; duplicate skill names throw) and returns roots plus `plugins` mappings; `findSkill(ref, mappings)` → absolute `SKILL.md` for `ns:name`/bare names |
| `src/config/schema.ts` | zod schemas + inferred types, `STAGES`, `effectiveKind`, `groundRecord`. All objects strict: new config keys must be added here. Agent nodes need `agent`; `agent`/`model`/`skill`/`skills` only on agent nodes. Node names `^[A-Za-z][A-Za-z0-9_-]*$` |
| `src/config/load.ts` | `loadUserConfig`, `loadFragment`, `loadYaml(file, schema)`, `ConfigError`; reports every YAML/schema issue as `file:line: path: msg`, one per line |
| `src/config/json-schema.ts` | `writeJsonSchema`; rerun `pnpm schema [out]` whenever `schema.ts` changes (refinements are not in the JSON schema) |
| `src/config/profile.ts` | `normalizeRemote` (→ lower-case `host/owner/repo`), `selectProfile` (override, else first matching `match.remote`/`match.path` glob; `/**` also matches its base dir) |
| `src/grounds/git.ts` | `runGit` (exported argv-array git runner, errors redacted), `Git` interface (incl. `toplevel`) + `cliGit` (argv arrays, `--`, rejects leading `-`, `redactUrls` hides url credentials in errors) |
| `src/grounds/lock.ts` | `readLock`/`writeLock` for `percolator.lock` (YAML, atomic); `LockSchema` (full hex commits), located ConfigError |
| `src/grounds/resolve.ts` | `resolveGrounds`; locked commit + cached dir = no git calls; only `update: true` moves a pin; mirror keyed by name; re-created (atomically) when its url changes; a lost rename race reuses the winner's dir |
| `src/grounds/mappings.ts` | `resolveMappings` (validates all mappings up front, one ConfigError), `resolveInGround` (no `:`, no escaping by `..`/absolute/symlink), `mappingsFor(step, mappings)` (generic; `*`, step id, hook name, stage for slots only), `checkGraphReferences` (node prompt files, `applies_to` stage/node/step id), `fragmentLayers`, `Layer = { source, fragment }` with source `ground:<name>/<file>@<commit12 or local>` |
| `src/graph/core.ts` | `CORE_STAGES`, `STAGE_CONTRACTS` (required outputs), `CORE_GROOM_GATE` (`approve-groom`, locked by `core`); deep-frozen |
| `src/graph/merge.ts` | `mergeLayers` → `Merged` (`Sourced<T>` = value + source + locked); never aliases inputs or core constants; violations throw `LockViolation` |
| `src/graph/rules.ts` | `checkRules(merged)` → `Violation[]` (require_skills, allowed_agents/models, max_rounds_ceiling, required_nodes); `allowed_models` fails closed (no model is a violation); the core gate is exempt from the ceiling here because `buildGraph` clamps it. `RuleViolationError` (a ConfigError carrying `violations`) |
| `src/graph/build.ts` | `buildGraph(merged)` → `Graph` (`steps`, each with `source`/`locked` copied from its binding or node (`core`/true for the groom gate), `regionStart`, `backEdges` keyed by `fromStepId`, `failRoutes` stepId → edge id: every review slot step routes to the review edge, a step's own `on_fail` to its own edge); `GraphError`. Step ids are unique. Each `BackEdge` has `jumpAfterIndex`: the review edge fires on review's fail but jumps after the last `after: review` hook |
| `src/engine/state.ts` | `RunState`, `newState`, `saveState`/`loadState` (`<dir>/state.json`, version 1, shape checked; `pendingJump` `{ edgeId, stepId, findings? }` persists a fail awaiting its jump (`stepId` = trigger; older states lack it, the engine uses the edge's `fromStepId`); `graphFingerprint`) |
| `src/engine/runtime.ts` | `Runtime` interface, `NodeOutcome` (`pass`/`fail`/`escalate`), `RunContext` |
| `src/engine/engine.ts` | `runGraph`: refuses a state recorded against a different graph (`graphFingerprint`); saves after every step; a `fail` follows `graph.failRoutes`; a pending jump is void once the cursor returns to or before its trigger step, and a later trigger on the same edge overwrites it; caps enforced in code (counters and `ctx.round` clamp at `maxRounds`; `ctx.maxRounds` is the innermost loop's cap, 1 outside loops); `once` hooks skip only after a `pass`; escalate pauses with the cursor on that step; contracts get one retry. The caller owns `RunState` and lowers `rounds[edgeId]` to grant another round |
| `src/validate.ts` | `validate` (result includes `grounds`): config → profile → grounds (lock beside config; relative `path:` grounds resolve against the config dir) → mappings → layers (mappings, profile, repo `<git toplevel ?? cwd>/.percolator/percolator.yaml`; only ENOENT means absent) → merge → rules → graph → prompt files/`applies_to`; throws `RuleViolationError`/ConfigError/LockViolation/GraphError, never returns a graph with violations |
| `src/cli.ts` | `main(argv, io)` → exit code (0 ok, 1 error/violations, 2 usage); `perc validate`, `perc schema`; `parseArgs`, no CLI deps |
| `src/index.ts` | public exports |
| `tests/helpers/fake-git.ts` | `FakeGit` (records `calls`; origin url kept in a marker file so it follows renames; `toplevels`, `cloneError`, `onClone` hooks); use instead of real git in unit tests |
| `tests/helpers/fake-runtime.ts` | `FakeRuntime` (scripted outcomes per step id; records `calls`, rounds and `maxRoundsSeen`; `roundsOf`/`maxRoundsOf`) and the `pass`/`fail`/`esc` helpers |
| `tests/helpers/exec-recorder.ts` | `ExecRecorder` (records `calls`; `respond(match, result)`; unmatched calls resolve `{}`); never run the real `hc` or `herdr-app` in tests |
| `.github/workflows/ci.yml` | test matrix, 3 OSes × Node 24 |

## Design decisions to keep

- **Six core stages, in order:** `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. All must be bound or the engine refuses to start. Percolator ships no bindings for `groom`, `plan`, `implement`, `review`.
- **Review loop:** default cap 3 rounds, then proceed to `deliver` with an unresolved-findings summary.
- **Back-edges** (`on_fail: { back_to, max_rounds }`): at the cap the run escalates (pauses for the owner).
- **Locks:** `required: true` locks always win over merge order. A locked target may only be restated deep-equal; otherwise `LockViolation` (`"<target> is locked by <src>; <attempt> cannot change it"`), naming the locking source.
