# Review findings (round 3 of 3) — SAMPLE

## Retry only transient errors

src/tracker/gh.ts retries `gh issue comment` on a 422, which is not transient. Retry only on 5xx and network errors.

## Missing test for the retry ceiling

tests/tracker/gh.test.ts: add one that asserts the third failure surfaces the original error text.
