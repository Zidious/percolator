import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, GraphError } from '../../src/graph/build.ts';
import { mappingsFor } from '../../src/grounds/mappings.ts';
import type { Mapping } from '../../src/config/schema.ts';
import { mergeLayers, mergePipelines } from '../../src/graph/merge.ts';
import { STAGE_CONTRACTS } from '../../src/graph/core.ts';
import type { Pipeline } from '../../src/config/schema.ts';
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

// ---- pipelines ----

const HOTFIX: Pipeline = {
  stages: ['intake', 'reproduce', 'fix', 'review', 'deliver'],
  outputs: { reproduce: ['failing_test'] },
  bindings: { reproduce: { agent: 'claude' }, fix: { agent: 'claude' }, review: { agent: 'claude' } },
  exit: 'pr',
};
/** The hotfix pipeline, merged from one profile layer at c.yaml (prefix profiles.default). */
function hotfix(over: Partial<Pipeline> = {}, lines: Record<string, number> = {}) {
  const bindings = Object.fromEntries(
    Object.entries({ ...HOTFIX.bindings, ...over.bindings }).filter(([, v]) => v !== undefined),
  ) as Pipeline['bindings'];
  const p = { ...HOTFIX, ...over, bindings };
  return mergePipelines([
    { source: 'profile:default', fragment: { pipelines: { hotfix: p } }, locator: { file: 'c.yaml', lines, prefix: 'profiles.default' } },
  ]).hotfix!;
}
function hotfixWithout(key: 'stages' | 'exit', bindings: Pipeline['bindings'] = {}) {
  const p: Pipeline = { ...HOTFIX, bindings: { ...HOTFIX.bindings, ...bindings } };
  delete p[key];
  return mergePipelines([
    { source: 'profile:default', fragment: { pipelines: { hotfix: p } }, locator: { file: 'c.yaml', lines: {}, prefix: 'profiles.default' } },
  ]).hotfix!;
}
const HOME = {
  profile: 'default',
  locator: { file: 'c.yaml', lines: { 'profiles.default': 2, 'profiles.default.pipelines.hotfix': 4 }, prefix: 'profiles.default' },
};

function throwsAt(fn: () => unknown, message: string, p: string | undefined) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof GraphError);
    assert.equal(e.message, message);
    assert.equal(e.path, p);
    return true;
  });
}

test("builds the chosen pipeline's stages in order", () => {
  const g = buildGraph(hotfix());
  assert.equal(g.pipeline, 'hotfix');
  assert.deepEqual(g.stages, ['intake', 'reproduce', 'fix', 'review', 'deliver']);
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'reproduce', 'fix', 'review', 'deliver']);
  assert.equal(g.exit, 'pr');
});

test("contracts come from the pipeline's outputs", () => {
  assert.deepEqual(buildGraph(hotfix()).contracts, {
    intake: ['ticket'],
    reproduce: ['failing_test'],
    fix: [],
    review: ['findings'],
    deliver: ['pr_url'],
  });
});

test('feature contracts are unchanged', () => {
  const g = buildGraph(full());
  assert.deepEqual(g.contracts, Object.fromEntries(Object.entries(STAGE_CONTRACTS).map(([k, v]) => [k, [...v.requiredOutputs]])));
  assert.equal(g.pipeline, 'feature');
});

test('exit implied by exit: pr when deliver is unbound; intake defaults to github.intake', () => {
  const g = buildGraph(hotfix());
  assert.deepEqual(g.steps.at(-1)!.def, { builtin: 'github.open_pr' });
  assert.deepEqual(g.steps[0]!.def, { builtin: 'github.intake' });
});

test('a pipeline must start with intake', () => {
  throwsAt(
    () => buildGraph(hotfix({ stages: ['reproduce', 'deliver'] }, { 'profiles.default.pipelines.hotfix.stages': 6 })),
    'c.yaml:6: profiles.default.pipelines.hotfix.stages: pipeline "hotfix" must start with intake; add intake as its first stage',
    'profiles.default.pipelines.hotfix.stages',
  );
});

test('duplicate stages are refused', () => {
  throwsAt(
    () => buildGraph(hotfix({ stages: ['intake', 'fix', 'fix', 'deliver'] })),
    'c.yaml: profiles.default.pipelines.hotfix.stages.2: stage "fix" is listed twice in pipeline "hotfix"; list each stage once',
    'profiles.default.pipelines.hotfix.stages.2',
  );
});

test('a pipeline other than feature needs stages', () => {
  throwsAt(
    () => buildGraph(hotfixWithout('stages')),
    'c.yaml: profiles.default.pipelines.hotfix: pipeline "hotfix" needs stages: list them, starting with intake and ending with its exit stage',
    'profiles.default.pipelines.hotfix',
  );
});

