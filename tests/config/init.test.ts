import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { initConfig, templatePath } from '../../src/config/init.ts';

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-init-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('templatePath points at templates/config.yaml in the repo', () => {
  assert.equal(templatePath(), path.resolve(import.meta.dirname, '..', '..', 'templates', 'config.yaml'));
});

test('initConfig writes the template byte for byte, creating the parent dir', async () => {
  const file = path.join(tmp, 'a', 'b', 'config.yaml');
  await initConfig(file);
  assert.equal(await fs.readFile(file, 'utf8'), await fs.readFile(templatePath(), 'utf8'));
});

test('initConfig refuses an existing file', async () => {
  const file = path.join(tmp, 'exists.yaml');
  await fs.writeFile(file, 'keep');
  await assert.rejects(initConfig(file), { message: `${file} already exists; edit it, or rerun with --force to replace it` });
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('initConfig with force replaces an existing file', async () => {
  const file = path.join(tmp, 'force.yaml');
  await fs.writeFile(file, 'keep');
  await initConfig(file, { force: true });
  assert.equal(await fs.readFile(file, 'utf8'), await fs.readFile(templatePath(), 'utf8'));
});
