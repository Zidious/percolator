import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinHandlers } from '../../src/run/builtins.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { BUILTIN_NAMES } from '../../src/tracker/index.ts';
import type { ValidateResult } from '../../src/validate.ts';

const meta = { runId: 'r', pipeline: 'feature', inputs: {}, worktree: 'w', branch: 'b', base: 'main', repo: 'o/r' } as unknown as RunMeta;
const deps = { home: 'h' } as unknown as DriverDeps;
const now = () => new Date('2026-01-01T00:00:00Z');

function v(pipeline: object): ValidateResult {
  return { pipeline: { inputs: {}, ...pipeline }, pipelines: {}, profile: 'p' } as unknown as ValidateResult;
}

test('builtinHandlers has a handler for every builtin but seed outside a fan-out pipeline', () => {
  const h = builtinHandlers({ deps, meta, v: v({}), dir: 'd', runId: 'r', now });
  assert.deepEqual(Object.keys(h).sort(), BUILTIN_NAMES.filter((n) => n !== 'percolator.seed').sort());
  for (const f of Object.values(h)) assert.equal(typeof f, 'function');
});

test('builtinHandlers adds seed in a fan-out pipeline', () => {
  const h = builtinHandlers({ deps, meta, v: v({ fan_out: { slices: { output: 'plan' } } }), dir: 'd', runId: 'r', now });
  assert.deepEqual(Object.keys(h).sort(), [...BUILTIN_NAMES].sort());
});