test('a named pipeline lists its unbound stages', () => {
  assert.throws(() => buildGraph(hotfix({ bindings: { fix: undefined as never } }), HOME), (e: unknown) => {
    assert.ok(e instanceof GraphError);
    assert.equal(
      e.message,
      'c.yaml:4: pipeline "hotfix" in profile "default" leaves stages unbound: fix; bind each under pipelines.hotfix.bindings:',
    );
    return true;
  });
});

test('a pipeline without an exit is refused', () => {
  throwsAt(
    () => buildGraph(hotfixWithout('exit')),
    'c.yaml: profiles.default.pipelines.hotfix: pipeline "hotfix" has no exit: bind its last stage "deliver" to one of github.open_pr, github.comment, github.open_issues, percolator.report, github.release, github.pr_review, github.private_fork_pr or set exit:',
    'profiles.default.pipelines.hotfix',
  );
});

test('a builtin exit binding implies the exit', () => {
  assert.equal(buildGraph(hotfixWithout('exit', { deliver: { builtin: 'github.open_pr' } })).exit, 'pr');
});

test('exit and binding must agree', () => {
  throwsAt(
    () => buildGraph(hotfix({ bindings: { deliver: { command: ['x'] } } }, { 'profiles.default.pipelines.hotfix.bindings.deliver': 9 })),
    'c.yaml:9: profiles.default.pipelines.hotfix.bindings.deliver: exit pr runs github.open_pr, but stage "deliver" is bound to a command; bind it to { builtin: github.open_pr } or change exit',
    'profiles.default.pipelines.hotfix.bindings.deliver',
  );
});

test('an exit kind implies its builtin on an unbound exit stage', () => {
  assert.deepEqual(buildGraph(hotfix({ exit: 'none' })).steps.at(-1)!.def, { builtin: 'percolator.report' });
  assert.deepEqual(buildGraph(hotfix({ exit: 'comment' })).steps.at(-1)!.def, { builtin: 'github.comment' });
  assert.equal(buildGraph(hotfixWithout('exit', { deliver: { builtin: 'github.comment' } })).exit, 'comment');
});

test('exit comment needs a ticket', () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'comment', ticket: 'none' })),
    "c.yaml: profiles.default.pipelines.hotfix: exit comment posts on the run's issue, but pipeline \"hotfix\" has ticket: none; set ticket: required or pick another exit",
    'profiles.default.pipelines.hotfix',
  );
});

test('exit comment needs a ticket on every run', () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'comment', ticket: 'optional' })),
    "c.yaml: profiles.default.pipelines.hotfix: exit comment posts on the run's issue, but pipeline \"hotfix\" has ticket: optional; set ticket: required or pick another exit",
    'profiles.default.pipelines.hotfix',
  );
});

test('exit pr_review needs input pr', () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'pr_review' })),
    'c.yaml: profiles.default.pipelines.hotfix: exit pr_review needs input "pr" (the pull request to review); declare it under pipelines.hotfix.inputs',
    'profiles.default.pipelines.hotfix',
  );
  assert.equal(buildGraph(hotfix({ exit: 'pr_review', inputs: { pr: { required: true } } })).exit, 'pr_review');
});

test("an exit's input must be required", () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'pr_review', inputs: { pr: { required: false } } })),
    'c.yaml: profiles.default.pipelines.hotfix: exit pr_review needs input "pr" (the pull request to review) on every run, but pipeline "hotfix" makes it optional; set required: true on pipelines.hotfix.inputs.pr',
    'profiles.default.pipelines.hotfix',
  );
  throwsAt(
    () => buildGraph(hotfix({ exit: 'private_fork_pr', inputs: { advisory: {} } as never })),
    'c.yaml: profiles.default.pipelines.hotfix: exit private_fork_pr needs input "advisory" (the GHSA id) on every run, but pipeline "hotfix" makes it optional; set required: true on pipelines.hotfix.inputs.advisory',
    'profiles.default.pipelines.hotfix',
  );
});

test('exit private_fork_pr needs input advisory', () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'private_fork_pr' })),
    'c.yaml: profiles.default.pipelines.hotfix: exit private_fork_pr needs input "advisory" (the GHSA id); declare it under pipelines.hotfix.inputs',
    'profiles.default.pipelines.hotfix',
  );
  assert.equal(buildGraph(hotfix({ exit: 'private_fork_pr', inputs: { advisory: { required: true } } })).exit, 'private_fork_pr');
});

test('exit release needs a tag', () => {
  throwsAt(
    () => buildGraph(hotfix({ exit: 'release', outputs: { deliver: ['tag'] } })),
    'c.yaml: profiles.default.pipelines.hotfix: exit release needs a tag: declare input "tag" or list "tag" under outputs of an earlier stage',
    'profiles.default.pipelines.hotfix',
  );
  assert.equal(buildGraph(hotfix({ exit: 'release', outputs: { fix: ['tag'] } })).exit, 'release');
});

test('contracts for a release exit stage include release_url', () => {
  const g = buildGraph(hotfix({ exit: 'release', inputs: { tag: { required: true } } }));
  assert.deepEqual(g.contracts.deliver, ['release_url']);
});

