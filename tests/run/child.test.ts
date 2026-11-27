import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../../src/engine/state.ts';
import { childrenOf, startLinkedRun } from '../../src/run/child.ts';
import { checkResumable } from '../../src/run/resumable.ts';
import { readRunGraph } from '../../src/run/graph-file.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { ENTRY, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';
const HOTFIX = [
  '    pipelines:',
  '      hotfix:',
  '        stages: [intake, implement, deliver]',
  '        exit: pr',
  '        bindings:',
  '          implement: { command: [echo, implement] }',
].join('\n');

const runCalls = (e: RunEnv) => e.deps.hc.calls.filter((c) => c[0] === 'run');
const runDirs = async (e: RunEnv) => (await fs.readdir(path.join(e.home, '.percolator', 'runs'))).sort();
const prepareParent = (e: RunEnv) => prepareRun({ ticket: '#5', pipeline: 'feature', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);

test('startLinkedRun prepares a child linked to its parent and starts its driver', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const child = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    assert.deepEqual(
      { runId: child.runId, parent: child.parent, pipeline: child.pipeline, ticket: child.ticket, repoRoot: child.repoRoot, profile: child.profile },
      { runId: 'child-1', parent: parent.runId, pipeline: 'hotfix', ticket: `${REPO}#5`, repoRoot: parent.repoRoot, profile: 'work' },
    );
    assert.deepEqual(await readRunMeta(path.join(e.home, '.percolator', 'runs', 'child-1')), child);
    assert.deepEqual(
      runCalls(e).map((c) => (c[1] as { name: string; argv: string[] })).map((o) => [o.name, o.argv.slice(1)]),
      [[child.driver, [ENTRY, 'drive', 'child-1']]],
    );
    assert.deepEqual((await childrenOf(e.home, parent.runId)).map((l) => l.meta?.runId), ['child-1']);
    assert.deepEqual(await childrenOf(e.home, 'child-1'), []);
  } finally {
    await e.cleanup();
  }
});

test('startLinkedRun on an existing child only relaunches its driver', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const first = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    const dirs = await runDirs(e);
    // driver still live: nothing happens
    assert.deepEqual(await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps), first);
    assert.equal(runCalls(e).length, 1);
    // driver gone: relaunched, not prepared again
    e.deps.hc.terminals.get(first.driver)!.state = 'finished';
    assert.deepEqual(await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps), first);
    assert.equal(runCalls(e).length, 2);
    assert.deepEqual(await runDirs(e), dirs);
    assert.equal(e.deps.app.calls.length, 2);
    // finished: not relaunched
    const dir = path.join(e.home, '.percolator', 'runs', 'child-1');
    const state = await loadState(dir);
    await saveState(dir, { ...state, status: 'completed' });
    e.deps.hc.terminals.get(first.driver)!.state = 'finished';
    await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    assert.equal(runCalls(e).length, 2);
  } finally {
    await e.cleanup();
  }
});

const EPIC = [
  '    pipelines:',
  '      epic:',
  '        stages: [intake, plan, implement, deliver]',
  '        exit: pr',
  '        bindings:',
  '          plan: { command: [echo, plan] }',
  '          implement: { command: [echo, implement] }',
  '        fan_out: { stage: implement, slices: { from: plan, output: slices } }',
].join('\n');

