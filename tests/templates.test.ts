import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadUserConfig } from '../src/config/load.ts';
import { selectProfile } from '../src/config/profile.ts';
import { STAGES } from '../src/config/schema.ts';
import { validate } from '../src/validate.ts';

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

test("template's default profile matches GitHub remotes", async () => {
  await withTemplate(async (tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    for (const remoteUrl of ['git@github.com:o/r.git', 'https://github.com/o/r']) {
      assert.equal(selectProfile(config, { cwd: tmp, remoteUrl }).name, 'default');
    }
  });
});

test('template binds agent stages to claude with the recommended models', async () => {
  await withTemplate(async (_tmp, configFile) => {
    const config = await loadUserConfig(configFile);
    const b = config.profiles['default']!.bindings!;
    const agent = (s: string) => (b as Record<string, unknown>)[s] as { agent: string; model: string; prompt: unknown; max_rounds?: number };
    assert.equal(agent('groom').model, 'sonnet');
    for (const s of ['plan', 'implement', 'review']) assert.equal(agent(s).model, 'opus');
    assert.equal(agent('review').max_rounds, 3);
    for (const s of ['groom', 'plan', 'implement', 'review']) {
      assert.equal(agent(s).agent, 'claude');
      assert.equal(typeof agent(s).prompt, 'string');
      assert.ok((agent(s).prompt as string).trim().length > 0);
    }
  });
});
