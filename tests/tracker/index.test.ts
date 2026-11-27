import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXITS } from '../../src/tracker/index.ts';

test('each exit declares what it needs from its pipeline, with what an input is for its error', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(EXITS).filter(([, e]) => e.needs !== undefined).map(([k, e]) => [k, e.needs])),
    {
      comment: { ticket: true },
      release: { tag: true },
      pr_review: { input: { name: 'pr', is: 'the pull request to review' } },
      private_fork_pr: { input: { name: 'advisory', is: 'the GHSA id' } },
    },
  );
});