test('exits that may write nothing add no contract to the exit stage', () => {
  assert.deepEqual(buildGraph(hotfix({ exit: 'none' })).contracts.deliver, []);
  assert.deepEqual(buildGraph(hotfix({ exit: 'issue' })).contracts.deliver, []);
});

test('the exit stage of any pipeline cannot be an agent node', () => {
  throwsAt(
    () => buildGraph(hotfix({ bindings: { deliver: { agent: 'claude' } } })),
    'c.yaml: profiles.default.pipelines.hotfix.bindings.deliver: deliver cannot be an agent node: Percolator opens the PR itself (use { builtin: github.open_pr })',
    'profiles.default.pipelines.hotfix.bindings.deliver',
  );
});

test('a hook naming an unknown stage is refused', () => {
  throwsAt(
    () =>
      buildGraph(
        hotfix(
          { nodes: { lint: { kind: 'script', command: ['x'], after: 'groom' } } },
          { 'profiles.default.pipelines.hotfix.nodes.lint.after': 12 },
        ),
      ),
    'c.yaml:12: profiles.default.pipelines.hotfix.nodes.lint.after: "after: groom" names no stage of pipeline "hotfix" (stages: intake, reproduce, fix, review, deliver); attach it to one of those or all',
    'profiles.default.pipelines.hotfix.nodes.lint.after',
  );
});

test('a feature hook naming an unknown stage is refused', () => {
  assert.throws(() => buildGraph(full({ nodes: { x: { kind: 'script', command: ['x'], before: 'nope' } } })), {
    message:
      'config: nodes.x.before: "before: nope" names no stage of pipeline "feature" (stages: intake, groom, plan, implement, review, deliver); attach it to one of those or all',
  });
});

test('back_to an unknown stage is refused', () => {
  throwsAt(
    () => buildGraph(hotfix({ nodes: { t: { kind: 'script', command: ['x'], after: 'fix', on_fail: { back_to: 'plan', max_rounds: 2 } } } })),
    'c.yaml: profiles.default.pipelines.hotfix.nodes.t.on_fail.back_to: back_to "plan" is not a stage of pipeline "hotfix" (stages: intake, reproduce, fix, review, deliver); use one of those',
    'profiles.default.pipelines.hotfix.nodes.t.on_fail.back_to',
  );
});

test('max_rounds on any stage loops back to the stage before it', () => {
  const g = buildGraph(hotfix({ bindings: { fix: { agent: 'claude', max_rounds: 2 } } }));
  assert.deepEqual(g.backEdges.fix, {
    id: 'fix',
    fromStepId: 'fix',
    toStepIndex: g.regionStart.reproduce,
    jumpAfterIndex: g.steps.findIndex((s) => s.id === 'fix'),
    maxRounds: 2,
    onCap: 'continue',
  });
  assert.deepEqual(g.loopStages, ['fix', 'review']);
  assert.equal(g.failRoutes.fix, 'fix');
  assert.equal(g.backEdges.review!.toStepIndex, g.regionStart.fix);
});

test('intake cannot loop', () => {
  throwsAt(
    () => buildGraph(hotfix({ bindings: { intake: { builtin: 'github.intake', kind: 'builtin', max_rounds: 2 } } })),
    'c.yaml: profiles.default.pipelines.hotfix.bindings.intake: stage "intake" cannot loop: there is no stage before it; remove max_rounds',
    'profiles.default.pipelines.hotfix.bindings.intake',
  );
});

test('a custom loop stage refuses on_fail on its last node', () => {
  throwsAt(
    () =>
      buildGraph(hotfix({ bindings: { fix: { agent: 'claude', max_rounds: 2, on_fail: { back_to: 'reproduce', max_rounds: 2 } } } })),
    'c.yaml: profiles.default.pipelines.hotfix.bindings.fix.on_fail: fix loop is set by max_rounds on its binding; remove on_fail from its last node',
    'profiles.default.pipelines.hotfix.bindings.fix.on_fail',
  );
});

test('the feature graph keeps its loop stages', () => {
  assert.deepEqual(buildGraph(full()).loopStages, ['review']);
});

const TRIAGE: Pipeline = {
  router: true,
  stages: ['intake', 'route'],
  routes: [{ label: 'bug', to: 'hotfix' }],
  choose: { agent: 'claude', model: 'opus', from: ['hotfix', 'feature'] },
  fallback: 'feature',
};
/** The triage router, merged from one profile layer at c.yaml (prefix profiles.default). */
function triage(over: Partial<Pipeline> = {}, lines: Record<string, number> = {}) {
  const p: Pipeline = { ...TRIAGE, ...over };
  for (const k of Object.keys(p) as (keyof Pipeline)[]) if (p[k] === undefined) delete p[k];
  return mergePipelines([
    { source: 'profile:default', fragment: { pipelines: { triage: p } }, locator: { file: 'c.yaml', lines, prefix: 'profiles.default' } },
  ]).triage!;
}
const PICK_PROMPT =
  'Pick the pipeline for this ticket from: hotfix: fix a bug fast; feature. Write pick.md: first line "pipeline: <name>", second line "unsure: true" or "unsure: false", then your reasons. Feedback from an earlier pick, if any, is in the inputs.';

