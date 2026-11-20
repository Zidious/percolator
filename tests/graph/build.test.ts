import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, GraphError } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import type { GraphFragment } from '../../src/config/schema.ts';

function full(extra: Pick<GraphFragment, 'nodes'> = {}, bindings: GraphFragment['bindings'] = {}) {
  return mergeLayers([
    {
      source: 'test',
      fragment: {
        bindings: {
          intake: { agent: 'claude' },
          groom: { agent: 'claude' },
          plan: [{ agent: 'claude' }, { agent: 'codex' }],
          implement: { agent: 'claude' },
          review: { agent: 'claude' },
          deliver: { agent: 'claude' },
          ...bindings,
        },
        ...extra,
      },
    },
  ]);
}

test('all six stages unbound are listed together', () => {
  assert.throws(
    () => buildGraph(mergeLayers([])),
    (e: unknown) => {
      assert.ok(e instanceof GraphError);
      assert.equal(e.message, 'unbound stages: intake, groom, plan, implement, review, deliver');
      return true;
    },
  );
});

test('orders hooks, slots and core gate', () => {
  const g = buildGraph(
    full({ nodes: { tm: { after: 'plan', agent: 'claude' }, pre: { before: 'all', kind: 'script', command: ['x'] } } }),
  );
  assert.deepEqual(
    g.steps.map((s) => s.id),
    ['pre', 'intake', 'groom', 'approve-groom', 'plan.0', 'plan.1', 'tm', 'implement', 'review', 'deliver'],
  );
});

test('review back-edge jumps to implement region incl. its before-hooks', () => {
  const g = buildGraph(full({ nodes: { lint: { before: 'implement', kind: 'script', command: ['lint'] } } }));
  const e = g.backEdges['review']!;
  assert.equal(e.toStepIndex, g.steps.findIndex((s) => s.id === 'lint'));
  assert.equal(e.maxRounds, 3);
  assert.equal(e.onCap, 'continue');
});

test('on_fail creates escalating back-edge', () => {
  const g = buildGraph(
    full({ nodes: { qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } } }),
  );
  const e = g.backEdges['qa']!;
  assert.equal(e.id, 'qa');
  assert.equal(e.fromStepId, 'qa');
  assert.equal(e.toStepIndex, g.regionStart.implement);
  assert.equal(e.maxRounds, 2);
  assert.equal(e.onCap, 'escalate');
});

test('back_to a later stage is rejected', () => {
  assert.throws(
    () => buildGraph(full({ nodes: { x: { after: 'plan', agent: 'claude', on_fail: { back_to: 'deliver', max_rounds: 1 } } } })),
    (e: unknown) => e instanceof GraphError && /back_to must point to an earlier stage/.test(e.message) && e.path === 'nodes.x',
  );
});

test('extension node without position is rejected', () => {
  assert.throws(
    () => buildGraph(full({ nodes: { loose: { agent: 'claude' } } })),
    (e: unknown) => e instanceof GraphError && e.path === 'nodes.loose',
  );
});

test('review on_fail is rejected: the review loop is core-owned', () => {
  assert.throws(
    () => buildGraph(full({}, { review: { agent: 'claude', on_fail: { back_to: 'implement', max_rounds: 2 } } })),
    (e: unknown) =>
      e instanceof GraphError && e.message.includes('review loop is core-owned; set max_rounds on the review binding instead'),
  );
});

test('on_fail on a non-last review slot node is allowed', () => {
  const g = buildGraph(
    full({}, { review: [{ agent: 'a', on_fail: { back_to: 'plan', max_rounds: 2 } }, { agent: 'b', max_rounds: 5 }] }),
  );
  assert.equal(g.backEdges['review.0']!.onCap, 'escalate');
  assert.equal(g.backEdges['review.1']!.maxRounds, 5);
  assert.equal(g.backEdges['review.1']!.onCap, 'continue');
});

test('before-all hook may not declare on_fail', () => {
  assert.throws(
    () =>
      buildGraph(
        full({ nodes: { pre: { before: 'all', kind: 'script', command: ['x'], on_fail: { back_to: 'intake', max_rounds: 1 } } } }),
      ),
    (e: unknown) => e instanceof GraphError && /before-all/.test(e.message) && e.path === 'nodes.pre',
  );
});

test('after-all hook may target any stage', () => {
  const g = buildGraph(
    full({ nodes: { post: { after: 'all', kind: 'script', command: ['x'], on_fail: { back_to: 'deliver', max_rounds: 1 } } } }),
  );
  assert.equal(g.backEdges['post']!.toStepIndex, g.regionStart.deliver);
});

test('regionStart for a stage without before-hooks is its first slot step', () => {
  const g = buildGraph(full());
  assert.equal(g.regionStart.plan, g.steps.findIndex((s) => s.id === 'plan.0'));
  for (const [stage, i] of Object.entries(g.regionStart)) assert.equal(g.steps[i]!.stage, stage);
});

test('core gate back-edge goes to groom region, max 3, escalates', () => {
  const g = buildGraph(full());
  assert.deepEqual(g.backEdges['approve-groom'], {
    id: 'approve-groom',
    fromStepId: 'approve-groom',
    toStepIndex: g.regionStart.groom,
    jumpAfterIndex: g.steps.findIndex((s) => s.id === 'approve-groom'),
    maxRounds: 3,
    onCap: 'escalate',
  });
});

