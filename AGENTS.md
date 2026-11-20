# AGENTS.md — working on Percolator

Percolator is a deterministic "software factory" engine. A `perc` CLI loads layered YAML config (core → grounds → profile → repo), builds a run graph (six core stages + hooks + bounded back-edges) and walks it, running each node through a pluggable runtime. Run state is persisted so a run can resume.

Read this before you change anything. Update it when you add a convention, a module or a command that the next session needs.

## Commands

```sh
pnpm install --frozen-lockfile   # install (pnpm-lock.yaml is committed; CI does the same)
pnpm typecheck                   # tsc -p tsconfig.test.json (src + tests, no emit)
pnpm test                        # node --test (all tests under tests/**/*.test.ts)
pnpm test:watch                  # node --test --watch
node --test tests/util/paths.test.ts   # focused run while iterating
pnpm build                       # tsc → dist/ (src only)
pnpm schema                      # regenerate schema/percolator.schema.json
```

## Hard rules

- **Node ≥ 24 only.** `engines` is `>=24`; CI runs Node 24 on ubuntu, windows and macos.
- **pnpm only.** Never `npm install` / `npx`; the lockfile is `pnpm-lock.yaml`. Install with `pnpm install --frozen-lockfile` locally and in CI. Only `pnpm add` / `pnpm remove` (with the owner's agreement) may change the lockfile.
- **Minimal dependencies.** Runtime deps are `zod` and `yaml` only; dev deps are `typescript` and `@types/node` only. Prefer Node built-ins:
  - argv parsing → `node:util` `parseArgs`
  - child processes → `node:child_process` `execFile` / `spawn`
  - globbing → `path.posix.matchesGlob`
  - running TS → Node's native type stripping

  Adding a dependency (`pnpm add` / `pnpm add -D`) needs the owner's agreement.
- **Native TypeScript.** Relative imports carry the `.ts` extension (`import { x } from './util/paths.ts'`). `tsc` rewrites them to `.js` in `dist/`. Only erasable syntax: no `enum`, `namespace` or constructor parameter properties. Type-only imports use `import type`, because `verbatimModuleSyntax` is on.
- **Cross-platform first.** Windows, Linux and macOS are all first-class, and the owner develops on Windows 11.
  - Build paths with `node:path`, never string concatenation.
  - `~` expands via `expandHome`, which handles both `~/` and `~\`.
  - Compare paths with `samePath` / `toPosix` from `src/util/paths.ts`.
- **Never spawn through a shell.** Child processes take argv arrays; never `shell: true`, never a command string. Put `--` before positional args that come from config (URLs, paths), and reject config values that start with `-`.
- **Atomic dirs.** Materialise directories in a tmp sibling and rename them into place, so a crash never leaves a half-built dir that looks valid.
- **Atomic writes.** Any file that must survive a crash, such as run state or `percolator.lock`, goes through `writeFileAtomic` (`src/util/fs.ts`).
- **LF line endings** (`.gitattributes`: `* text=auto eol=lf`).
- **Never commit `docs/` or `.superpowers/`.** Both are gitignored on purpose: the design spec and plans stay local. Never `git add -f` them.
- **TDD for every step: new features, bug fixes, and fixes for review findings.**
  1. RED: write the test first and run it. Watch it fail for the expected reason, e.g. a missing module or a wrong value, not a typo.
  2. GREEN: write the minimum code that makes it pass, then run it again.
  3. Refactor with the tests still green.

  No production code without a failing test first. If you wrote code before the test, delete it and start from the test.

  Agents load the `superpowers:test-driven-development` skill before implementing. Reports include the RED and GREEN commands with their **pasted** output (a prose summary such as "RED: module missing" is not evidence), and a review treats missing RED evidence as a blocking finding. Tests assert behaviour, including error message text where users will see it. Don't write tests that only exercise mocks.
- **Test style.** `node:test` plus `node:assert/strict` (no vitest). Plan sketches written in vitest style (`expect`, `vi`, `test.each`) get translated when implemented.
- **Test layout.** Tests live in `tests/`, mirroring `src/`. Fixtures go in `tests/fixtures/`. Temp dirs come from `fs.mkdtemp(path.join(os.tmpdir(), ...))`, never a fixed path. Test output must be pristine (no stray warnings).
- Commit messages are conventional (`feat(scope): …`, `chore: …`).

## Layout

| Path | What it is |
|---|---|
| `src/util/paths.ts` | `expandHome`, `toPosix`, `samePath` |
| `src/util/fs.ts` | `writeFileAtomic`, `readYamlFile` (yaml Document + LineCounter for located errors) |
| `src/config/schema.ts` | zod schemas + inferred types (`STAGES`, `Stage`, `GroundSpec`, `Mapping`, `NodeDef`, `Binding`, `Rules`, `GraphFragment`, `Profile`, `UserConfig`, `effectiveKind`). All objects are strict, so a new config key must be added here. |
| `src/config/load.ts` | `loadUserConfig`, `loadFragment`, `ConfigError` (`file`, `line`, `path`). Reports **every** YAML or schema issue as `file:line: path: msg`, one per line. Union errors are flattened to the closest branch. |
| `src/config/json-schema.ts` | `writeJsonSchema`. `pnpm schema` regenerates the committed `schema/percolator.schema.json`; rerun it whenever `schema.ts` changes. |
| `src/config/profile.ts` | `normalizeRemote` (any git URL form → lower-case `host/owner/repo`, no user, port or `.git`), `selectProfile` (override, then the first profile whose `match.remote` / `match.path` glob matches; a `/**` pattern also matches its base dir) |
| `src/grounds/git.ts` | `Git` interface + `cliGit` (execFile with argv arrays; `--` before positionals; values starting with `-` are rejected) |
| `src/grounds/lock.ts` | `Lock`, `readLock`, `writeLock` (`percolator.lock`, YAML, written atomically) |
| `src/grounds/resolve.ts` | `resolveGrounds`. A locked commit with a cached dir makes no git calls (offline). Only `update: true` moves a pin. Materialisation is tmp dir + rename, and the mirror is keyed by url. |
| `tests/helpers/fake-git.ts` | `FakeGit`: records `calls`, serves refs. Use it in unit tests instead of real git. |
| `src/engine/state.ts` | `RunState`, `newState`, `saveState`, `loadState` (`<dir>/state.json`, version 1) |
| `src/index.ts` | public exports |
| `.github/workflows/ci.yml` | test matrix (3 OSes × Node 24) |

## Design decisions to keep

- **The six core stages, in order:** `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. Every one must be bound, or the engine refuses to start. Percolator ships no agent bindings for `groom`, `plan`, `implement` or `review`.
- **Review loop.** The default cap is 3 rounds. When the cap is hit, the run proceeds to `deliver` with an unresolved-findings summary.
- **Extension back-edges** (`on_fail: { back_to, max_rounds }`). When their cap is hit, the run escalates, i.e. pauses for the owner.
- **Locks.** `required: true` locks always win over merge order, and the error names the source that locked the value.
