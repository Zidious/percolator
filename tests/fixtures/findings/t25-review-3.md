1. **A missing earlier answers file fails `perc answer` with Node's raw ENOENT text** (`src/run/answer.ts` `applyAnswer`, the `fs.readFile(path.join(dir, earlierRel))` added in aca9d4b).
   This read has no catch, unlike `splitFindings`. If the earlier `answers.md` has been deleted, `perc answer <id> --answer 1=x` prints `ENOENT: no such file or directory, open '…'`. That message names neither the run nor what to do next, which breaks the AGENTS.md errors rule.
   Change: catch the error and throw one line, worded like the `splitFindings` message, for example `run <id>: cannot read <step>'s earlier answers <path> (<code>); restore the file, then run perc answer <id> again`. Add an answer test that deletes the earlier file and asserts the exact text. Also check that the test writes nothing and leaves `asking` set.

2. **Follow-up questions are numbered from any `## Question N` line in the earlier file, including lines inside question or answer text** (`src/run/answer.ts` `applyAnswer`, `/^## Question (\d+)$/gm`).
   Question and answer text is written into `answers.md` unescaped. If an earlier question or answer contains the line `## Question 7`, the next questions start at 8 instead of continuing from the real count.
   Change: number on from a count that doesn't depend on body text. One option is to keep the number of questions already answered in `state.answered[step]`. Another is to count only the headings the code itself wrote, for example by writing each answer with a marker the regex can rely on. Add a case with a question whose text contains `## Question 7`.

3. **The summary says "answered 1 questions"** (`src/run/answer.ts` `applyAnswer`, ``summary = `answered ${items.length} questions of ${asking.stepId}` ``).
   For a single question, `perc answer` prints `answered 1 questions of plan`.
   Change: use the singular when `items.length === 1`, and assert both forms in the answer/CLI tests.