test('a router builds rules, choose, pick-pipeline and route steps', () => {
  const g = buildGraph(triage(), undefined, { descriptions: { hotfix: 'fix a bug fast' } });
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'route.0', 'route.1', 'pick-pipeline', 'route.3']);
  assert.deepEqual(g.steps.map((s) => s.def), [
    { builtin: 'github.intake' },
    { builtin: 'percolator.route_rules' },
    { agent: 'claude', model: 'opus', prompt: PICK_PROMPT },
    { kind: 'gate', on_fail: { back_to: 'route', max_rounds: 3 } },
    { builtin: 'percolator.route' },
  ]);
  assert.deepEqual(g.steps.slice(1).map((s) => [s.stage, s.name, s.slotLast]), [
    ['route', 'route', false],
    ['route', 'route', false],
    ['route', 'pick-pipeline', false],
    ['route', 'route', true],
  ]);
  assert.equal(g.exit, 'route');
  assert.deepEqual(g.contracts, { intake: ['ticket'], route: ['route'] });
  assert.deepEqual(g.loopStages, []);
});

test("a router's pick-pipeline gate loops back to its own route stage", () => {
  const g = buildGraph(triage());
  assert.deepEqual(g.backEdges['pick-pipeline'], {
    id: 'pick-pipeline',
    fromStepId: 'pick-pipeline',
    toStepIndex: g.regionStart.route,
    jumpAfterIndex: 3,
    maxRounds: 3,
    onCap: 'escalate',
  });
  assert.equal(g.failRoutes['pick-pipeline'], 'pick-pipeline');
  assert.equal(g.failRoutes['route.1'], undefined);
});

test('the choose prompt and agent settings pass through; names without a description stand alone', () => {
  const g = buildGraph(triage({ choose: { agent: 'codex', effort: 'high', skills: ['triage'], prompt: 'pick one', from: ['hotfix'] } }));
  assert.deepEqual(g.steps[2]!.def, { agent: 'codex', effort: 'high', skills: ['triage'], prompt: 'pick one' });
  const plain = buildGraph(triage());
  assert.match(String(plain.steps[2]!.def.prompt), /^Pick the pipeline for this ticket from: hotfix; feature\. Write pick\.md/);
});

test('choose.command passes through to the choose step', () => {
  const g = buildGraph(triage({ choose: { agent: 'command', command: ['node', 'pick.js'], from: ['hotfix'] } }));
  const { prompt, ...rest } = g.steps[2]!.def;
  assert.deepEqual(rest, { agent: 'command', command: ['node', 'pick.js'] });
  assert.match(String(prompt), /^Pick the pipeline for this ticket from: hotfix\. Write pick\.md/);
});

test('max_rounds_ceiling clamps the pick-pipeline cap', () => {
  const merged = triage();
  merged.rules.push({ value: { max_rounds_ceiling: 2 }, source: 'r', locked: false });
  assert.equal(buildGraph(merged).backEdges['pick-pipeline']!.maxRounds, 2);
});

test('a router without choose builds rules and route only', () => {
  const g = buildGraph(triage({ choose: undefined }));
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'route.0', 'route.3']);
  assert.deepEqual(g.backEdges, {});
});

test('a router cannot set exit', () => {
  throwsAt(
    () => buildGraph(triage({ exit: 'pr' }, { 'profiles.default.pipelines.triage.exit': 7 })),
    'c.yaml:7: profiles.default.pipelines.triage.exit: router pipeline "triage" cannot set exit: its route stage hands the ticket to another pipeline; remove exit',
    'profiles.default.pipelines.triage.exit',
  );
});

test('binding route on a router is refused', () => {
  throwsAt(
    () =>
      buildGraph(
        triage({ bindings: { route: { builtin: 'percolator.route' } } }, { 'profiles.default.pipelines.triage.bindings.route': 9 }),
      ),
    'c.yaml:9: profiles.default.pipelines.triage.bindings.route: stage "route" of a router is built in; configure it with routes, choose and fallback',
    'profiles.default.pipelines.triage.bindings.route',
  );
});

test('a router must end with its route stage', () => {
  throwsAt(
    () => buildGraph(triage({ stages: ['intake', 'route', 'deliver'] })),
    'c.yaml: profiles.default.pipelines.triage.stages: router pipeline "triage" must end with stage route; make route its last stage',
    'profiles.default.pipelines.triage.stages',
  );
});

test('a router may run stages of its own before route', () => {
  const g = buildGraph(triage({ stages: ['intake', 'look', 'route'], bindings: { look: { agent: 'claude' } } }));
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'look', 'route.0', 'route.1', 'pick-pipeline', 'route.3']);
  assert.deepEqual(g.contracts, { intake: ['ticket'], look: [], route: ['route'] });
});

