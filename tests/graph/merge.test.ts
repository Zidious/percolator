import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers, LockViolation } from '../../src/graph/merge.ts';
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
      assert.match(String((err as Error).message), /bindings\.review is locked by ground:company-sdlc; profile:work/);
      assert.equal(err.target, 'bindings.review');
      assert.equal(err.lockedBy, 'ground:company-sdlc');
      assert.equal(err.attemptedBy, 'profile:work');
      assert.equal(err.file, 'profile:work');
      assert.equal(err.path, 'bindings.review');
      assert.equal(
        err.message,
        'bindings.review is locked by ground:company-sdlc; profile:work cannot change it',
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
    /nodes\.sec is locked by ground:co; profile:work cannot change it/,
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
    /nodes\.approve-groom is locked by core; profile:work cannot change it/,
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
    /bindings\.review is locked by ground:co; profile:work cannot change it/,
  );
});

test('restating a locked binding with a different value plus required: true is rejected', () => {
  assert.throws(
    () =>
      mergeLayers([
        L('ground:co', { bindings: { review: LOCKED } }),
        L('profile:work', { bindings: { review: { agent: 'codex', required: true } } }),
      ]),
    /bindings\.review is locked by ground:co; profile:work cannot change it/,
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
    /bindings\.review is locked by ground:co; repo cannot change it/,
  );
});
