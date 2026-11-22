import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli.ts';

const fx = (p: string) => path.resolve(import.meta.dirname, '..', 'fixtures', p);

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cli-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

async function run(argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

test('validate prints profile, grounds, mappings, steps and back-edges', async () => {
  const r = await run(['validate', '--config', fx('e2e/config.yaml'), '--profile', 'work']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('profile: work'));
  assert.ok(lines.includes('ground company local'));
  assert.ok(lines.includes('ground team local'));
  assert.ok(lines.some((l) => /^policy .*policies[\\/]sdlc\.md$/.test(l)));
  assert.ok(lines.includes('1. intake: builtin github.intake'));
  assert.ok(lines.includes('3. approve-groom (after groom): gate'));
  assert.ok(lines.includes('review → implement (max 3, continue)'));
  assert.ok(lines.includes('approve-groom → groom (max 3, escalate)'));
});

test('validate shows approvers, what runs each step and the stages a mapping applies to', async () => {
  const cfg = path.join(tmp, 'detail.yaml');
  await fs.writeFile(
    cfg,
    [
      'version: 1',
      'grounds:',
      `  team: { path: ${JSON.stringify(fx('e2e/grounds/team'))} }`,
      'profiles:',
      '  work:',
      '    tracker: { kind: github, approvers: [alice, bob] }',
      '    use:',
      '      - { from: team, file: policies/sdlc.md, as: policy, applies_to: [implement, review] }',
      '    bindings:',
      '      intake: { builtin: github.intake }',
      '      groom: { agent: claude }',
      '      plan: { agent: claude, model: sonnet }',
      '      implement: { agent: claude, model: opus, effort: high, skills: [a:one, b:two] }',
      '      review: { agent: claude, skill: code-review }',
      '      deliver: { builtin: github.open_pr }',
      '    nodes:',
      '      lint: { command: [pnpm, lint], after: implement }',
      '      sign-off: { kind: gate, after: plan }',
      '',
    ].join('\n'),
  );
  const r = await run(['validate', '--config', cfg, '--profile', 'work']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('approvers: alice, bob'), r.out);
  assert.ok(lines.some((l) => /^policy .*policies[\\/]sdlc\.md \(applies to implement, review\)$/.test(l)), r.out);
  for (const line of [
    '1. intake: builtin github.intake',
    '2. groom: claude',
    '3. approve-groom (after groom): gate',
    '4. plan: claude, model sonnet',
    '5. sign-off (after plan): gate',
    '6. implement: claude, model opus, effort high, skills a:one, b:two',
    '7. lint (after implement): command pnpm lint',
    '8. review: claude, skills code-review',
    '9. deliver: builtin github.open_pr',
  ]) {
    assert.ok(lines.includes(line), `missing "${line}" in:\n${r.out}`);
  }
});

test('validate shows the runtime settings the profile sets', async () => {
  const cfg = path.join(tmp, 'runtime.yaml');
  const base = await fs.readFile(fx('e2e/config.yaml'), 'utf8');
  const abs = (n: string) => JSON.stringify(path.join(fx('e2e/grounds'), n));
  await fs.writeFile(
    cfg,
    base
      .replace('./grounds/company', abs('company'))
      .replace('./grounds/team', abs('team'))
      .replace('  work:\n', '  work:\n    runtime: { space: false, keep_terminals: true, base: dev }\n'),
  );
  const r = await run(['validate', '--config', cfg, '--profile', 'work']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').includes('runtime: base dev, keep_terminals true, space false'), r.out);
  const plain = await run(['validate', '--config', fx('e2e/config.yaml'), '--profile', 'work']);
  assert.ok(!plain.out.includes('runtime:'), plain.out);
});

test('validate says an empty approvers list leaves only local decisions', async () => {
  const cfg = path.join(tmp, 'no-approvers.yaml');
  const base = await fs.readFile(fx('e2e/config.yaml'), 'utf8');
  const abs = (n: string) => JSON.stringify(path.join(fx('e2e/grounds'), n));
  await fs.writeFile(
    cfg,
    base
      .replace('./grounds/company', abs('company'))
      .replace('./grounds/team', abs('team'))
      .replace('  work:\n', '  work:\n    tracker: { kind: github, approvers: [] }\n'),
  );
  const r = await run(['validate', '--config', cfg, '--profile', 'work']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').includes('approvers: none on GitHub (only local perc approve/reject)'), r.out);
});

test('validate names the default approver when the profile lists none', async () => {
  const r = await run(['validate', '--config', fx('e2e/config.yaml'), '--profile', 'work']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').includes('approvers: the gh user running perc'), r.out);
});

test('validate reports config errors on stderr with exit 1', async () => {
  const r = await run(['validate', '--config', fx('e2e/unbound.yaml'), '--profile', 'work']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unbound/i);
  assert.equal(r.out, '');
});

test('validate prints rule violations and exits 1', async () => {
  const cfg = path.join(tmp, 'rules.yaml');
  const abs = (n: string) => JSON.stringify(path.join(fx('e2e/grounds'), n));
  const base = (await fs.readFile(fx('e2e/config.yaml'), 'utf8'))
    .replace('./grounds/company', abs('company'))
    .replace('./grounds/team', abs('team'));
  await fs.writeFile(cfg, `${base}    rules:\n      allowed_agents: [codex]\n`);
  const r = await run(['validate', '--config', cfg, '--profile', 'work']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  const fix = `allowed_agents (from ${cfg}:21) allows: codex; use one of those`;
  assert.equal(
    r.err,
    [
      `${cfg}:12: profiles.work.bindings.groom: uses agent "claude", but ${fix}`,
      `${cfg}:13: profiles.work.bindings.plan: uses agent "claude", but ${fix}`,
      `${cfg}:14: profiles.work.bindings.implement: uses agent "claude", but ${fix}`,
      `${fx('e2e/grounds/company/percolator.yaml')}:2: bindings.review: uses agent "claude", but ${fix}`,
      '',
    ].join('\n'),
  );
});

async function pipelinesConfig(): Promise<string> {
  const cfg = path.join(tmp, 'pipelines.yaml');
  await fs.writeFile(
    cfg,
    [
      'version: 1',
      'profiles:',
      '  default:',
      '    bindings:',
      '      intake: { builtin: github.intake }',
      '      groom: { agent: claude }',
      '      plan: { agent: claude }',
      '      implement: { agent: claude }',
      '      review: { agent: claude }',
      '      deliver: { builtin: github.open_pr }',
      '    pipelines:',
      '      hotfix:',
      '        stages: [intake, implement, deliver]',
      '        exit: pr',
      '        bindings:',
      '          implement: { agent: claude, model: opus }',
      '',
    ].join('\n'),
  );
  return cfg;
}

test('perc validate prints every pipeline', async () => {
  const cfg = await pipelinesConfig();
  const r = await run(['validate', '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 0, r.err);
  const blocks = r.out.split('\n\npipeline: ');
  assert.equal(blocks.length, 2, r.out);
  assert.ok(r.out.startsWith('pipeline: feature (default)\nprofile: default\n'), r.out);
  assert.ok(blocks[0]!.includes('\n7. deliver: builtin github.open_pr\n'), r.out);
  assert.ok(blocks[1]!.startsWith('hotfix\nprofile: default\n'), r.out);
  assert.ok(blocks[1]!.includes('\n2. implement: claude, model opus\n'), r.out);
  assert.ok(blocks[1]!.includes('\n3. deliver: builtin github.open_pr\n'), r.out);
});

test('perc validate --pipeline prints that pipeline only', async () => {
  const cfg = await pipelinesConfig();
  const r = await run(['validate', '--config', cfg, '--profile', 'default', '--pipeline', 'hotfix']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('pipeline: hotfix\nprofile: default\n'), r.out);
  assert.ok(!r.out.includes('pipeline: feature'), r.out);
});

test('perc validate --pipeline nope names the pipelines at the profile\'s pipelines line', async () => {
  const cfg = await pipelinesConfig();
  const r = await run(['validate', '--config', cfg, '--profile', 'default', '--pipeline', 'nope']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(
    r.err,
    `${cfg}:11: unknown pipeline "nope" in profile "default" (pipelines: feature, hotfix); pass one of those to --pipeline\n`,
  );
});

test('usage lists validate --pipeline', async () => {
  const r = await run(['--help']);
  assert.ok(r.out.includes('validate [--config <file>] [--profile <name>] [--pipeline <name>] [--update]'), r.out);
});

test('unknown command prints usage and exits 2', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage/i);
  assert.match(r.err, /frobnicate/);
});

test('unknown flag prints usage and exits 2', async () => {
  const r = await run(['validate', '--nope']);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage/i);
});

test('--help prints usage to stdout and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: perc/i);
  assert.equal(r.err, '');
});

test('schema writes the JSON schema to --out and prints the path', async () => {
  const out = path.join(tmp, 'nested', 's.json');
  const r = await run(['schema', '--out', out]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(out));
  const json = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(json.type, 'object');
});

test('--help lists the run commands', async () => {
  const r = await run(['--help']);
  assert.ok(
    r.out.includes(
      [
        '  run [<ticket>] [--pipeline <name>] [--input key=value]... [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]',
        "      start a run of a pipeline (default: the profile's; feature: groom, approval, plan, implement, review, PR)",
        '      in its own hc terminal (--foreground: in this one)',
        '  resume <run-id> [--foreground]',
        '      continue a paused or interrupted run (grants one more round at a cap)',
        '  status [<run-id>] [--json]',
        '      list runs, or show one (--json: the stable JSON contract)',
        '  approve <run-id> | reject <run-id> <feedback>',
        '      answer the approval gate a run is waiting at',
        '  clean <run-id> [--force]',
        "      remove a finished run's terminals and worktree (keeps the branch and the run record; perc delete removes it all)",
        '  delete <run-id>... [--yes] | delete --finished [--yes]',
        '      remove a run entirely: stop it, its terminals, worktree and record (keeps the branch)',
        '  herdr link',
        '      tell the Percolator Herdr panel how to run perc (writes perc.json)',
        '  drive <run-id>',
        "      internal: what a run's driver terminal executes",
        '',
      ].join('\n'),
    ),
    r.out,
  );
});

test('run with no ticket on a pipeline that needs one exits 2', async () => {
  const cfg = await pipelinesConfig();
  const r = await run(['run', '--repo', tmp, '--config', cfg, '--profile', 'default']);
  assert.equal(r.code, 2);
  assert.match(r.err, /^pipeline "feature" needs a ticket; pass one: perc run <ticket> --pipeline feature\n\nusage: perc/);
});

test('herdr link writes perc.json for the running cli and prints the path', async () => {
  const appHome = path.join(tmp, 'herdr-app');
  await fs.mkdir(path.join(appHome, 'mods', 'percolator'), { recursive: true });
  const saved = process.env['HERDR_APP_HOME'];
  process.env['HERDR_APP_HOME'] = appHome;
  try {
    const r = await run(['herdr', 'link']);
    const file = path.join(appHome, 'mods', 'percolator', 'perc.json');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `wrote ${file}
`);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(json.node, process.execPath);
    assert.equal(json.cli, path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.ts'));
  } finally {
    if (saved === undefined) delete process.env['HERDR_APP_HOME'];
    else process.env['HERDR_APP_HOME'] = saved;
  }
});

test('herdr with no or an unknown subcommand is a usage error', async () => {
  for (const argv of [['herdr'], ['herdr', 'nope']]) {
    const r = await run(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /^herdr needs a subcommand: link/);
    assert.match(r.err, /usage/i);
  }
});
