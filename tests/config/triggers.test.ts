import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trigger } from '../../src/config/schema.ts';
import { onTrigger, TRIGGER_KINDS, triggerKind } from '../../src/config/triggers.ts';

const SAMPLES: Trigger[] = [
  { schedule: '0 9 * * 1' },
  { label: 'percolator' },
  { pr_opened: true },
  { dependabot: true },
  { check_failed: { branch: 'main' } },
];

test('triggerKind names each trigger by its config key, in TRIGGER_KINDS order', () => {
  assert.deepEqual(SAMPLES.map(triggerKind), [...TRIGGER_KINDS]);
});

test('onTrigger calls the handler of the trigger\'s kind with the trigger and returns its result', () => {
  const seen = SAMPLES.map((t) =>
    onTrigger(t, {
      schedule: (s) => `schedule ${s.schedule}`,
      label: (l) => `label ${l.label}`,
      pr_opened: (p) => `pr_opened ${JSON.stringify(p.pr_opened)}`,
      dependabot: () => 'dependabot',
      check_failed: (c) => `check_failed ${c.check_failed.branch}`,
    }),
  );
  assert.deepEqual(seen, ['schedule 0 9 * * 1', 'label percolator', 'pr_opened true', 'dependabot', 'check_failed main']);
});
