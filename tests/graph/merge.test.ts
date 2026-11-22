import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers, mergePipelines, LockViolation } from '../../src/graph/merge.ts';
import { CORE_STAGES, STAGE_CONTRACTS, CORE_GROOM_GATE } from '../../src/graph/core.ts';
import type { Layer } from '../../src/grounds/mappings.ts';

const L = (source: string, fragment: Layer['fragment']): Layer => ({ source, fragment });

test('later layer overrides unlocked binding', () => {
  const m = mergeLayers([
    L('ground:co', { bindings: { implement: { agent: 'claude' } } }),
    L('profile:work', { bindings: { implement: { agent: 'codex' } } }),
  ]);
  assert.equal(m.bindings.implement!.value[0]!.agent, 'codex');
  assert.equal(m.bindings.implement!.source, 'profile:work');
  assert.equal(m.bindings.implement!.locked, false);
});

test('array bindings are normalised to NodeDef[]', () => {
  const m = mergeLayers([L('a', { bindings: { plan: [{ agent: 'x' }, { agent: 'y' }] } })]);
  assert.equal(m.bindings.plan!.value.length, 2);
});

test('profile cannot override locked binding; error names the ground', () => {
  assert.throws(
    () =>
      mergeLayers([
        L('ground:company-sdlc', { bindings: { review: { agent: 'claude', skill: 'co:review', required: true } } }),
        L('profile:work', { bindings: { review: { agent: 'codex' } } }),
      ]),
    (err: unknown) => {
      assert.ok(err instanceof LockViolation);
      assert.equal(err.target, 'bindings.review');
      assert.equal(err.lockedBy, 'ground:company-sdlc');
      assert.equal(err.attemptedBy, 'profile:work');
      assert.equal(err.file, 'profile:work');
      assert.equal(err.path, 'bindings.review');
      assert.equal(
        err.message,
        'profile:work: bindings.review: locked by ground:company-sdlc (required: true); remove this binding or restate it exactly',
      );
      return true;
    },
  );
});

test('locked node cannot be replaced; unlocked node can', () => {
  assert.throws(
    () =>
      mergeLayers([
        L('ground:co', { nodes: { sec: { kind: 'gate', after: 'review', required: true } } }),
        L('profile:work', { nodes: { sec: { kind: 'gate', after: 'plan' } } }),
      ]),
    {
      message: 'profile:work: nodes.sec: locked by ground:co (required: true); remove this node or restate it exactly',
    },
  );
  const m = mergeLayers([
    L('ground:co', { nodes: { lint: { kind: 'script', after: 'implement', command: ['a'] } } }),
    L('profile:work', { nodes: { lint: { kind: 'script', after: 'implement', command: ['b'] } } }),
  ]);
  assert.equal(m.nodes.lint!.source, 'profile:work');
  assert.deepEqual(m.nodes.lint!.value.command, ['b']);
});

test('a later layer may add a new node while others are locked', () => {
  const m = mergeLayers([
    L('ground:co', { nodes: { sec: { kind: 'gate', after: 'review', required: true } } }),
    L('profile:work', { nodes: { extra: { kind: 'script', after: 'plan', command: ['x'] } } }),
  ]);
  assert.ok(m.nodes.sec && m.nodes.extra);
});

test('core groom gate is present and locked', () => {
  const n = mergeLayers([]).nodes['approve-groom']!;
  assert.equal(n.locked, true);
  assert.equal(n.source, 'core');
  assert.deepEqual(n.value, CORE_GROOM_GATE.def);
});

test('rules from all layers are kept with sources', () => {
  const m = mergeLayers([
    L('ground:co', { rules: { allowed_agents: ['a'] } }),
    L('profile:work', {}),
    L('repo', { rules: { allowed_agents: ['b'] } }),
  ]);
  assert.equal(m.rules.length, 2);
  assert.deepEqual(
    m.rules.map((r) => r.source),
    ['ground:co', 'repo'],
  );
  assert.equal(m.rules[0]!.locked, false);
});

