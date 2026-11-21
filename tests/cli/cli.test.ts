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
  assert.ok(lines.includes('1. intake'));
  assert.ok(lines.includes('3. approve-groom (after groom)'));
  assert.ok(lines.includes('review → implement (max 3, continue)'));
  assert.ok(lines.includes('approve-groom → groom (max 3, escalate)'));
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
  assert.equal(
    r.err,
    [
      'bindings.groom uses agent "claude", but allowed_agents (from profile:work) allows: codex',
      'bindings.plan uses agent "claude", but allowed_agents (from profile:work) allows: codex',
      'bindings.implement uses agent "claude", but allowed_agents (from profile:work) allows: codex',
      'bindings.review uses agent "claude", but allowed_agents (from profile:work) allows: codex',
      '',
    ].join('\n'),
  );
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
        '  run <ticket> [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]',
        '      start a run: groom, approval, plan, implement, review, PR (default: in its own hc terminal)',
        '  resume <run-id> [--foreground]',
        '      continue a paused or interrupted run (grants one more round at a cap)',
        '  status [<run-id>] [--json]',
        '      list runs, or show one (--json: the stable JSON contract)',
        '  approve <run-id> | reject <run-id> <feedback>',
        '      answer the approval gate a run is waiting at',
        '  clean <run-id> [--force]',
        "      remove a finished run's terminals and worktree (keeps the branch and the run record)",
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

test('run with no ticket exits 2', async () => {
  const r = await run(['run']);
  assert.equal(r.code, 2);
  assert.match(r.err, /^run needs <ticket>\n\nusage: perc/);
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
