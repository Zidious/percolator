import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { StepRecord } from '../../../src/engine/state.ts';
import type { Step } from '../../../src/graph/build.ts';
import { percolatorReport } from '../../../src/tracker/exits/report.ts';

const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });

async function setup(notes: { round: number; text: string }[] = []) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-report-'));
  const stepDir = path.join(runDir, 'steps', 'report', '1');
  const history: StepRecord[] = [];
  for (const n of notes) {
    const rel = `steps/review/${n.round}/outputs/notes.md`;
    await fs.mkdir(path.join(runDir, 'steps', 'review', String(n.round), 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), n.text);
    history.push({ stepId: 'review', attempt: n.round, startedAt: '', endedAt: '', status: 'pass', verifyRound: n.round, outputs: { notes: rel } });
  }
  const steps = [{ id: 'review', stage: 'review', role: 'slot', slotLast: true }];
  const ctx = { graph: { steps }, state: { history }, previousOutputs: {} } as unknown as RunContext;
  return { runDir, ctx, io: { stepDir, outputsDir: path.join(stepDir, 'outputs') } };
}

test('none exit passes with no outputs', async () => {
  const s = await setup();
  try {
    const out = await percolatorReport({ runDir: s.runDir })({ id: 'report' } as Step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'pass', outputs: {} });
  } finally {
    await rm(s.runDir);
  }
});

test('none exit writes the notes to its outputs', async () => {
  const s = await setup([{ round: 4, text: 'N4.' }, { round: 5, text: 'N5.' }]);
  try {
    const out = await percolatorReport({ runDir: s.runDir })({ id: 'report' } as Step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'pass', outputs: { notes: 'steps/report/1/outputs/notes.md' } });
    assert.equal(
      await fs.readFile(path.join(s.io.outputsDir, 'notes.md'), 'utf8'),
      '## Noticed in review, not fixed\n\n### Round 4\n\nN4.\n\n### Round 5\n\nN5.\n',
    );
  } finally {
    await rm(s.runDir);
  }
});
