import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkAgents } from '../../src/adapters/check.ts';
import type { GraphFragment } from '../../src/config/schema.ts';
import { buildGraph } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import type { ResolvedMapping } from '../../src/grounds/mappings.ts';

const base: NonNullable<GraphFragment['bindings']> = {
  intake: { builtin: 'github.intake' },
  groom: { agent: 'claude' },
  plan: { agent: 'claude' },
  implement: { agent: 'claude' },
  review: { agent: 'claude' },
  deliver: { command: ['echo'] },
};

function graphOf(bindings: NonNullable<GraphFragment['bindings']>, nodes: GraphFragment['nodes'] = {}) {
  return buildGraph(mergeLayers([{ source: 'repo:t', fragment: { bindings: { ...base, ...bindings }, nodes } }]));
}

function mapping(as: ResolvedMapping['as'], absPath: string, extra: Record<string, unknown> = {}): ResolvedMapping {
  return { from: 'g', dir: 'x', as, applies_to: ['*'], required: false, absPath, ground: 'g', commit: 'local', source: 'test', ...extra } as ResolvedMapping;
}

async function tmp(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function problems(p: Promise<void>): Promise<string[]> {
  const err = await p.then(
    () => undefined,
    (e: Error) => e,
  );
  return err === undefined ? [] : err.message.split('\n');
}

test('the built-in agents pass', async () => {
  await checkAgents(graphOf({ review: { agent: 'codex' }, plan: { agent: 'command', command: ['x'] } }), [], 'cfg.yaml');
});

test('unknown agent, missing command and a dashed command are all reported, hooks as nodes.<id>', async () => {
  const g = graphOf(
    { review: { agent: 'gemini' }, plan: { agent: 'command' }, implement: { agent: 'command', command: ['-rf'] } },
    { audit: { after: 'review', agent: 'nope' } },
  );
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.plan: agent "command" needs "command" (the program to run)',
    'cfg.yaml: bindings.implement: command must not start with "-"',
    'cfg.yaml: bindings.review: unknown agent "gemini" (known: claude, codex, command)',
    'cfg.yaml: nodes.audit: unknown agent "nope" (known: claude, codex, command)',
  ]);
});

test('an agent that cannot load plugins is refused a plugins mapping', async () => {
  const g = graphOf({ review: { agent: 'codex' } });
  const m = mapping('plugins', '/p', { dir: 'plug', applies_to: ['review'] });
  assert.deepEqual(await problems(checkAgents(g, [m], 'cfg.yaml')), [
    'cfg.yaml: bindings.review: agent "codex" cannot load plugins, but mapping g:plug (plugins) applies to it',
  ]);
});

test('a skill must be found in the mapped skills or plugins when the agent has no native skills', async (t) => {
  const dir = await tmp(t);
  await fs.mkdir(path.join(dir, 'skills', 'sec'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'sec', 'SKILL.md'), 's');
  const m = mapping('skills', path.join(dir, 'skills'), { dir: 'skills' });
  const g = graphOf({ review: { agent: 'codex', skills: ['g:sec', 'g:missing'] }, plan: { agent: 'claude', skill: 'g:missing' } });
  assert.deepEqual(await problems(checkAgents(g, [m], 'cfg.yaml')), [
    'cfg.yaml: bindings.review: skill "g:missing" not found in the skills or plugins mapped to it (agent "codex" loads skills from files)',
  ]);
});

test('skills mappings must use dir', async () => {
  const m = mapping('skills', '/x/a.md', { dir: undefined, file: 'a.md' });
  assert.deepEqual(await problems(checkAgents(graphOf({}), [m], 'cfg.yaml')), [
    'cfg.yaml: mapping g:a.md: skills mappings must use dir',
  ]);
});

test('an unknown builtin is reported with the known names, alongside other problems', async () => {
  const g = graphOf({ intake: { builtin: 'read-ticket' }, review: { agent: 'gemini' } }, { audit: { after: 'review', builtin: 'nope' } });
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.intake: unknown builtin "read-ticket" (known: github.intake, github.open_pr)',
    'cfg.yaml: bindings.review: unknown agent "gemini" (known: claude, codex, command)',
    'cfg.yaml: nodes.audit: unknown builtin "nope" (known: github.intake, github.open_pr)',
  ]);
});

test('the known builtins pass', async () => {
  await checkAgents(graphOf({ deliver: { builtin: 'github.open_pr' } }), [], 'cfg.yaml');
});
