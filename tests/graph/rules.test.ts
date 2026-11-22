import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules, RuleViolationError } from '../../src/graph/rules.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import type { Merged } from '../../src/graph/merge.ts';
import type { GraphFragment, Rules } from '../../src/config/schema.ts';

function m(bindings: NonNullable<GraphFragment['bindings']>, rules: Rules[], nodes: GraphFragment['nodes'] = {}): Merged {
  return mergeLayers([
    { source: 'repo:base', fragment: { bindings, nodes } },
    ...rules.map((r, i) => ({ source: `rules:${i}`, fragment: { rules: r } })),
  ]);
}

test('require_skills flags review node missing a skill', () => {
  const v = checkRules(m({ review: { agent: 'claude' } }, [{ require_skills: [{ stage: 'review', skills: ['co:security'] }] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'require_skills');
  assert.equal(v[0]!.target, 'bindings.review');
  assert.equal(v[0]!.source, 'rules:0');
  assert.equal(v[0]!.message, 'missing required skill(s) co:security, required by require_skills (from rules:0); add them to its skills:');
  assert.deepEqual(v[0]!.where, { file: 'repo:base', path: 'bindings.review' });
});

test('require_skills accepts skill or skills', () => {
  assert.deepEqual(
    checkRules(
      m({ review: [{ agent: 'a', skill: 'co:security' }, { agent: 'b', skills: ['co:security'] }] }, [
        { require_skills: [{ stage: 'review', skills: ['co:security'] }] },
      ]),
    ),
    [],
  );
});

test('allowed_models intersects across rule sets', () => {
  const v = checkRules(m({ review: { agent: 'claude', model: 'a' } }, [{ allowed_models: ['a', 'b'] }, { allowed_models: ['b'] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'allowed_models');
  assert.equal(v[0]!.target, 'bindings.review');
});

test('max_rounds_ceiling applies to default review rounds', () => {
  const v = checkRules(m({ review: { agent: 'claude' } }, [{ max_rounds_ceiling: 2 }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'max_rounds_ceiling');
  assert.equal(v[0]!.message, 'allows 3 review rounds, over max_rounds_ceiling 2 (from rules:0); set max_rounds to 2 or less');
});

test('required_nodes missing is a violation', () => {
  const v = checkRules(m({}, [{ required_nodes: ['security-scan'] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'required_nodes');
  assert.equal(v[0]!.message, 'node "security-scan" is required by required_nodes but is not defined; add it under nodes:');
  assert.deepEqual(v[0]!.where, { file: 'rules:0', path: 'rules.required_nodes.0' });
});

test('required_nodes present passes', () => {
  assert.deepEqual(checkRules(m({}, [{ required_nodes: ['approve-groom'] }])), []);
});

test('clean config has no violations', () => {
  assert.deepEqual(
    checkRules(m({ review: { agent: 'claude', model: 'a' } }, [{ allowed_agents: ['claude'] }, { max_rounds_ceiling: 3 }])),
    [],
  );
});

test('allowed_agents with [] allows nothing', () => {
  const v = checkRules(m({ review: { agent: 'claude' } }, [{ allowed_agents: [] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'allowed_agents');
});

test('allowed_agents: rule sets without the key do not restrict', () => {
  assert.deepEqual(checkRules(m({ review: { agent: 'claude' } }, [{ max_rounds_ceiling: 3 }])), []);
});

test('allowed_agents violation names the first excluding rule set and is readable', () => {
  const v = checkRules(
    m({ review: { agent: 'codex' } }, [{ allowed_agents: ['claude', 'codex'] }, { allowed_agents: ['claude'] }, { allowed_agents: ['gemini'] }]),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.source, 'rules:1');
  assert.equal(v[0]!.message, 'uses agent "codex", but allowed_agents (from rules:1) allows: claude; use one of those');
});

test('allowed_models: excluded model names first excluding set', () => {
  const v = checkRules(
    m({ plan: { agent: 'claude', model: 'b' }, review: { agent: 'claude', model: 'a' } }, [{ allowed_models: ['b', 'c'] }, { allowed_models: ['b'] }]),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.target, 'bindings.review');
  assert.equal(v[0]!.source, 'rules:0');
});

test('allowed_models fails closed: an agent node without model is a violation, once, against the first set', () => {
  const v = checkRules(
    m({ implement: { agent: 'claude' }, deliver: { command: ['x'] } }, [{ max_rounds_ceiling: 9 }, { allowed_models: ['sonnet'] }, { allowed_models: ['sonnet', 'opus'] }]),
  );
  assert.deepEqual(v, [
    {
      rule: 'allowed_models',
      source: 'rules:1',
      target: 'bindings.implement',
      message: 'has no model, but allowed_models (from rules:1) requires one of: sonnet; set model: to one of them',
      where: { file: 'repo:base', path: 'bindings.implement' },
    },
  ]);
});

test('allowed_models: [] with no model reports (nothing)', () => {
  const v = checkRules(m({ implement: { agent: 'claude' } }, [{ allowed_models: [] }]));
  assert.equal(v[0]!.message, 'has no model, but allowed_models (from rules:0) requires one of: (nothing); set model: to one of them');
});

test('allowed_agents only: an agent node without model is fine', () => {
  assert.deepEqual(checkRules(m({ implement: { agent: 'claude' } }, [{ allowed_agents: ['claude'] }])), []);
});

test("require_skills '*' covers every binding and extension agent node but not non-agent nodes", () => {
  const v = checkRules(
    m({ plan: { agent: 'claude' }, implement: { command: ['x'] } }, [{ require_skills: [{ stage: '*', skills: ['s'] }] }], {
      lint: { agent: 'claude', after: 'implement' },
      ok: { agent: 'claude', skill: 's', after: 'plan' },
      scan: { command: ['y'], after: 'plan' },
    }),
  );
  assert.deepEqual(v.map((x) => x.target), ['bindings.plan', 'nodes.lint']);
});

test('multi-node bindings get indexed targets', () => {
  const v = checkRules(
    m({ review: [{ agent: 'a', skill: 's' }, { agent: 'b' }] }, [{ require_skills: [{ stage: 'review', skills: ['s'] }] }]),
  );
  assert.deepEqual(v.map((x) => x.target), ['bindings.review.1']);
});

test('on_fail.max_rounds over the ceiling is a violation, on extension nodes too', () => {
  const v = checkRules(
    m({ review: { agent: 'claude', max_rounds: 2 } }, [{ max_rounds_ceiling: 2 }], {
      lint: { command: ['x'], after: 'implement', on_fail: { back_to: 'implement', max_rounds: 5 } },
    }),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.target, 'nodes.lint.on_fail');
  assert.equal(v[0]!.message, 'allows 5 rounds, over max_rounds_ceiling 2 (from rules:0); set on_fail.max_rounds to 2 or less');
  assert.deepEqual(v[0]!.where, { file: 'repo:base', path: 'nodes.lint.on_fail' });
});

test('max_rounds_ceiling does not flag the core approve-groom gate', () => {
  const merged = m({ review: { agent: 'claude', max_rounds: 2 } }, [{ max_rounds_ceiling: 2 }]);
  assert.equal(merged.nodes['approve-groom']!.source, 'core');
  assert.equal(merged.nodes['approve-groom']!.value.on_fail!.max_rounds, 3);
  assert.deepEqual(checkRules(merged), []);
});

test('max_rounds_ceiling still flags a non-core node with on_fail.max_rounds above it', () => {
  const v = checkRules(
    m({ review: { agent: 'claude', max_rounds: 2 } }, [{ max_rounds_ceiling: 2 }], {
      gate2: { kind: 'gate', after: 'groom', on_fail: { back_to: 'groom', max_rounds: 3 } },
    }),
  );
  assert.deepEqual(v.map((x) => x.target), ['nodes.gate2.on_fail']);
});

test('max_rounds_ceiling names the first rule set whose ceiling is exceeded', () => {
  const v = checkRules(
    m({ review: { agent: 'claude', max_rounds: 3 } }, [{ max_rounds_ceiling: 5 }, { max_rounds_ceiling: 2 }, { max_rounds_ceiling: 1 }]),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.source, 'rules:1');
});

test('violations are ordered by rule set, then stage, then node name', () => {
  const v = checkRules(
    m({ review: { agent: 'claude' }, plan: { agent: 'claude' } }, [{ require_skills: [{ stage: '*', skills: ['s'] }] }, { required_nodes: ['zz'] }], {
      b: { agent: 'claude', after: 'plan' },
      a: { agent: 'claude', after: 'plan' },
    }),
  );
  assert.deepEqual(v.map((x) => x.target), ['bindings.plan', 'bindings.review', 'nodes.a', 'nodes.b', 'nodes.zz']);
});

test('require_skills on a stage bound to a script is a violation', () => {
  const v = checkRules(m({ review: { command: ['make', 'lint'] } }, [{ require_skills: [{ stage: 'review', skills: ['my:review'] }] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'require_skills');
  assert.equal(v[0]!.target, 'bindings.review');
  assert.equal(v[0]!.source, 'rules:0');
  assert.equal(
    v[0]!.message,
    'has no agent node, but require_skills (from rules:0) requires skill(s) my:review there; bind an agent node there or remove the rule',
  );
});

test('require_skills "*" with no agent nodes anywhere is not a violation', () => {
  assert.deepEqual(checkRules(m({ review: { command: ['make', 'lint'] } }, [{ require_skills: [{ stage: '*', skills: ['s'] }] }])), []);
});

test('required_nodes with a position accepts the right hook', () => {
  const v = checkRules(
    m({}, [{ required_nodes: [{ name: 'threat-model', after: 'plan' }] }], { 'threat-model': { agent: 'claude', after: 'plan' } }),
  );
  assert.deepEqual(v, []);
});

test('required_nodes with a position rejects a moved hook', () => {
  const v = checkRules(
    m({}, [{ required_nodes: [{ name: 'threat-model', after: 'plan' }] }], { 'threat-model': { agent: 'claude', before: 'implement' } }),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'required_nodes');
  assert.equal(v[0]!.target, 'nodes.threat-model');
  assert.equal(
    v[0]!.message,
    'required after plan by required_nodes (from rules:0), but it is attached before implement; attach it after plan',
  );
});

test('violations are located at the node and name the rule line', () => {
  const merged = mergeLayers([
    {
      source: 'repo:base',
      fragment: { bindings: { implement: { agent: 'claude' } }, nodes: { audit: { agent: 'claude', before: 'plan' } } },
      locator: { file: 'n.yaml', lines: { 'bindings.implement': 3, 'nodes.audit': 7 } },
    },
    {
      source: 'rules:0',
      fragment: {
        rules: {
          require_skills: [{ stage: 'implement', skills: ['tdd'] }],
          required_nodes: ['missing', { name: 'audit', after: 'implement' }],
        },
      },
      locator: { file: 'r.yaml', lines: { 'rules.require_skills': 2, 'rules.required_nodes': 4, 'rules.required_nodes.0': 5 } },
    },
  ]);
  const err = new RuleViolationError(checkRules(merged), 'config');
  assert.deepEqual(err.message.split('\n'), [
    'n.yaml:3: bindings.implement: missing required skill(s) tdd, required by require_skills (from r.yaml:2); add them to its skills:',
    'r.yaml:5: rules.required_nodes.0: node "missing" is required by required_nodes but is not defined; add it under nodes:',
    'n.yaml:7: nodes.audit: required after implement by required_nodes (from r.yaml:4), but it is attached before plan; attach it after implement',
  ]);
  assert.equal(err.file, 'n.yaml');
  assert.equal(err.line, 3);
  assert.equal(err.path, 'bindings.implement');
});
