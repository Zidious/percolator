import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { copyContained } from '../../src/util/copy.ts';

async function tmp(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-copy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** Create a symlink, or skip the test when the platform denies it. */
async function link(t: TestContext, target: string, file: string, type: 'junction' | 'file'): Promise<boolean> {
  try {
    await fs.symlink(target, file, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlinks need privilege');
      return false;
    }
    throw err;
  }
}

test('copyContained copies a tree and follows in-root links', async (t) => {
  const base = await tmp(t);
  const root = path.join(base, 'ground');
  await fs.mkdir(path.join(root, 'src', 'sub'), { recursive: true });
  await fs.mkdir(path.join(root, 'shared'));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'A');
  await fs.writeFile(path.join(root, 'src', 'sub', 'b.txt'), 'B');
  await fs.writeFile(path.join(root, 'shared', 'c.txt'), 'C');
  if (!(await link(t, path.join(root, 'shared'), path.join(root, 'src', 'lnk'), 'junction'))) return;

  const dest = path.join(base, 'out', 'copy');
  await copyContained(path.join(root, 'src'), dest, root);
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(dest, 'sub', 'b.txt'), 'utf8'), 'B');
  assert.equal(await fs.readFile(path.join(dest, 'lnk', 'c.txt'), 'utf8'), 'C');
  assert.ok(!(await fs.lstat(path.join(dest, 'lnk'))).isSymbolicLink());
  assert.deepEqual((await fs.readdir(path.join(base, 'out'))).sort(), ['copy']);
});

test('copyContained copies the content of an in-root file link', async (t) => {
  const base = await tmp(t);
  await fs.mkdir(path.join(base, 'src'));
  await fs.writeFile(path.join(base, 'f.txt'), 'F');
  if (!(await link(t, path.join(base, 'f.txt'), path.join(base, 'src', 'f-link.txt'), 'file'))) return;
  const dest = path.join(base, 'out');
  await copyContained(path.join(base, 'src'), dest, base);
  assert.equal(await fs.readFile(path.join(dest, 'f-link.txt'), 'utf8'), 'F');
  assert.ok(!(await fs.lstat(path.join(dest, 'f-link.txt'))).isSymbolicLink());
});

test('copyContained copies a single file', async (t) => {
  const base = await tmp(t);
  await fs.writeFile(path.join(base, 'x.md'), 'X');
  await copyContained(path.join(base, 'x.md'), path.join(base, 'y', 'x.md'), base);
  assert.equal(await fs.readFile(path.join(base, 'y', 'x.md'), 'utf8'), 'X');
});

test('copyContained refuses a link outside the root and leaves nothing behind', async (t) => {
  const base = await tmp(t);
  const root = path.join(base, 'ground');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'S');
  await fs.writeFile(path.join(root, 'src', 'ok.txt'), 'ok');
  if (!(await link(t, outside, path.join(root, 'src', 'esc'), 'junction'))) return;

  const parent = path.join(base, 'out');
  const dest = path.join(parent, 'copy');
  await assert.rejects(copyContained(path.join(root, 'src'), dest, root), /esc links outside the ground/);
  await assert.rejects(fs.access(dest));
  assert.deepEqual(await fs.readdir(parent), []);
});

test('copyContained throws when dest already exists', async (t) => {
  const base = await tmp(t);
  await fs.writeFile(path.join(base, 'x.md'), 'X');
  await fs.mkdir(path.join(base, 'dest'));
  await assert.rejects(copyContained(path.join(base, 'x.md'), path.join(base, 'dest'), base), /dest already exists/);
});
