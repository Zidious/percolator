import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import { contractsFor } from '../../src/graph/build.ts';
import type { Step } from '../../src/graph/build.ts';
import { FEATURE } from '../../src/graph/core.ts';
import { reusePriorGroom } from '../../src/run/reuse-groom.ts';
import { priorGroomFile } from '../../src/tracker/intake.ts';
import { FakeRuntime } from '../helpers/fake-runtime.ts';

const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const mk = (id: string, stage: Step['stage'], role: Step['role'], slotLast = false) =>
  ({ id, name: id, stage, role, slotLast, def: {} }) as unknown as Step;
const ctx = (executed: Record<string, number> = {}) =>
  ({ state: { executed }, graph: { contracts: contractsFor(FEATURE, 'feature') } }) as unknown as RunContext;

const PRIOR = {
  text: '# The ticket\n\nbody',
  gateUrl: 'https://github.com/o/r/issues/2#issuecomment-1',
  decision: { decision: 'approve', by: 'alice', url: 'https://github.com/o/r/issues/2#issuecomment-2' },
};

async function withRun(fn: (runDir: string) => Promise<void>): Promise<void> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-reuse-'));
  try {
    await fn(runDir);
  } finally {
    await rm(runDir);
  }
}

test('without prior-groom.json every step goes to the inner runtime', () =>
  withRun(async (runDir) => {
    const inner = new FakeRuntime();
    const rt = reusePriorGroom(inner, runDir);
    await rt.executeStep(mk('groom', 'groom', 'slot', true), ctx());
    await rt.executeStep(mk('approve-groom', 'groom', 'hook'), ctx());
    assert.deepEqual(inner.calls, ['groom', 'approve-groom']);
  }));

test('an approved prior groom: the last groom slot passes with it as groomed_ticket, without an agent', () =>
  withRun(async (runDir) => {
    await fs.writeFile(priorGroomFile(runDir), JSON.stringify(PRIOR));
    const inner = new FakeRuntime();
    const rt = reusePriorGroom(inner, runDir);
    const first = await rt.executeStep(mk('groom.0', 'groom', 'slot'), ctx());
    assert.deepEqual(first, { status: 'pass', outputs: {} });
    const out = await rt.executeStep(mk('groom', 'groom', 'slot', true), ctx({ groom: 2 }));
    assert.deepEqual(out, { status: 'pass', outputs: { groomed_ticket: 'steps/groom/3/outputs/groomed_ticket.md' } });
    assert.equal(await fs.readFile(path.join(runDir, 'steps', 'groom', '3', 'outputs', 'groomed_ticket.md'), 'utf8'), '# The ticket\n\nbody\n');
    assert.deepEqual(inner.calls, []);
  }));

test('an approved prior groom: approve-groom passes with the earlier approval and posts nothing', () =>
  withRun(async (runDir) => {
    await fs.writeFile(priorGroomFile(runDir), JSON.stringify(PRIOR));
    const inner = new FakeRuntime();
    const out = await reusePriorGroom(inner, runDir).executeStep(mk('approve-groom', 'groom', 'hook'), ctx());
    assert.deepEqual(out, { status: 'pass', outputs: { approval: 'steps/approve-groom/1/outputs/approval.md' } });
    assert.equal(
      await fs.readFile(path.join(runDir, 'steps', 'approve-groom', '1', 'outputs', 'approval.md'), 'utf8'),
      `Approved earlier by @alice: ${PRIOR.decision.url} (groomed ticket ${PRIOR.gateUrl}).\n`,
    );
    assert.deepEqual(inner.calls, []);
  }));

test('an approved prior groom: other steps, groom hooks included, still run', () =>
  withRun(async (runDir) => {
    await fs.writeFile(priorGroomFile(runDir), JSON.stringify(PRIOR));
    const inner = new FakeRuntime();
    const rt = reusePriorGroom(inner, runDir);
    await rt.executeStep(mk('lint-ticket', 'groom', 'hook'), ctx());
    await rt.executeStep(mk('plan', 'plan', 'slot', true), ctx());
    assert.deepEqual(inner.calls, ['lint-ticket', 'plan']);
  }));
