import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { writeJsonSchema } from '../../src/config/json-schema.ts';
import { ConfigError, loadFragment, loadUserConfig } from '../../src/config/load.ts';
import { effectiveKind } from '../../src/config/schema.ts';

const fx = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', 'config', name);

test('loads a valid config with defaults applied', async () => {
  const c = await loadUserConfig(fx('valid.yaml'));
  expect(c.profiles.work.use![0]).toMatchObject({ as: 'policy', applies_to: ['*'], required: false });
});

test('YAML syntax error reports file and line', async () => {
  const err = await loadUserConfig(fx('bad-yaml.yaml')).catch((e) => e);
  expect(err).toBeInstanceOf(ConfigError);
  expect(err).toMatchObject({ name: 'ConfigError', line: 4, file: fx('bad-yaml.yaml') });
});

test('schema error reports path and line', async () => {
  await expect(loadUserConfig(fx('bad-schema.yaml'))).rejects.toMatchObject({
    name: 'ConfigError',
    path: 'profiles.work.use.0.as',
    line: 6,
  });
});

test('mapping with both file and dir is rejected', async () => {
  await expect(loadUserConfig(fx('mapping-both.yaml'))).rejects.toBeInstanceOf(ConfigError);
});

test('node with both before and after is rejected', async () => {
  await expect(loadFragment(fx('node-both.yaml'))).rejects.toBeInstanceOf(ConfigError);
});

test('loadFragment loads a valid fragment; effectiveKind infers script', async () => {
  const f = await loadFragment(fx('fragment.yaml'));
  expect(effectiveKind(f.nodes!.lint)).toBe('script');
});

test('node with no agent/builtin/command is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const file = path.join(dir, 'f.yaml');
    await fs.writeFile(file, 'nodes:\n  x:\n    model: m\n');
    await expect(loadFragment(file)).rejects.toBeInstanceOf(ConfigError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json schema is generated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const out = path.join(dir, 's.json');
    await writeJsonSchema(out);
    const parsed = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(parsed.properties.profiles).toBeDefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
