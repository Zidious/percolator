import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { graphFingerprint, runGraph } from '../../src/engine/engine.ts';
import { grantRound, newState } from '../../src/engine/state.ts';
import type { RunState } from '../../src/engine/state.ts';
import type { GraphFragment } from '../../src/config/schema.ts';
import { buildGraph } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import { esc, fail, FakeRuntime, pass } from '../helpers/fake-runtime.ts';

const init = { runId: 'r1', ticket: 'T-1', profile: 'default', groundVersions: {} };

function graph(nodes: GraphFragment['nodes'] = {}, bindings: GraphFragment['bindings'] = {}) {
  return buildGraph(
    mergeLayers([
      {
        source: 'test',
        fragment: {
          bindings: {
            intake: { agent: 'claude' },
            groom: { agent: 'claude' },
            plan: [{ agent: 'claude' }, { agent: 'codex' }],
            implement: { agent: 'claude' },
            review: { agent: 'claude' },
            deliver: { builtin: 'github.open_pr' },
            ...bindings,
          },
          nodes,
        },
      },
    ]),
  );
}

/** save spy that keeps a snapshot of every saved state */
function saver() {
  const saved: RunState[] = [];
  const save = mock.fn(async (s: RunState) => {
    saved.push(structuredClone(s));
  });
  return { save, saved };
}

test('happy path completes and saves after every step', async () => {
  const g = graph();
  const before = structuredClone(g);
  const { save, saved } = saver();
  const rt = new FakeRuntime();
  const s = await runGraph(g, newState(init), { runtime: rt, save, now: () => 'T' });
  assert.equal(s.status, 'completed');
  assert.equal(save.mock.callCount(), g.steps.length);
  assert.equal(saved.at(-1)!.status, 'completed');
  assert.deepEqual(rt.calls, g.steps.map((x) => x.id));
  assert.deepEqual(saved.map((x) => x.cursor), g.steps.map((_, i) => i + 1));
  assert.deepEqual(s.history[0], { stepId: 'intake', attempt: 1, startedAt: 'T', endedAt: 'T', status: 'pass', outputs: { ticket: 'x' } });
  assert.equal(s.executed['implement'], 1);
  assert.deepEqual(g, before, 'graph is not mutated');
});

test('escalate pauses; resume re-runs that step and does not re-run completed ones', async () => {
  const g = graph();
  const { save, saved } = saver();
  const s1 = await runGraph(g, newState(init), { runtime: new FakeRuntime({ 'plan.0': [esc('question')] }), save });
  assert.equal(s1.status, 'paused');
  assert.equal(s1.pausedReason, 'question');
  assert.equal(s1.cursor, g.steps.findIndex((x) => x.id === 'plan.0'));
  assert.equal(saved.at(-1)!.status, 'paused');
  assert.equal(s1.history.at(-1)!.status, 'escalate');
  const rt2 = new FakeRuntime();
  const s2 = await runGraph(g, { ...s1, status: 'running' }, { runtime: rt2, save });
  assert.equal(rt2.calls[0], 'plan.0');
  assert.ok(!rt2.calls.includes('intake'));
  assert.equal(s2.status, 'completed');
  assert.equal(s2.history.filter((h) => h.stepId === 'plan.0').at(-1)!.attempt, 2);
});

test('fail without a back-edge fails the run', async () => {
  const { save, saved } = saver();
  const s = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({ 'plan.1': [{ status: 'fail', outputs: { plan: 'x' } }] }), save });
  assert.equal(s.status, 'failed');
  assert.equal(saved.at(-1)!.status, 'failed');
  assert.equal(s.history.at(-1)!.stepId, 'plan.1');
});

test('gate fail sends run back to groom', async () => {
  const rt = new FakeRuntime({ 'approve-groom': [{ status: 'fail', outputs: {}, reason: 'reject: tighten AC' }, pass()] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'groom').length, 2);
  assert.deepEqual(rt.calls.slice(0, 5), ['intake', 'groom', 'approve-groom', 'groom', 'approve-groom']);
  assert.equal(s.rounds['approve-groom'], 1);
});

test('qa on_fail back_to implement max 2 → pauses at cap', async () => {
  const g = graph({ qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } });
  const { save, saved } = saver();
  const rt = new FakeRuntime({ qa: [fail('q1'), fail('q2')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedReason, 'cap: qa reached 2 rounds');
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 2);
  assert.ok(!rt.calls.includes('deliver'));
  assert.equal(s.cursor, g.steps.findIndex((x) => x.id === 'qa'));
  assert.equal(saved.at(-1)!.status, 'paused');
});

