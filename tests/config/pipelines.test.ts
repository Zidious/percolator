import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPipeline, pickPipeline, pipelineSpecs } from '../../src/config/pipelines.ts';
import type { PipelineSpec } from '../../src/config/pipelines.ts';
import { mergePipelines } from '../../src/graph/merge.ts';

const where = { file: 'c.yaml', line: 7 };

const spec = (name: string, over: Partial<PipelineSpec> = {}): PipelineSpec => ({
  name,
  stages: ['intake', 'deliver'],
  ticket: 'required',
  inputs: {},
  default: false,
  ...over,
});

const specs = (...list: PipelineSpec[]): Record<string, PipelineSpec> => Object.fromEntries(list.map((s) => [s.name, s]));

test('defaultPipeline picks the one marked default', () => {
  assert.equal(defaultPipeline(specs(spec('feature'), spec('hotfix', { default: true })), 'work', where), 'hotfix');
});

test('two defaults are refused', () => {
  assert.throws(() => defaultPipeline(specs(spec('a', { default: true }), spec('b', { default: true })), 'work', where), {
    name: 'ConfigError',
    message: 'c.yaml:7: profile "work" marks more than one default pipeline (a, b); keep default: true on one',
  });
});

test('feature is the default when none is marked', () => {
  assert.equal(defaultPipeline(specs(spec('feature'), spec('hotfix')), 'work', where), 'feature');
});

test('no default and no feature pipeline is refused', () => {
  assert.throws(() => defaultPipeline(specs(spec('hotfix')), 'work', where), {
    name: 'ConfigError',
    message: 'c.yaml:7: profile "work" has no default pipeline; mark one with default: true',
  });
});

test('unknown pipeline lists the profile\'s pipelines', () => {
  assert.throws(() => pickPipeline(specs(spec('feature'), spec('hotfix')), 'nope', 'default', where), {
    name: 'ConfigError',
    message: 'c.yaml:7: unknown pipeline "nope" in profile "default" (pipelines: feature, hotfix); pass one of those to --pipeline',
  });
});

test('pickPipeline returns the named pipeline, or the default without a name', () => {
  const s = specs(spec('feature'), spec('hotfix'));
  assert.equal(pickPipeline(s, 'hotfix', 'work', where).name, 'hotfix');
  assert.equal(pickPipeline(s, undefined, 'work', where).name, 'feature');
});

test('pipelineSpecs fills header defaults and marks the default pipeline', () => {
  const merged = mergePipelines([
    {
      source: 'profile:work',
      fragment: {
        bindings: { intake: { builtin: 'github.intake' } },
        pipelines: {
          hotfix: { stages: ['intake', 'implement', 'deliver'], inputs: { why: { required: true, description: 'reason' } } },
        },
      },
    },
  ]);
  const s = pipelineSpecs(merged, 'work', where);
  assert.deepEqual(Object.keys(s), ['feature', 'hotfix']);
  assert.deepEqual(s.hotfix, {
    name: 'hotfix',
    stages: ['intake', 'implement', 'deliver'],
    inputs: { why: { required: true, description: 'reason' } },
    ticket: 'required',
    default: false,
  });
  assert.equal(s.feature!.default, true);
  assert.equal(s.feature!.exit, 'pr');
  assert.deepEqual(s.feature!.inputs, {});
});

test('pipelineSpecs leaves feature out when it has no bindings and is not defined', () => {
  const merged = mergePipelines([
    { source: 'profile:work', fragment: { pipelines: { alert: { default: true, stages: ['intake', 'deliver'], ticket: 'none' } } } },
  ]);
  const s = pipelineSpecs(merged, 'work', where);
  assert.deepEqual(Object.keys(s), ['alert']);
  assert.equal(s.alert!.ticket, 'none');
  assert.equal(s.alert!.default, true);
});

test('pipelineSpecs lists feature when it is defined under pipelines', () => {
  const merged = mergePipelines([
    { source: 'profile:work', locator: { file: 'c.yaml', lines: {} }, fragment: { pipelines: { feature: { description: 'the usual' }, alert: { stages: ['intake', 'deliver'] } } } },
  ]);
  assert.deepEqual(Object.keys(pipelineSpecs(merged, 'work', where)), ['feature', 'alert']);
});
