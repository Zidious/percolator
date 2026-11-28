import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemLine, questionLines } from '../../src/run/status-text.ts';

test('itemLine is the first non-empty line without heading, list number, bold or backticks', () => {
  assert.equal(itemLine('\n\n## 2. **Fix** the `parser` and __this__\nmore'), 'Fix the parser and this');
  assert.equal(itemLine('  3) keep `x`'), 'keep x');
  assert.equal(itemLine(''), '');
});

test('questionLines numbers the first line and indents the rest, keeping blank lines blank', () => {
  assert.deepEqual(questionLines(2, '\nWhich base?\n\nmain or dev\n'), ['  2. Which base?', '', '     main or dev']);
});