test('redefining a locked binding with a deep-equal value is a no-op', () => {
  const b = { agent: 'claude', skill: 'co:review', required: true } as const;
  const m = mergeLayers([
    L('ground:co', { bindings: { review: { ...b } } }),
    L('profile:work', { bindings: { review: { ...b } } }),
  ]);
  assert.equal(m.bindings.review!.source, 'ground:co');
  assert.equal(m.bindings.review!.locked, true);
});

test('redefining a locked node with a deep-equal value is a no-op', () => {
  const def = { kind: 'gate', after: 'review', required: true } as const;
  const m = mergeLayers([L('ground:co', { nodes: { sec: { ...def } } }), L('profile:work', { nodes: { sec: { ...def } } })]);
  assert.equal(m.nodes.sec!.source, 'ground:co');
});

test('redefining the core gate differently is a LockViolation naming core', () => {
  assert.throws(
    () => mergeLayers([L('profile:work', { nodes: { 'approve-groom': { kind: 'gate', after: 'groom' } } })]),
    {
      message:
        'profile:work: nodes.approve-groom: locked by Percolator core (required: true); remove this node: approve-groom is built in',
    },
  );
});

test('core constants', () => {
  assert.deepEqual(CORE_STAGES, ['intake', 'groom', 'plan', 'implement', 'review', 'deliver']);
  assert.deepEqual(STAGE_CONTRACTS.deliver.requiredOutputs, ['pr_url']);
  assert.equal(CORE_GROOM_GATE.name, 'approve-groom');
});

test('mutating a merged core gate does not corrupt later merges or the constant', () => {
  const first = mergeLayers([]);
  first.nodes['approve-groom']!.value.required = false;
  first.nodes['approve-groom']!.value.on_fail!.max_rounds = 99;
  const second = mergeLayers([]);
  assert.deepEqual(second.nodes['approve-groom']!.value, {
    kind: 'gate',
    after: 'groom',
    required: true,
    on_fail: { back_to: 'groom', max_rounds: 3 },
  });
  assert.equal(CORE_GROOM_GATE.def.required, true);
});

test('merged values do not alias layer inputs', () => {
  const binding = { agent: 'claude', skills: ['a'] };
  const node = { kind: 'gate' as const, after: 'plan' as const };
  const rules = { allowed_agents: ['claude'] };
  const m = mergeLayers([L('ground:co', { bindings: { plan: binding }, nodes: { g: node }, rules })]);
  binding.skills.push('b');
  binding.agent = 'changed';
  node.after = 'review' as never;
  rules.allowed_agents.push('codex');
  assert.deepEqual(m.bindings.plan!.value, [{ agent: 'claude', skills: ['a'] }]);
  assert.equal(m.nodes.g!.value.after, 'plan');
  assert.deepEqual(m.rules[0]!.value.allowed_agents, ['claude']);
});

test('core constants are frozen', () => {
  assert.ok(Object.isFrozen(CORE_STAGES));
  assert.ok(Object.isFrozen(STAGE_CONTRACTS));
  assert.ok(Object.isFrozen(STAGE_CONTRACTS.plan.requiredOutputs));
  assert.ok(Object.isFrozen(CORE_GROOM_GATE.def));
  assert.ok(Object.isFrozen(CORE_GROOM_GATE.def.on_fail));
});

const LOCKED = { agent: 'claude', skill: 'co:review', required: true };

test('an empty layer does not disturb a locked binding, and a later empty-binding is rejected', () => {
  assert.throws(
    () => mergeLayers([L('ground:co', { bindings: { review: LOCKED } }), L('profile:work', { bindings: { review: [] } })]),
    { message: 'profile:work: bindings.review: locked by ground:co (required: true); remove this binding or restate it exactly' },
  );
});

test('restating a locked binding with a different value plus required: true is rejected', () => {
  assert.throws(
    () =>
      mergeLayers([
        L('ground:co', { bindings: { review: LOCKED } }),
        L('profile:work', { bindings: { review: { agent: 'codex', required: true } } }),
      ]),
    { message: 'profile:work: bindings.review: locked by ground:co (required: true); remove this binding or restate it exactly' },
  );
});

