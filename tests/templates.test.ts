import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadUserConfig } from '../src/config/load.ts';
import { selectProfile } from '../src/config/profile.ts';
import { STAGES } from '../src/config/schema.ts';
import { validate, validateAll } from '../src/validate.ts';

const TEMPLATE = path.resolve(import.meta.dirname, '..', 'templates', 'config.yaml');

async function withTemplate<T>(fn: (tmp: string, configFile: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-template-'));
  try {
    const configFile = path.join(tmp, 'config.yaml');
    await fs.copyFile(TEMPLATE, configFile);
    return await fn(tmp, configFile);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test('template validates through the full pipeline', async () => {
  await withTemplate(async (tmp, configFile) => {
    const r = await validate({ configFile, cwd: tmp, profile: 'default', home: tmp });
    assert.equal(r.profile, 'default');
    const slots = new Set(r.graph.steps.filter((s) => s.role === 'slot').map((s) => s.stage));
    for (const stage of STAGES) assert.ok(slots.has(stage), `missing slot stage ${stage}`);
  });
});

test("the template's feature pipeline validates as the default", async () => {
  await withTemplate(async (tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const feature = config.profiles['default']!.pipelines?.['feature'];
    assert.ok(feature, 'profiles.default.pipelines has feature');
    assert.equal(feature.default, true);
    assert.equal(config.profiles['default']!.bindings, undefined, 'the bindings live inside pipelines.feature');
    const r = await validate({ configFile, cwd: tmp, profile: 'default', home: tmp });
    assert.equal(r.pipeline.name, 'feature');
    assert.equal(r.pipeline.default, true);
  });
});

test("template's default profile matches GitHub remotes", async () => {
  await withTemplate(async (tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    for (const remoteUrl of ['git@github.com:o/r.git', 'https://github.com/o/r']) {
      assert.equal(selectProfile(config, { cwd: tmp, remoteUrl }).name, 'default');
    }
  });
});

test('template binds agent stages to claude on opus, each with a skill', async () => {
  await withTemplate(async (_tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const b = config.profiles['default']!.pipelines!['feature']!.bindings!;
    type Agent = { agent: string; model: string; effort?: string; skill?: string; skills?: string[]; prompt?: unknown; max_rounds?: number };
    const agent = (s: string) => (b as Record<string, unknown>)[s] as Agent;
    for (const s of ['groom', 'plan', 'implement', 'review']) {
      assert.equal(agent(s).agent, 'claude');
      assert.equal(agent(s).model, 'opus');
      assert.ok(agent(s).skill !== undefined || (agent(s).skills ?? []).length > 0, `${s} names a skill`);
    }
    assert.equal(agent('review').effort, 'medium');
    assert.equal(agent('review').max_rounds, 3);
    // groom keeps a prompt: it stops brainstorming before it moves on to planning
    assert.match(agent('groom').prompt as string, /then stop: no plan and no code/);
  });
});

test('template adds a pr-description agent hook before deliver', async () => {
  await withTemplate(async (tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const node = (config.profiles['default']!.pipelines!['feature']!.nodes as Record<string, { agent: string; model: string; before: string; prompt: string }> | undefined)?.['pr-description'];
    assert.ok(node, 'profiles.default.pipelines.feature.nodes has pr-description');
    assert.equal(node.agent, 'claude');
    assert.equal(node.model, 'opus');
    assert.equal(node.before, 'deliver');
    assert.match(node.prompt, /pr_body\.md/);
    const r = await validate({ configFile, cwd: tmp, profile: 'default', home: tmp });
    const steps = r.graph.steps;
    const deliver = steps.findIndex((s) => s.role === 'slot' && s.stage === 'deliver');
    assert.ok(deliver > 0);
    assert.equal(steps[deliver - 1]!.id, 'pr-description');
    assert.equal(steps[deliver - 1]!.role, 'hook');
  });
});

test('the pr-description prompt uses only known template variables', async () => {
  await withTemplate(async (_tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const node = (config.profiles['default']!.pipelines!['feature']!.nodes as Record<string, { prompt: string }> | undefined)?.['pr-description'];
    assert.ok(node, 'profiles.default.pipelines.feature.nodes has pr-description');
    const known = new Set(['run_id', 'ticket', 'step', 'stage', 'round', 'max_rounds', 'worktree', 'branch', 'base', 'run_dir', 'outputs_dir']);
    const names = [...node.prompt.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)].map((m) => m[1]!);
    assert.ok(names.length > 0);
    for (const n of names) assert.ok(known.has(n), `unknown template variable {{${n}}}`);
  });
});

test('the pr-description prompt does not point at review rounds and always finishes with pass', async () => {
  await withTemplate(async (_tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const node = (config.profiles['default']!.pipelines!['feature']!.nodes as Record<string, { prompt: string }> | undefined)?.['pr-description'];
    assert.ok(node, 'profiles.default.pipelines.feature.nodes has pr-description');
    assert.doesNotMatch(node.prompt, /\brounds\b/);
    assert.match(node.prompt, /Finish with status pass/);
  });
});

/** The template with its commented example pipelines uncommented: lines after a `# ` that start with a key or are indented. */
function uncommentExamples(text: string): string {
  return text.replace(/^(\s*)# ((?:[a-z][a-z0-9_-]*:|  ).*)$/gm, '$1$2');
}

test("the docs' example config is exactly what perc init writes", async () => {
  const doc = await fs.readFile(path.resolve(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');
  const example = doc.split('## Example config')[1]?.split('```yaml\n')[1]?.split('```\n')[0];
  assert.ok(example !== undefined, 'docs/configuration.md has a yaml block under "## Example config"');
  assert.equal(example, await fs.readFile(TEMPLATE, 'utf8'));
});

test('the commented example pipelines validate once uncommented', async () => {
  await withTemplate(async (tmp, configFile) => {
    await fs.writeFile(configFile, uncommentExamples(await fs.readFile(TEMPLATE, 'utf8')));
    const rs = await validateAll({ configFile, cwd: tmp, profile: 'default', home: tmp });
    assert.deepEqual(rs.map((r) => r.pipeline.name), ['feature', 'dd-alert', 'hotfix', 'triage', 'epic']);
    const triage = rs.find((r) => r.pipeline.name === 'triage')!;
    assert.equal(triage.pipeline.router, true);
    assert.deepEqual(triage.pipeline.choose?.from, ['feature', 'hotfix']);
    assert.deepEqual(triage.pipeline.triggers, [{ label: 'triage' }]);
    assert.deepEqual(triage.graph.steps.map((s) => s.id).slice(-4), ['route.0', 'route.1', 'pick-pipeline', 'route.3']);
  });
});

test('the commented fan-out example validates as a parent and as a slice', async () => {
  await withTemplate(async (tmp, configFile) => {
    await fs.writeFile(configFile, uncommentExamples(await fs.readFile(TEMPLATE, 'utf8')));
    const parent = await validate({ configFile, cwd: tmp, profile: 'default', home: tmp, pipeline: 'epic' });
    assert.deepEqual(parent.pipeline.fan_out, { stage: 'implement', slices: { from: 'plan', output: 'slices' }, max_parallel: 3 });
    const last = parent.graph.steps.at(-1)!;
    assert.deepEqual([last.id, last.def], ['implement', { builtin: 'percolator.fan_out' }]);
    const slice = await validate({ configFile, cwd: tmp, profile: 'default', home: tmp, pipeline: 'epic', sliceFrom: 'implement' });
    assert.deepEqual(slice.graph.steps[0]!.def, { builtin: 'percolator.seed' });
    assert.equal(slice.graph.steps.at(-1)!.stage, 'deliver');
  });
});
