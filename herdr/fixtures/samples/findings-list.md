1. **Answers lost on a contract error** (`src/engine/engine.ts:75`).
   The re-run no longer lists answers.
   Change: keep them until the step passes.

2. **Enter in an answer field starts a run** (`herdr/mods/percolator/main.js:445`).
   Change: give answer fields their own submit.

3. **The summary says "answered 1 questions"**.
   Change: use the singular.