test('review fails 3 times → proceeds to deliver with unresolved findings', async () => {
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), fail('f3')] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 3);
  assert.equal(rt.calls.at(-1), 'deliver');
  assert.equal(s.unresolvedFindings, 'f3');
  assert.equal(s.status, 'completed');
});

test('review passes on round 2 → 2 implement runs, no unresolved findings', async () => {
  const st = newState(init);
  st.unresolvedFindings = 'stale';
  const rt = new FakeRuntime({ review: [fail('f1'), pass({ findings: '' })] });
  const s = await runGraph(graph(), st, { runtime: rt, save: saver().save });
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 2);
  assert.equal(s.unresolvedFindings, undefined);
  assert.ok(!('unresolvedFindings' in s));
  assert.equal(s.status, 'completed');
});

test('before:implement hook re-runs each round; once:true runs once', async () => {
  const g = graph({
    setup: { before: 'implement', kind: 'script', command: ['setup'], once: true },
    lint: { before: 'implement', kind: 'script', command: ['lint'] },
  });
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), pass({ findings: '' })] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'lint').length, 3);
  assert.equal(rt.calls.filter((id) => id === 'setup').length, 1);
  assert.equal(s.executed['setup'], 1);
});

test('missing contract output retries once then pauses', async () => {
  const g = graph();
  const { save, saved } = saver();
  const rt = new FakeRuntime({ groom: [pass(), pass()] });
  const s = await runGraph(g, newState(init), { runtime: rt, save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedReason, 'contract: groom missing groomed_ticket');
  assert.deepEqual(rt.calls, ['intake', 'groom', 'groom']);
  assert.deepEqual(
    s.history.filter((h) => h.stepId === 'groom').map((h) => [h.status, h.attempt]),
    [['contract_error', 1], ['contract_error', 2]],
  );
  assert.equal(s.cursor, g.steps.findIndex((x) => x.id === 'groom'));
  assert.equal(save.mock.callCount(), 3, 'contract_error records are saved too');
  assert.equal(saved.at(-1)!.status, 'paused');
});

test('contract retry that satisfies the contract continues', async () => {
  const rt = new FakeRuntime({ deliver: [pass({ url: 'nope' })] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.deepEqual(
    s.history.filter((h) => h.stepId === 'deliver').map((h) => [h.status, h.attempt]),
    [['contract_error', 1], ['pass', 2]],
  );
});

test('only the last node of a slot carries the contract', async () => {
  const rt = new FakeRuntime({ 'plan.0': [pass()] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'plan.0').length, 1);
});

test('review fail without findings is a contract error, not a review round', async () => {
  const rt = new FakeRuntime({ review: [{ status: 'fail', outputs: {} }, pass({ findings: '' })] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 1);
  assert.equal(s.rounds['review'], undefined);
  assert.deepEqual(s.history.filter((h) => h.stepId === 'review').map((h) => h.status), ['contract_error', 'pass']);
});

test('a failing slot step is not contract-checked (except review)', async () => {
  const g = graph({}, { implement: { agent: 'claude', on_fail: { back_to: 'plan', max_rounds: 2 } } });
  const rt = new FakeRuntime({ implement: [{ status: 'fail', outputs: {} }] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(s.rounds['implement'], 1);
});

test('after:review hook runs every round, including failing ones', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude' } });
  const { save, saved } = saver();
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), pass({ findings: '' })] });
  const s = await runGraph(g, newState(init), { runtime: rt, save });
  assert.deepEqual(rt.calls.slice(rt.calls.indexOf('implement')), [
    'implement', 'review', 'audit',
    'implement', 'review', 'audit',
    'implement', 'review', 'audit',
    'deliver',
  ]);
  assert.equal(s.status, 'completed');
  assert.equal(s.pendingJump, undefined);
  // the save right after review's first fail records the pending jump
  const firstFail = saved.find((x) => x.history.at(-1)!.stepId === 'review')!;
  assert.deepEqual(firstFail.pendingJump, { edgeId: 'review', stepId: 'review', findings: 'f1' });
});

test('review cap with an after:review hook continues with the last findings', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude' } });
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), fail('f3')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(rt.calls.filter((id) => id === 'audit').length, 3);
  assert.equal(rt.calls.at(-1), 'deliver');
  assert.equal(s.unresolvedFindings, 'f3');
  assert.equal(s.pendingJump, undefined);
  assert.equal(s.status, 'completed');
});