test('slotLast is true only for the last node of each slot; hooks never', () => {
  const g = buildGraph(full({ nodes: { tm: { after: 'plan', agent: 'claude' } } }));
  assert.deepEqual(
    g.steps.filter((s) => s.slotLast).map((s) => s.id),
    ['intake', 'groom', 'plan.1', 'implement', 'review', 'deliver'],
  );
});

test('step name is the stage for slot nodes and the node name for hooks', () => {
  const g = buildGraph(full());
  assert.equal(g.steps.find((s) => s.id === 'plan.1')!.name, 'plan');
  assert.equal(g.steps.find((s) => s.id === 'approve-groom')!.name, 'approve-groom');
});

test('hook named like a core step id is rejected (review)', () => {
  assert.throws(
    () => buildGraph(full({ nodes: { review: { before: 'deliver', kind: 'script', command: ['x'] } } })),
    (e: unknown) =>
      e instanceof GraphError &&
      e.path === 'nodes.review' &&
      e.message === 'nodes.review: node "review" clashes with a core step id; rename it',
  );
});

test('hook named like a multi-node slot step id is rejected (plan.0)', () => {
  assert.throws(
    () => buildGraph(full({ nodes: { 'plan.0': { after: 'plan', kind: 'script', command: ['x'] } } })),
    (e: unknown) => e instanceof GraphError && e.path === 'nodes.plan.0' && /clashes with a core step id/.test(e.message),
  );
});

test('review back-edge jumps after the last after:review hook', () => {
  const g = buildGraph(full({ nodes: { rep: { after: 'review', kind: 'script', command: ['x'] } } }));
  const e = g.backEdges['review']!;
  assert.equal(e.fromStepId, 'review');
  assert.equal(e.jumpAfterIndex, g.steps.findIndex((s) => s.id === 'rep'));
});

test('review jumpAfterIndex is the review step when no after:review hooks', () => {
  const g = buildGraph(full());
  assert.equal(g.backEdges['review']!.jumpAfterIndex, g.steps.findIndex((s) => s.id === 'review'));
});

test('on_fail edge jumps after its own step', () => {
  const g = buildGraph(
    full({ nodes: { qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } } }),
  );
  assert.equal(g.backEdges['qa']!.jumpAfterIndex, g.steps.findIndex((s) => s.id === 'qa'));
});

test('max_rounds_ceiling clamps the core gate cap; no ceiling leaves 3', () => {
  const withRules = (ceilings: number[]) =>
    mergeLayers([
      { source: 'a', fragment: { bindings: full().bindings as never, rules: { max_rounds_ceiling: ceilings[0]! } } },
      ...(ceilings[1] ? [{ source: 'b', fragment: { rules: { max_rounds_ceiling: ceilings[1] } } }] : []),
    ]);
  assert.equal(buildGraph(withRules([2])).backEdges['approve-groom']!.maxRounds, 2);
  assert.equal(buildGraph(withRules([5, 2])).backEdges['approve-groom']!.maxRounds, 2);
  assert.equal(buildGraph(withRules([9])).backEdges['approve-groom']!.maxRounds, 3);
  assert.equal(buildGraph(full()).backEdges['approve-groom']!.maxRounds, 3);
});

test('after:X hook may back_to X', () => {
  const g = buildGraph(
    full({ nodes: { chk: { after: 'plan', kind: 'script', command: ['x'], on_fail: { back_to: 'plan', max_rounds: 2 } } } }),
  );
  assert.equal(g.backEdges['chk']!.toStepIndex, g.regionStart.plan);
});

test('on_fail on a non-review slot node is allowed', () => {
  const g = buildGraph(full({}, { implement: { agent: 'claude', on_fail: { back_to: 'plan', max_rounds: 2 } } }));
  assert.equal(g.backEdges['implement']!.toStepIndex, g.regionStart.plan);
  assert.equal(g.backEdges['implement']!.onCap, 'escalate');
});

test('buildGraph does not mutate Merged', () => {
  const m = full({ nodes: { qa: { before: 'deliver', kind: 'script', command: ['q'] } } });
  const snapshot = structuredClone(m);
  buildGraph(m);
  assert.deepEqual(m, snapshot);
});

test('failRoutes routes every review slot step to the review edge', () => {
  const g = buildGraph(full({}, { review: [{ agent: 'a' }, { agent: 'b' }] }));
  assert.equal(g.failRoutes['review.0'], 'review.1');
  assert.equal(g.failRoutes['review.1'], 'review.1');
  assert.deepEqual(Object.keys(g.backEdges).sort(), ['approve-groom', 'review.1']);
});

test('failRoutes routes a step with its own on_fail to its own edge', () => {
  const g = buildGraph(
    full(
      { nodes: { qa: { before: 'deliver', kind: 'script', command: ['qa'], on_fail: { back_to: 'implement', max_rounds: 2 } } } },
      { review: [{ agent: 'a', on_fail: { back_to: 'plan', max_rounds: 2 } }, { agent: 'b' }] },
    ),
  );
  assert.equal(g.failRoutes['qa'], 'qa');
  assert.equal(g.failRoutes['review.0'], 'review.0');
  assert.equal(g.failRoutes['review.1'], 'review.1');
  assert.equal(g.failRoutes['approve-groom'], 'approve-groom');
  assert.equal(g.failRoutes['implement'], undefined);
});
