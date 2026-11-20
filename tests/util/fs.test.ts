import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { readYamlFile, writeFileAtomic } from '../../src/util/fs.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-fs-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeFileAtomic leaves no tmp files and replaces content', async () => {
  const target = path.join(dir, 'out.txt');
  await writeFileAtomic(target, 'first');
  await writeFileAtomic(target, 'second');
  assert.equal(await fs.readFile(target, 'utf8'), 'second');
  assert.deepEqual(await fs.readdir(dir), ['out.txt']);
});

test('readYamlFile returns document, lineCounter and text', async () => {
  const target = path.join(dir, 'a.yaml');
  await fs.writeFile(target, 'a: 1\nb: 2\n');
  const { doc, lineCounter, text } = await readYamlFile(target);
  assert.deepEqual(doc.toJS(), { a: 1, b: 2 });
  assert.equal(text, 'a: 1\nb: 2\n');
  assert.equal(lineCounter.linePos(5).line, 2);
});