test('pause while a jump is pending: resume applies the jump', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude' } });
  const { save, saved } = saver();
  const rt1 = new FakeRuntime({ review: [fail('f1'), fail('f2')], audit: [pass(), esc('hold')] });
  const s1 = await runGraph(g, newState(init), { runtime: rt1, save });
  assert.equal(s1.status, 'paused');
  assert.equal(s1.pausedReason, 'hold');
  assert.deepEqual(saved.at(-1)!.pendingJump, { edgeId: 'review', stepId: 'review', findings: 'f2' });
  assert.equal(saved.at(-1)!.rounds['review'], 1);

  const rt2 = new FakeRuntime();
  const s2 = await runGraph(g, { ...structuredClone(saved.at(-1)!), status: 'running' }, { runtime: rt2, save });
  assert.deepEqual(rt2.calls, ['audit', 'implement', 'review', 'audit', 'deliver']);
  assert.equal(s2.rounds['review'], 2);
  assert.equal(s2.pendingJump, undefined);
  assert.equal(s2.status, 'completed');
});

test('a failing hook between trigger and jump takes precedence and clears the pending jump', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude', on_fail: { back_to: 'implement', max_rounds: 3 } } });
  const rt = new FakeRuntime({ review: [fail('f1')], audit: [fail('a1')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 2);
  assert.equal(s.rounds['audit'], 1);
  assert.equal(s.rounds['review'], undefined, 'review round was not counted');
  assert.equal(s.pendingJump, undefined);
});

test('a failing hook without an edge between trigger and jump fails the run', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude' } });
  const rt = new FakeRuntime({ review: [fail('f1')], audit: [{ status: 'fail', outputs: {} }] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'failed');
  assert.equal(s.history.at(-1)!.stepId, 'audit');
});

test('an outer qa round gives review a fresh loop', async () => {
  const g = graph({ qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } });
  const findings = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const rt = new FakeRuntime({ review: findings.map(fail), qa: [fail('q1'), pass()] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(rt.calls.filter((id) => id === 'review').length, 6, 'review capped at 3 in each qa round');
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 6);
  assert.equal(s.unresolvedFindings, 'f6');
  assert.equal(s.rounds['qa'], 1);
  assert.equal(s.rounds['review'], 3);
});

test('ctx.round is the round of the innermost loop containing the step', async () => {
  const g = graph({
    audit: { after: 'review', agent: 'claude' },
    qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } },
  });
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), pass({ findings: '' })], qa: [fail('q1')] });
  await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.deepEqual(rt.roundsOf('implement'), [1, 2, 3, 1]);
  assert.deepEqual(rt.roundsOf('audit'), [1, 2, 3, 1]);
  assert.deepEqual(rt.roundsOf('qa'), [1, 2]);
  assert.deepEqual(rt.roundsOf('groom'), [1]);
  assert.deepEqual(rt.roundsOf('deliver'), [1]);
});

test('ctx.previousOutputs holds the latest outputs per step', async () => {
  const rt = new FakeRuntime({
    implement: [pass({ summary: 's1' }), pass({ summary: 's2' })],
    review: [fail('f1'), { status: 'fail', outputs: {} }, pass({ findings: '' })],
  });
  await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.deepEqual(rt.previous[0], {});
  const implementCalls = rt.calls.flatMap((id, i) => (id === 'implement' ? [i] : []));
  assert.deepEqual(rt.previous[implementCalls[0]!]!['plan.1'], { plan: 'x' });
  const lastReviewCall = rt.calls.lastIndexOf('review');
  // the contract_error record does not replace the last valid review outputs
  assert.deepEqual(rt.previous[lastReviewCall]!['review'], { findings: 'f1' });
  assert.deepEqual(rt.previous[lastReviewCall]!['implement'], { summary: 's2' });
});

test('escalate without a reason names the step', async () => {
  const s = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({ groom: [{ status: 'escalate', outputs: {} }] }), save: saver().save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedReason, 'escalate: groom');
});

test('a skipped once:true hook at the jump point still applies the pending jump', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude', once: true } });
  const rt = new FakeRuntime({ review: [fail('f1'), fail('f2'), pass({ findings: '' })] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 3);
  assert.equal(rt.calls.filter((id) => id === 'audit').length, 1);
  assert.equal(s.pendingJump, undefined);
  assert.equal(s.status, 'completed');
});

