import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules } from '../../src/graph/rules.ts';
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
  assert.match(v[0]!.message, /bindings\.review/);
  assert.match(v[0]!.message, /co:security/);
  assert.match(v[0]!.message, /rules:0/);
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
  assert.match(v[0]!.message, /3/);
});

test('required_nodes missing is a violation', () => {
  const v = checkRules(m({}, [{ required_nodes: ['security-scan'] }]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, 'required_nodes');
  assert.match(v[0]!.message, /security-scan/);
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
  assert.equal(v[0]!.message, 'bindings.review uses agent "codex", but allowed_agents (from rules:1) allows: claude');
});

test('allowed_models: nodes without model pass; excluded model names first excluding set', () => {
  const v = checkRules(
    m({ plan: { agent: 'claude' }, review: { agent: 'claude', model: 'a' } }, [{ allowed_models: ['b', 'c'] }, { allowed_models: ['b'] }]),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.target, 'bindings.review');
  assert.equal(v[0]!.source, 'rules:0');
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
  assert.match(v[0]!.message, /5/);
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
