import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Step } from '../../../src/graph/build.ts';
import { defineExit } from '../../../src/tracker/exits/define.ts';

const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const ctx = { graph: { steps: [] }, state: { history: [] }, previousOutputs: {} } as unknown as RunContext;

async function setup() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-define-'));
  const stepDir = path.join(runDir, 'steps', 'deliver', '1');
  return { runDir, io: { stepDir, outputsDir: path.join(stepDir, 'outputs') } };
}

test('defineExit writes each output as outputs/<key>.md, one line each, and passes with them', async () => {
  const s = await setup();
  try {
    const h = defineExit('github.comment', s.runDir, async () => ({ write: { comment_url: 'https://x/c/1' } }));
    assert.deepEqual(await h({ id: 'deliver' } as Step, ctx, s.io), {
      status: 'pass',
      outputs: { comment_url: 'steps/deliver/1/outputs/comment_url.md' },
    });
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'comment_url.md'), 'utf8'), 'https://x/c/1\n');
  } finally {
    await rm(s.runDir);
  }
});

test('defineExit passes with no outputs when the body writes none', async () => {
  const s = await setup();
  try {
    const h = defineExit('percolator.report', s.runDir, async () => ({ write: {} }));
    assert.deepEqual(await h({ id: 'deliver' } as Step, ctx, s.io), { status: 'pass', outputs: {} });
  } finally {
    await rm(s.runDir);
  }
});

test('defineExit escalates with the builtin as prefix, for an escalation and for a thrown error', async () => {
  const s = await setup();
  try {
    const asked = defineExit('github.release', s.runDir, async () => ({ escalate: 'tag "x" is not a valid tag name' }));
    assert.deepEqual(await asked({ id: 'deliver' } as Step, ctx, s.io), {
      status: 'escalate',
      outputs: {},
      reason: 'github.release: tag "x" is not a valid tag name',
    });
    const threw = defineExit('github.open_pr', s.runDir, async () => {
      throw new Error('push rejected');
    });
    assert.deepEqual(await threw({ id: 'deliver' } as Step, ctx, s.io), {
      status: 'escalate',
      outputs: {},
      reason: 'github.open_pr: push rejected',
    });
  } finally {
    await rm(s.runDir);
  }
});
