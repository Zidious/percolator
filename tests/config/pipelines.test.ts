import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGlobalStages, checkPipelines, defaultPipeline, pickPipeline, pipelineSpecs } from '../../src/config/pipelines.ts';
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

test('a top-level require_skills stage must belong to some pipeline of the profile', () => {
  const locator = { file: 'c.yaml', lines: { 'profiles.work.rules.require_skills.1.stage': 9 }, prefix: 'profiles.work' };
  const merged = mergePipelines([
    {
      source: 'profile:work',
      locator,
      fragment: {
        bindings: { intake: { builtin: 'github.intake' } },
        rules: {
          require_skills: [
            { stage: 'triage', skills: ['a'] },
            { stage: 'tirage', skills: ['a'] },
            { stage: '*', skills: ['a'] },
          ],
        },
        pipelines: {
          alert: { stages: ['intake', 'triage', 'deliver'], rules: { require_skills: [{ stage: 'nowhere', skills: ['a'] }] } },
        },
      },
    },
  ]);
  assert.deepEqual(checkGlobalStages(merged, pipelineSpecs(merged, 'work', where), 'work'), [
    {
      rule: 'require_skills',
      source: 'profile:work',
      target: 'rules.require_skills.1',
      message: 'names stage "tirage", which no pipeline in profile "work" has; use one of their stages or *',
      where: { file: 'c.yaml', line: 9, path: 'profiles.work.rules.require_skills.1.stage' },
    },
  ]);
});

// cross-pipeline checks: a profile `work` at c.yaml, its pipeline keys indexed at known lines
const lines: Record<string, number> = {
  'profiles.work.pipelines': 3,
  'profiles.work.pipelines.triage': 4,
  'profiles.work.pipelines.triage.ticket': 5,
  'profiles.work.pipelines.triage.routes.0.to': 6,
  'profiles.work.pipelines.triage.routes.1.to': 7,
  'profiles.work.pipelines.triage.choose.from.0': 8,
  'profiles.work.pipelines.triage.choose.from.1': 9,
  'profiles.work.pipelines.triage.fallback': 10,
};
const layer = (pipelines: Record<string, unknown>, withFeature = true) =>
  mergePipelines([
    {
      source: 'profile:work',
      locator: { file: 'c.yaml', lines, prefix: 'profiles.work' },
      fragment: { ...(withFeature ? { bindings: { intake: { builtin: 'github.intake' } } } : {}), pipelines: pipelines as never },
    },
  ]);
const profileWith = (pipelines: Record<string, unknown>) =>
  layer({
    hotfix: { description: 'fix a bug fast', stages: ['intake', 'implement', 'deliver'], exit: 'pr' },
    alert: { stages: ['intake', 'deliver'], exit: 'pr', ticket: 'none' },
    ...pipelines,
  });
const triage = (over: Record<string, unknown> = {}) => ({ triage: { router: true, stages: ['intake', 'route'], ...over } });
const check = (merged: ReturnType<typeof mergePipelines>) => checkPipelines(merged, pipelineSpecs(merged, 'work', where), 'work');
const known = '(pipelines: feature, hotfix, alert, triage); use one of those';

test('a valid router passes the cross-pipeline checks', () => {
  assert.doesNotThrow(() =>
    check(profileWith(triage({ routes: [{ label: 'bug', to: 'hotfix' }], choose: { agent: 'claude', from: ['hotfix', 'feature'] }, fallback: 'feature' }))),
  );
});

test('a route to an unknown pipeline is refused at its to', () => {
  assert.throws(() => check(profileWith(triage({ routes: [{ label: 'bug', to: 'hotfix' }, { label: 'x', to: 'nope' }] }))), {
    name: 'ConfigError',
    message: `c.yaml:7: profiles.work.pipelines.triage.routes.1.to: route to "nope" names no pipeline in profile "work" ${known}`,
  });
});

test('choose.from naming an unknown pipeline is refused at its entry', () => {
  assert.throws(() => check(profileWith(triage({ choose: { agent: 'claude', from: ['hotfix', 'hotfx'] } }))), {
    message: `c.yaml:9: profiles.work.pipelines.triage.choose.from.1: route to "hotfx" names no pipeline in profile "work" ${known}`,
  });
});

test('a fallback naming an unknown pipeline is refused at fallback', () => {
  assert.throws(() => check(profileWith(triage({ fallback: 'nope' }))), {
    message: `c.yaml:10: profiles.work.pipelines.triage.fallback: route to "nope" names no pipeline in profile "work" ${known}`,
  });
});

test('a router cannot route to a router', () => {
  assert.throws(
    () => check(profileWith({ ...triage({ routes: [{ label: 'bug', to: 'inner' }] }), inner: { router: true, stages: ['intake', 'route'] } })),
    {
      message:
        'c.yaml:6: profiles.work.pipelines.triage.routes.0.to: router "triage" cannot route to router "inner"; route to a pipeline that does the work',
    },
  );
});

test('a router cannot route to itself', () => {
  assert.throws(() => check(profileWith(triage({ fallback: 'triage' }))), {
    message:
      'c.yaml:10: profiles.work.pipelines.triage.fallback: router "triage" cannot route to router "triage"; route to a pipeline that does the work',
  });
});

test('a router cannot route to a pipeline with ticket: none', () => {
  assert.throws(() => check(profileWith(triage({ choose: { agent: 'claude', from: ['alert'] } }))), {
    message:
      'c.yaml:8: profiles.work.pipelines.triage.choose.from.0: router "triage" routes tickets, but pipeline "alert" has ticket: none; route to a pipeline that takes a ticket',
  });
});

test('a router needs ticket: required', () => {
  assert.throws(() => check(profileWith(triage({ ticket: 'optional' }))), {
    message:
      'c.yaml:5: profiles.work.pipelines.triage.ticket: router "triage" hands its ticket to another pipeline, so it needs one; set ticket: required or remove ticket',
  });
});

test("a router's fallback defaults to the profile default", () => {
  const merged = profileWith({ ...triage(), hotfix: { default: true, stages: ['intake', 'implement', 'deliver'], exit: 'pr' } });
  assert.equal(pipelineSpecs(merged, 'work', where).triage!.fallback, 'hotfix');
});

test("a router's fallback defaults to feature when the profile default is the router", () => {
  const s = pipelineSpecs(profileWith(triage({ default: true })), 'work', where);
  assert.equal(s.triage!.fallback, 'feature');
  assert.equal(s.hotfix!.fallback, undefined);
});

test('a default router with no feature pipeline needs a fallback', () => {
  const merged = layer({ ...triage({ default: true }), hotfix: { stages: ['intake', 'deliver'], exit: 'pr' } }, false);
  assert.throws(() => check(merged), {
    message:
      'c.yaml:4: profiles.work.pipelines.triage: router "triage" has no fallback: the profile default "triage" is a router and there is no feature pipeline; set fallback to a pipeline that does the work',
  });
});

test('a defaulted fallback is checked like a written one', () => {
  const merged = profileWith({ ...triage(), alert: { default: true, stages: ['intake', 'deliver'], exit: 'pr', ticket: 'none' } });
  assert.throws(() => check(merged), {
    message:
      'c.yaml:4: profiles.work.pipelines.triage: router "triage" routes tickets, but pipeline "alert" has ticket: none; route to a pipeline that takes a ticket',
  });
});
