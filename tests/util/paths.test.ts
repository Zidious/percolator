import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { expandHome, samePath, toPosix } from '../../src/util/paths.ts';

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
