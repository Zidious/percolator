import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeJsonSchema } from '../../src/config/json-schema.ts';
import { ConfigError, loadFragment, loadUserConfig } from '../../src/config/load.ts';
import { effectiveKind } from '../../src/config/schema.ts';

const fx = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', 'config', name);

test('loads a valid config with defaults applied', async () => {
  const c = await loadUserConfig(fx('valid.yaml'));
  assert.partialDeepStrictEqual(c.profiles.work.use![0], { as: 'policy', applies_to: ['*'], required: false });
});

test('YAML syntax error reports file and line', async () => {
  const err = await loadUserConfig(fx('bad-yaml.yaml')).catch((e) => e);
  assert.ok(err instanceof ConfigError);
  assert.equal(err.name, 'ConfigError');
  assert.equal(err.line, 4);
  assert.equal(err.file, fx('bad-yaml.yaml'));
});

test('schema error reports path and line', async () => {
  await assert.rejects(loadUserConfig(fx('bad-schema.yaml')), {
    name: 'ConfigError',
    path: 'profiles.work.use.0.as',
    line: 6,
  });
});

test('mapping with both file and dir is rejected', async () => {
  await assert.rejects(loadUserConfig(fx('mapping-both.yaml')), ConfigError);
});

test('node with both before and after is rejected', async () => {
  await assert.rejects(loadFragment(fx('node-both.yaml')), ConfigError);
});

test('loadFragment loads a valid fragment; effectiveKind infers script', async () => {
  const f = await loadFragment(fx('fragment.yaml'));
  assert.equal(effectiveKind(f.nodes!.lint), 'script');
});

test('node with no agent/builtin/command is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const file = path.join(dir, 'f.yaml');
    await fs.writeFile(file, 'nodes:\n  x:\n    model: m\n');
    await assert.rejects(loadFragment(file), ConfigError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function withYaml(text: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const file = path.join(dir, 'f.yaml');
    await fs.writeFile(file, text);
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('unknown stage in a hook lists the valid values', async () => {
  await withYaml('nodes:\n  x:\n    agent: a\n    before: foo\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.path, 'nodes.x.before');
    assert.equal(err.line, 4);
    assert.ok(err.message.includes('intake'));
    assert.ok(err.message.includes('all'));
  });
});

test('ground with neither git nor path gives a readable message', async () => {
  await withYaml('version: 1\ngrounds:\n  g: {}\nprofiles: {}\n', async (file) => {
    const err = await loadUserConfig(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.match(String(err.path), /^grounds\.g\./);
    assert.doesNotMatch(err.message, /Invalid input$/m);
    assert.match(err.message, /expected string/);
  });
});

for (const name of ['../x', 'a/b', '..\\x','-x', '.hidden', 'a b']) {
  test(`ground name ${JSON.stringify(name)} is rejected as unsafe`, async () => {
    await withYaml(`version: 1\ngrounds:\n  ${JSON.stringify(name)}:\n    path: /tmp/x\nprofiles: {}\n`, async (file) => {
      const err = await loadUserConfig(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(file));
      assert.match(err.message, /ground names? .*letters, digits, "\.", "_" and "-"/);
      assert.doesNotMatch(err.message, /Invalid input$/m);
    });
  });
}

test('ordinary ground names are accepted', async () => {
  await withYaml('version: 1\ngrounds:\n  company-1.x_y:\n    path: /tmp/x\nprofiles: {}\n', async (file) => {
    assert.deepEqual(Object.keys((await loadUserConfig(file)).grounds!), ['company-1.x_y']);
  });
});

test('every schema issue appears in the message, first one in line/path', async () => {
  await withYaml('nodes:\n  a:\n    agent: x\n    before: foo\n  b:\n    agent: y\n    after: bar\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.equal(err.path, 'nodes.a.before');
    assert.equal(err.line, 4);
    const lines = err.message.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(`${file}:4: nodes.a.before:`));
    assert.ok(lines[1].includes(`${file}:7: nodes.b.after:`));
  });
});

test('every YAML error appears in the message', async () => {
  await withYaml('a: 1\na: 2\nb: 1\nb: 2\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.equal(err.message.split('\n').length, 2);
    assert.equal(err.line, 2);
  });
});

test('json schema is generated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const out = path.join(dir, 's.json');
    await writeJsonSchema(out);
    const parsed = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.notEqual(parsed.properties.profiles, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