test('a no-op restatement does not transfer the lock; a later change still names the first locker', () => {
  assert.throws(
    () =>
      mergeLayers([
        L('ground:co', { bindings: { review: { ...LOCKED } } }),
        L('profile:work', { bindings: { review: { ...LOCKED } } }),
        L('repo', { bindings: { review: { agent: 'codex' } } }),
      ]),
    { message: 'repo: bindings.review: locked by ground:co (required: true); remove this binding or restate it exactly' },
  );
});

test('lock violation names both files and lines', () => {
  const ground: Layer = {
    source: 'ground:co',
    fragment: { bindings: { review: { ...LOCKED } } },
    locator: { file: 'g.yaml', lines: { 'bindings.review': 2 } },
  };
  const profile: Layer = {
    source: 'profile:w',
    fragment: { bindings: { review: { agent: 'codex' } } },
    locator: { file: 'c.yaml', lines: { 'profiles.w.bindings.review': 9 }, prefix: 'profiles.w' },
  };
  assert.throws(
    () => mergeLayers([ground, profile]),
    (err: unknown) => {
      assert.ok(err instanceof LockViolation);
      assert.equal(
        err.message,
        'c.yaml:9: profiles.w.bindings.review: locked by g.yaml:2 (required: true); remove this binding or restate it exactly',
      );
      assert.equal(err.file, 'c.yaml');
      assert.equal(err.line, 9);
      assert.equal(err.path, 'profiles.w.bindings.review');
      assert.equal(err.lockedBy, 'ground:co');
      assert.equal(err.attemptedBy, 'profile:w');
      return true;
    },
  );
});

test('an identical restatement from another file still passes', () => {
  const m = mergeLayers([
    { source: 'ground:co', fragment: { bindings: { review: { ...LOCKED } } }, locator: { file: 'g.yaml', lines: { 'bindings.review': 2 } } },
    { source: 'repo', fragment: { bindings: { review: { ...LOCKED } } }, locator: { file: 'r.yaml', lines: { 'bindings.review': 5 } } },
  ]);
  assert.equal(m.bindings.review!.source, 'ground:co');
  assert.deepEqual(m.bindings.review!.value, [LOCKED]);
});

test('top-level bindings merge into feature', () => {
  const r = mergePipelines([L('a', { bindings: { plan: { agent: 'claude' } } })]);
  assert.equal(r.feature!.bindings.plan!.value[0]!.agent, 'claude');
  assert.equal(r.feature!.name, 'feature');
});

test('pipelines merge per pipeline across layers', () => {
  const r = mergePipelines([
    L('a', { pipelines: { hotfix: { bindings: { fix: { agent: 'claude' } } } } }),
    L('b', { pipelines: { hotfix: { bindings: { fix: { agent: 'codex' } } } } }),
  ]);
  assert.equal(r.hotfix!.bindings.fix!.value[0]!.agent, 'codex');
  assert.equal(r.hotfix!.bindings.fix!.source, 'b');
});

test('top-level rules apply to every pipeline', () => {
  const r = mergePipelines([
    L('a', { rules: { allowed_agents: ['claude'] } }),
    L('b', { pipelines: { hotfix: { stages: ['intake', 'deliver'] } } }),
  ]);
  assert.deepEqual(r.hotfix!.rules.map((x) => x.source), ['a']);
  assert.deepEqual(r.feature!.rules.map((x) => x.source), ['a']);
});

test('rules are marked global or pipeline', () => {
  const r = mergePipelines([
    L('a', { rules: { allowed_agents: ['claude'] } }),
    L('b', { pipelines: { hotfix: { stages: ['intake', 'deliver'], rules: { allowed_models: ['m'] } } } }),
  ]);
  assert.deepEqual(r.hotfix!.rules.map((x) => [x.source, x.scope]), [
    ['a', 'global'],
    ['b', 'pipeline'],
  ]);
  assert.deepEqual(r.feature!.rules.map((x) => [x.source, x.scope]), [['a', 'global']]);
});

