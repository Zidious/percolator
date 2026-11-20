import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { exists } from '../../src/util/fs.ts';
import { initConfig, templatePath } from '../../src/config/init.ts';

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-init-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('templatePath points at templates/config.yaml in the repo', async () => {
  assert.equal(templatePath(), path.resolve(import.meta.dirname, '..', '..', 'templates', 'config.yaml'));
  assert.ok(await exists(templatePath()), 'the template file exists');
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

test('initConfig refuses a directory target, with or without force', async () => {
  const dir = path.join(tmp, 'adir');
  await fs.mkdir(dir);
  const message = `${dir} is a directory; pass a file path to --config`;
  await assert.rejects(initConfig(dir), { message });
  await assert.rejects(initConfig(dir, { force: true }), { message });
});