test('once hook escalate → resume re-runs it', async () => {
  const g = graph({ chk: { before: 'deliver', kind: 'script', command: ['chk'], once: true } });
  const s1 = await runGraph(g, newState(init), { runtime: new FakeRuntime({ chk: [esc('hold')] }), save: saver().save });
  assert.equal(s1.status, 'paused');
  const rt2 = new FakeRuntime();
  const s2 = await runGraph(g, { ...s1, status: 'running' }, { runtime: rt2, save: saver().save });
  assert.deepEqual(rt2.calls, ['chk', 'deliver']);
  assert.equal(s2.status, 'completed');
});

test('once hook with on_fail is re-run until it passes or hits its cap', async () => {
  const g = graph({ chk: { before: 'deliver', kind: 'script', command: ['chk'], once: true, on_fail: { back_to: 'implement', max_rounds: 3 } } });
  const rt1 = new FakeRuntime({ chk: [fail('c1'), pass()] });
  const s1 = await runGraph(g, newState(init), { runtime: rt1, save: saver().save });
  assert.equal(rt1.calls.filter((id) => id === 'chk').length, 2);
  assert.equal(s1.status, 'completed');

  const rt2 = new FakeRuntime({ chk: [fail('c1'), fail('c2'), fail('c3')] });
  const s2 = await runGraph(g, newState(init), { runtime: rt2, save: saver().save });
  assert.equal(rt2.calls.filter((id) => id === 'chk').length, 3);
  assert.equal(s2.status, 'paused');
  assert.match(s2.pausedReason!, /^cap: chk /);
});

test('review escalating without findings pauses with its reason, not a contract error', async () => {
  const rt = new FakeRuntime({ review: [esc('need the owner')] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedReason, 'need the owner');
  assert.equal(rt.calls.filter((id) => id === 'review').length, 1);
  assert.equal(s.history.at(-1)!.status, 'escalate');
});

test('resuming at a qa cap and failing again keeps the counter and message at the cap', async () => {
  const g = graph({ qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } });
  const s1 = await runGraph(g, newState(init), { runtime: new FakeRuntime({ qa: [fail('q1'), fail('q2')] }), save: saver().save });
  assert.equal(s1.pausedReason, 'cap: qa reached 2 rounds');
  const rt2 = new FakeRuntime({ qa: [fail('q3')] });
  const s2 = await runGraph(g, { ...s1, status: 'running' }, { runtime: rt2, save: saver().save });
  assert.deepEqual(rt2.calls, ['qa']);
  assert.equal(s2.status, 'paused');
  assert.equal(s2.pausedReason, 'cap: qa reached 2 rounds');
  assert.equal(s2.rounds['qa'], 2);
});

test('a resumed run that completes has no pausedReason', async () => {
  const s1 = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({ groom: [esc('question')] }), save: saver().save });
  assert.equal(s1.pausedReason, 'question');
  const s2 = await runGraph(graph(), { ...s1, status: 'running' }, { runtime: new FakeRuntime(), save: saver().save });
  assert.equal(s2.status, 'completed');
  assert.ok(!('pausedReason' in s2));
});

test('a contract key that is present but not a string is a contract error', async () => {
  const bad = { status: 'fail', outputs: { findings: undefined as unknown as string } } as const;
  const rt = new FakeRuntime({ review: [bad, bad] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedReason, 'contract: review missing findings');
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 1);
});

test('a runtime mutating previousOutputs cannot change history', async () => {
  const inner = new FakeRuntime();
  const runtime = {
    async executeStep(step: Parameters<FakeRuntime['executeStep']>[0], ctx: Parameters<FakeRuntime['executeStep']>[1]) {
      const prev = ctx.previousOutputs['intake'];
      if (prev) prev['ticket'] = 'tampered';
      return inner.executeStep(step, ctx);
    },
  };
  const s = await runGraph(graph(), newState(init), { runtime, save: saver().save });
  assert.equal(s.history[0]!.outputs['ticket'], 'x');
});

test('a new run records the graph fingerprint, and resuming against the same graph works', async () => {
  const { save, saved } = saver();
  const rt = new FakeRuntime({ implement: [esc('stuck')] });
  const s = await runGraph(graph(), newState(init), { runtime: rt, save });
  assert.match(s.graphFingerprint!, /^[0-9a-f]{64}$/);
  assert.equal(saved[0]!.graphFingerprint, s.graphFingerprint);
  s.status = 'running';
  const done = await runGraph(graph(), s, { runtime: new FakeRuntime(), save });
  assert.equal(done.status, 'completed');
});

