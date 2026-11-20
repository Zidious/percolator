# Percolator Plan 3 — GitHub Tracker, Groom Gate, `perc run`/`resume`/`status` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `perc run <ticket>` takes a GitHub issue all the way to an open PR. The groomed ticket is posted on the issue and waits for approval. Every node runs in its own Herdr terminal. The driver survives the terminal it was typed in, and `perc resume` / `perc status` work on a run at any point. Every plan-3 carry-over from plans 1 and 2 is folded in, either as a task or as a recorded decision.

**Architecture:** Plan 3 builds on plans 1 and 2 without changing their shape.
- A `Gh` interface wraps the `gh` CLI: an argv-tested `cliGh` for real use and an in-memory `FakeGh` for tests.
- Three `StepHandler`s plug into `HerdrRuntime`'s existing `builtins`/`gate` options: `github.intake`, `github.open_pr` and the gate.
- `src/run/` adds run metadata (`run.json`), `prepareRun` (validate, ticket, worktree, space, initial state), `launchDriver` (perc re-launches itself in an hc terminal with `--outlive-parent`) and `drive` (the engine loop with a real runtime).
- `src/cli.ts` gains `run`, `resume`, `status`, `approve`, `reject`, `clean` and the internal `drive`.
- Side effects stay engine-owned. Agents never post, push or open PRs.

**Tech Stack:** Node ≥ 24 (native TS), TypeScript 5, zod 4, `yaml` 2, `node:test`, pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-percolator-design.md`. The relevant sections are §5.1 (side effects are engine-owned), §5.5 (humans: groom gate, escalation), §5.6 (fragments, locks, rules), §5.7 (runtime, process model) and §5.8 (run state). Read it together with `AGENTS.md` and plans 1 and 2 in `docs/superpowers/plans/`.

## Execution status (resume here)

Executed with superpowers:subagent-driven-development: one implementer and one spec+quality review per task, with fix rounds until the review is clean. The per-run ledger lives in `.superpowers/` (gitignored), so this section is the portable record.

| Task | State | Commits |
|---|---|---|
| 1–21 | done, reviewed | `17f1851..f664395` |
| 22 | done, reviewed (smoke flags only; the real-tool runs are owner actions) | `c3b5199..da04289` |
| Final whole-branch review fix wave (I1–I6, M1–M3, M5) | applied | `da04289..` (the `fix(tracker)`/`fix(run)`/`fix(cli)` commits after `da04289`, plus this `docs(plan)` commit) |

**Owner actions pending (resume here):**
1. Run the four smokes from Task 22 Step 2, then do Task 22 Step 3 from the results.
   - `hc.smoke.ts --space <id>`: **passed 2026-11-20**.
     - The script step passed with outputs `note`.
     - `transcript.txt` was 0 bytes, as expected: the script prints nothing.
     - The argv launch gave `firstMessageSent=undefined`, the same as the plan 2 result.
     - The labelled terminal `perc-smoke-…-sp` was listed by `herdr-app ls` in the space.
     - This closes the carry-over "the smoke `--space` branch has never run".
   - `hc.smoke.ts --boot`: **run 2026-11-20** (cancelled after about 28 s).
     - **The plain idle program reported `status=null` at turn 0 throughout.** A plain program never reports `idle` at turn 0, so the boot grace is not needed for programs. It is kept for agents.
     - **`claude` in a fresh folder sat at turn 0 with a status object** `{app:"claude-code", kind:"permission", msg:"trust this folder", state:"blocked"}` (seen with `hc get`). Two consequences:
       1. **Bug, fixed in `fix(hc)`:** `hc get` (and possibly `wait`) reports `status` as an object, while `hc ls` reports a string. `cliHc` had passed the object through, so the runtime's status checks never matched against the real hc. It now maps the object to its `state`.
       2. **Plan-4 item:** every agent step runs in a fresh worktree, so claude will stop at the folder-trust prompt before its first turn. Attention now reports it as `blocked`, but the owner must answer it in each terminal. Pre-trusting the worktree, or surfacing `msg` in the attention line, is plan-4 work.
     - The cancel (Ctrl-C) skipped the smoke's `finally`, leaving its two terminals live. They were removed by hand. The smoke should also clean up on SIGINT (plan 4).
   - `hc.smoke.ts --codex`: pending.
   - `gh.smoke.ts --issue <a real issue>`: **passed 2026-11-20** on `Zidious/percolator#1`.
     - The URL form parsed to `github.com/zidious/percolator` #1, lower-cased as ruled.
     - `number`, `title`, `body`, `url`, `state` (`OPEN`) and `author` (a login string) all mapped.
     - A re-run with two comments showed each comment's `author` (login string), `body`, `createdAt` (ISO UTC, second precision, e.g. `2026-11-20T22:44:24Z`) and `url` (`…/issues/1#issuecomment-<id>`). The comments came in time order, which is the shape the gate and intake consume.
     - Still unverified: pagination on long issues (100+ comments).
2. Push `main` and watch the 3-OS CI matrix.

**Rulings that bind later tasks:**
- **Node:** development ran on Node 26.12.1 (winget has no Node 24) with pnpm 12.18.0. engines `>=24` holds, and the CI matrix on Node 24 is the check for anything that only works on 26.
- **Ownership (Task 11):** the runtime's ownership check also covers *finished* terminals under a step's name, because only terminals labelled with the run's `percolator.run` may be killed or removed. `sweepTerminals` re-checks `percolator.run` itself, fetching with `get` when `ls` gives no labels, and never trusts hc's `--label` filter alone.
- **Granted round (Task 12):** `grantRound(state)` lowers `rounds[pausedCap]`, deletes `pausedCap` and sets `state.grantedRound`. On start, `runGraph` jumps back to the loop start (`cursor = edge.toStepIndex`) without re-running the cap step, and voids an overtaken `pendingJump`. Task 19's "resume at a cap grants one round" relies on this.
- **Depth sort (Task 7):** dir-mapping depth counts segments of `path.posix.normalize(toPosix(dir))`, with `.` as depth 0. `runPath` is built with `path.resolve`.
- **Ticket refs (Task 13):** `parseTicket` lower-cases `repo` in every form, matching `normalizeRemote`. For Task 18: "`#123` with no GitHub origin" means there is no `origin` remote, so pass `defaultRepo: undefined` then. Any host, GHE included, counts as GitHub.
- **Run identity (for Tasks 18/19):** restore `keepTerminals` from `run.json` on resume. A mismatch would adopt a kept terminal from an earlier round. Task 11 sets no `percolator.role` label yet; Task 18's driver adds `percolator.role: driver`.
- **driverName (Task 17):** uses `terminalName` as-is, whatever it does to `@driver`.
- **Task 22:** the executor adds only the smoke flags. The real-tool runs are owner actions.
- **Tests:** plan-2 runtime fixtures may gain `labels: { 'percolator.run': <runId> }`, as fixture setup only.

**Final-wave rulings (binding from here on):**
- **I1 ticket refs:** owner and repo match `^[A-Za-z0-9_.-]+$`, are not `.`/`..` and do not start with `-`; the host matches `^[A-Za-z0-9.-]+(:\d+)?$`; the number is ≥ 1; the default repo is checked the same way. `prepareRun` also refuses a worktree outside its root (`worktreeIn`).
- **I2 gate comments:** one comment per round, not per attempt: round = pass/fail records of the gate step in `state.history` + 1; marker `<!-- percolator:gate run=<id> step=<step> round=<n> -->`; the marker search only trusts comments by `gh.user()` (case-insensitive); a failed lookup after posting falls back to the pre-post `now`.
- **I3 driver liveness:** `drive` holds `<runDir>/driver.json` (`{ pid, host, terminal, startedAt }`, created with `wx`, a dead pid on this host replaced, another host counts as live, removed in `finally`); `checkResumable` refuses another live holder; `perc status` reports `driver pid <pid>`.
- **I4 worktree_root:** a relative root resolves against the config file's dir.
- **I5 origin check:** an explicit `owner/repo#n` must match the clone's origin owner/repo (host and case ignored) before anything is created.
- **I6 mappings:** `state.mappingsFingerprint` (+ `mappingKeys`) is recorded at `prepareRun` and compared on resume; absent in older states, so not checked there; tracker and runtime blocks are not covered.
- **M2 clean:** `perc clean` needs `--force` unless the run completed or failed.

