# AGENTS.md — working on Percolator

Deterministic "software factory" engine. The `perc` CLI loads layered YAML config (core → grounds → profile → repo), builds a run graph for one pipeline (its stages + hooks + bounded back-edges; `feature` is the six-stage ticket → PR pipeline), walks it through pluggable runtimes, and persists run state for resume.

Update this file when you add a convention, a directory or a command. Do not document what individual functions do; that belongs in the code.

## Commands

```sh
pnpm install --frozen-lockfile        # lockfile is committed; CI does the same
pnpm typecheck                        # src + tests, no emit
pnpm test                             # all tests; pnpm test:watch to watch
node --test tests/util/paths.test.ts  # focused run
pnpm build                            # tsc → dist/ (gitignored)
pnpm schema                           # regenerate schema/percolator.schema.json after changing the zod schema
node src/cli.ts <command> …           # run perc from a checkout; `perc --help` lists commands
node src/cli.ts validate [--pipeline <name>]        # check every pipeline of the profile, or one
node src/cli.ts run [<ticket>] [--pipeline <name>] [--input key=value]...  # start a run of a pipeline (default: the profile's); no ticket for ticket: none
node src/cli.ts approve <id> [--pipeline <name>]  # answer a gate; --pipeline answers a router's pick-pipeline gate
node src/cli.ts pipelines [--json]                  # list the repo's pipelines (--json: the panel's contract)
node src/cli.ts delete <id>...|--finished [--yes]  # remove runs; keeps branches
node src/cli.ts watch [--repo <dir>]... [--interval <s>] [--foreground]  # start runs from triggers (hc terminal percolator-watch); `watch stop` ends it
pnpm herdr:sync                       # mirror herdr/mods/* into the Herdr app (reloads live; removes stale files, keeps perc.json); after any panel/cup change
node tests/smoke/hc.smoke.ts          # manual smoke tests against the real hc / gh (gh.smoke.ts); flags in each file's header; never in pnpm test
node tests/smoke/panel.shots.ts [--out dir]   # screenshots of every fixture state at 280/380/720 and in the window; needs Herdr open
node tests/smoke/skill.smoke.ts       # sandboxed agent scenarios for skills/percolator-config; --verify <root> afterwards; never in pnpm test
```

## Hard rules

