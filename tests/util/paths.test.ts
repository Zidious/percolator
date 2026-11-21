import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { expandHome, foldCase, isInside, samePath, toPosix } from '../../src/util/paths.ts';

test('expandHome handles both separators', () => {
  assert.equal(expandHome('~/dev/x', '/h'), path.resolve('/h', 'dev/x'));
  assert.equal(expandHome('~\\dev\\x', '/h'), path.resolve('/h', 'dev', 'x'));
  assert.equal(expandHome('~', '/h'), path.resolve('/h'));
});

test('toPosix normalises windows paths', () => {
  assert.equal(toPosix('C:\\Users\\Me\\repo'), 'c:/Users/Me/repo');
});

test('samePath ignores case on windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(samePath('C:\\Repo', 'c:/repo'), true);
});

test('expandHome refuses ~user', () => {
  assert.throws(() => expandHome('~bob/x', '/h'), {
    message: '"~bob/x": ~user paths are not supported; use ~/ or an absolute path',
  });
  assert.equal(expandHome('~', '/h'), path.resolve('/h'));
  assert.equal(expandHome('~/x', '/h'), path.resolve('/h', 'x'));
});

test('foldCase lower-cases on win32 and darwin only', () => {
  assert.equal(foldCase('/A/B', 'win32'), '/a/b');
  assert.equal(foldCase('/A/B', 'darwin'), '/a/b');
  assert.equal(foldCase('/A/B', 'linux'), '/A/B');
});

test('isInside is true for the dir itself and anything under it, never a sibling sharing its prefix', () => {
  const root = path.resolve('repo', '.worktrees', 'r1');
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(path.join(root, 'src', 'a'), root), true);
  assert.equal(isInside(`${root}-other`, root), false);
  assert.equal(isInside(path.resolve('repo'), root), false);
  assert.equal(isInside(`${root}${path.sep}`, root), true);
});

test('isInside ignores case and slash style on win32', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isInside('C:/Repo/.worktrees/R1/src', 'c:\\repo\\.worktrees\\r1'), true);
});
