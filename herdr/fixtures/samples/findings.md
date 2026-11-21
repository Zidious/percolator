# Review findings (round 3 of 3) — SAMPLE

Two findings are still open after the last implement round.

1. **src/tracker/gh.ts** — backoff retries `gh issue comment` on a 422, which is not transient. Retry only on 5xx and network errors.
2. **tests/tracker/gh.test.ts** — no test covers the retry ceiling; add one that asserts the third failure surfaces the original error text.

Resolved this round: jitter is now seeded in tests; the retry count is read from config.