test('resuming against a changed graph throws before running anything', async () => {
  const { save } = saver();
  const s = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({ implement: [esc('stuck')] }), save });
  s.status = 'running';
  const before = structuredClone(s);
  const changed = graph({ lint: { before: 'implement', kind: 'script', command: ['lint'] } });
  const rt = new FakeRuntime();
  const save2 = mock.fn(async () => {});
  await assert.rejects(
    runGraph(changed, s, { runtime: rt, save: save2 }),
    (e: Error) => {
      assert.equal(
        e.message,
        'run state was recorded against a different graph (config changed since this run started); start a new run',
      );
      return true;
    },
  );
  assert.deepEqual(rt.calls, []);
  assert.equal(save2.mock.callCount(), 0);
  assert.deepEqual(s, before);
});

test('a pending jump for a back-edge not in the graph is a clear error', async () => {
  const s = newState(init);
  s.cursor = 3;
  s.pendingJump = { edgeId: 'nope', stepId: 'nope' };
  const rt = new FakeRuntime();
  await assert.rejects(runGraph(graph(), s, { runtime: rt, save: async () => {} }), (e: Error) => {
    assert.ok(!(e instanceof TypeError));
    assert.equal(e.message, 'run state has a pending jump on back-edge "nope", which is not in this graph');
    return true;
  });
  assert.deepEqual(rt.calls, []);
});

const twoReviewers = { review: [{ agent: 'claude' }, { agent: 'codex' }] };

test('a fail on a non-last review node loops back to implement after the rest of review runs', async () => {
  const g = graph({}, twoReviewers);
  const { save, saved } = saver();
  const rt = new FakeRuntime({ 'review.0': [fail('f1'), pass()] });
  const s = await runGraph(g, newState(init), { runtime: rt, save });
  assert.deepEqual(rt.calls.slice(rt.calls.indexOf('review.0')), ['review.0', 'review.1', 'implement', 'review.0', 'review.1', 'deliver']);
  assert.equal(s.status, 'completed');
  assert.equal(s.rounds['review.1'], 1);
  assert.equal(s.pendingJump, undefined);
  assert.equal(s.unresolvedFindings, undefined);
  const firstFail = saved.find((x) => x.history.at(-1)!.stepId === 'review.0')!;
  assert.deepEqual(firstFail.pendingJump, { edgeId: 'review.1', stepId: 'review.0', findings: 'f1' });
});

test('non-last review fails every round → deliver with unresolved findings', async () => {
  const g = graph({}, twoReviewers);
  const rt = new FakeRuntime({ 'review.0': [fail('f'), fail('f'), fail('f')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(s.unresolvedFindings, 'f');
  assert.equal(s.rounds['review.1'], 3);
  assert.equal(rt.calls.filter((id) => id === 'review.1').length, 3);
  assert.equal(rt.calls.filter((id) => id === 'deliver').length, 1);
});

test('both review nodes failing count one round, and the last findings win', async () => {
  const g = graph({}, twoReviewers);
  const rt = new FakeRuntime({ 'review.0': [fail('a1'), fail('a2'), fail('a3')], 'review.1': [fail('b1'), fail('b2'), fail('b3')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save: saver().save });
  assert.equal(s.status, 'completed');
  assert.equal(s.rounds['review.1'], 3);
  assert.equal(rt.calls.filter((id) => id === 'implement').length, 3);
  assert.equal(rt.calls.filter((id) => id === 'deliver').length, 1);
  assert.equal(s.unresolvedFindings, 'b3');
  assert.equal(s.pendingJump, undefined);
});

test('a later non-last review fail overwrites the pending findings', async () => {
  const g = graph({}, { review: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'claude' }] });
  const { save, saved } = saver();
  const rt = new FakeRuntime({ 'review.0': [fail('a1')], 'review.1': [fail('b1')] });
  const s = await runGraph(g, newState(init), { runtime: rt, save });
  const second = saved.find((x) => x.history.at(-1)!.stepId === 'review.1')!;
  assert.deepEqual(second.pendingJump, { edgeId: 'review.2', stepId: 'review.1', findings: 'b1' });
  assert.equal(s.rounds['review.2'], 1);
  assert.equal(s.status, 'completed');
});

test('ctx.round is clamped at a cap on resume', async () => {
  const g = graph({ qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } });
  const rt1 = new FakeRuntime({ qa: [fail('q1'), fail('q2')] });
  const s1 = await runGraph(g, newState(init), { runtime: rt1, save: saver().save });
  assert.equal(s1.pausedReason, 'cap: qa reached 2 rounds');
  const rt2 = new FakeRuntime({ qa: [fail('q3')] });
  await runGraph(g, { ...s1, status: 'running' }, { runtime: rt2, save: saver().save });
  assert.deepEqual(rt1.roundsOf('qa'), [1, 2]);
  assert.deepEqual(rt2.roundsOf('qa'), [2]);
  assert.deepEqual(rt1.maxRoundsOf('qa'), [2, 2]);
  assert.deepEqual(rt2.maxRoundsOf('qa'), [2]);
});

test('ctx.maxRounds is 1 outside any loop and the review cap inside review', async () => {
  const rt = new FakeRuntime();
  await runGraph(graph({}, { review: { agent: 'claude', max_rounds: 4 } }), newState(init), { runtime: rt, save: saver().save });
  assert.deepEqual(rt.maxRoundsOf('intake'), [1]);
  assert.deepEqual(rt.maxRoundsOf('review'), [4]);
  assert.deepEqual(rt.maxRoundsOf('deliver'), [1]);
});

test('a pending jump without stepId (older state) is triggered by its edge step', async () => {
  const g = graph({ audit: { after: 'review', agent: 'claude' } });
  const s = newState(init);
  s.cursor = g.steps.findIndex((x) => x.id === 'audit');
  s.pendingJump = { edgeId: 'review', findings: 'f1' } as RunState['pendingJump'];
  const rt = new FakeRuntime();
  const out = await runGraph(g, s, { runtime: rt, save: saver().save });
  assert.deepEqual(rt.calls, ['audit', 'implement', 'review', 'audit', 'deliver']);
  assert.equal(out.rounds['review'], 1);
  assert.equal(out.status, 'completed');
});

const qaGraph = () =>
  graph({ qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } });

