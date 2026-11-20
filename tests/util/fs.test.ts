import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readYamlFile, writeFileAtomic } from '../../src/util/fs.js';

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
  expect(await fs.readFile(target, 'utf8')).toBe('second');
  expect(await fs.readdir(dir)).toEqual(['out.txt']);
});

test('readYamlFile returns document, lineCounter and text', async () => {
  const target = path.join(dir, 'a.yaml');
  await fs.writeFile(target, 'a: 1\nb: 2\n');
  const { doc, lineCounter, text } = await readYamlFile(target);
  expect(doc.toJS()).toEqual({ a: 1, b: 2 });
  expect(text).toBe('a: 1\nb: 2\n');
  expect(lineCounter.linePos(5).line).toBe(2);
});
