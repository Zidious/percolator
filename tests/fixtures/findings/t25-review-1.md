1. **The owner's answers are lost when the re-run step does not finish cleanly** (`src/engine/engine.ts:75`).
   `state.answered[step.id]` is deleted right after any attempt is recorded. That includes a `contract_error` and a plain escalate (a timeout, or an agent crash).
   - Contract case: groom answers its questions, re-runs, but forgets `groomed_ticket.md`. The engine retries groom at once, and the retry's inputs no longer list `answers (from groom)`.
   - Timeout case: a timeout followed by `perc resume` loses them the same way.

   Change: drop the entry only when the attempt passes, fails, or escalates with new questions. Keep it on `contract_error` and on an escalate without questions. Add engine tests for the contract retry and for escalate-then-resume, asserting that the step's previousOutputs still has `answers`.

2. **Pressing Enter in a question's answer field starts a new run** (`herdr/mods/percolator/main.js:445`, `textState` at ~502–517).
   `syncAsks` makes the answer fields with `this.textState`. That helper's `submit` handler calls `this.startRun(cx)`, and its `change` handler clears the start picker's error, not `actError`. With the start picker open and a ticket filled in, typing an answer and pressing Enter runs `perc run …`, and the answer is not submitted.

   Change: give answer fields their own InputState factory. Its submit should do nothing (or call `submitAnswer`), and its change should clear `actError`. Add a `tests/herdr/main.test.ts` case asserting that submit on an answer field does not call `startRun`.

3. **At the cap, only one review slot's findings reach the owner. The other slots' findings are not filtered and are not asked about** (`src/engine/engine.ts` `decide`, `src/engine/state.ts` `answerFindings`).
   With two reviewers (`review.0`, `review.1`) both failing in the last round, `asking` holds only `review.1`'s findings (test "both review nodes failing count one round…" asserts `b3`).
   - `review.0`'s `a3` is never shown to the owner.
   - In the extra round, implement's inputs still list `findings (from review.0)` in full, because `latestOutputs` still has it. This breaks the AC "the `findings` input there holds only the ticked findings".
   - With none ticked, `a3` is silently delivered.

   Change: at the cap, collect the findings of every loop-stage step that failed in the deciding round and list them all (for example items grouped per step, each saved in `answered` under its own step id). Or override the other slots' `findings` in `answered`, with an empty file when none of theirs is ticked. Add an engine test with two failing reviewers that asserts what implement sees after a partial tick.

4. **Text before the first `## ` heading is dropped, so real findings can vanish** (`src/run/answer.ts` `findingItems`).
   The preamble is dropped whenever there is at least one section. Runs started before this change (like this one) were told to write a numbered list. With a policy mapping, review is also told to add a "Policy compliance" section. So `1. bug A\n2. bug B\n\n## Policy compliance\n…` becomes one item, "Policy compliance". The owner cannot tick bug A or bug B, and ticking none delivers without fixing them. The plan's Review Focus 1 accepted dropping the preamble, but this case shows the cost.

   Change: keep a non-empty preamble as its own first item, and update the `findingItems` test.

5. **The "Policy compliance" section becomes a tickable finding** (`src/runtime/task.ts:120`).
   The review brief now makes every `## ` section a finding. The policies paragraph still asks for a "Policy compliance" section in `findings.md`, so the panel lists it as a finding to send back to implement.

   Change: ask for one `## ` finding per policy breach (and no section when compliant), or have `findingItems` skip a `## Policy compliance` heading. Add a test in `tests/runtime/task.test.ts` and `tests/run/answer.test.ts`.

6. **A `max_rounds` stage with no `findings` output pauses at its cap with nothing to tick** (`src/engine/engine.ts` `decide`, `src/run/answer.ts` `checkAnswer`).
   A custom loop stage whose contract has no `findings` (for example `report`) now pauses with an empty list. `--agree 1` is refused with "it lists none", so the owner cannot grant another round; the only answer is to move on. Before this change it continued.

   Change: when the failing step wrote no findings, either let `perc answer <id> --agree all` (or similar) send the whole failure back, or say plainly in the message and panel that the only choice is to move on. Add a test.

7. **`perc status <id>` cuts each question to its first line** (`src/cli.ts`, `itemLine` in `runStatus`).
   The drive message and the README send CLI users to `perc status <id>` to read the questions. A multi-line question (options, context) shows only its first line, so the owner answers without seeing the options.

   Change: print questions in full, with continuation lines indented. Keep the first-line form for findings. Update the status-text test in `tests/cli/answer.test.ts`.

8. **Some new error messages don't say what to do next** (`src/run/answer.ts`, `checkAnswer` and `applyAnswer`).
   AGENTS.md says errors "say what to do next". These don't:
   - `run X: question 2 is answered twice`
   - `run X: there is no question 5 (it asks 1–3)`
   - `run X: there is no finding 5 (it lists 1–4)`
   - `run X asks about back-edge "…", which is not in this graph`

   Change: add the next step to each, for example `; give each question once, with --answer or --na`, or `start a new run` for the back-edge case. Update the exact-text tests.

9. **Small wording and coverage gaps** (`herdr/mods/percolator/turn.js`, README, implement summary).
   - The findings form's hint hard-codes "go back to implement", but for a custom `max_rounds` stage the loop start can be another stage. Use the stage of `graph.steps[edge.toStepIndex]`, carried in `asked` from status JSON, or drop the stage name from the hint.
   - The groomed ticket requires screenshots of both new states. The window-mode shot was not taken, and the summary reports that `panel.shots.ts` stopped with "unknown command percolator.key/escape". Re-run it, or note the gap in the PR.
