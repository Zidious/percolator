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

test('effort on an agent that cannot take it is reported; on claude it passes', async () => {
  const g = graphOf({ review: { agent: 'codex', effort: 'high' }, plan: { agent: 'claude', effort: 'medium' } });
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.review.effort: agent "codex" does not take "effort"; remove it or use agent "claude"',
  ]);
});

test('unknown agent, missing command and a dashed command are all reported, hooks as nodes.<id>', async () => {
  const g = graphOf(
    { review: { agent: 'gemini' }, plan: { agent: 'command' }, implement: { agent: 'command', command: ['-rf'] } },
    { audit: { after: 'review', agent: 'nope' } },
  );
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.plan: agent "command" needs "command" (the program to run); add command: [program, ...args]',
    'cfg.yaml: bindings.implement.command: command must not start with "-"; put the program first',
    'cfg.yaml: bindings.review.agent: unknown agent "gemini" (known: claude, codex, command); use one of those',
    'cfg.yaml: nodes.audit.agent: unknown agent "nope" (known: claude, codex, command); use one of those',
  ]);
});

test('an agent that cannot load plugins is refused a plugins mapping', async () => {
  const g = graphOf({ review: { agent: 'codex' } });
  const m = mapping('plugins', '/p', { dir: 'plug', applies_to: ['review'] });
  assert.deepEqual(await problems(checkAgents(g, [m], 'cfg.yaml')), [
    "cfg.yaml: bindings.review: agent \"codex\" cannot load plugins, but mapping g:plug (plugins) applies to it; narrow that mapping's applies_to or use agent \"claude\"",
  ]);
});

test('a skill must be found in the mapped skills or plugins when the agent has no native skills', async (t) => {
  const dir = await tmp(t);
  await fs.mkdir(path.join(dir, 'skills', 'sec'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'sec', 'SKILL.md'), 's');
  const m = mapping('skills', path.join(dir, 'skills'), { dir: 'skills' });
  const g = graphOf({ review: { agent: 'codex', skills: ['g:sec', 'g:missing'] }, plan: { agent: 'claude', skill: 'g:missing' } });
  assert.deepEqual(await problems(checkAgents(g, [m], 'cfg.yaml')), [
    'cfg.yaml: bindings.review.skills.1: skill "g:missing" not found in the skills or plugins mapped to it (agent "codex" loads skills from files); map a skills dir that has it, or remove the skill',
  ]);
});

test('skills mappings must use dir', async () => {
  const m = mapping('skills', '/x/a.md', { dir: undefined, file: 'a.md', path: 'use.2' });
  assert.deepEqual(await problems(checkAgents(graphOf({}), [m], 'cfg.yaml')), [
    'cfg.yaml: use.2.file: skills mappings must use dir; replace file: with dir:',
  ]);
});

test('an unknown builtin is reported with the known names, alongside other problems', async () => {
  const g = graphOf({ intake: { builtin: 'read-ticket' }, review: { agent: 'gemini' } }, { audit: { after: 'review', builtin: 'nope' } });
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.intake.builtin: unknown builtin "read-ticket" (known: github.intake, github.open_pr, github.comment, github.open_issues, percolator.report, github.release, github.pr_review, github.private_fork_pr); use one of those',
    'cfg.yaml: bindings.review.agent: unknown agent "gemini" (known: claude, codex, command); use one of those',
    'cfg.yaml: nodes.audit.builtin: unknown builtin "nope" (known: github.intake, github.open_pr, github.comment, github.open_issues, percolator.report, github.release, github.pr_review, github.private_fork_pr); use one of those',
  ]);
});

test('the known builtins pass', async () => {
  await checkAgents(graphOf({ deliver: { builtin: 'github.open_pr' } }), [], 'cfg.yaml');
});

test('a skill: (singular) is reported at .skill', async () => {
  const g = graphOf({ review: { agent: 'codex', skill: 'g:missing' } });
  assert.deepEqual(await problems(checkAgents(g, [], 'cfg.yaml')), [
    'cfg.yaml: bindings.review.skill: skill "g:missing" not found in the skills or plugins mapped to it (agent "codex" loads skills from files); map a skills dir that has it, or remove the skill',
  ]);
});

test('problems are located through the step and mapping locators', async () => {
  const locator = { file: 'g.yaml', lines: { 'bindings.review': 4, 'bindings.review.agent': 5, 'use.0': 2, 'use.0.file': 3 } };
  const g = buildGraph(mergeLayers([{ source: 'ground:g', fragment: { bindings: { ...base, review: { agent: 'gemini' } } }, locator }]));
  const m = mapping('skills', '/x/a.md', { dir: undefined, file: 'a.md', path: 'use.0', locator });
  assert.deepEqual(await problems(checkAgents(g, [m], 'cfg.yaml')), [
    'g.yaml:5: bindings.review.agent: unknown agent "gemini" (known: claude, codex, command); use one of those',
    'g.yaml:3: use.0.file: skills mappings must use dir; replace file: with dir:',
  ]);
});

test('a one-item list binding is located at its item, and a missing skill at its list entry', async () => {
  const lines = {
    'bindings.review': 4,
    'bindings.review.0': 5,
    'bindings.review.0.agent': 5,
    'bindings.review.0.effort': 6,
    'bindings.review.0.skills': 7,
    'bindings.review.0.skills.0': 8,
    'bindings.review.0.skills.1': 9,
  };
  const locator = { file: 'g.yaml', lines };
  const fragment = { bindings: { ...base, review: [{ agent: 'codex', effort: 'high' as const, skills: ['g:a', 'g:missing'] }] } };
  const g = buildGraph(mergeLayers([{ source: 'ground:g', fragment, locator }]));
  const out = await problems(checkAgents(g, [], 'cfg.yaml'));
  assert.deepEqual(out, [
    'g.yaml:6: bindings.review.0.effort: agent "codex" does not take "effort"; remove it or use agent "claude"',
    'g.yaml:8: bindings.review.0.skills.0: skill "g:a" not found in the skills or plugins mapped to it (agent "codex" loads skills from files); map a skills dir that has it, or remove the skill',
    'g.yaml:9: bindings.review.0.skills.1: skill "g:missing" not found in the skills or plugins mapped to it (agent "codex" loads skills from files); map a skills dir that has it, or remove the skill',
  ]);
});