test('a cap pause records pausedCap and currentStep', async () => {
  const s = await runGraph(qaGraph(), newState(init), { runtime: new FakeRuntime({ qa: [fail('q1'), fail('q2')] }), save: saver().save });
  assert.equal(s.status, 'paused');
  assert.equal(s.pausedCap, 'qa');
  assert.equal(s.currentStep, 'qa');
});

test('currentStep follows the cursor and is absent on a completed run', async () => {
  const { save, saved } = saver();
  const s = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({}), save });
  assert.equal(s.status, 'completed');
  assert.ok(!('currentStep' in s));
  assert.ok(!('currentStep' in saved.at(-1)!));
  assert.equal(saved[0]!.currentStep, 'groom');
});

test('grantRound lets exactly one more round run', async () => {
  const g = qaGraph();
  const s1 = await runGraph(g, newState(init), { runtime: new FakeRuntime({ qa: [fail('q1'), fail('q2')] }), save: saver().save });
  assert.equal(grantRound(s1), 'qa');
  assert.equal(s1.rounds['qa'], 1);
  assert.ok(!('pausedCap' in s1));
  assert.equal(s1.grantedRound, 'qa');
  s1.status = 'running';
  const rt2 = new FakeRuntime({ qa: [fail('q3'), fail('q4')] });
  const s2 = await runGraph(g, s1, { runtime: rt2, save: saver().save });
  assert.deepEqual(rt2.calls, ['implement', 'review', 'qa']);
  assert.ok(!('grantedRound' in s2));
  assert.equal(s2.status, 'paused');
  assert.equal(s2.pausedCap, 'qa');
  assert.equal(s2.pausedReason, 'cap: qa reached 2 rounds');
});

test('grantRound is a no-op without a cap pause', async () => {
  const s = await runGraph(graph(), newState(init), { runtime: new FakeRuntime({ groom: [esc('question')] }), save: saver().save });
  const before = structuredClone(s);
  assert.equal(grantRound(s), undefined);
  assert.deepEqual(s, before);
});

test('resuming from a non-cap pause clears pausedCap', async () => {
  const g = qaGraph();
  const s1 = await runGraph(g, newState(init), { runtime: new FakeRuntime({ qa: [fail('q1'), fail('q2')] }), save: saver().save });
  s1.status = 'running';
  const s2 = await runGraph(g, s1, { runtime: new FakeRuntime({}), save: saver().save });
  assert.equal(s2.status, 'completed');
  assert.ok(!('pausedCap' in s2));
});

test('graphFingerprint is exported and stable', () => {
  assert.equal(graphFingerprint(qaGraph()), graphFingerprint(qaGraph()));
});
