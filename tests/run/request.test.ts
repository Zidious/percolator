import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineSpec } from '../../src/config/pipelines.ts';
import { checkRequest, InputError, parseInputs } from '../../src/run/request.ts';

const spec = (over: Partial<PipelineSpec> = {}): PipelineSpec => ({
  name: 'dd-alert',
  stages: ['intake', 'triage', 'deliver'],
  ticket: 'none',
  inputs: { alert_url: { required: true }, note: { required: false } },
  default: false,
  ...over,
});

test('parseInputs splits on the first =', () => {
  assert.deepEqual(parseInputs(['q=a=b']), { q: 'a=b' });
});

test('parseInputs keeps a Windows path', () => {
  assert.deepEqual(parseInputs(['dir=C:\\x y']), { dir: 'C:\\x y' });
});

test('parseInputs keeps an empty value and a value starting with -', () => {
  assert.deepEqual(parseInputs(['a=', 'b=-x']), { a: '', b: '-x' });
});

test('malformed input', () => {
  for (const raw of ['novalue', '=x']) {
    assert.throws(() => parseInputs([raw]), { name: 'InputError', message: `--input needs key=value, got "${raw}"` });
  }
});

test('duplicate input', () => {
  assert.throws(() => parseInputs(['a=1', 'a=2']), { name: 'InputError', message: '--input a is given twice; give it once' });
});

test('a ticket on a ticket: none pipeline is refused', () => {
  assert.throws(() => checkRequest(spec(), '#5', { alert_url: 'u' }), {
    name: 'InputError',
    message: 'pipeline "dd-alert" takes no ticket (ticket: none); drop the ticket or pick another pipeline with --pipeline',
  });
});

test('a missing ticket on a ticket: required pipeline is refused', () => {
  assert.throws(() => checkRequest(spec({ name: 'hotfix', ticket: 'required', inputs: {} }), undefined, {}), {
    name: 'InputError',
    message: 'pipeline "hotfix" needs a ticket; pass one: perc run <ticket> --pipeline hotfix',
  });
});

test('an unknown input is refused, listing the declared ones', () => {
  assert.throws(() => checkRequest(spec(), undefined, { alert_url: 'u', nope: 'x' }), {
    name: 'InputError',
    message: 'pipeline "dd-alert" has no input "nope" (inputs: alert_url, note); drop it or declare it under pipelines.dd-alert.inputs',
  });
});

test('an input to a pipeline without inputs says none', () => {
  assert.throws(() => checkRequest(spec({ name: 'hotfix', ticket: 'optional', inputs: {} }), undefined, { nope: 'x' }), {
    name: 'InputError',
    message: 'pipeline "hotfix" has no input "nope" (inputs: none); drop it or declare it under pipelines.hotfix.inputs',
  });
});

test('a missing required input is refused', () => {
  assert.throws(() => checkRequest(spec(), undefined, { note: 'n' }), {
    name: 'InputError',
    message: 'pipeline "dd-alert" needs input alert_url; pass --input alert_url=<value>',
  });
});

test('the ticket is checked before the inputs', () => {
  assert.throws(() => checkRequest(spec(), '#5', { nope: 'x' }), { message: /takes no ticket/ });
});

test('a valid request passes', () => {
  checkRequest(spec(), undefined, { alert_url: 'u' });
  checkRequest(spec({ ticket: 'optional' }), '#5', { alert_url: 'u' });
  checkRequest(spec({ ticket: 'optional' }), undefined, { alert_url: 'u', note: '' });
  assert.ok(new InputError('x') instanceof Error);
});