**Minor findings deferred to the final whole-branch review:**
- T1: `~user` throws a plain Error with no file:line from `selectProfile` and from `path:` grounds; no test that `validate` passes `realCwd`.
- T2: `sweepLeftovers` reports a path even when its `rm` failed; the swap-path restore rename swallows its error; the swap path ignores `renameIntoPlace`'s result; sweep option tests are thin.
- T3: the `gitEnv` PATH assertion is tautological on Windows; no test that `runGit` applies `gitEnv`.
- T4: a node with no hook position prints "attached unattached"; no tests for `before/after all` or for both set.
- T5: deep equality via `sortKeys` + `JSON.stringify` (vs `isDeepStrictEqual`); dedupe/merge keys use the raw path text (`./p.md` ≠ `p.md`); a `loadFragment` failure drops problems already collected; the profile root is detected with `startsWith('profile:')`.
- T6: a non-ENOENT stat error surfaces as a raw ErrnoException; the `lstatRepoLayer`/`loadRepoLayer` test hooks are public API.
- T7: runs materialized before the fix don't self-heal.
- T8: `perc validate` output for git grounds is untested (`main()` has no git injection).
- T9: the deliver check hand-rolls the kind instead of using `effectiveKind`; a cast hides the `STAGE_BRIEFS` narrowing; `BuiltinName` is unused.
- T10: no dedicated `FakeHc.list` test; label keys starting with `-` are not rejected.
- T11: a finished prior attempt (after a timeout escalation) is not collected; a script killed with perc when `outliveParent` is false reports fail.
- T12: no test that the re-run implement sees the capped findings; no test of a grant with `unresolvedFindings` set.
- T13: `/pull/12/files` gets the generic error. (`#0` and a `-`-leading repo are now refused, by I1.)

## Global Constraints

- Node ≥ 24; pnpm only (`pnpm install --frozen-lockfile`); runtime deps `zod`, `yaml` only. No new deps.
- Native TS: relative imports end in `.ts`; erasable syntax only; `import type` for types.
- Windows, Linux, macOS first-class. Use `node:path`, `expandHome`, `samePath`/`toPosix`. Executables are spawned with `execFile`, which cannot run `.cmd` shims on Windows. `gh`, `git`, `hc` and `herdr-app` are real `.exe`s; perc launches itself as `[process.execPath, <cli entry>, ...]`.
- No shell spawning: argv arrays only. Put `--` before config- or user-supplied positionals, and reject values starting with `-`.
- Atomic dirs: build in a tmp sibling, then rename into place. Crash-critical files go through `writeFileAtomic`. That covers `state.json`, `run.json`, `issue.json`, `gate.json`, `decision.json` and `waiting.json`.
- Strict TDD with pasted RED and GREEN output. Use `node:test` + `node:assert/strict`, and assert user-facing message text. Temp dirs come from `fs.mkdtemp(path.join(os.tmpdir(), ...))`. Clean up with `fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })`.
- Never run the real `gh`, `hc` or `herdr-app` in `pnpm test`. Use `FakeGh`, `FakeHc`, `ExecRecorder` and a fake `HerdrApp`. Real `git` on temp repos is fine, as plan 2's worktree tests already do.
- Child processes never prompt. git gets `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. gh gets `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1` and `NO_COLOR=1`.
- gh facts (gh 2.58 on the owner's machine; the real calls are re-checked in Task 22's smoke):
  - Repos are passed as `--repo HOST/OWNER/REPO`, which is the `normalizeRemote` form (`github.com/o/r`).
  - `issue view --json number,title,body,url,state,author,comments`. Each comment carries `author.login`, `body`, `createdAt` and `url`.
  - `issue comment --body-file F` and `pr create --body-file F` print the new URL on stdout.
  - `pr list --head B --state open --json number,url`, `pr edit N --body-file F`, `api user --jq .login`.
- hc facts in addition to plan 2's:
  - `hc ls --json [--all] [--label k=v]...` returns `{ terminals: [{ address, name?, state, ... }] }`, and the label filter is applied server-side.
  - `hc get --json` includes `labels`.
  - Inside an hc terminal, `HC_TERMINAL_ID` holds that terminal's address (e.g. `t18`).
  - hc terminals do not get perc's environment, so everything goes through argv or files.
- Never `hc send --force`. Never wrap `herdr-app space.close`, which ends the space's terminals; the owner closes spaces in the app. Only kill or remove terminals labelled with the run's `percolator.run`.
- Paths: run dir `~/.percolator/runs/<run-id>/` (not configurable, so `resume`/`status` find runs without knowing the profile). Default worktree `~/.percolator/worktrees/<repo>/<run-id>`. Branch `percolator/<run-id>`.
- Commit straight to `main` (no remote yet). Conventional commits.

## Review Focus

1. **The driver dies while the run is `running`.** This happens when the terminal is closed, perc is killed or the machine reboots. `perc status` must say the driver is not running and print the resume command. `perc resume` must relaunch the driver, adopt live node terminals, and never re-post the gate comment or open a second PR. Tested in Tasks 19 and 20.
2. **Approvals that must not count.** A `/percolator approve` from someone outside `approvers` must not count. Neither may a comment posted before this round's gate comment (an earlier round's), nor one that only quotes the command mid-text. The run keeps waiting. Tested in Task 15.
3. **The config or grounds changed between start and resume.** Examples are an edited profile, `perc validate --update` moving a pin, or a changed repo layer. Resume refuses with a message that names what changed. It never re-maps the cursor onto a different graph. Tested in Task 19.
4. **Ticket references in real-world forms.** `#123` must work in a clone with an SSH remote or a GHE host. Other forms are `123`, `owner/repo#123` and issue URLs with a trailing slash. A `/pull/12` URL, `#123` with no GitHub origin and a closed issue must each be refused with a clear message. Tested in Tasks 13 and 14.
5. **A crash between a side effect and the save.** Cases: the gate comment was posted but `gate.json` was not written; the PR was created but the engine never saved `pr_url`; the push already happened. A rerun must leave exactly one comment and one PR, and the push must be harmless. Tested in Tasks 15 and 16.

## Carry-over ledger

Each carry-over maps to the task or decision that covers it.

| Carry-over | Where |
|---|---|
| Adopt a live prior attempt whose `done.json` is ok when `keepTerminals` is false | Task 11 |
| Sort `dir` mappings by depth, parents first | Task 7 |
| Terminal ownership check on re-attach (`percolator.run` label) | Tasks 10, 11 |
| Sweep leftover terminals by label at run end | Tasks 10, 11, 19 |
| Ignore an idle report at turn 0 | Task 11 (boot grace). Task 22 verifies it against the real hc |
| Reject agent bindings for deliver / fix the brief | Task 9 (rejected; deliver brief removed) |
| A finished script is re-run on resume instead of using its exit code | Task 11 |
| hc launching `.cmd` shims (codex) on Windows; codex `--add-dir` | Task 22 (owner smoke; adapter comment updated from the result) |
| The smoke `--space` branch has never run | Task 22 |
| Three-OS CI has never run | Task 21 (CI build and schema check). **Owner action:** add a GitHub remote and push; the executor cannot |
| Profile `runtime:` block (worktree root, `keep_terminals`, base, space) | Task 17. Decision: the run root is fixed, see Global Constraints |
| Worktree removal | Tasks 17 (`removeWorktree`), 20 (`perc clean`) |
| Gate handler and builtins via `HerdrRuntime` options | Tasks 14–16, 19 |
| `space.close` ends terminals | Decision: never wrapped and never called; `perc clean` leaves spaces alone |
| `perc resume` grants a round by lowering `state.rounds[edgeId]`; refused on a fingerprint mismatch | Tasks 12, 19 |
| `required_nodes` must check hook position | Task 4 |
| Mapping `required: true` locks are not enforced | Task 5 |
| A lost mirror race adopts the winner without re-checking its url | Task 2 |
| Collect crash-leftover `*.tmp-*`/`*.old-*` dirs | Task 2 |
| Trust model for the repo layer; `GIT_TERMINAL_PROMPT` | Tasks 6, 3 |
| Idempotent `deliver` | Task 16 |
| `groundVersions` with the ref, as PR evidence | Task 8, used in Task 16 |
| Fragments that reference other grounds (§5.6) | Task 5. Decision: fragments may `use` only grounds declared in the user config, so every pin stays in the one `percolator.lock` |
| Profile path matching: realpath, macOS case folding, `~user` | Task 1. Decision: `~user` is refused with a clear error |
| Package `files`/`exports`; CI `pnpm build`; schema-sync check | Task 21 |

---

## File Structure

```
src/
  util/paths.ts            # (modify) expandHome rejects ~user; foldCase(platform)
  util/fs.ts               # (modify) sweepLeftovers
  util/exec.ts             # (modify) Exec opts.env
  config/profile.ts        # (modify) realpath + case-fold matching
  config/schema.ts         # (modify) fragment use, required_nodes positions, trust_repo_config, runtime, tracker.approvers
  grounds/git.ts           # (modify) gitEnv
  grounds/resolve.ts       # (modify) race url re-check, sweep cache
  grounds/layers.ts        # collectLayers (depth-first fragments) + mergeMappings (mapping locks)
  graph/rules.ts           # (modify) required_nodes position
  graph/build.ts           # (modify) deliver rejects agent nodes
  engine/engine.ts         # (modify) pausedCap, currentStep, export graphFingerprint
  engine/state.ts          # (modify) pausedCap, currentStep, grantRound
  herdr/hc.ts              # (modify) Terminal.labels, list()
  runtime/herdr-runtime.ts # (modify) ownership, adoption, script exit codes, boot grace, sweepTerminals
  runtime/task.ts          # (modify) STAGE_BRIEFS without deliver; groom brief mentions gate feedback
  workspace/run-dir.ts     # (modify) depth-sorted dir materialization
  workspace/worktree.ts    # (modify) removeWorktree, detectBase
  adapters/check.ts        # (modify) unknown builtin names
  tracker/ticket.ts        # parseTicket, formatTicket
  tracker/gh.ts            # Gh, cliGh, GhError
  tracker/intake.ts        # githubIntake, IssueMeta, readIssueMeta
  tracker/gate.ts          # githubGate, writeDecision, readWaiting
  tracker/pr.ts            # prBody, githubOpenPr
  tracker/index.ts         # BUILTIN_NAMES
  run/meta.ts              # RunMeta, read/writeRunMeta, newRunId, driverName, listRuns
  run/prepare.ts           # prepareRun, launchDriver
  run/drive.ts             # drive
  validate.ts              # (modify) collectLayers, trust, groundVersions with ref, realCwd
  cli.ts                   # (modify) run, resume, status, approve, reject, clean, drive
tests/ mirrors src/; tests/helpers/fake-gh.ts, tests/helpers/fake-app.ts; tests/helpers/git-repo.ts
```

