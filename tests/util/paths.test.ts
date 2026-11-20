import path from 'node:path';
import { expect, test } from 'vitest';
import { expandHome, samePath, toPosix } from '../../src/util/paths.js';

test('expandHome handles both separators', () => {
  expect(expandHome('~/dev/x', '/h')).toBe(path.resolve('/h', 'dev/x'));
  expect(expandHome('~\\dev\\x', '/h')).toBe(path.resolve('/h', 'dev', 'x'));
  expect(expandHome('~', '/h')).toBe(path.resolve('/h'));
});

test('toPosix normalises windows paths', () => {
  expect(toPosix('C:\\Users\\Me\\repo')).toBe('c:/Users/Me/repo');
});

test.runIf(process.platform === 'win32')('samePath ignores case on windows', () => {
  expect(samePath('C:\\Repo', 'c:/repo')).toBe(true);
});
