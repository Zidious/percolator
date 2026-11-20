# AGENTS.md — working on Percolator

Percolator is a deterministic "software factory" engine. A `perc` CLI loads layered YAML config (core → grounds → profile → repo), builds a run graph (six core stages + hooks + bounded back-edges) and walks it, running each node through a pluggable runtime. Run state is persisted so a run can resume.

Read this before you change anything. Update it when you add a convention, a module or a command that the next session needs.

## Commands

```sh
npm ci              # install (lockfile is committed; CI uses npm ci)
npm run typecheck   # tsc -p tsconfig.test.json (src + tests, no emit)
npm test            # vitest run (all tests under tests/**/*.test.ts)
npx vitest run tests/util   # focused run while iterating
npm run build       # tsc → dist/ (src only)
npm run schema      # regenerate schema/percolator.schema.json
```

## Hard rules

- **Node ≥ 24 only.** `engines` is `>=24`; CI runs Node 24 on ubuntu, windows and macos.
- **Minimal dependencies.** Runtime deps are `zod` and `yaml` only. Prefer Node built-ins:
  - argv parsing → `node:util` `parseArgs`
  - child processes → `node:child_process` `execFile` / `spawn`
  - globbing → `path.posix.matchesGlob`
  - running TS → Node's native type stripping

  Adding a dependency needs the owner's agreement.
- **Native TypeScript.** Relative imports carry the `.ts` extension (`import { x } from './util/paths.ts'`). `tsc` rewrites them to `.js` in `dist/`. Only erasable syntax: no `enum`, `namespace` or constructor parameter properties. Type-only imports use `import type`, because `verbatimModuleSyntax` is on.
- **Cross-platform first.** Windows, Linux and macOS are all first-class, and the owner develops on Windows 11.
  - Build paths with `node:path`, never string concatenation.
  - `~` expands via `expandHome`, which handles both `~/` and `~\`.
  - Compare paths with `samePath` / `toPosix` from `src/util/paths.ts`.
- **Never spawn through a shell.** Child processes take argv arrays; never `shell: true`, never a command string.
- **Atomic writes.** Any file that must survive a crash, such as run state or `percolator.lock`, goes through `writeFileAtomic` (`src/util/fs.ts`).
- **LF line endings** (`.gitattributes`: `* text=auto eol=lf`).
- **Never commit `docs/` or `.superpowers/`.** Both are gitignored on purpose: the design spec and plans stay local. Never `git add -f` them.
- **TDD for every step: new features, bug fixes, and fixes for review findings.**
  1. RED: write the test first and run it. Watch it fail for the expected reason, e.g. a missing module or a wrong value, not a typo.
  2. GREEN: write the minimum code that makes it pass, then run it again.
  3. Refactor with the tests still green.

  No production code without a failing test first. If you wrote code before the test, delete it and start from the test.

  Agents load the `superpowers:test-driven-development` skill before implementing. Reports include the RED and GREEN commands with their **pasted** output (a prose summary such as "RED: module missing" is not evidence), and a review treats missing RED evidence as a blocking finding. Tests assert behaviour, including error message text where users will see it. Don't write tests that only exercise mocks.
- **Test layout.** Tests live in `tests/`, mirroring `src/`. Fixtures go in `tests/fixtures/`. Temp dirs come from `fs.mkdtemp(path.join(os.tmpdir(), ...))`, never a fixed path. Test output must be pristine (no stray warnings).
- Commit messages are conventional (`feat(scope): …`, `chore: …`).

## Layout

| Path | What it is |
|---|---|
| `src/util/paths.ts` | `expandHome`, `toPosix`, `samePath` |
| `src/util/fs.ts` | `writeFileAtomic`, `readYamlFile` (yaml Document + LineCounter for located errors) |
| `src/config/schema.ts` | zod schemas + inferred types (`STAGES`, `Stage`, `GroundSpec`, `Mapping`, `NodeDef`, `Binding`, `Rules`, `GraphFragment`, `Profile`, `UserConfig`, `effectiveKind`). All objects are strict, so a new config key must be added here. |
| `src/config/load.ts` | `loadUserConfig`, `loadFragment`, `ConfigError` (`file`, `line`, `path`). Reports **every** YAML or schema issue as `file:line: path: msg`, one per line. Union errors are flattened to the closest branch. |
| `src/config/json-schema.ts` | `writeJsonSchema`. `npm run schema` regenerates the committed `schema/percolator.schema.json`; rerun it whenever `schema.ts` changes. |
| `src/engine/state.ts` | `RunState`, `newState`, `saveState`, `loadState` (`<dir>/state.json`, version 1) |
| `src/index.ts` | public exports |
| `.github/workflows/ci.yml` | test matrix (3 OSes × Node 24) |

## Design decisions to keep

- **The six core stages, in order:** `intake`, `groom`, `plan`, `implement`, `review`, `deliver`. Every one must be bound, or the engine refuses to start. Percolator ships no agent bindings for `groom`, `plan`, `implement` or `review`.
- **Review loop.** The default cap is 3 rounds. When the cap is hit, the run proceeds to `deliver` with an unresolved-findings summary.
- **Extension back-edges** (`on_fail: { back_to, max_rounds }`). When their cap is hit, the run escalates, i.e. pauses for the owner.
- **Locks.** `required: true` locks always win over merge order, and the error names the source that locked the value.