- **Node ≥ 24.** CI runs Node 24 on ubuntu, windows, macos.
- **pnpm only.** Never `npm`/`npx`. Only `pnpm add`/`pnpm remove`, with the owner's agreement, may change the lockfile.
- **Minimal deps.** Runtime: `zod`, `yaml`. Dev: `typescript`, `@types/node`. New deps need the owner's agreement; prefer Node built-ins.
- **Native TypeScript.** Relative imports use `.ts`. Erasable syntax only: no `enum`, `namespace`, constructor parameter properties. `import type` for types.
- **Cross-platform.** Windows (the owner's OS), Linux, macOS are first-class. `node:path`, never concatenated paths; `expandHome` for `~`; `samePath`/`toPosix` (`src/util/paths.ts`) to compare.
- **No shell spawning.** Argv arrays only, never `shell: true`. Put `--` before config-supplied positionals and reject values starting with `-`.
- **Atomic writes.** Dirs: build in a tmp sibling, then rename. Crash-critical files (run state, `percolator.lock`): `writeFileAtomic`.
- **LF** line endings.
- **Never commit `docs/superpowers/` or `.superpowers/`** (local specs/plans and subagent scratch), not even with `git add -f`. What a spec decides that must outlive it goes into code, tests or this file.
- **Strict TDD for every step**, bug and review fixes included: RED (test fails for the expected reason), GREEN (minimum code), refactor. No production code without a failing test first; if code came first, delete it. Load `superpowers:test-driven-development` before implementing. Reports paste RED and GREEN output; missing RED is a blocking review finding. Tests assert behaviour, including error message text, never just mocks.
- **Tests:** `node:test` + `node:assert/strict` (translate vitest-style sketches). `tests/` mirrors `src/`; fixtures in `tests/fixtures/`; temp dirs via `fs.mkdtemp(path.join(os.tmpdir(), ...))`; output pristine.
- **Commits:** conventional (`feat(scope): …`, `chore: …`); no agent attribution trailers; never amend or push unless asked.

## Layout

Read the module before changing it.

| Dir | What |
|---|---|
| `src/cli.ts` | `perc` entry: arg parsing, commands, exit codes (0 ok, 1 error/failed run, 2 usage) |
| `src/config/` | zod schema (single source for config keys), YAML loading with located errors, profiles; `pipelines.ts`: pipeline specs, the default pipeline, checks across pipelines (routes, next, triggers) |
| `src/grounds/` | git grounds: resolve and pin (`percolator.lock`), layers, mappings |
| `src/graph/` | core stages and contracts, layer merge with locks, rules, graph build |
| `src/engine/` | `runGraph`, run state, `Runtime` interface |
| `src/runtime/` | `HerdrRuntime`: task rendering, terminal lifecycle, outputs collection |
| `src/run/` | run lifecycle: prepare, launch/drive, driver lock, metadata; `request.ts`: `--input` parsing and the run request checked against its pipeline; `pick-pipeline.ts`: the pipeline a ticket asks for (label, `/percolator run` comment); `child.ts`: linked child runs; `route.ts`: a router's decision (`route.json`) and handoff; `fan-out.ts`: the fan-out and seed builtins (`fanout.json`, slice runs); `pipelines-json.ts`: `perc pipelines` |
| `src/tracker/` | GitHub: tickets, `gh` client, intake, approval gate, PRs; `BUILTIN_NAMES` is the single source of builtin node names, `EXITS` of exit kinds |
| `src/tracker/exits/` | one handler per exit builtin (comment, issues, report, release, review, private fork PR) |
| `src/herdr/` | clients for `hc` and `herdr-app` |
| `src/adapters/` | agent argv builders (`claude`, `codex`, `command`) |
| `src/workspace/` | worktrees, run/step dirs, ground materialization, skill plugins |
| `src/util/` | paths, atomic fs, argv-only exec; `cron.ts` (cron with time zones, Intl only), `sections.ts` (`## ` sections of drafted issues and slices) |
| `src/watch/` | `perc watch`: trigger polling, the firing ledger (`~/.percolator/watch/fired.json`), the watch loop and its heartbeat (`watch.json`) |
| `src/validate.ts` | config → graph validation pipeline |
| `templates/` | recommended config written by `perc init` |
| `skills/` | agent-agnostic skills shipped in the package |
| `scripts/` | repo tooling run by package scripts (`herdr-sync.ts`); typechecked, tested under `tests/scripts/` |
| `herdr/` | Herdr panel (`mods/percolator/`, plain JS, pure logic in `model.js`) and status-bar cup (`mods/percolator-cup/`), layout, fixtures |

## Conventions

- **Test fakes:** never spawn the real `hc`, `herdr-app` or `gh`: use `FakeHc`, `FakeHerdrApp`, `FakeGh`, `ExecRecorder` (`tests/helpers/`). Unit tests use `FakeGit`; real git only via `makeRepo()` / `setupRunEnv()`. Engine tests use `FakeRuntime`.
- **No prompts:** git and gh run with prompt-free env (`gitEnv`, the gh client's env); credentials in URLs are redacted from errors.
- **Errors:** one line, name the file or run, say what to do next; tests assert the exact text.
- **Panel contract:** `perc status --json` and `herdr/mods/percolator/model.js` (its only reader) change together. After changing either mod, run `pnpm herdr:sync` so the running app shows it (Herdr does not follow symlinks or junctions). Herdr refuses cross-mod imports, so the cup carries copies of the panel's `model.js`, `mark.js`, `source.js`; re-copy them, and `tests/herdr/cup.test.ts` keeps them equal.
- **Resume-safe:** run ids, terminal names and posted comments are deterministic or marked so a resume finds them instead of duplicating them.
- **README stays true:** `README.md` is the user-facing doc. A change that makes anything in it wrong (requirements, stages, the example config, config keys, statuses and how to answer them, integrations, setup) updates it in the same commit, including the diagrams in `assets/diagram-*-{light,dark}.svg` (both themes). A new integration gets a row in the Integrations table and its own `###` section. Check it before calling the work done.

## Design decisions to keep

- **Pipelines:** every pipeline starts with intake and ends with one exit builtin; the feature pipeline's stages are intake, groom, plan, implement, review, deliver, and its approve-groom gate is built in (required) there only. Every stage must be bound or the engine refuses to start. No built-in bindings for `groom`…`review`; `perc init` writes the recommended config (`pipelines.feature`). Top-level `bindings`/`nodes` belong to `feature`; top-level `rules` apply to every pipeline.
- **Routing hands off:** a router's route step starts a new linked run; a run's graph never changes once it starts.
- **Fan-out runs children:** each slice is a linked run `<parent>-s<i>` from the fanned stage to the exit; the parent waits for them.
- **Bounded loops:** review caps at 3 rounds, then delivers anyway (the PR body does not carry the findings); a back-edge (`on_fail: { back_to, max_rounds }`) at its cap escalates to the owner.
- **Locks:** `required: true` wins over merge order. A locked target may only be restated deep-equal; otherwise `LockViolation`, located at the attempt: `"<file>:<line>: <path>: locked by <file>:<line> (required: true); remove this <binding|node|mapping> or restate it exactly"` (mappings read `mapping <name> is locked by …`); a core lock reads `"… locked by Percolator core (required: true); remove this node: <name> is built in"`.
- **Completion** = `done.json` + `outputs/<key>.md`; hc status is only for attention.
- **Worktrees in the repo:** `<repo>/.worktrees/<run-id>`, listed in `.git/info/exclude`, so the repo's agent trust covers them. Run dirs stay in `~/.percolator/runs`, reached via `--add-dir` (`~/.percolator` must be trusted in Claude Code once).
- **Terminal ownership:** a terminal not labelled `percolator.run` = this run is never re-attached, adopted, killed or removed. One exception: `perc delete` ends live terminals whose cwd is inside the run's worktree (the run space's own shell, ones opened there), which would otherwise hold it open on Windows. The watcher terminal (`percolator-watch`, labelled `percolator.role=watcher`) is the only terminal outside any run that perc ends or removes (`perc watch`, `perc watch stop`), and only when it carries that label.
- **Driver pane:** the panel peeks at the driver (`terminal.peek`), never puts it in a pane: closing a Herdr pane ends its terminal, and with it the run.