---

## Phase A — config and grounds hardening

### Task 1: Profile matching through realpath and case folding; `~user` refused

**Files:**
- Modify: `src/util/paths.ts`, `src/config/profile.ts`, `src/validate.ts`
- Test: `tests/util/paths.test.ts`, `tests/config/profile.test.ts`

**Interfaces:**
- Produces:
  - `expandHome(p, home?)` throws `Error` with `"~bob/x": ~user paths are not supported; use ~/ or an absolute path` for any `p` matching `^~[^/\\]`.
  - `foldCase(s: string, platform: NodeJS.Platform = process.platform): string` lower-cases on `win32` and `darwin`. It replaces the private `fold` in `profile.ts`.
  - `selectProfile` ctx gains `realCwd?: string` and `platform?: NodeJS.Platform`.
    - A `match.path` pattern is tried as written, and also with its static prefix realpathed. The static prefix is the leading segments with none of `*?[{`; it is realpathed with `fs.realpathSync.native` only when it exists.
    - The subject is `cwd` and, when given, `realCwd`. Any subject/pattern pair that matches selects the profile.
  - `validate` passes `realCwd: await fs.realpath(opts.cwd).catch(() => opts.cwd)`.

- [ ] **Step 1: Write the failing tests.**
  - `expandHome refuses ~user` asserts the exact message above. `~` and `~/x` still expand.
  - `path match follows a symlinked cwd`. In a tmp dir create `real/` and the symlink `link → real`; skip on win32 when symlink creation throws EPERM, the same pattern as plan 2. The pattern is `<tmp>/real/**`, `cwd` is `<tmp>/link/sub` and `realCwd` is `<tmp>/real/sub`. The profile is selected.
  - `path match follows a symlinked pattern base`. The pattern is `<tmp>/link/**` and the cwd is `<tmp>/real`. The profile is selected.
  - `path match is case-insensitive on darwin`. The pattern is `/Users/Me/Dev/**`, cwd `/users/me/dev/x`, `platform: 'darwin'`: selected. With `platform: 'linux'` it is not selected and throws `no profile matches this repository`.
