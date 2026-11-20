import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli.ts';

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cli-init-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

async function run(argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

test('init writes the config and prints the next step', async () => {
  const file = path.join(tmp, 'one', 'config.yaml');
  const r = await run(['init', '--config', file]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `wrote ${file}\nnext: perc validate --config ${file} --profile default\n`);
  const v = await run(['validate', '--config', file, '--profile', 'default']);
  assert.equal(v.code, 0, v.err);
});

test('init on an existing config exits 1 with the error', async () => {
  const file = path.join(tmp, 'two.yaml');
  await fs.writeFile(file, 'keep');
  const r = await run(['init', '--config', file]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `${file} already exists; edit it, or rerun with --force to replace it\n`);
});

test('init --force overwrites', async () => {
  const file = path.join(tmp, 'three.yaml');
  await fs.writeFile(file, 'keep');
  const r = await run(['init', '--config', file, '--force']);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(await fs.readFile(file, 'utf8'), 'keep');
});

test('init with a positional is a usage error', async () => {
  const r = await run(['init', 'extra', '--config', path.join(tmp, 'four.yaml')]);
  assert.equal(r.code, 2);
  assert.ok(r.err.startsWith("Unexpected argument 'extra'"), r.err);
  assert.ok(r.err.includes('usage: perc'));
});

test('help lists init', async () => {
  const r = await run(['--help']);
  assert.ok(r.out.includes('init [--config <file>] [--force]'));
});
