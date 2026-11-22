import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli.ts';
import { readPipelines } from '../../herdr/mods/percolator/model.js';

const fixture = path.resolve(import.meta.dirname, '..', '..', 'herdr', 'fixtures', 'pipelines.json');

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-pipelines-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

async function run(argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, { home: tmp });
  return { code, out, err };
}

const FEATURE_BINDINGS = [
  '    bindings:',
  '      intake: { builtin: github.intake }',
  '      groom: { agent: claude }',
  '      plan: { agent: claude }',
  '      implement: { agent: claude }',
  '      review: { agent: claude }',
  '      deliver: { builtin: github.open_pr }',
];

async function config(name: string, pipelines: string[]): Promise<string> {
  const cfg = path.join(tmp, `${name}.yaml`);
  await fs.writeFile(cfg, ['version: 1', 'profiles:', '  default:', ...FEATURE_BINDINGS, '    pipelines:', ...pipelines, ''].join('\n'));
  return cfg;
}

const HOTFIX = [
  '      hotfix:',
  '        stages: [intake, fix, deliver]',
  '        exit: pr',
  '        bindings:',
  '          fix: { agent: claude }',
];
const SPIKE = [
  '      spike:',
  '        default: true',
  '        description: Research a question',
  '        stages: [intake, research, deliver]',
  '        exit: pr',
  '        ticket: optional',
  '        inputs:',
  '          question: { required: true, description: What to find out }',
  '          depth: {}',
  '        bindings:',
  '          research: { agent: claude }',
];

test('perc pipelines --json lists the repo\'s pipelines', async () => {
  const cfg = await config('ok', [...HOTFIX, ...SPIKE]);
  const r = await run(['pipelines', '--json', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const data = JSON.parse(r.out);
  assert.equal(data.schema, 1);
  assert.equal(data.repo, path.resolve(tmp));
  assert.equal(data.profile, 'default');
  assert.deepEqual(
    data.pipelines.map((p: { name: string }) => p.name),
    ['spike', 'feature', 'hotfix'],
  );
  const [spike, feature, hotfix] = data.pipelines;
  assert.deepEqual(spike, {
    name: 'spike',
    default: true,
    router: false,
    ticket: 'optional',
    inputs: [
      { name: 'question', required: true, description: 'What to find out' },
      { name: 'depth', required: false },
    ],
    exit: 'pr',
    description: 'Research a question',
    steps: [
      { id: 'intake', stage: 'intake', role: 'core', kind: 'builtin' },
      { id: 'research', stage: 'research', role: 'core', kind: 'agent' },
      { id: 'deliver', stage: 'deliver', role: 'core', kind: 'builtin' },
    ],
    loops: [],
  });
  assert.equal(feature.default, false);
  assert.equal(feature.ticket, 'required');
  assert.equal(feature.exit, 'pr');
  assert.deepEqual(
    feature.steps.map((s: { id: string }) => s.id),
    ['intake', 'groom', 'approve-groom', 'plan', 'implement', 'review', 'deliver'],
  );
  assert.deepEqual(feature.loops.find((l: { id: string }) => l.id === 'review'), {
    id: 'review',
    from: 'review',
    to: 'implement',
    max: 3,
    atCap: 'continue',
  });
  assert.equal(hotfix.description, undefined);
  assert.deepEqual(hotfix.inputs, []);
});

test('a broken pipeline is listed with its error', async () => {
  const cfg = await config('broken', [...HOTFIX, '      broken:', '        stages: [intake, work, deliver]', '        exit: pr']);
  const r = await run(['pipelines', '--json', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(
    data.pipelines.map((p: { name: string }) => p.name),
    ['feature', 'hotfix', 'broken'],
  );
  assert.deepEqual(data.pipelines[2], {
    name: 'broken',
    error: `${cfg}:17: pipeline "broken" in profile "default" leaves stages unbound: work; bind each under pipelines.broken.bindings:`,
  });
});

test('a pipeline with several rule violations is listed with the first only', async () => {
  const cfg = path.join(tmp, 'rules.yaml');
  await fs.writeFile(
    cfg,
    [
      'version: 1',
      'profiles:',
      '  default:',
      ...FEATURE_BINDINGS,
      '    pipelines:',
      ...HOTFIX,
      '        rules:',
      '          require_skills:',
      '            - { stage: nope, skills: [a] }',
      '            - { stage: nada, skills: [b] }',
      '',
    ].join('\n'),
  );
  const r = await run(['pipelines', '--json', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).pipelines[1], {
    name: 'hotfix',
    error: `${cfg}:19: profiles.default.pipelines.hotfix.rules.require_skills.0.stage: names stage "nope", which pipeline "hotfix" does not have (stages: intake, fix, deliver); use one of those or *`,
  });
});

test('a config-level error exits 1', async () => {
  const cfg = path.join(tmp, 'bad.yaml');
  await fs.writeFile(cfg, 'version: 1\nprofiles: 3\n');
  const r = await run(['pipelines', '--json', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, `${cfg}:2: profiles: Invalid input: expected record, received number\n`);
});

test('text output lists one line per pipeline', async () => {
  const cfg = await config('text', [...HOTFIX, ...SPIKE, '      broken:', '        stages: [intake, work, deliver]', '        exit: pr']);
  const r = await run(['pipelines', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines.length, 5, r.out);
  assert.equal(lines[0], 'spike (default)  ticket optional  exit pr  inputs question, depth');
  assert.equal(lines[1], 'feature  ticket required  exit pr  inputs -');
  assert.equal(lines[2], 'hotfix  ticket required  exit pr  inputs -');
  assert.equal(
    lines[3],
    `broken  error ${cfg}:28: pipeline "broken" in profile "default" leaves stages unbound: work; bind each under pipelines.broken.bindings:`,
  );
  assert.equal(lines[4], '');
});

test('the panel reads the JSON, and it has the fixture\'s keys', async () => {
  const cfg = await config('contract', [...HOTFIX, ...SPIKE]);
  const r = await run(['pipelines', '--json', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  const read = readPipelines(r.out);
  assert.ok(read.ok, read.ok ? '' : read.error);
  const fx = JSON.parse(await fs.readFile(fixture, 'utf8'));
  assert.deepEqual(Object.keys(read.data).sort(), Object.keys(fx).sort());
  const keys = (p: object) => Object.keys(p).sort();
  // spike has a description, as the fixture's feature does
  assert.deepEqual(keys(read.data.pipelines[0]), keys(fx.pipelines[0]));
  for (const p of read.data.pipelines as { description?: string }[]) {
    const fxMatch = (fx.pipelines as object[]).find((f) => ('description' in f) === (p.description !== undefined))!;
    assert.deepEqual(keys(p), keys(fxMatch));
  }
});

test('usage lists perc pipelines', async () => {
  const r = await run(['--help']);
  assert.ok(r.out.includes('  pipelines [--repo <dir>] [--config <file>] [--profile <name>] [--json]\n'), r.out);
});
