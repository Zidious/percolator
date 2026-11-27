import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerError } from '../../src/run/answer.ts';
import { InputError } from '../../src/run/request.ts';
import { UsageError } from '../../src/util/errors.ts';

test('input and answer errors are usage errors, which perc reports with its usage and exit code 2', () => {
  assert.ok(new InputError('x') instanceof UsageError);
  assert.ok(new AnswerError('x') instanceof UsageError);
});

test('subclassing UsageError keeps each error\'s own name and message', () => {
  assert.equal(new InputError('bad input').name, 'InputError');
  assert.equal(new AnswerError('bad answer').name, 'Error');
  assert.equal(new UsageError('bad flag').message, 'bad flag');
});