test('startLinkedRun with fanOut records the slice and builds the slice graph, which resumes', async () => {
  const e = await setupRunEnv({ extra: EPIC });
  try {
    const parent = await prepareRun({ ticket: '#5', pipeline: 'epic', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
    const fanOut = { parent: parent.runId, slice: 2, from: 'implement', title: 'Second' };
    const child = await startLinkedRun({ parent, pipeline: 'epic', ticket: parent.ticket!, runId: `${parent.runId}-s2`, fanOut }, e.deps);
    assert.deepEqual(child.fanOut, fanOut);
    assert.equal(child.branch, `percolator/${parent.runId}-s2`);
    assert.equal(child.base, parent.base);
    const dir = path.join(e.home, '.percolator', 'runs', child.runId);
    assert.deepEqual((await readRunMeta(dir)).fanOut, fanOut);
    assert.deepEqual((await readRunGraph(dir))!.steps.map((s) => s.id), ['intake', 'implement', 'deliver']);
    e.deps.hc.terminals.get(child.driver)!.state = 'finished';
    // the slice graph's fingerprint matches on resume
    const r = await checkResumable(child.runId, e.deps);
    assert.deepEqual(r.v.graph.steps.map((s) => s.id), ['intake', 'implement', 'deliver']);
  } finally {
    await e.cleanup();
  }
});

test('a child run is allowed while its parent is live on the same ticket', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const dir = path.join(e.home, '.percolator', 'runs', parent.runId);
    await saveState(dir, { ...(await loadState(dir)), status: 'running' });
    await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    // a sibling is exempt too
    await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-2' }, e.deps);
    // an unlinked run on the ticket is still refused
    await assert.rejects(prepareParent(e), /^Error: ticket github\.com\/o\/r#5 already has a live run /);
  } finally {
    await e.cleanup();
  }
});

test('startLinkedRun leaves a paused child for perc resume <child>: no relaunch, no round granted', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const child = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    const dir = path.join(e.home, '.percolator', 'runs', 'child-1');
    const paused = { ...(await loadState(dir)), status: 'paused' as const, pausedCap: 'review.0', pausedReason: 'review: cap reached' };
    await saveState(dir, paused);
    e.deps.hc.terminals.get(child.driver)!.state = 'finished';
    assert.deepEqual(await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps), child);
    assert.equal(runCalls(e).length, 1);
    assert.deepEqual(await loadState(dir), paused);
  } finally {
    await e.cleanup();
  }
});

test('a child whose prepare stopped before run.json is prepared again on the next start', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const dir = path.join(e.home, '.percolator', 'runs', 'child-1');
    // a directory where graph.json goes makes the prepare fail after the worktree and grounds
    await fs.mkdir(path.join(dir, 'graph.json'), { recursive: true });
    await assert.rejects(startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps));
    assert.equal(await fs.stat(path.join(dir, 'run.json')).then(() => true, () => false), false);
    await fs.rm(path.join(dir, 'graph.json'), { recursive: true });
    const child = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    assert.deepEqual(await readRunMeta(dir), child);
    assert.equal((await loadState(dir)).status, 'running');
    assert.equal(runCalls(e).length, 1);
  } finally {
    await e.cleanup();
  }
});

test('a child that cannot resume is not relaunched; the error names the child', async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const child = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    const dir = path.join(e.home, '.percolator', 'runs', 'child-1');
    await saveState(dir, { ...(await loadState(dir)), graphFingerprint: 'other' });
    e.deps.hc.terminals.get(child.driver)!.state = 'finished';
    await assert.rejects(startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps), {
      message: 'linked run child-1 cannot be resumed: run child-1 was started with a different graph (its config or the Percolator version changed since); start a new run',
    });
    assert.equal(runCalls(e).length, 1);
  } finally {
    await e.cleanup();
  }
});

test("a live terminal named like the child's driver but not labelled with it is not its driver", async () => {
  const e = await setupRunEnv({ extra: HOTFIX });
  try {
    const parent = await prepareParent(e);
    const child = await startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps);
    e.deps.hc.terminals.delete(child.driver);
    e.deps.hc.add({ name: child.driver, labels: { 'percolator.run': 'other' } });
    await assert.rejects(startLinkedRun({ parent, pipeline: 'hotfix', ticket: parent.ticket!, runId: 'child-1' }, e.deps), {
      message: `linked run child-1 cannot be resumed: terminal ${child.driver} is not part of run child-1 (percolator.run=other); remove it with hc rm or rename it, then resume`,
    });
    assert.equal(runCalls(e).length, 1);
  } finally {
    await e.cleanup();
  }
});