const EPIC: Pipeline = {
  stages: ['intake', 'plan', 'implement', 'review', 'deliver'],
  outputs: { plan: ['plan'] },
  bindings: { plan: { agent: 'claude' }, implement: { agent: 'claude' }, review: { agent: 'claude' } },
  nodes: { test: { kind: 'script', command: ['t'], after: 'implement', on_fail: { back_to: 'implement', max_rounds: 2 } } },
  exit: 'pr',
  fan_out: { stage: 'implement', slices: { from: 'plan', output: 'slices' } },
};
/** The epic pipeline (fans implement out over plan's slices), merged from one profile layer at c.yaml. */
function epic(over: Partial<Pipeline> = {}, lines: Record<string, number> = {}) {
  return mergePipelines([
    {
      source: 'profile:default',
      fragment: { pipelines: { epic: { ...EPIC, ...over } } },
      locator: { file: 'c.yaml', lines, prefix: 'profiles.default' },
    },
  ]).epic!;
}
const CHILD = { part: { sliceFrom: 'implement' } } as const;

test('fan-out parent graph ends at the fan-out step', () => {
  const g = buildGraph(epic());
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'plan', 'implement']);
  const last = g.steps.at(-1)!;
  assert.deepEqual([last.stage, last.name, last.role, last.slotLast, last.def], ['implement', 'implement', 'slot', true, { builtin: 'percolator.fan_out' }]);
  assert.deepEqual(g.stages, ['intake', 'plan', 'implement']);
  assert.deepEqual(g.regionStart, { intake: 0, plan: 1, implement: 2 });
  assert.deepEqual(g.backEdges, {});
  assert.deepEqual(g.failRoutes, {});
  assert.deepEqual(g.loopStages, []);
  assert.deepEqual(g.contracts, { intake: ['ticket'], plan: ['plan', 'slices'], implement: ['slices_done'] });
  assert.equal(g.exit, 'pr');
  assert.deepEqual(buildGraph(epic(), undefined, { part: 'parent' }), g);
});

test('fan-out child graph starts with seed and then the fanned stage', () => {
  const g = buildGraph(epic(), undefined, CHILD);
  assert.deepEqual(g.steps.map((s) => s.id), ['intake', 'implement', 'test', 'review', 'deliver']);
  const seed = g.steps[0]!;
  assert.deepEqual([seed.stage, seed.role, seed.slotLast, seed.source, seed.def], ['intake', 'slot', true, 'core', { builtin: 'percolator.seed' }]);
  assert.deepEqual(g.stages, ['intake', 'implement', 'review', 'deliver']);
  assert.deepEqual(g.regionStart, { intake: 0, implement: 1, review: 3, deliver: 4 });
  assert.deepEqual(g.contracts, { intake: ['ticket', 'slice'], implement: ['summary'], review: ['findings'], deliver: ['pr_url'] });
  assert.deepEqual(g.loopStages, ['review']);
  assert.equal(g.exit, 'pr');
});

test('a loop stage cannot be the fan-out stage', () => {
  const lines = { 'profiles.default.pipelines.epic.bindings.review': 12 };
  throwsAt(
    () => buildGraph(epic({ nodes: {}, fan_out: { stage: 'review', slices: { from: 'plan', output: 'slices' } } }, lines)),
    'c.yaml:12: profiles.default.pipelines.epic.bindings.review: review loops back to implement every round, so it cannot start a fan-out slice; set fan_out.stage to implement or an earlier stage',
    'profiles.default.pipelines.epic.bindings.review',
  );
});

test('child loops rebase onto the sliced steps', () => {
  const g = buildGraph(epic(), undefined, CHILD);
  assert.deepEqual(g.backEdges.test, { id: 'test', fromStepId: 'test', toStepIndex: 1, jumpAfterIndex: 2, maxRounds: 2, onCap: 'escalate' });
  assert.deepEqual(g.backEdges.review, { id: 'review', fromStepId: 'review', toStepIndex: 1, jumpAfterIndex: 3, maxRounds: 3, onCap: 'continue' });
  assert.deepEqual(g.failRoutes, { test: 'test', review: 'review' });
});

test('a child back_to before the fan-out is refused, for the parent too', () => {
  const nodes = { test: { kind: 'script' as const, command: ['t'], after: 'implement', on_fail: { back_to: 'plan', max_rounds: 2 } } };
  const lines = { 'profiles.default.pipelines.epic.nodes.test.on_fail.back_to': 14 };
  const message =
    'c.yaml:14: profiles.default.pipelines.epic.nodes.test.on_fail.back_to: test loops back to plan, which runs before the fan-out at implement; loop back to implement or later';
  throwsAt(() => buildGraph(epic({ nodes }, lines), undefined, CHILD), message, 'profiles.default.pipelines.epic.nodes.test.on_fail.back_to');
  throwsAt(() => buildGraph(epic({ nodes }, lines)), message, 'profiles.default.pipelines.epic.nodes.test.on_fail.back_to');
});

