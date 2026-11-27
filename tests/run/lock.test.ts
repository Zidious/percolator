import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveness } from '../../src/run/lock.ts';

test('liveness keeps pid and pidAlive when given and leaves out the missing ones', () => {
  const alive = (_pid: number): boolean => true;
  assert.deepEqual(liveness({ pid: 42, pidAlive: alive }), { pid: 42, pidAlive: alive });
  assert.deepEqual(liveness({ pid: 42 }), { pid: 42 });
  assert.deepEqual(Object.keys(liveness({})), []);
});