test('the groom gate is only in feature', () => {
  const r = mergePipelines([L('a', { pipelines: { hotfix: { stages: ['intake', 'groom', 'deliver'] } } })]);
  assert.equal('approve-groom' in r.feature!.nodes, true);
  assert.equal('approve-groom' in r.hotfix!.nodes, false);
});

test('pipeline headers merge with their sources', () => {
  const r = mergePipelines([
    L('a', { pipelines: { hotfix: { stages: ['intake', 'fix', 'deliver'], exit: 'pr' } } }),
    L('b', { pipelines: { hotfix: { ticket: 'optional' } } }),
  ]);
  assert.deepEqual(r.hotfix!.header.value, { stages: ['intake', 'fix', 'deliver'], exit: 'pr', ticket: 'optional' });
  assert.equal(r.hotfix!.header.source, 'b');
  assert.deepEqual(r.feature!.header.value.stages, [...CORE_STAGES]);
});

test('router keys are part of the pipeline header', () => {
  const r = mergePipelines([
    L('a', { pipelines: { triage: { router: true, stages: ['intake', 'route'], routes: [{ label: 'bug', to: 'hotfix' }] } } }),
    L('b', { pipelines: { triage: { choose: { agent: 'claude', from: ['hotfix'] }, fallback: 'hotfix' } } }),
  ]);
  assert.deepEqual(r.triage!.header.value, {
    router: true,
    stages: ['intake', 'route'],
    routes: [{ label: 'bug', to: 'hotfix' }],
    choose: { agent: 'claude', from: ['hotfix'] },
    fallback: 'hotfix',
  });
});

test('triggers are part of the pipeline header', () => {
  const r = mergePipelines([L('a', { pipelines: { p: { stages: ['intake', 'deliver'], triggers: [{ label: 'x' }] } } })]);
  assert.deepEqual(r.p!.header.value.triggers, [{ label: 'x' }]);
});

test('next is part of the pipeline header', () => {
  const r = mergePipelines([L('a', { pipelines: { split: { stages: ['intake', 'deliver'], exit: 'issue', next: 'hotfix' } } })]);
  assert.equal(r.split!.header.value.next, 'hotfix');
});

const LOCKED_HOTFIX = { required: true, stages: ['intake', 'fix', 'deliver'], exit: 'pr' as const };
const groundLayer: Layer = {
  source: 'ground:co/p.yaml',
  fragment: { pipelines: { hotfix: LOCKED_HOTFIX } },
  locator: { file: 'p.yaml', lines: { 'pipelines.hotfix': 3 } },
};

test('a locked pipeline header may only be restated', () => {
  assert.throws(
    () =>
      mergePipelines([
        groundLayer,
        {
          source: 'profile:default',
          fragment: { pipelines: { hotfix: { stages: ['intake', 'deliver'] } } },
          locator: { file: 'c.yaml', lines: { 'profiles.default.pipelines.hotfix': 7 }, prefix: 'profiles.default' },
        },
      ]),
    (err: unknown) => {
      assert.ok(err instanceof LockViolation);
      assert.equal(err.path, 'profiles.default.pipelines.hotfix');
      assert.equal(
        err.message,
        'c.yaml:7: profiles.default.pipelines.hotfix: locked by p.yaml:3 (required: true); remove this pipeline or restate it exactly',
      );
      return true;
    },
  );
});

test('restating a locked header exactly is allowed', () => {
  const r = mergePipelines([groundLayer, L('profile:default', { pipelines: { hotfix: { ...LOCKED_HOTFIX } } })]);
  assert.equal(r.hotfix!.header.source, 'ground:co/p.yaml');
});

test('bindings inside a pipeline locate under pipelines.<p>', () => {
  const r = mergePipelines([
    {
      source: 'profile:default',
      fragment: { pipelines: { hotfix: { bindings: { fix: { agent: 'claude' } } } } },
      locator: { file: 'c.yaml', lines: {}, prefix: 'profiles.default' },
    },
  ]);
  assert.equal(r.hotfix!.bindings.fix!.locator!.prefix, 'profiles.default.pipelines.hotfix');
});