test('fan_out.stage must be a stage of the pipeline', () => {
  throwsAt(
    () => buildGraph(epic({ fan_out: { stage: 'build', slices: { from: 'plan', output: 'slices' } } }, { 'profiles.default.pipelines.epic.fan_out.stage': 11 })),
    'c.yaml:11: profiles.default.pipelines.epic.fan_out.stage: fan_out.stage "build" is not a stage of pipeline "epic"; use one of intake, plan, implement, review, deliver',
    'profiles.default.pipelines.epic.fan_out.stage',
  );
});

test('fan_out.slices.from must be a stage before the fanned stage', () => {
  for (const from of ['review', 'implement', 'nope']) {
    throwsAt(
      () => buildGraph(epic({ fan_out: { stage: 'implement', slices: { from, output: 'slices' } } })),
      'c.yaml: profiles.default.pipelines.epic.fan_out.slices.from: fan_out.slices.from must be a stage before implement',
      'profiles.default.pipelines.epic.fan_out.slices.from',
    );
  }
});

test('fan_out.stage cannot be intake or the exit stage', () => {
  for (const stage of ['intake', 'deliver']) {
    throwsAt(
      () => buildGraph(epic({ fan_out: { stage, slices: { from: 'intake', output: 'slices' } } })),
      'c.yaml: profiles.default.pipelines.epic.fan_out.stage: fan_out.stage cannot be intake or the exit stage',
      'profiles.default.pipelines.epic.fan_out.stage',
    );
  }
});

test('a pipeline without fan_out builds whole for part parent', () => {
  assert.deepEqual(buildGraph(full(), undefined, { part: 'parent' }), buildGraph(full()));
});

const at = (g: ReturnType<typeof buildGraph>, id: string) => g.steps.findIndex((s) => s.id === id);

test('gate after a stage without on_fail loops back to that stage', () => {
  const g = buildGraph(full({ nodes: { 'approve-plan': { kind: 'gate', after: 'plan' } } }));
  assert.deepEqual(g.backEdges['approve-plan'], {
    id: 'approve-plan',
    fromStepId: 'approve-plan',
    toStepIndex: g.regionStart.plan,
    jumpAfterIndex: at(g, 'approve-plan'),
    maxRounds: 3,
    onCap: 'escalate',
  });
  assert.equal(g.failRoutes['approve-plan'], 'approve-plan');
});

test('gate before a stage loops back to the stage before it', () => {
  const g = buildGraph(full({ nodes: { 'approve-x': { kind: 'gate', before: 'implement' } } }));
  assert.equal(g.backEdges['approve-x']!.toStepIndex, g.regionStart.plan);
  assert.equal(g.backEdges['approve-x']!.jumpAfterIndex, at(g, 'approve-x'));
});

test('slot gate goes back to its own stage after another node, else to the stage before', () => {
  const after = buildGraph(full({}, { plan: [{ agent: 'claude' }, { kind: 'gate' }] }));
  assert.equal(after.backEdges['plan.1']!.toStepIndex, after.regionStart.plan);
  assert.equal(after.failRoutes['plan.1'], 'plan.1');
  const first = buildGraph(full({}, { plan: [{ kind: 'gate' }, { agent: 'claude' }] }));
  assert.equal(first.backEdges['plan.0']!.toStepIndex, first.regionStart.groom);
});

test('explicit on_fail on a gate is kept', () => {
  const g = buildGraph(full({ nodes: { 'approve-x': { kind: 'gate', after: 'implement', on_fail: { back_to: 'plan', max_rounds: 2 } } } }));
  assert.equal(g.backEdges['approve-x']!.toStepIndex, g.regionStart.plan);
  assert.equal(g.backEdges['approve-x']!.maxRounds, 2);
});

test('implicit gate cap is clamped by max_rounds_ceiling', () => {
  const merged = full({ nodes: { 'approve-plan': { kind: 'gate', after: 'plan' } } }, { review: { agent: 'claude', max_rounds: 2 } });
  merged.rules.push({ value: { max_rounds_ceiling: 2 }, source: 'r', locked: false });
  assert.equal(buildGraph(merged).backEdges['approve-plan']!.maxRounds, 2);
});

test('gate in a loop stage after a node of it routes to the loop', () => {
  const g = buildGraph(full({ nodes: { 'approve-x': { kind: 'gate', after: 'review' } } }));
  assert.equal(g.backEdges['approve-x'], undefined);
  assert.equal(g.failRoutes['approve-x'], 'review');
  const slot = buildGraph(full({}, { review: [{ agent: 'claude' }, { kind: 'gate' }, { agent: 'codex' }] }));
  assert.equal(slot.backEdges['review.1'], undefined);
  assert.equal(slot.failRoutes['review.1'], 'review.2');
});

