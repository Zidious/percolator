import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Step } from '../../../src/graph/build.ts';
import { percolatorReport } from '../../../src/tracker/exits/report.ts';

test('none exit passes with no outputs', async () => {
  const out = await percolatorReport()({ id: 'report' } as Step, {} as RunContext, { stepDir: '/s', outputsDir: '/s/outputs' });
  assert.deepEqual(out, { status: 'pass', outputs: {} });
});
