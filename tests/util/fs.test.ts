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

const errno = (code: string) => Object.assign(new Error(`${code}: rename`), { code });

test('writeFileAtomic retries a rename that fails with EPERM, then writes the file', async () => {
  const target = path.join(dir, 'state.json');
  let attempts = 0;
  const rename = async (from: string, to: string) => {
    attempts++;
    if (attempts <= 2) throw errno('EPERM');
    await fs.rename(from, to);
  };
  await writeFileAtomic(target, 'ok', { rename });
  assert.equal(attempts, 3);
  assert.equal(await fs.readFile(target, 'utf8'), 'ok');
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('writeFileAtomic gives up after 6 attempts with the original error and leaves no tmp file', async () => {
  const target = path.join(dir, 'state.json');
  const original = errno('EBUSY');
  let attempts = 0;
  const rename = async () => {
    attempts++;
    throw original;
  };
  await assert.rejects(writeFileAtomic(target, 'x', { rename }), (e) => e === original);
  assert.equal(attempts, 6);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('writeFileAtomic does not retry other rename errors', async () => {
  const target = path.join(dir, 'state.json');
  let attempts = 0;
  const original = errno('EXDEV');
  await assert.rejects(
    writeFileAtomic(target, 'x', {
      rename: async () => {
        attempts++;
        throw original;
      },
    }),
    (e) => e === original,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(dir), []);
});