test('gate opening a loop stage goes back to the stage before at once, not after the stage has run', () => {
  const g = buildGraph(full({ nodes: { 'approve-x': { kind: 'gate', before: 'review' } } }));
  const at = g.steps.findIndex((s) => s.id === 'approve-x');
  assert.deepEqual(g.backEdges['approve-x'], {
    id: 'approve-x',
    fromStepId: 'approve-x',
    toStepIndex: g.regionStart.implement,
    jumpAfterIndex: at,
    maxRounds: 3,
    onCap: 'escalate',
  });
  assert.equal(g.failRoutes['approve-x'], 'approve-x');
  const slot = buildGraph(full({}, { review: [{ kind: 'gate' }, { agent: 'claude' }] }));
  assert.equal(slot.backEdges['review.0']!.toStepIndex, slot.regionStart.implement);
  assert.equal(slot.failRoutes['review.0'], 'review.0');
});

test('a gate without on_fail and nowhere to go back to is refused where it is attached', () => {
  const cases: [Record<string, number>, GraphFragment['nodes'], string, string][] = [
    [
      { 'nodes.pre': 5, 'nodes.pre.before': 6 },
      { pre: { kind: 'gate', before: 'all' } },
      'g.yaml:6: nodes.pre.before: gate "pre" runs before all stages, so a reject has no stage to go back to; attach it before or after a stage, or remove it',
      'nodes.pre.before',
    ],
    [
      { 'nodes.post': 5, 'nodes.post.after': 6 },
      { post: { kind: 'gate', after: 'all' } },
      'g.yaml:6: nodes.post.after: gate "post" runs after all stages, so a reject has no stage to go back to; attach it after a stage, or give it on_fail: { back_to: <stage>, max_rounds: <n> }',
      'nodes.post.after',
    ],
    [
      { 'nodes.pre': 5, 'nodes.pre.before': 6 },
      { pre: { kind: 'gate', before: 'intake' } },
      'g.yaml:6: nodes.pre.before: gate "pre" runs before intake, so a reject has no earlier stage to go back to; attach it after intake or a later stage, or remove it',
      'nodes.pre.before',
    ],
  ];
  for (const [lines, nodes, message, p] of cases) throwsAt(() => buildGraph(fullAt(lines, { nodes })), message, p);
  throwsAt(
    () => buildGraph(fullAt({ 'bindings.intake': 3, 'bindings.intake.0': 4 }, {}, { intake: [{ kind: 'gate' }, { agent: 'claude' }] })),
    'g.yaml:4: bindings.intake.0: gate "intake.0" runs before intake, so a reject has no earlier stage to go back to; attach it after intake or a later stage, or remove it',
    'bindings.intake.0',
  );
});

test('a gate without on_fail after a stage with no agent goes back to the nearest earlier stage with one', () => {
  const script = { plan: { command: ['pnpm', 'test'] } };
  const after = buildGraph(full({ nodes: { check: { kind: 'gate', after: 'plan' } } }, script));
  assert.equal(after.backEdges.check!.toStepIndex, after.regionStart.groom);
  const before = buildGraph(full({ nodes: { check: { kind: 'gate', before: 'implement' } } }, script));
  assert.equal(before.backEdges.check!.toStepIndex, before.regionStart.groom);
  const slot = buildGraph(full({}, { plan: [{ command: ['pnpm', 'test'] }, { kind: 'gate' }] }));
  assert.equal(slot.backEdges['plan.1']!.toStepIndex, slot.regionStart.groom);
});

test('a gate without on_fail with no stage up to it that has an agent is refused where it is attached', () => {
  const intake = { intake: { builtin: 'github.intake' } };
  throwsAt(
    () => buildGraph(fullAt({ 'nodes.x': 5, 'nodes.x.after': 6 }, { nodes: { x: { kind: 'gate', after: 'intake' } } }, intake)),
    'g.yaml:6: nodes.x.after: gate "x" runs after intake, so a reject has no earlier stage with an agent to go back to; attach it after groom or a later stage, or remove it',
    'nodes.x.after',
  );
  throwsAt(
    () => buildGraph(fullAt({ 'nodes.x': 5, 'nodes.x.before': 6 }, { nodes: { x: { kind: 'gate', before: 'groom' } } }, intake)),
    'g.yaml:6: nodes.x.before: gate "x" runs before groom, so a reject has no earlier stage with an agent to go back to; attach it after groom or a later stage, or remove it',
    'nodes.x.before',
  );
  throwsAt(
    () => buildGraph(fullAt({ 'bindings.groom': 3, 'bindings.groom.0': 4 }, {}, { ...intake, groom: [{ kind: 'gate' }, { agent: 'claude' }] })),
    'g.yaml:4: bindings.groom.0: gate "groom.0" runs before groom, so a reject has no earlier stage with an agent to go back to; attach it after groom or a later stage, or remove it',
    'bindings.groom.0',
  );
  const script = { command: ['s'] };
  const scripts = { intake: { builtin: 'github.intake' }, groom: script, plan: script, implement: script, review: script };
  throwsAt(
    () => buildGraph(fullAt({ 'nodes.x': 5, 'nodes.x.after': 6 }, { nodes: { x: { kind: 'gate', after: 'plan' } } }, scripts)),
    'g.yaml:6: nodes.x.after: gate "x" runs after plan, so a reject has no earlier stage with an agent to go back to; give it on_fail: { back_to: <stage>, max_rounds: <n> }, or remove it',
    'nodes.x.after',
  );
});

