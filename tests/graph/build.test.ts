import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, GraphError } from '../../src/graph/build.ts';
import { mappingsFor } from '../../src/grounds/mappings.ts';
import type { Mapping } from '../../src/config/schema.ts';
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
          deliver: { builtin: 'github.open_pr' },
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
      assert.equal(e.message, 'config: stages unbound: intake, groom, plan, implement, review, deliver; bind each under bindings:');
      assert.equal(e.file, 'config');
      return true;
    },
  );
});

const allBut = (stage: string) =>
  mergeLayers([
    {
      source: 'ground:g',
      fragment: {
        bindings: Object.fromEntries(
          ['intake', 'groom', 'plan', 'implement', 'review', 'deliver'].filter((s) => s !== stage).map((s) => [s, { command: ['x'] }]),
        ),
      },
    },
  ]);

test('unbound stages name the profile at its bindings: line', () => {
  const home = { profile: 'w', locator: { file: 'c.yaml', lines: { 'profiles.w': 3, 'profiles.w.bindings': 4 }, prefix: 'profiles.w' } };
  assert.throws(() => buildGraph(allBut('plan'), home), (e: unknown) => {
    assert.ok(e instanceof GraphError);
    assert.equal(e.message, 'c.yaml:4: profile "w" leaves stages unbound: plan; bind each under bindings:');
    assert.equal(e.file, 'c.yaml');
    assert.equal(e.line, 4);
    assert.equal(e.path, undefined);
    return true;
  });
});

test('unbound stages fall back to the profile line when it has no bindings: key', () => {
  const home = { profile: 'w', locator: { file: 'c.yaml', lines: { 'profiles.w': 3 }, prefix: 'profiles.w' } };
  assert.throws(() => buildGraph(allBut('review'), home), {
    message: 'c.yaml:3: profile "w" leaves stages unbound: review; bind each under bindings:',
  });
});

/** full(), written in g.yaml with the given key lines. */
function fullAt(lines: Record<string, number>, extra: Pick<GraphFragment, 'nodes'> = {}, bindings: GraphFragment['bindings'] = {}) {
  const merged = full(extra, bindings);
  const locator = { file: 'g.yaml', lines };
  for (const b of Object.values(merged.bindings)) b.locator = locator;
  for (const n of Object.values(merged.nodes)) if (n.source !== 'core') n.locator = locator;
  return merged;
}

