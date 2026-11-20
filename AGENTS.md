# AGENTS.md — working on Percolator

Deterministic "software factory" engine. The `perc` CLI loads layered YAML config (core → grounds → profile → repo), builds a run graph (six core stages + hooks + bounded back-edges), walks it through pluggable runtimes, and persists run state for resume.

Update this file when you add a convention, a directory or a command. Do not document what individual functions do; that belongs in the code.

## Commands

```sh
pnpm install --frozen-lockfile   # lockfile is committed; CI does the same
pnpm typecheck                   # tsc -p tsconfig.test.json (src + tests, no emit)
pnpm test                        # node --test "tests/**/*.test.ts"
pnpm test:watch
node --test tests/util/paths.test.ts   # focused run
pnpm build                       # tsc → dist/ (src only; dist/ is gitignored, published via package.json files)
pnpm schema                      # regenerate schema/percolator.schema.json
perc init [--config <file>] [--force]   # write the recommended config (templates/config.yaml)
perc run <ticket> [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]   # start a run (driver in its own hc terminal unless --foreground)
perc resume <run-id> [--foreground]   # continue a paused/interrupted run; checks run here before the driver launches
perc status [<run-id>]                # list runs, or show one (detail, last 10 history records)
perc approve <run-id> | perc reject <run-id> <feedback>   # answer the gate a run waits at
perc clean <run-id> [--force]         # remove a finished run's terminals and worktree (keeps branch and run record)
perc drive <run-id>                   # internal: what the driver terminal runs
node tests/smoke/hc.smoke.ts [--space <id>] [--boot] [--codex]   # manual: talks to the real hc (needs hc on PATH; --space also uses herdr-app; --boot launches claude + an idle program; --codex runs codex on Windows); not in pnpm test
node tests/smoke/gh.smoke.ts --issue <owner/repo#n>   # manual, read-only: real gh issue view, prints parsed JSON; not in pnpm test
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
- **`docs/superpowers/` is committed** (the design spec and the current plan; delete a plan once it is done). **Never commit `.superpowers/`** (subagent-run scratch; gitignored; never `git add -f`).
- **Strict TDD for every step**, including bug fixes and review fixes:
  1. RED: write the test, run it, see it fail for the expected reason (not a typo).
  2. GREEN: minimum code to pass; rerun.
  3. Refactor, tests green.

  No production code without a failing test first; if code came first, delete it. Load the `superpowers:test-driven-development` skill before implementing. Reports include RED and GREEN commands with **pasted** output (a prose summary is not evidence); missing RED is a blocking review finding. Tests assert behaviour, including user-facing error message text; no tests that only exercise mocks.
- **Test style:** `node:test` + `node:assert/strict`, no vitest. Translate vitest-style plan sketches (`expect`, `vi`, `test.each`).
- **Test layout:** `tests/` mirrors `src/`; fixtures in `tests/fixtures/`; temp dirs via `fs.mkdtemp(path.join(os.tmpdir(), ...))`, never fixed paths; output must be pristine (no stray warnings).
- **Conventional commits** (`feat(scope): …`, `chore: …`).

## Layout

Detailed behaviour lives in the code and in `docs/superpowers/specs/2026-11-20-percolator-design.md`; read the module before changing it.

| Dir | What |
|---|---|
| `src/cli.ts` | `perc` entry: arg parsing, commands, exit codes (0 ok, 1 error/failed run, 2 usage) |
| `src/config/` | zod schema (single source for config keys; rerun `pnpm schema` after changing it), YAML loading with located errors, profile selection, JSON schema generation |
| `src/grounds/` | git grounds: resolve and pin (`percolator.lock`), layer collection, mappings |
| `src/graph/` | core stages and contracts, layer merge with locks, rules, graph build (steps, back-edges) |
| `src/engine/` | `runGraph`, run state, `Runtime` interface |
| `src/runtime/` | `HerdrRuntime`: task rendering, terminal lifecycle, `done.json`/outputs collection |
| `src/run/` | run lifecycle: prepare, launch/drive, driver lock, run metadata |
| `src/tracker/` | GitHub: ticket parsing, `gh` client, intake, approval gate, PR opening; `BUILTIN_NAMES` is the single source of builtin node names |
| `src/herdr/` | clients for `hc` and `herdr-app` |
| `src/adapters/` | agent argv builders (`claude`, `codex`, `command`) and config checks |
| `src/workspace/` | worktrees, run/step dirs, ground materialization, skill plugins |
| `src/util/` | paths, atomic fs, argv-only exec |
| `src/validate.ts` | full config → graph validation pipeline |
| `tests/helpers/` | fakes and fixtures builders (see Testing conventions) |
| `tests/smoke/` | manual smoke tests against the real `hc`/`gh`; never run by `pnpm test` |

## Conventions

- **Testing:** never spawn the real `hc`, `herdr-app` or `gh` in tests: use `FakeHc`, `FakeHerdrApp`, `FakeGh`, `ExecRecorder` (`tests/helpers/`). Unit tests use `FakeGit`; real git only through `makeRepo()` / `setupRunEnv()`. Engine tests script outcomes with `FakeRuntime`.
- **No prompts:** git and gh always run with prompt-free env (`gitEnv`, the gh client's env); credentials in URLs are redacted from errors.
- **Errors:** one line, name the file or run, and say what to do next; tests assert the exact text.
- **Resume-safe:** run ids, terminal names and posted comments are deterministic or marked so a resume finds them instead of duplicating them.

## Design decisions to keep

- **Six core stages, in order:** `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. All must be bound or the engine refuses to start. Percolator ships no bindings for `groom`, `plan`, `implement`, `review`.
- **Review loop:** default cap 3 rounds, then proceed to `deliver` with an unresolved-findings summary.
- **Back-edges** (`on_fail: { back_to, max_rounds }`): at the cap the run escalates (pauses for the owner).
- **Locks:** `required: true` locks always win over merge order. A locked target may only be restated deep-equal; otherwise `LockViolation` (`"<target> is locked by <src>; <attempt> cannot change it"`), naming the locking source.
- **Completion** = `done.json` + `outputs/<key>.md` files; hc status is only for attention.
- **Terminal ownership:** a terminal not labelled `percolator.run` = this run is never re-attached, adopted, killed or removed.
