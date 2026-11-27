import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_ROUNDS, PICK_GATE, ROUTE_CHOOSE } from '../../src/graph/core.ts';

test('a router\'s step ids keep their names, which run state and perc approve --pipeline refer to', () => {
  assert.equal(ROUTE_CHOOSE, 'route.1');
  assert.equal(PICK_GATE, 'pick-pipeline');
});

test('a stage loop caps at 3 rounds unless its binding sets max_rounds', () => {
  assert.equal(DEFAULT_MAX_ROUNDS, 3);
});
