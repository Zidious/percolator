import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { UserConfigSchema } from '../../src/config/schema.ts';
import { BUILTIN_NAMES } from '../../src/tracker/index.ts';

type Node = Record<string, unknown>;

function isObject(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function described(n: Node): boolean {
  const d = n['description'];
  return typeof d === 'string' && d.trim() !== '' && !d.includes('\n');
}

/** JSON paths (from `$`) of every property or record value without a one-line description. */
function missingDescriptions(schema: unknown, at = '$'): string[] {
  const out = new Set<string>();
  const walk = (n: unknown, p: string): void => {
    if (!isObject(n)) return;
    if (isObject(n['properties'])) {
      for (const [k, child] of Object.entries(n['properties'])) {
        const cp = `${p}.${k}`;
        if (!isObject(child) || !described(child)) out.add(cp);
        walk(child, cp);
      }
    }
    if (isObject(n['additionalProperties'])) {
      const cp = `${p}.*`;
      if (!described(n['additionalProperties'])) out.add(cp);
      walk(n['additionalProperties'], cp);
    }
    if (n['items'] !== undefined) walk(n['items'], `${p}[]`);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const branches = n[key];
      if (Array.isArray(branches)) for (const b of branches) walk(b, p);
    }
  };
  walk(schema, at);
  return [...out].sort();
}

/** The node at a path made by missingDescriptions (`.key`, `.*`, `[]`), searching union branches. */
function at(schema: unknown, p: string): Node | undefined {
  const steps = p.replace(/^\$/, '').match(/\.[^.[\]]+|\[\]/g) ?? [];
  let nodes: unknown[] = [schema];
  for (const step of steps) {
    const next: unknown[] = [];
    const expand = (n: unknown): void => {
      if (!isObject(n)) return;
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        const b = n[key];
        if (Array.isArray(b)) b.forEach(expand);
      }
      if (step === '[]') next.push(n['items']);
      else if (step === '.*') next.push(n['additionalProperties']);
      else if (isObject(n['properties'])) next.push(n['properties'][step.slice(1)]);
    };
    nodes.forEach(expand);
    nodes = next.filter((x) => x !== undefined);
  }
  return nodes.find(isObject);
}

const generated = () => z.toJSONSchema(UserConfigSchema, { io: 'input' });

test('walker finds undescribed keys in nested anyOf, items and record values', () => {
  const s = {
    type: 'object',
    properties: {
      a: { description: 'ok', anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }] },
      c: { description: 'ok', type: 'array', items: { type: 'object', properties: { d: { description: '  ' } } } },
      e: { description: 'two\nlines', type: 'object', additionalProperties: { type: 'object' } },
      f: { description: 'ok', additionalProperties: false },
    },
  };
  assert.deepEqual(missingDescriptions(s), ['$.a.b', '$.c[].d', '$.e', '$.e.*']);
});

test('every key in the generated config schema has a one-line description', () => {
  assert.deepEqual(missingDescriptions(generated()), []);
});

test('descriptions state the defaults the code uses', () => {
  const s = generated();
  const desc = (p: string): string => {
    const n = at(s, p);
    assert.ok(n, `no schema node at ${p}`);
    return String(n['description']);
  };
  const expected: [string, RegExp][] = [
    ['$.profiles.*.runtime.keep_terminals', /default false/],
    ['$.profiles.*.runtime.space', /default true/],
    ['$.profiles.*.runtime.base', /detected from the repo/],
    ['$.profiles.*.trust_repo_config', /default false/],
    ['$.profiles.*.nodes.*.max_rounds', /default 3/],
    ['$.profiles.*.nodes.*.once', /default false/],
    ['$.profiles.*.use[].applies_to', /default all stages/],
    ['$.profiles.*.nodes.*.escalation', /not used.*no effect/],
    ['$.profiles.*.use[].as', /prompt \(accepted but not used yet; has no effect\)/],
    ['$.profiles.*.nodes.*.prompt', /stage contract \(bindings\) or the node's purpose \(hooks\)/],
    ['$.profiles.*.nodes.*.prompt', /\{run_id\}, \{worktree\}/],
    ['$.profiles.*.nodes.*.command', /program for agent: command/],
    ['$.profiles.*.nodes.*.max_rounds', /read from the last node bound to review/],
    ['$.profiles.*.rules.allowed_models', /when set, every agent node must name one of them/],
    ['$.profiles.*.nodes.*.required', /in bindings, the whole stage binding/],
    ['$.profiles.*.runtime.worktree_root', /<root>\/<repo>\/; relative to the config file, ~ expanded/],
    ['$.profiles.*.rules.require_skills[].stage', /a named stage must be bound to an agent node/],
  ];
  for (const [p, re] of expected) assert.match(desc(p), re, p);
  assert.ok(desc('$.profiles.*.nodes.*.builtin').includes(BUILTIN_NAMES.join(' or ')), 'builtin names come from BUILTIN_NAMES');
  assert.deepEqual(at(s, '$.profiles.*.use[].applies_to')?.['default'], ['*']);
});
