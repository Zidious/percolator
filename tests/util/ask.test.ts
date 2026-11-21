import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { askLine } from '../../src/util/ask.ts';

test('askLine writes the question and returns the answered line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (b: Buffer) => (shown += b.toString()));
  const answer = askLine('go? ', { input, output });
  input.write('yes\n');
  assert.equal(await answer, 'yes');
  assert.equal(shown, 'go? ');
});

test('askLine returns an empty answer at end of input', async () => {
  const input = new PassThrough();
  const answer = askLine('go? ', { input, output: new PassThrough() });
  input.end();
  assert.equal(await answer, '');
});
