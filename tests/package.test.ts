import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonSchema } from '../src/config/json-schema.ts';

const root = path.resolve(import.meta.dirname, '..');

test('package.json publishes dist and schema with explicit exports', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['dist', 'schema']);
  assert.deepEqual(pkg.exports, {
    '.': './dist/index.js',
    './schema.json': './schema/percolator.schema.json',
  });
  assert.deepEqual(pkg.bin, { perc: 'dist/cli.js' });
  assert.equal(pkg.main, 'dist/index.js');
});

test('committed JSON schema matches the generated one byte for byte', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-schema-'));
  try {
    const out = path.join(dir, 'schema.json');
    await writeJsonSchema(out);
    const generated = await fs.readFile(out);
    const committed = await fs.readFile(path.join(root, 'schema', 'percolator.schema.json'));
    assert.ok(generated.equals(committed), 'schema/percolator.schema.json is stale; run pnpm schema');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