test('a loop stage bound only to a gate builds, its gate being the stage loop', () => {
  const script = { command: ['s'] };
  const g = buildGraph(
    full({}, { intake: { builtin: 'github.intake' }, groom: script, plan: script, implement: script, review: { kind: 'gate' } }),
  );
  assert.equal(g.backEdges.review!.onCap, 'continue');
  assert.equal(g.backEdges.review!.toStepIndex, g.regionStart.implement);
});

test('a gate without on_fail routed into a stage loop that goes back to a stage with no agent is refused', () => {
  const implement = { implement: { command: ['s'] } };
  throwsAt(
    () => buildGraph(fullAt({ 'nodes.qa': 5, 'nodes.qa.after': 6 }, { nodes: { qa: { kind: 'gate', after: 'review' } } }, implement)),
    'g.yaml:6: nodes.qa.after: gate "qa" runs after review, whose loop goes back to implement, a stage with no agent to act on a reject; give it on_fail: { back_to: <stage>, max_rounds: <n> }, or attach it before review',
    'nodes.qa.after',
  );
  throwsAt(
    () => buildGraph(fullAt({ 'bindings.review': 3, 'bindings.review.1': 4 }, {}, { ...implement, review: [{ agent: 'claude' }, { kind: 'gate' }, { agent: 'codex' }] })),
    'g.yaml:4: bindings.review.1: gate "review.1" runs after review, whose loop goes back to implement, a stage with no agent to act on a reject; give it on_fail: { back_to: <stage>, max_rounds: <n> }, or attach it before review',
    'bindings.review.1',
  );
  // before the loop stage it has its own edge, to the nearest earlier stage with an agent
  const before = buildGraph(full({ nodes: { qa: { kind: 'gate', before: 'review' } } }, implement));
  assert.equal(before.backEdges.qa!.toStepIndex, before.regionStart.plan);
});

test('a gate without on_fail after the exit stage is refused, since a reject would deliver again', () => {
  throwsAt(
    () => buildGraph(fullAt({ 'nodes.post': 5, 'nodes.post.after': 6 }, { nodes: { post: { kind: 'gate', after: 'deliver' } } })),
    'g.yaml:6: nodes.post.after: gate "post" runs after deliver, the exit stage, so a reject would deliver again; attach it before deliver, or give it on_fail: { back_to: <stage>, max_rounds: <n> }',
    'nodes.post.after',
  );
  throwsAt(
    () => buildGraph(fullAt({ 'bindings.deliver': 3, 'bindings.deliver.1': 4 }, {}, { deliver: [{ builtin: 'github.open_pr' }, { kind: 'gate' }] })),
    'g.yaml:4: bindings.deliver.1: gate "deliver.1" runs after deliver, the exit stage, so a reject would deliver again; attach it before deliver, or give it on_fail: { back_to: <stage>, max_rounds: <n> }',
    'bindings.deliver.1',
  );
  const lines = { 'profiles.default.pipelines.triage.nodes.post.after': 9 };
  throwsAt(
    () => buildGraph(triage({ nodes: { post: { kind: 'gate', after: 'route' } } }, lines), undefined, { descriptions: {} }),
    'c.yaml:9: profiles.default.pipelines.triage.nodes.post.after: gate "post" runs after route, the exit stage, so a reject would deliver again; attach it before route, or give it on_fail: { back_to: <stage>, max_rounds: <n> }',
    'profiles.default.pipelines.triage.nodes.post.after',
  );
  // before the exit stage is fine: it goes back to review's loop or the stage before
  assert.equal(buildGraph(full({ nodes: { pre: { kind: 'gate', before: 'deliver' } } })).failRoutes.pre, 'pre');
});

test('implicit gate edge across a fan-out is refused', () => {
  const nodes = { 'approve-x': { kind: 'gate' as const, before: 'implement' } };
  const lines = { 'profiles.default.pipelines.epic.nodes.approve-x': 14 };
  const message =
    'c.yaml:14: profiles.default.pipelines.epic.nodes.approve-x: approve-x goes back to plan on reject (a gate without on_fail returns to the stage it follows), which runs before the fan-out at implement; attach it after implement or later, or give it on_fail with back_to implement or later';
  throwsAt(() => buildGraph(epic({ nodes }, lines), undefined, CHILD), message, 'profiles.default.pipelines.epic.nodes.approve-x');
  throwsAt(() => buildGraph(epic({ nodes }, lines)), message, 'profiles.default.pipelines.epic.nodes.approve-x');
});