test('graph errors give the file and line of the offending key', () => {
  const cases: [ReturnType<typeof full>, string, string][] = [
    [
      fullAt({ 'nodes.x': 5, 'nodes.x.on_fail.back_to': 7 }, { nodes: { x: { after: 'plan', agent: 'claude', on_fail: { back_to: 'deliver', max_rounds: 1 } } } }),
      'g.yaml:7: nodes.x.on_fail.back_to: back_to must point to an earlier stage (got "deliver" at "x"); use "plan" or an earlier stage',
      'nodes.x.on_fail.back_to',
    ],
    [
      fullAt({ 'nodes.loose': 5 }, { nodes: { loose: { agent: 'claude' } } }),
      'g.yaml:5: nodes.loose: extension node "loose" needs "before" or "after"; attach it to a stage or all',
      'nodes.loose',
    ],
    [
      fullAt({ 'bindings.review': 9 }, {}, { review: { agent: 'claude', on_fail: { back_to: 'implement', max_rounds: 2 } } }),
      'g.yaml:9: bindings.review.on_fail: review loop is core-owned; set max_rounds on the review binding instead',
      'bindings.review.on_fail',
    ],
    [
      fullAt({ 'nodes.pre': 5, 'nodes.pre.on_fail': 6 }, { nodes: { pre: { before: 'all', kind: 'script', command: ['x'], on_fail: { back_to: 'intake', max_rounds: 1 } } } }),
      'g.yaml:6: nodes.pre.on_fail: a before-all hook cannot declare on_fail (no earlier stage to return to); remove on_fail or attach the hook to a stage',
      'nodes.pre.on_fail',
    ],
    [
      fullAt({ 'nodes.plan.0': 5 }, { nodes: { 'plan.0': { after: 'plan', kind: 'script', command: ['x'] } } }),
      'g.yaml:5: nodes.plan.0: node "plan.0" clashes with a core step id; rename it',
      'nodes.plan.0',
    ],
    [
      fullAt({ 'bindings.deliver': 11 }, {}, { deliver: { agent: 'claude' } }),
      'g.yaml:11: bindings.deliver: deliver cannot be an agent node: Percolator opens the PR itself (use { builtin: github.open_pr })',
      'bindings.deliver',
    ],
  ];
  for (const [merged, message, p] of cases) {
    assert.throws(() => buildGraph(merged), (e: unknown) => {
      assert.ok(e instanceof GraphError);
      assert.equal(e.message, message);
      assert.equal(e.file, 'g.yaml');
      assert.equal(e.path, p);
      return true;
    });
  }
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
    {
      name: 'GraphError',
      path: 'nodes.x.on_fail.back_to',
      message: 'config: nodes.x.on_fail.back_to: back_to must point to an earlier stage (got "deliver" at "x"); use "plan" or an earlier stage',
    },
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
    (e: unknown) => e instanceof GraphError && /before-all/.test(e.message) && e.path === 'nodes.pre.on_fail',
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
      e.message === 'config: nodes.review: node "review" clashes with a core step id; rename it',
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

test('steps carry the source and lock of their binding', () => {
  const merged = mergeLayers([
    {
      source: 'profile:p',
      fragment: {
        bindings: {
          intake: { agent: 'claude' },
          groom: { agent: 'claude' },
          plan: { agent: 'claude', required: true },
          implement: { agent: 'claude' },
          review: { agent: 'claude' },
          deliver: { builtin: 'github.open_pr' },
        },
      },
    },
  ]);
  const g = buildGraph(merged);
  const byId = (id: string) => g.steps.find((s) => s.id === id)!;
  assert.deepEqual({ source: byId('plan').source, locked: byId('plan').locked }, { source: 'profile:p', locked: true });
  assert.deepEqual({ source: byId('intake').source, locked: byId('intake').locked }, { source: 'profile:p', locked: false });
  assert.deepEqual({ source: byId('approve-groom').source, locked: byId('approve-groom').locked }, { source: 'core', locked: true });
});

test('mappingsFor matches *, stage (slots only), node name and step id', () => {
  const g = buildGraph(full({ nodes: { 'threat-model': { after: 'plan', agent: 'claude' } } }));
  const m = (applies_to: string[]): Mapping => ({ from: 'g', file: 'f.md', as: 'policy', applies_to, required: false });
  const maps = [m(['*']), m(['plan']), m(['plan.1']), m(['threat-model'])];
  const at = (id: string) => mappingsFor(g.steps.find((s) => s.id === id)!, maps).map((x) => x.applies_to[0]);
  assert.deepEqual(at('plan.0'), ['*', 'plan']);
  assert.deepEqual(at('plan.1'), ['*', 'plan', 'plan.1']);
  assert.deepEqual(at('threat-model'), ['*', 'threat-model']);
});

test('deliver cannot be an agent node; script and builtin are fine', () => {
  assert.throws(
    () => buildGraph(full({}, { deliver: { agent: 'claude' } })),
    (e: unknown) => {
      assert.ok(e instanceof GraphError);
      assert.equal(
        (e as Error).message,
        'config: bindings.deliver: deliver cannot be an agent node: Percolator opens the PR itself (use { builtin: github.open_pr })',
      );
      assert.equal((e as GraphError).path, 'bindings.deliver');
      return true;
    },
  );
  assert.throws(() => buildGraph(full({}, { deliver: [{ command: ['x'] }, { agent: 'claude' }] })), /deliver cannot be an agent node/);
  buildGraph(full({}, { deliver: { command: ['x'] } }));
});

test('a one-item list binding is located at its item: bindings.<stage>.0', () => {
  const merged = fullAt(
    { 'bindings.implement': 9, 'bindings.implement.0': 10, 'bindings.implement.0.on_fail': 11, 'bindings.implement.0.on_fail.back_to': 12 },
    {},
    { implement: [{ agent: 'claude', on_fail: { back_to: 'deliver', max_rounds: 1 } }] },
  );
  assert.throws(() => buildGraph(merged), {
    message: 'g.yaml:12: bindings.implement.0.on_fail.back_to: back_to must point to an earlier stage (got "deliver" at "implement"); use "implement" or an earlier stage',
    path: 'bindings.implement.0.on_fail.back_to',
  });
});