- [ ] **Step 2:** Run `node --test tests/util/paths.test.ts tests/config/profile.test.ts`. Expected: FAIL. `~bob/x` resolves silently and the symlink and darwin cases throw `no profile matches`.
- [ ] **Step 3:** Implement as specified above.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(config): profile path matching through realpath and case folding; refuse ~user`.

---

### Task 2: Grounds cache hygiene — race url re-check and leftover sweep

**Files:**
- Modify: `src/util/fs.ts`, `src/grounds/resolve.ts`
- Test: `tests/util/fs.test.ts`, `tests/grounds/resolve.test.ts`

**Interfaces:**
- Produces:
  - `sweepLeftovers(dir: string, o?: { olderThanMs?: number; now?: number; recursive?: boolean }): Promise<string[]>`. It removes entries whose name matches `LEFTOVER = /\.(?:tmp|old)-(?:\d+-)?[0-9a-f]{8}$|\.\d+\.[0-9a-f]{8}\.tmp$/` and whose `mtime` is older than `olderThanMs` (default `3_600_000`). It returns the removed absolute paths, sorted.
    - A missing `dir` returns `[]`.
    - With `recursive`, it descends into directories that do not match. It never follows symlinks (lstat).
    - The age floor protects a concurrent run's tmp work.
  - `renameIntoPlace` returns `Promise<boolean>`: `true` when our rename won.
  - `openMirror` re-checks a lost race. When it loses and `git.remoteUrl(mirror)` is not `sameUrl(url)`, it throws `ground mirror <mirror> was replaced concurrently by a mirror of <other url>; run perc again`.
  - `resolveGrounds` calls `sweepLeftovers(cacheDir)` first. It is non-recursive and its result is ignored.

- [ ] **Step 1: Write the failing tests.**
  - `sweepLeftovers removes old tmp/old siblings only`. Create `a.tmp-1234-deadbeef/`, `b.old-cafebabe/`, `state.json.99.0badf00d.tmp`, `keep/` and a fresh `c.tmp-0000beef/`, then set mtimes with `fs.utimes` (two hours back, except the fresh one). It returns the first three; `keep` and the fresh one remain.
  - `sweepLeftovers recursive finds nested leftovers`: `steps/x/1/plugins/g.tmp-abcdef12` is removed.
  - `a lost mirror race to a different url is an error`. FakeGit's `onClone` creates the target mirror with a different origin url during our clone. The call rejects with the exact message above.
  - `resolveGrounds sweeps old leftovers in the cache` asserts that an aged `x.tmp-1-deadbeef` in `cacheDir` is gone after the call.
- [ ] **Step 2:** Run `node --test tests/util/fs.test.ts tests/grounds/resolve.test.ts`. Expected: FAIL (`sweepLeftovers` is not exported, and the race resolves silently).
- [ ] **Step 3:** Implement as specified above.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Update the `AGENTS.md` rows for `util/fs.ts` and `grounds/resolve.ts`. Commit `fix(grounds): re-check the url after a lost mirror race; sweep crash leftovers`.

---

### Task 3: Child processes never prompt

**Files:**
- Modify: `src/util/exec.ts`, `src/grounds/git.ts`
- Test: `tests/util/exec.test.ts`, `tests/grounds/git.test.ts`

**Interfaces:**
- Produces:
  - `Exec = (file, args, opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>`. `nodeExec` passes `{ ...process.env, ...opts.env }` when `env` is given.
  - `gitEnv(): NodeJS.ProcessEnv` returns `{ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }`. `runGit` passes it to `execFile`.

- [ ] **Step 1: Write the failing tests.**
  - `nodeExec passes extra env and keeps PATH` runs `process.execPath` with `['-e', 'process.stdout.write((process.env.PERC_T ?? "") + "|" + (process.env.PATH ? "path" : ""))']` and `env: { PERC_T: 'x' }`. stdout is `x|path`.
  - `gitEnv disables prompts` asserts both keys and that `PATH` equals `process.env.PATH`.
- [ ] **Step 2:** Run `node --test tests/util/exec.test.ts tests/grounds/git.test.ts`. Expected: FAIL (stdout `|path`; `gitEnv` is not exported).
- [ ] **Step 3:** Implement as specified above.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix: child processes never prompt (git env, exec env option)`.

---

### Task 4: `required_nodes` checks hook position

**Files:**
- Modify: `src/config/schema.ts`, `src/graph/rules.ts`, `schema/percolator.schema.json` (regenerated)
- Test: `tests/graph/rules.test.ts`, `tests/config/load.test.ts`

**Interfaces:**
- Produces:
  - `RulesSchema.required_nodes: (string | { name: string; before?: StageOrAll; after?: StageOrAll })[]`. In the object form exactly one of `before`/`after` is set; otherwise the message is `exactly one of "before" or "after" is required`.
  - The violation for a wrong position has `rule: 'required_nodes'` and `target: 'nodes.<name>'`, with this message:
    `node "<name>" is required <after plan> by required_nodes (from <source>), but it is attached <before implement>`
    - A position prints as `before <stage>` / `after <stage>`; the value `all` prints as `before all` / `after all`.
  - The string form and the missing-node message are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `required_nodes with a position accepts the right hook`: `{ name: 'threat-model', after: 'plan' }` with the node `after: plan` gives 0 violations.
  - `required_nodes with a position rejects a moved hook`: the same rule with the node `before: implement` gives exactly the message above.
  - In load.test, `required_nodes object needs before or after` uses `{ name: x }` and the error text contains the schema message.
- [ ] **Step 2:** Run `node --test tests/graph/rules.test.ts tests/config/load.test.ts`. Expected: FAIL (the schema rejects the object form).
- [ ] **Step 3:** Implement. Run `pnpm schema`.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(rules): required_nodes may pin a hook position`.

---

### Task 5: Fragments `use` other grounds; mapping locks

**Files:**
- Create: `src/grounds/layers.ts`
- Modify: `src/config/schema.ts`, `src/grounds/mappings.ts`, `src/validate.ts`, `schema/percolator.schema.json`
- Test: `tests/grounds/layers.test.ts`, `tests/cli/validate.test.ts`

**Interfaces:**
- Consumes: `resolveInGround`, `throwProblems`, `loadFragment`, `LockViolation` (from `graph/merge.ts`).
- Produces:
  - `use: Mapping[]` moves into `graphFragmentShape`, so fragments and the repo layer accept it. The profile keeps it through the spread. `mergeLayers` ignores `use`.
  - `ResolvedMapping` gains `source: string`, the layer source that declared it.
  - `collectLayers(o: { roots: { source: string; use: Mapping[]; fragment: GraphFragment }[]; grounds: Record<string, ResolvedGround>; configFile: string }): Promise<{ layers: Layer[]; mappings: ResolvedMapping[] }>`
    - Roots are processed in order (profile, then the repo layer when present). Each root's `use` is walked depth-first.
    - An `as: graph` mapping loads its fragment, recurses into the fragment's `use`, then pushes the fragment's layer (source `ground:<g>/<file>@<commit12|local>`). Dependencies come before the fragment that uses them; a root's own layer comes after all of its fragments.
    - Graph mappings are de-duplicated by `<ground>:<file>`, and the first visit wins. This also stops cycles.
    - Every `use` may name only grounds in `grounds` (the user config). For an unknown ground the problem is `ground "<g>": unknown ground (mapping <path>, used by <source>); declare it under grounds: in <configFile>`. All problems are collected into one `ConfigError`. The profile-level message stays as it is today.
  - `mergeMappings(perLayer: { source: string; mappings: ResolvedMapping[] }[]): ResolvedMapping[]`, in layer order.
    - The key is `<as>:<ground>:<file|dir>`, and a duplicate keeps the first position.
    - If the earlier mapping is `required: true` and the later one is not deep-equal (ignoring `source`), it throws `LockViolation('mapping <ground>:<path> (<as>)', earlier.source, later.source)`.
    - Otherwise the later mapping replaces the earlier in place.
  - `validate` builds its layers and mappings through `collectLayers` + `mergeMappings`.

- [ ] **Step 1: Write the failing tests** in `tests/grounds/layers.test.ts`. Use path grounds in tmp dirs.
  - `fragment use pulls a second fragment, dependencies first`. Ground `company/percolator.yaml` uses `team/percolator.yaml` (`as: graph`). Layer sources come out in the order company→team dependency first: `[ground:team/percolator.yaml@local, ground:company/percolator.yaml@local, profile:p]`.
  - `fragment cycle is visited once`: a uses b and b uses a. Each layer appears once.
  - `fragment use of an undeclared ground is a ConfigError` with the exact message.
  - `a required mapping cannot be weakened by a later layer`. The company fragment has `{ from: team, file: p.md, as: policy, required: true, applies_to: ['*'] }` and the profile restates it with `applies_to: [review]`. This throws `mapping team:p.md (policy) is locked by ground:company/percolator.yaml@local; profile:p cannot change it`.
  - `an unlocked mapping is overridden in place by a later layer` asserts the final `applies_to` and the position.
  - In validate.test, `validate walks fragment use`: the result's mappings include the fragment-declared policy with `source` set.
- [ ] **Step 2:** Run `node --test tests/grounds/layers.test.ts tests/cli/validate.test.ts`. Expected: FAIL (the module is missing; the schema rejects `use` in a fragment).
- [ ] **Step 3:** Implement. Remove `fragmentLayers` once validate no longer uses it, and move its tests to `layers.test.ts`. Run `pnpm schema`.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Update `AGENTS.md`: add the `grounds/layers.ts` row and update the `mappings.ts` row. Commit `feat(grounds): fragments use other declared grounds; enforce mapping locks`.

---

### Task 6: Repo-layer trust

The repo layer can add nodes that run commands. A cloned repo must not do that unless the owner allows it.

**Files:**
- Modify: `src/config/schema.ts`, `src/validate.ts`, `schema/percolator.schema.json`
- Test: `tests/cli/validate.test.ts`

**Interfaces:**
- Produces:
  - `ProfileSchema.trust_repo_config?: boolean` (default false).
  - When `<repo>/.percolator/percolator.yaml` exists and the profile does not trust it, `validate` throws a `ConfigError` against the config file:
    `<repoFile> exists, but profile "<name>" does not trust repo config (it can add nodes that run commands); set trust_repo_config: true in that profile to use it`
    - The file's existence is checked before loading. An absent file is still fine, and any other read error still propagates.

- [ ] **Step 1: Write the failing tests.**
  - `an untrusted repo layer is refused` asserts the exact message.
  - `a trusted repo layer is merged` adds `trust_repo_config: true` to the existing repo-layer test.
- [ ] **Step 2:** Run `node --test tests/cli/validate.test.ts`. Expected: FAIL (the untrusted layer merges).
- [ ] **Step 3:** Implement. Update existing repo-layer fixtures and tests to set `trust_repo_config: true`. Run `pnpm schema`.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(config): repo config is used only when the profile trusts it`.

---

### Task 7: Dir mappings materialized parents first

**Files:**
- Modify: `src/workspace/run-dir.ts`
- Test: `tests/workspace/run-dir.test.ts`

**Interfaces:**
- Produces: in `materializeGrounds`, the copy order is `dir` mappings sorted by path depth (`toPosix(dir)` segment count, ascending, stable), then `file` mappings. The result order is unchanged.

- [ ] **Step 1: Write the failing test.** `a sub-dir mapping listed before its parent keeps the parent's other files` maps `policies/sub/` and then `policies/`. After materializing, `grounds/g/policies/top.md` and `grounds/g/policies/sub/a.md` both exist.
- [ ] **Step 2:** Run `node --test tests/workspace/run-dir.test.ts`. Expected: FAIL (`top.md` missing).
- [ ] **Step 3:** Implement the sort.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(workspace): materialize parent dir mappings before sub-dirs`.

---

### Task 8: Ground versions carry the ref

**Files:**
- Modify: `src/validate.ts`, `src/cli.ts`
- Test: `tests/cli/validate.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Produces:
  - `groundVersion(g: ResolvedGround): string`, exported from `validate.ts`. A git ground gives `<ref> (<commit12>)`, e.g. `v2.3.1 (abc123def456)`; a path ground gives `local`.
  - `ValidateResult.groundVersions` uses it.
  - `perc validate` prints `ground <name> <version>`, replacing `ground <name>@<version>`.

- [ ] **Step 1: Write the failing tests.** For a git ground at ref `main` pinned to commit `c…`, `groundVersions.x === 'main (c12…)'`. The CLI output contains `ground x main (`.
- [ ] **Step 2:** Run `node --test tests/cli/validate.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update the existing assertions.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: record ground versions with their ref`.

---

### Task 9: Deliver is never an agent; builtin names are checked

**Files:**
- Create: `src/tracker/index.ts`
- Modify: `src/graph/build.ts`, `src/runtime/task.ts`, `src/adapters/check.ts`, `tests/fixtures/e2e/config.yaml`
- Test: `tests/graph/build.test.ts`, `tests/runtime/task.test.ts`, `tests/adapters/check.test.ts`

**Interfaces:**
- Produces:
  - `buildGraph` throws `GraphError('deliver cannot be an agent node: Percolator opens the PR itself (use { builtin: github.open_pr })', 'bindings.deliver')` when any deliver slot node is an agent. Script and builtin nodes stay allowed.
  - `STAGE_BRIEFS: Readonly<Record<Exclude<Stage, 'deliver'>, string>>`. The groom brief gains this sentence: `If the inputs include findings from an approval gate, revise the groomed ticket to address them.`
  - `BUILTIN_NAMES = ['github.intake', 'github.open_pr'] as const`, in `src/tracker/index.ts`.
  - `checkAgents` also reports `<target>: unknown builtin "<name>" (known: github.intake, github.open_pr)` for every builtin step, inside the same single `ConfigError`.

- [ ] **Step 1: Write the failing tests.** Cover the deliver agent `GraphError` message, the groom brief sentence in `buildTask` output for the groom slot, and the unknown builtin message.
- [ ] **Step 2:** Run `node --test tests/graph/build.test.ts tests/runtime/task.test.ts tests/adapters/check.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Change the e2e fixture's `builtin: read-ticket` to `github.intake`, and update any test that binds deliver to an agent.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(graph): deliver cannot be an agent; unknown builtins fail validation`.

---

## Phase B — runtime and engine

### Task 10: hc labels and `list`

**Files:**
- Modify: `src/herdr/hc.ts`, `tests/helpers/fake-hc.ts`
- Test: `tests/herdr/hc.test.ts`

**Interfaces:**
- Produces:
  - `Terminal.labels: Record<string, string>`. It is `{}` when hc omits it.
  - `Hc.list(o?: { labels?: Record<string, string>; all?: boolean }): Promise<Terminal[]>` runs `hc ls --json [--all] [--label k=v]... ` with labels in insertion order, and parses `terminals[]`.
  - `FakeHc.get` returns `labels`. `FakeHc.list` filters by every given label and by `state === 'live'` unless `all`. It records `['list', o]`.

- [ ] **Step 1: Write the failing tests** with ExecRecorder:
  - `list passes label filters and --all` asserts the exact argv `['ls','--json','--all','--label','percolator.run=r1']` and parses two terminals.
  - `get returns labels`.
- [ ] **Step 2:** Run `node --test tests/herdr/hc.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(hc): terminal labels and list by label`.

---

### Task 11: Runtime — ownership, adoption, script exit codes, boot grace, sweep

**Files:**
- Modify: `src/runtime/herdr-runtime.ts`
- Test: `tests/runtime/herdr-runtime.test.ts`

**Interfaces:**
- Consumes: `Terminal.labels`, `Hc.list` (Task 10).
- Produces:
  - **Ownership.** Before re-attaching to or adopting any live terminal, it must carry `labels['percolator.run'] === runId`. Otherwise the step escalates with `terminal <n> is not part of run <runId> (percolator.run=<value or none>); remove it with hc rm or rename it, then resume`. It never launches under that name and never kills it.
  - **Adoption with keepTerminals false.** The prior-attempt loop also adopts a live attempt whose `done.json` is ok. `#await` then collects it and kills it, so no second agent launches. When `keepTerminals` is true, the current behaviour stays: skip it, because a kept terminal is expected to remain.
  - **Script exit code on resume.** In `#runTerminal`, a *finished* existing terminal for a **script** step is collected from its exit code (through `#await`) and is not relaunched. Agents keep the current relaunch-when-no-`done.json` behaviour.
  - **Boot grace.** In `#await`, a status of `idle`/`done` at `turn === 0` is not reported as attention until `bootGraceS` (a new option, default 120) has passed since `#await` started. Until then it just sleeps `pollMs`.
  - `sweepTerminals(hc: Hc, runId: string, o?: { exceptRole?: string }): Promise<string[]>`, exported.
    - It lists `{ labels: { 'percolator.run': runId }, all: true }` and skips terminals whose `labels['percolator.role'] === o.exceptRole`. hc does not return labels from `ls`, so a terminal it cannot classify is fetched with `get`.
    - It kills and removes the rest by `name ?? address` and returns their names.

- [ ] **Step 1: Write the failing tests** (FakeHc, injectable `now`/`sleep`):
  - `a live terminal of another run is never adopted`. Pre-`add` the step's terminal name with `labels: { 'percolator.run': 'other' }`. The outcome is escalate with the exact reason, and there is no `run`, `kill` or `rm` call.
  - `keepTerminals false adopts a live attempt whose done.json is ok`. Attempt 1 is live with a valid `done.json` and outputs; execute as attempt 2. There is no `run` call, the outcome is pass with attempt 1's outputs, and attempt 1 is killed and removed.
  - `a finished script terminal is collected from its exit code on resume`. Pre-add a finished terminal, `exitCode: 3`. The outcome is fail with `exit code 3`, and there is no `run` call.
  - `idle at turn 0 within the boot grace is not attention`. The terminal is idle at turn 0 and `now` advances by 10 s per sleep; `done.json` appears on the 3rd sleep. `onAttention` is never called.
  - `idle at turn 0 past the boot grace is attention once`: `bootGraceS: 5`, with idle reported once.
  - `sweepTerminals removes the run's terminals but not the driver` asserts the names returned and the calls.
- [ ] **Step 2:** Run `node --test tests/runtime/herdr-runtime.test.ts`. Expected: FAIL on all six.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS, including every plan-2 runtime test.
- [ ] **Step 5:** Update the `AGENTS.md` `herdr-runtime.ts` row. Commit `fix(runtime): check terminal ownership, adopt finished attempts, keep script exit codes, boot grace, sweep`.

---

### Task 12: Engine — `pausedCap`, `currentStep`, `grantRound`

**Files:**
- Modify: `src/engine/engine.ts`, `src/engine/state.ts`
- Test: `tests/engine/engine.test.ts`, `tests/engine/state.test.ts`

**Interfaces:**
- Produces:
  - `RunState.pausedCap?: string`. `decide` sets it to the edge id when it pauses at an escalating cap, and `runGraph` deletes it together with `pausedReason` when it starts in `running`.
  - `RunState.currentStep?: string` is `steps[cursor]?.id`. The engine sets it before every `save` and deletes it when the cursor is past the end.
  - `grantRound(state: RunState): string | undefined`, exported from `state.ts`. When `pausedCap` is set, it lowers `rounds[pausedCap]` by one (floor 0), deletes `pausedCap` and returns the edge id. Otherwise it returns undefined. It does not change `status`; the caller sets `running`.
  - `graphFingerprint` is exported from `engine.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `a cap pause records pausedCap and currentStep`. Use a qa `on_fail { back_to: implement, max_rounds: 2 }` hook that fails twice. Then `pausedCap === 'qa'` and `currentStep === 'qa'`.
  - `grantRound lets exactly one more round run`. Call `grantRound` and set `status = 'running'`, with qa scripted to fail again. `runGraph` runs implement and qa once more, then pauses again at the cap.
  - `grantRound is a no-op without a cap pause`.
- [ ] **Step 2:** Run `node --test tests/engine/engine.test.ts tests/engine/state.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): record the cap edge and current step; grantRound for resume`.

---

## Phase C — GitHub tracker

### Task 13: Ticket parsing and the `gh` client

**Files:**
- Create: `src/tracker/ticket.ts`, `src/tracker/gh.ts`, `tests/helpers/fake-gh.ts`
- Test: `tests/tracker/ticket.test.ts`, `tests/tracker/gh.test.ts`

**Interfaces:**
- Produces:
  - `type TicketRef = { repo: string; number: number }`, where `repo` is in `host/owner/repo` form.
  - `parseTicket(ref: string, defaultRepo?: string): TicketRef` accepts:
    - `#123` and `123`, which need `defaultRepo`;
    - `owner/repo#123`, with host `github.com`;
    - `host/owner/repo#123`;
    - `https://<host>/<owner>/<repo>/issues/<n>[/]`, optionally with `#…`/`?…`.

    It throws these errors:
    - with no `defaultRepo`: `ticket "#123" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123`
    - for `/pull/<n>`: `"<ref>" is a pull request, not an issue`
    - for anything else: `cannot read ticket "<ref>": use #123, owner/repo#123 or an issue URL`
  - `formatTicket(t: TicketRef): string` gives `<repo>#<n>`. This is the canonical `state.ticket`, and plan 2's `terminalName` already parses `#(\d+)$`.
  - Types:
    ```ts
    type IssueComment = { author: string; body: string; createdAt: string; url: string };
    type Issue = { number: number; title: string; body: string; url: string; state: string; author: string; comments: IssueComment[] };
    ```
  - `interface Gh` has these methods:
    - `issue(repo, n): Promise<Issue>`
    - `comment(repo, n, bodyFile): Promise<string>` (the new comment URL)
    - `user(): Promise<string>`
    - `findPr(repo, head): Promise<{ number: number; url: string } | undefined>`
    - `createPr(repo, o: { base; head; title; bodyFile }): Promise<string>`
    - `editPr(repo, n, bodyFile): Promise<void>`
  - `cliGh(o?: { exec?: Exec; bin?: string }): Gh`.
    - Every call runs with the prompt-free env (Global Constraints). Issue/PR numbers come after `--`. `head`/`base`/`title` values starting with `-` are refused.
    - A non-zero exit throws `GhError` (`gh <sub> failed: <stderr trimmed, first 500 chars>`). The message keeps gh's own text, e.g. its `gh auth login` hint.
  - `FakeGh` (test helper) holds an in-memory map of issues and comments and a PR list. Comments get monotonically increasing `createdAt` from an injectable clock. It records `calls`, and it has a `fail(method, message)` switch that makes that method throw `GhError`.

- [ ] **Step 1: Write the failing tests.**
  - `parseTicket` is table-driven. It covers every accepted form above with `defaultRepo` `github.com/o/r`, plus a GHE URL `https://ghe.acme.com/a/b/issues/7/` → `{ repo: 'ghe.acme.com/a/b', number: 7 }`, and the three error messages.
  - For `cliGh` with ExecRecorder:
    - `issue` argv is `['issue','view','--repo','github.com/o/r','--json','number,title,body,url,state,author,comments','--','5']`, and the result is parsed with `author: 'me'` from `author.login`.
    - `comment` argv ends with `['--body-file', f, '--', '5']` and returns the trimmed stdout URL.
    - `findPr` returns `undefined` for `[]`.
    - `createPr` refuses `head: '-x'` with `gh pr create: head must not start with "-": -x`.
    - A non-zero exit gives `GhError` with message `gh issue view failed: …`.
    - The env contains `GH_PROMPT_DISABLED: '1'`. Assert the recorded `opts.env`; extend `ExecRecorder.calls` to carry `opts`.
- [ ] **Step 2:** Run `node --test tests/tracker/ticket.test.ts tests/tracker/gh.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Add `AGENTS.md` rows for `tracker/ticket.ts`, `tracker/gh.ts` and `tests/helpers/fake-gh.ts`. Commit `feat(tracker): ticket references and gh client`.

---

### Task 14: `github.intake`

**Files:**
- Create: `src/tracker/intake.ts`
- Test: `tests/tracker/intake.test.ts`

**Interfaces:**
- Consumes: `Gh`, `TicketRef`, `StepHandler`/`StepIo` (from `herdr-runtime.ts`), `collectOutputs`.
- Produces:
  - `type IssueMeta = { repo: string; number: number; title: string; url: string }`
  - `readIssueMeta(runDir): Promise<IssueMeta>` reads `<runDir>/issue.json`. It throws `run <runDir> has no issue.json (intake has not run)` when the file is absent.
  - `GATE_MARKER = '<!-- percolator:gate'`, exported for Task 15.
  - `githubIntake(o: { gh: Gh; runDir: string; ticket: TicketRef }): StepHandler`. It writes `issue.json` atomically and `outputs/ticket.md`, then returns pass with the collected outputs. The `ticket.md` layout (exact):
    ```
    # <title>

    <url> (<repo>#<n>, opened by @<author>)

    ## Body

    <body or "_No description._">

    ## Comments

    ### @<login> at <createdAt>

    <body>
    ```
    - Comments containing `GATE_MARKER` are left out. With no comments the section reads `_No comments._`.
    - An issue whose `state` is not `OPEN` gives escalate: `github.intake: <repo>#<n> is <state lowercased>; reopen it or pick another ticket`.
    - A `GhError` gives escalate `github.intake: <message>`. Nothing throws.

- [ ] **Step 1: Write the failing tests** with FakeGh:
  - The exact `ticket.md` for an issue with one human comment and one gate-marker comment.
  - The contents of `issue.json`.
  - The escalate reason for a closed issue.
  - The escalate reason for a gh failure.
- [ ] **Step 2:** Run `node --test tests/tracker/intake.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tracker): github.intake builtin`.

---

### Task 15: The approval gate

Both channels are built: an issue comment (`/percolator approve|reject`) and the local `perc approve`/`perc reject` commands, which write `decision.json`. Reactions are not used in v1 (the builder's pick per §5.5).

**Files:**
- Create: `src/tracker/gate.ts`
- Test: `tests/tracker/gate.test.ts`

**Interfaces:**
- Consumes: `Gh`, `readIssueMeta`, `GATE_MARKER`, `StepHandler`.
- Produces:
  - `type Decision = { decision: 'approve' | 'reject'; feedback?: string; by: string; via: 'comment' | 'local'; url?: string }`
  - `type Waiting = { stepId: string; stepDir: string; since: string; commentUrl: string }`, kept in `<runDir>/waiting.json`.
  - `readWaiting(runDir): Promise<Waiting | undefined>`.
  - `writeDecision(runDir, d: { decision: 'approve' | 'reject'; feedback?: string }): Promise<Waiting>` writes `<waiting.stepDir>/decision.json` with `by: os.userInfo().username` and `via: 'local'`. When nothing is waiting it throws `run is not waiting at a gate`.
  - `githubGate(o: { gh: Gh; runDir: string; runId: string; approvers?: string[]; pollMs?: number; trackerPollMs?: number; sleep?: (ms) => Promise<void>; now?: () => number }): StepHandler`. Defaults: `pollMs` 2000, `trackerPollMs` 30000, `approvers` `[await gh.user()]` fetched once per call.

    The gate's run looks like this:
    1. **Post, once per attempt.**
       - The marker is `<!-- percolator:gate run=<runId> step=<stepId> attempt=<attempt dir name> -->`.
       - If `<stepDir>/gate.json` exists, it is used.
       - Otherwise the issue's comments are searched for the marker; this covers a crash after the post. Only if none is found is a comment posted, with the body below written to `<stepDir>/gate-comment.md`.
       - Then `gate.json` is written as `{ commentUrl, postedAt }`, where `postedAt` is the found or new comment's `createdAt`.
    2. Write `waiting.json`.
    3. **Loop.**
       - If `<stepDir>/decision.json` exists, use it. An invalid one gives escalate `<file> is invalid: <why>`.
       - Every `trackerPollMs`, scan the comments that are `createdAt > postedAt` and written by someone in `approvers`. The first, in time order, whose **first line** matches `^/percolator\s+(approve|reject)\b\s*(.*)$` decides. The feedback is the rest of that line plus any later lines, trimmed.
       - Otherwise sleep `pollMs`.
    4. Delete `waiting.json`.
       - On approve: write `outputs/approval.md` (`Approved by @<by> via <comment <url>|perc approve>.`) and pass.
       - On reject: write `outputs/findings.md` (`Rejected by @<by>: <feedback or "(no feedback given)">`) and fail. The core gate's `on_fail` then sends the run back to groom.

    The comment body (exact):
    ```
    <marker>
    **Percolator** needs approval to continue run `<runId>` (step `<stepId>`).

    ### <key>

    <text of each output .md file of the step just before the gate, in key order>

    Reply `/percolator approve` to continue, or `/percolator reject <what to change>` to send it back.
    Locally: `perc approve <runId>` or `perc reject <runId> "<what to change>"`.
    ```
    - The "step just before" is the last earlier step in `ctx.graph.steps` that has `ctx.previousOutputs`.
    - The output text is capped at 60000 chars, with `… (truncated; full text in <abs path>)` appended.
  - gh errors while polling are retried on the next tracker poll and never end the gate. An error while posting gives escalate `gate <stepId>: <message>`.

- [ ] **Step 1: Write the failing tests** with FakeGh and fake `sleep`/`now`:
  - `posts the groomed ticket once and passes on an approver's comment`. The comment body is exact, one `comment` call is made, the outcome is pass, `approval.md` exists and `waiting.json` is gone.
  - `reject carries the feedback to findings` with a multi-line body. The outcome is fail, and `findings.md` holds the exact text.
  - `ignores non-approvers, earlier comments and quoted commands`. Seed:
    - a `/percolator approve` from `mallory`;
    - one from the owner dated before `postedAt`;
    - `please do not /percolator approve yet` from the owner;
    - then the owner's real approve.

    Only the last one decides; check the `by` and the url in `approval.md`.
  - `a crash after posting reuses the existing comment`. Seed a comment that already carries the marker, with no `gate.json`. There are zero `comment` calls.
  - `a local decision wins without the tracker`. Call `writeDecision` from a second async task after the gate starts waiting. The outcome is pass via `perc approve`.
  - `writeDecision when nothing waits` throws the exact message.
  - `gh failure while polling keeps waiting`: the first poll throws and the second returns an approve.
- [ ] **Step 2:** Run `node --test tests/tracker/gate.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tracker): approval gate via issue comment or perc approve/reject`.

---

### Task 16: PR body and `github.open_pr` (idempotent)

**Files:**
- Create: `src/tracker/pr.ts`
- Test: `tests/tracker/pr.test.ts`

**Interfaces:**
- Consumes: `Gh`, `readIssueMeta`, `runGit`, `RunContext`.
- Produces:
  - `prBody(o: { issue: IssueMeta; runId: string; summary?: string; review: { used: number; max: number; unresolved?: string }; groundVersions: Record<string, string>; findingsPath?: string }): string`. The output (exact):
    ```
    Closes #<n>

    ## Summary

    <summary or "_No summary was written._">

    ## Review

    Self-review passed in round <used> of <max>.
    ```
    - With unresolved findings, the Review line is replaced by `Self-review stopped at the cap of <max> rounds with unresolved findings:` followed by a blank line and the findings text.
    - Then:
      ```

      ## Built under

      - <name> <version>        (one per ground, name order; "- no grounds" when empty)

      <sub>Percolator run `<runId>`</sub>
      ```
    - The body stays under 60000 chars: findings are cut with `… (truncated; full findings in <findingsPath>)`.
  - `githubOpenPr(o: { gh: Gh; runDir: string; worktree: string; branch: string; base: string; push?: (worktree: string, branch: string) => Promise<void> }): StepHandler`. It reads:
    - `issue.json`;
    - the latest `summary` of the last implement slot step, from `ctx.previousOutputs`;
    - `ctx.state.unresolvedFindings` (a run-relative path; read the file);
    - review rounds from the `onCap: 'continue'` back-edge. `used` is the max on unresolved, else `(rounds[edge] ?? 0) + 1`.
    - `ctx.state.groundVersions`.

    Then:
    1. Push. The default is `runGit(['push', '--set-upstream', 'origin', '--', branch], worktree)`; re-pushing is harmless.
    2. Write `<stepDir>/pr-body.md`.
    3. `findPr(repo, branch)`. If a PR is found, `editPr` it; otherwise `createPr` with `base` (the `base` with a leading `origin/` removed), `head: branch` and `title: <issue title>`.
    4. Write `outputs/pr_url.md` (the URL) and pass.

    Any error gives escalate `github.open_pr: <message>`.

- [ ] **Step 1: Write the failing tests.**
  - `prBody` exact output, passed and capped variants, and truncation.
  - `open_pr creates a PR and records pr_url`. Use FakeGh and a recording `push`: one push, one `createPr` with the exact args, and `pr_url.md` holds the URL.
  - `open_pr run twice opens one PR`. The second call finds the PR and makes `editPr`, with no second `createPr`.
  - `open_pr escalates on a push failure` with the reason text.
- [ ] **Step 2:** Run `node --test tests/tracker/pr.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Add `AGENTS.md` rows for `tracker/intake.ts`, `gate.ts` and `pr.ts`. Commit `feat(tracker): github.open_pr with an evidence-carrying, idempotent PR`.

---

## Phase D — `perc run` / `resume` / `status`

### Task 17: Profile `runtime:` block, run metadata, worktree removal and base detection

**Files:**
- Create: `src/run/meta.ts`, `tests/helpers/git-repo.ts`
- Modify: `src/config/schema.ts`, `src/workspace/worktree.ts`, `src/validate.ts`, `schema/percolator.schema.json`
- Test: `tests/run/meta.test.ts`, `tests/workspace/worktree.test.ts`, `tests/config/load.test.ts`, `tests/cli/validate.test.ts`

**Interfaces:**
- Produces:
  - `ValidateResult` gains `runtime: Profile['runtime']` and `tracker: Profile['tracker']`, the selected profile's blocks as written (undefined when absent). `prepareRun`/`drive` read them from here.
  - `ProfileSchema.runtime?: { worktree_root?: string; base?: string; keep_terminals?: boolean; space?: boolean }` (strict).
    - `worktree_root` defaults to `~/.percolator/worktrees`, and the worktree is `<root>/<repo name>/<run-id>`.
    - `keep_terminals` defaults to false and `space` defaults to true. `base` defaults to `detectBase`.
  - `ProfileSchema.tracker` becomes `{ kind: 'github'; approvers?: string[] }`.
  - `RunMeta`:
    ```ts
    { version: 1; runId; ticket /* formatTicket */; repo; issue: number; repoRoot; configFile; profile; worktree; branch; base; space?: string; keepTerminals: boolean; driver: string; createdAt: string }
    ```
  - `writeRunMeta(dir, m)` writes atomically. `readRunMeta(dir)` checks the shape and throws `Run metadata <file> is missing or invalid: <field>`.
  - `newRunId(issue: number, now: Date, rand = randomBytes(2).toString('hex'))` gives `t<issue>-<YYYYMMDD>-<HHMMSS>-<rand>` (UTC).
  - `driverName(runId, ticket)` is `terminalName(runId, ticket, '@driver', 0)`.
  - `listRuns(home): Promise<{ dir: string; meta?: RunMeta; state?: RunState; error?: string }[]>` covers every dir under `~/.percolator/runs`, newest `createdAt` first, with broken runs listed with their `error`.
  - `detectBase(repoRoot): Promise<string>` returns `git rev-parse --abbrev-ref origin/HEAD` (e.g. `origin/main`), else the current branch.
  - `removeWorktree({ repoRoot, dir, force }): Promise<boolean>`.
    - It returns false when `dir` is not a listed worktree.
    - Otherwise it runs `git worktree remove [--force] -- <dir>`. On git's "contains modified or untracked files" it throws `worktree <dir> has uncommitted changes; commit them or use --force`.
  - `tests/helpers/git-repo.ts`: `makeRepo(): Promise<{ root: string; origin: string; cleanup(): Promise<void> }>` creates a repo with one commit on `main` and a bare `origin` with `origin/HEAD` set.

- [ ] **Step 1: Write the failing tests:**
  - the runtime schema round-trip, plus an unknown key in `runtime` rejected with its path;
  - a `RunMeta` round-trip and an invalid-field message;
  - the `newRunId` format for a fixed date;
  - `listRuns` order and a broken run;
  - `detectBase` gives `origin/main` on `makeRepo`;
  - `removeWorktree` removes a clean worktree, refuses a dirty one with the exact message, and returns false for an unknown dir.
- [ ] **Step 2:** Run `node --test tests/run/meta.test.ts tests/workspace/worktree.test.ts tests/config/load.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `pnpm schema`.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(run): runtime config, run metadata, worktree removal and base detection`.

---

### Task 18: `prepareRun` and `launchDriver`

**Files:**
- Create: `src/run/prepare.ts`, `tests/helpers/fake-app.ts`
- Test: `tests/run/prepare.test.ts`

**Interfaces:**
- Consumes: `validate`, `parseTicket`/`formatTicket`, `normalizeRemote`, `newRunId`, `driverName`, `ensureWorktree`, `detectBase`, `HerdrApp`, `newState`, `graphFingerprint`, `materializeGrounds`, `writeRunMeta`, `saveState`.
- Produces:
  - `type DriverDeps = { hc: Hc; app: HerdrApp; gh: Gh; home: string; now?: () => Date; sleep?: (ms: number) => Promise<void>; out: (s: string) => void; selfTerminal?: string; entry: string }`. `entry` is the absolute CLI path that the driver terminal runs.
  - `prepareRun(o: { ticket: string; repoDir: string; configFile: string; profile?: string }, deps): Promise<RunMeta>` does the following, in order, and nothing is created before validation passes:
    1. `validate`.
    2. `parseTicket` with the default repo `normalizeRemote(origin)`.
    3. `runId`, `branch = percolator/<runId>`, and `base = runtime.base ?? detectBase`. When the base starts with `origin/`, `git fetch --quiet origin` first.
    4. `ensureWorktree`.
    5. If `runtime.space !== false`, `app.newSpace('<repo name> #<n>', worktree)`. On failure, `herdr-app space.new failed: …; start the Herdr app or set runtime.space: false in profile "<name>"`.
    6. `writeRunMeta`.
    7. `materializeGrounds`.
    8. `newState` with `graphFingerprint` and `groundVersions`, then `saveState`.
  - `launchDriver(meta, deps): Promise<string>` returns the terminal name.
    - A live driver terminal gives `run <id> is already being driven by terminal <name>`. A finished one is removed first.
    - Then `hc.run({ name: meta.driver, cwd: meta.worktree, argv: [process.execPath, deps.entry, 'drive', meta.runId], labels: { 'percolator.run', 'percolator.role': 'driver', 'herdr.space'? }, outliveParent: true })`.
  - `FakeHerdrApp` records `newSpace` calls and can be set to fail.

- [ ] **Step 1: Write the failing tests.** Use `makeRepo`, a config with every stage bound to scripts plus `github.intake`/`github.open_pr`, FakeHc, FakeGh and FakeHerdrApp.
  - `prepareRun creates worktree, space, run.json and state`. Assert:
    - the paths under `home`;
    - the branch `percolator/<runId>`;
    - the base `origin/main`;
    - the `newSpace` args `['<repo> #5', worktree]`;
    - `state.graphFingerprint` is set and `cursor` is 0.
  - `a config error creates nothing`. A broken profile rejects, and there is no `runs/` and no worktree.
  - `#5 without a GitHub origin` gives the Task 13 message.
  - `space failure names the fix` asserts the exact message.
  - `launchDriver argv and labels` asserts the exact `run` options.
  - `launchDriver refuses a live driver`.
- [ ] **Step 2:** Run `node --test tests/run/prepare.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(run): prepare a run and launch its driver`.

---

### Task 19: `drive` — resume checks, wiring, end-of-run sweep

**Files:**
- Create: `src/run/drive.ts`
- Test: `tests/run/drive.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `drive(runId: string, deps: DriverDeps): Promise<RunState>`.
  1. `readRunMeta` and `loadState`.
     - A `completed` run is refused with `run <id> already completed<: pr url if any>`.
     - A `failed` run is refused with `run <id> failed at <currentStep>; start a new run`.
  2. **Driver guard.** If `hc.get(meta.driver)` is live and its address is not `deps.selfTerminal`, refuse with `run <id> is already being driven by terminal <name>`.
  3. **Resume checks.** Re-run `validate({ configFile, cwd: repoRoot, profile })`.
     - A fingerprint mismatch gives `run <id> was started with a different graph (config changed since); start a new run`.
     - A ground-version mismatch gives `grounds changed since run <id> started: <name> <old> → <new>[, …]; start a new run`.
  4. `sweepLeftovers(runDir, { recursive: true })`, `ensureWorktree` (this re-creates a deleted worktree on its branch) and `materializeGrounds`.
  5. Build the `HerdrRuntime`:
     - `keepTerminals`, `space`, `outliveParent: true`, with no `parentTerminal` (the driver polls `done.json`, and an `hc send` into the driver would only type into its screen);
     - `builtins: { 'github.intake': githubIntake, 'github.open_pr': githubOpenPr }` and `gate: githubGate` (approvers from `tracker.approvers`);
     - `onAttention`, which prints `<step>: <kind> — attend terminal <terminal>` and writes `<runDir>/attention.json` (`{ stepId, terminal, kind, at }`) atomically. That file is deleted after every completed step (from the `save` callback), so `perc status` can show "a person is needed" (§5.5, §5.7 step 5).
  6. `grantRound` (printing `granted one more round on <edge>`), set `status = 'running'`, save, then `runGraph`.
  7. At the end:
     - `completed`: `sweepTerminals(exceptRole: 'driver')` and print `run <id> completed: <pr url>`.
     - `failed`: sweep the same way and print `run <id> failed at <step>`.
     - `paused`: no sweep (resume may adopt terminals). Print `run <id> paused at <step>: <reason>` and `resume with: perc resume <id>`.

- [ ] **Step 1: Write the failing tests.** This is the in-process e2e: `prepareRun` then `drive`. Use FakeHc with `behave` writing each script step's outputs and exit 0, and FakeGh holding issue #5 plus an approver's `/percolator approve` posted after the gate comment. The real `push` goes to `makeRepo`'s bare origin.
  - `drive runs a ticket to a PR`. Assert:
    - the status is `completed`;
    - exactly one gate comment and one `createPr`;
    - the PR body contains `Closes #5`;
    - `origin` has the branch;
    - the swept names include the node terminals;
    - the output ends `run <id> completed: <url>`.
  - `a rejected groom goes back to groom with the feedback as input`. The first comment is a reject and the second an approve. Groom runs twice, and the second groom `task.md`/inputs list `findings (from approve-groom)`.
  - `resume after a driver crash at the gate re-posts nothing`. Make the first `drive` throw from `sleep` while waiting at the gate, to simulate a kill. A second `drive` completes. There is still one gate comment.
  - `resume after a crash in deliver opens one PR`. Seed FakeGh with an existing open PR for the branch. There is no `createPr`, and `pr_url` is that URL.
  - `resume refuses a changed config`. Edit the profile between runs; the error is the exact fingerprint message.
  - `resume refuses changed grounds`. Rewrite `groundVersions` in `state.json` to simulate a moved pin; the error is the exact grounds message.
  - `resume at a cap grants one round` prints `granted one more round on <edge>`.
  - `a live driver elsewhere is refused`.
  - `a completed run is refused`.
- [ ] **Step 2:** Run `node --test tests/run/drive.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS, and output pristine.
- [ ] **Step 5:** Add `AGENTS.md` rows for `run/meta.ts`, `run/prepare.ts` and `run/drive.ts`. Commit `feat(run): drive a run end to end with resume checks`.

---

### Task 20: CLI — `run`, `resume`, `status`, `approve`, `reject`, `clean`, `drive`

**Files:**
- Modify: `src/cli.ts`, `src/index.ts`
- Test: `tests/cli/cli.test.ts`, `tests/cli/run.test.ts`

**Interfaces:**
- Produces:
  - `main(argv, io, deps?: Partial<DriverDeps>)`. Missing deps default to `cliHc()`, `cliHerdrApp()`, `cliGh()`, `os.homedir()`, `process.env.HC_TERMINAL_ID` and `fileURLToPath(import.meta.url)`.
  - The USAGE gains these lines (exact):
    ```
      run <ticket> [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]
          start a run: groom, approval, plan, implement, review, PR (default: in its own hc terminal)
      resume <run-id> [--foreground]
          continue a paused or interrupted run (grants one more round at a cap)
      status [<run-id>]
          list runs, or show one
      approve <run-id> | reject <run-id> <feedback>
          answer the approval gate a run is waiting at
      clean <run-id> [--force]
          remove a finished run's terminals and worktree (keeps the branch and the run record)
      drive <run-id>
          internal: what a run's driver terminal executes
    ```
  - `run`: `prepareRun`. Then either `drive` in-process with `--foreground`, or `launchDriver` and print:
    ```
    run <id> started
      terminal <driver> (space "<repo> #<n>")
      worktree <path>
      follow with: perc status <id>
    ```
  - `resume`: refuse `completed`/`failed` with the same messages as `drive`, and run the resume checks *before* launching, so errors reach the owner's terminal. Then launch the driver (or drive with `--foreground`).
  - `status` with no id prints one line per run: `<runId>  <status>  <currentStep or "-">  <ticket>  <detail>`. The detail is:
    - `waiting for approval: <commentUrl>` when `waiting.json` exists;
    - else for a paused run, its `pausedReason`;
    - else for a running run whose `attention.json` names the current step, `<kind>: attend terminal <terminal>`;
    - else for a running run, `driver <name>` when live, or `driver not running; perc resume <id>`;
    - else for a completed run, the PR URL;
    - else, for a broken run, `error: <error>`.

    With an id it prints `run <id>`, then the `ticket`, `profile`, `worktree`, `branch`, `status`, `step` and `detail` lines (two-space indent), then `history:` with the last 10 records as `<stepId> a<attempt> <status>`. An hc that is unavailable gives `driver unknown (hc: <message>)`, never a crash.
  - `approve`/`reject`: `writeDecision`, then print `approved <stepId> of run <id>` / `rejected <stepId> of run <id>`.
  - `clean`: refuse while the driver is live (`run <id> is being driven by terminal <name>; stop it first`). Otherwise run `sweepTerminals` (all roles) and `removeWorktree({ force })`, then print `removed <n> terminal(s) and worktree <path>`. Spaces are not closed.
  - `drive`: `drive(runId, deps)`. The exit code is 1 when the result is `failed`, else 0.
  - `index.ts` exports `drive`, `prepareRun`, `cliGh`, `parseTicket` and the tracker handlers.

- [ ] **Step 1: Write the failing tests** in `tests/cli/run.test.ts` through `main`, with injected fakes:
  - `run without --foreground launches the driver and prints the start block` (exact text);
  - `run --foreground drives to completion` (exit 0);
  - `status lists runs with details`, covering the waiting, paused, `driver not running` and completed lines exactly;
  - `status <id> when hc is missing` prints `driver unknown (hc: hc not found on PATH)`;
  - `approve writes the decision`, and `approve when not waiting` exits 1 with `run is not waiting at a gate`;
  - `resume refuses a changed config before launching`, with no `run` call on FakeHc;
  - `clean refuses a live driver`, and `clean removes terminals and worktree`;
  - in `cli.test.ts`, the updated USAGE and `perc run` with no ticket exits 2.
- [ ] **Step 2:** Run `node --test tests/cli/run.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Update the `AGENTS.md` Commands section (`perc run/resume/status/approve/reject/clean`) and the `cli.ts` row. Commit `feat(cli): perc run, resume, status, approve, reject, clean`.

---

## Phase E — packaging, CI, real-tool checks

### Task 21: Package fields; CI build and schema-sync

**Files:**
- Modify: `package.json`, `.github/workflows/ci.yml`, `AGENTS.md`
- Test: `tests/package.test.ts`

**Interfaces:**
- Produces:
  - `package.json` gains:
    - `"files": ["dist", "schema"]`
    - `"exports": { ".": "./dist/index.js", "./schema.json": "./schema/percolator.schema.json" }`
    - `"bin": { "perc": "dist/cli.js" }` (unchanged)
  - CI gains these steps after the tests: `pnpm build`, then `pnpm schema` and `git diff --exit-code -- schema/`.

- [ ] **Step 1: Write the failing test.** `tests/package.test.ts` reads `package.json` and asserts `files` and `exports` exactly. It also regenerates the schema into a tmp file with `writeJsonSchema(tmp)` and asserts it equals `schema/percolator.schema.json` byte for byte. This is the local twin of the CI check.
- [ ] **Step 2:** Run `node --test tests/package.test.ts`. Expected: FAIL (`files` undefined).
- [ ] **Step 3:** Edit `package.json` and `ci.yml`. Run `pnpm build`; expect `dist/cli.js` to have the shebang and `node dist/cli.js --help` to print USAGE.
- [ ] **Step 4:** Rerun, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `chore: package files/exports; CI build and schema-sync check`.
- [ ] **Owner action (not the executor):** create the GitHub remote and push `main`, then watch the 3-OS matrix. Record the result in the build-status memory.

---

### Task 22: Real-tool smoke (manual; the owner runs it)

**Files:**
- Modify: `tests/smoke/hc.smoke.ts`, `src/adapters/index.ts` (comment only, from the result)
- Create: `tests/smoke/gh.smoke.ts`

**Interfaces:**
- Produces:
  - `hc.smoke.ts` gains these flags:
    - `--boot`: launches `claude` (no message) and, separately, the idle program `[process.execPath, '-e', 'setInterval(()=>{},1e3)']`. For each it prints `get` status/turn every second for 20 s. This verifies whether a plain program ever reports `idle` at turn 0, which is what Task 11's grace assumes.
    - `--codex`: on Windows, launches `codex --no-daemon --help` via `hc run` and prints the exit code and whether the screen contains `--add-dir`. This verifies `.cmd` shim launching through hc and the flag.
  - `gh.smoke.ts --issue <owner/repo#n>`: runs `cliGh().issue`, then posts and deletes nothing. It is read-only and prints the parsed issue, verifying the JSON field shapes.

- [ ] **Step 1:** Implement the flags. They are not part of `pnpm test`, so there is no RED; note this in the report.
- [ ] **Step 2: Owner runs** each of the following and pastes the output into the report:
  - `node tests/smoke/hc.smoke.ts --space <id>` (the never-run branch);
  - `node tests/smoke/hc.smoke.ts --boot`;
  - `node tests/smoke/hc.smoke.ts --codex`;
  - `node tests/smoke/gh.smoke.ts --issue <a real issue>`.
- [ ] **Step 3:** From the results, update the codex comment in `src/adapters/index.ts`: `--add-dir` verified or removed, and the `.cmd` launch works or needs an explicit `codex.cmd` note. If `--boot` shows idle at turn 0 for programs, keep the grace; if not, note it in AGENTS.md. If a check fails, open a follow-up task in this plan rather than patching untested.
- [ ] **Step 4:** Final run of `pnpm test` and `pnpm typecheck`; paste the output.
- [ ] **Step 5:** Commit `chore(smoke): boot, codex and gh real-tool checks`. Update the build-status memory: plan 3 is done, plus the remaining owner actions.
