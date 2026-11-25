import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../../src/cli.ts';
import { FakeHc } from '../helpers/fake-hc.ts';

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
  assert.ok(!r.out.includes('slice runs'), r.out);
});

test('perc validate of a fan-out pipeline prints its slice runs after the parent graph', async () => {
  const template = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', 'templates', 'config.yaml'), 'utf8');
  const cfg = path.join(tmp, 'epic.yaml');
  // the template's commented example pipelines, uncommented (as in tests/templates.test.ts)
  await fs.writeFile(cfg, template.replace(/^(\s*)# ((?:[a-z][a-z0-9_-]*:|  ).*)$/gm, '$1$2'));
  const r = await run(['validate', '--config', cfg, '--profile', 'default', '--pipeline', 'epic']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\n3. implement: builtin percolator.fan_out\n\nback-edges:\n'), r.out);
  assert.equal(
    r.out.slice(r.out.indexOf('\n\nslice runs')),
    [
      '',
      '',
      'slice runs (fan-out of implement, at most 3 at a time):',
      'steps:',
      '1. intake: builtin percolator.seed',
      '2. implement: claude, model opus, skills superpowers:executing-plans, superpowers:test-driven-development',
      '3. review: claude, model opus, skills deep-dive-review',
      '4. deliver: builtin github.open_pr',
      '',
      'back-edges:',
      'review → implement (max 3, continue)',
      '',
    ].join('\n'),
  );
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
        "  answer <run-id> [--answer <n>=<text>]... [--na <n>]... [--agree <n>[,<n>…]]... [--foreground]",
        '      answer the questions or the findings a paused run is asking about (perc status <run-id> lists them)',
        '  status [<run-id>] [--json]',
        '      list runs, or show one (--json: the stable JSON contract)',
        '  approve <run-id> [--pipeline <name>] | reject <run-id> <feedback>',
        '      answer the approval gate a run is waiting at (--pipeline: the pipeline a pick-pipeline gate goes with)',
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

async function runWith(argv: string[], deps: Parameters<typeof main>[2]) {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, deps);
  return { code, out, err };
}

const WATCH_ENTRY = path.resolve('/opt/perc/cli.js');

test('perc watch launches the watcher terminal', async () => {
  const hc = new FakeHc();
  const cfg = path.join(tmp, 'watch.yaml');
  const r = await runWith(['watch', '--repo', tmp, '--repo', fx('.'), '--config', cfg, '--profile', 'work', '--interval', '30'], { hc, home: tmp, entry: WATCH_ENTRY });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(hc.calls.filter((c) => c[0] === 'run'), [
    [
      'run',
      {
        name: 'percolator-watch',
        cwd: tmp,
        argv: [process.execPath, WATCH_ENTRY, 'watch', '--foreground', '--repo', tmp, '--repo', fx('.'), '--config', cfg, '--profile', 'work', '--interval', '30'],
        labels: { 'percolator.role': 'watcher' },
        outliveParent: true,
      },
    ],
  ]);
  assert.equal(r.out, `watcher started in terminal percolator-watch\n  repos ${tmp}, ${fx('.')}\n  stop with: perc watch stop\n`);
});

test('perc watch refuses a second watcher', async () => {
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' } });
  const r = await runWith(['watch', '--repo', tmp], { hc, home: tmp, entry: WATCH_ENTRY });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'perc watch is already running in terminal percolator-watch; perc watch stop to stop it\n');
  assert.deepEqual(hc.calls.filter((c) => c[0] === 'run'), []);
});

test('perc watch --foreground refuses while the watcher terminal is live in another terminal', async () => {
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' } });
  const r = await runWith(['watch', '--foreground', '--repo', tmp], { hc, home: tmp, entry: WATCH_ENTRY, selfTerminal: 'w9:p9' });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'perc watch is already running in terminal percolator-watch; perc watch stop to stop it\n');
});

test('perc watch --foreground refuses while another watcher beats in watch.json', async () => {
  const home = await fs.mkdtemp(path.join(tmp, 'home-'));
  const file = path.join(home, '.percolator', 'watch', 'watch.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify({ pid: 9, host: os.hostname(), startedAt: at, heartbeatAt: at, repos: [tmp], intervalS: 60 }));
  const r = await runWith(['watch', '--foreground', '--repo', tmp], { hc: new FakeHc(), home, entry: WATCH_ENTRY, pid: 10, pidAlive: (pid) => pid === 9 });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'perc watch is already running as pid 9; stop it first (perc watch stop, or end pid 9)\n');
});

test('perc watch replaces a finished watcher terminal and leaves a foreign one alone', async () => {
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' }, state: 'finished' });
  assert.equal((await runWith(['watch', '--repo', tmp], { hc, home: tmp, entry: WATCH_ENTRY })).code, 0);
  assert.deepEqual(hc.calls.map((c) => c[0]), ['get', 'rm', 'run']);
  const other = new FakeHc();
  other.add({ name: 'percolator-watch', state: 'finished' });
  const r = await runWith(['watch', '--repo', tmp], { hc: other, home: tmp, entry: WATCH_ENTRY });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'terminal percolator-watch is not a Percolator watcher; close or rename it, then run perc watch again\n');
  assert.deepEqual(other.calls.map((c) => c[0]), ['get']);
});

test('--interval below 15 is a usage error', async () => {
  for (const v of ['14', '0']) {
    const r = await runWith(['watch', '--interval', v], { hc: new FakeHc(), home: tmp, entry: WATCH_ENTRY });
    assert.equal(r.code, 2);
    assert.match(r.err, /^--interval must be at least 15 seconds\n\nusage: perc/);
  }
  const r = await runWith(['watch', '--interval', '1m'], { hc: new FakeHc(), home: tmp, entry: WATCH_ENTRY });
  assert.equal(r.code, 2);
  assert.match(r.err, /^--interval must be a whole number of seconds, got "1m"\n\nusage: perc/);
});

test('perc watch stop ends the watcher terminal and removes watch.json', async () => {
  const home = await fs.mkdtemp(path.join(tmp, 'home-'));
  const file = path.join(home, '.percolator', 'watch', 'watch.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}');
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' } });
  hc.add({ name: 'driver', labels: { 'percolator.run': 'r1', 'percolator.role': 'driver' } });
  const r = await runWith(['watch', 'stop'], { hc, home, entry: WATCH_ENTRY });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'stopped the watcher in terminal percolator-watch\n');
  assert.deepEqual([...hc.terminals.keys()], ['driver']);
  assert.equal(await fs.stat(file).then(() => true, () => false), false);
  const again = await runWith(['watch', 'stop'], { hc, home, entry: WATCH_ENTRY });
  assert.equal(again.out, 'no watcher running\n');
});

test('usage lists perc watch', async () => {
  const r = await run(['--help']);
  assert.ok(
    r.out.includes(
      [
        '  watch [--repo <dir>]... [--config <file>] [--profile <name>] [--interval <s>] [--foreground] | watch stop',
        "      start runs from the pipelines' triggers, polling each repo every --interval seconds (default 60, at least 15)",
        '      in hc terminal percolator-watch (--foreground: in this one); watch stop ends it',
        '',
      ].join('\n'),
    ),
    r.out,
  );
});

/** A home with a live watcher's watch.json (pid 9), and the clock and sleep `perc watch stop` waits with. */
async function liveWatcher(onSleep: (o: { home: string; tick: () => void }) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(tmp, 'home-'));
  const file = path.join(home, '.percolator', 'watch', 'watch.json');
  const stop = path.join(home, '.percolator', 'watch', 'stop.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const at = new Date(clock).toISOString();
  await fs.writeFile(file, JSON.stringify({ pid: 9, host: os.hostname(), intervalS: 60, heartbeatAt: at, startedAt: at, repos: [] }));
  const stopAsked: unknown[] = [];
  const deps = {
    home,
    entry: WATCH_ENTRY,
    pid: 10,
    pidAlive: () => true,
    now: () => new Date(clock),
    sleep: async () => {
      stopAsked.push(JSON.parse(await fs.readFile(stop, 'utf8')).pid);
      await onSleep({ home, tick: () => (clock += 500) });
    },
  };
  const gone = (p: string) => fs.stat(p).then(() => false, () => true);
  return { home, file, stop, deps, stopAsked, gone };
}

test('perc watch stop waits for the watcher to exit and does not kill it', async () => {
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' } });
  const w = await liveWatcher(async ({ home }) => {
    await fs.rm(path.join(home, '.percolator', 'watch', 'watch.json'));
    hc.terminals.get('percolator-watch')!.state = 'finished';
  });
  const r = await runWith(['watch', 'stop'], { hc, ...w.deps });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'stopped the watcher in terminal percolator-watch\n');
  assert.deepEqual(w.stopAsked, [9]);
  assert.equal(hc.calls.some((c) => c[0] === 'kill'), false);
  assert.equal(hc.terminals.has('percolator-watch'), false);
  assert.equal(await w.gone(w.stop), true);
});

test('perc watch stop kills the watcher after 30s', async () => {
  const hc = new FakeHc();
  hc.add({ name: 'percolator-watch', labels: { 'percolator.role': 'watcher' } });
  const w = await liveWatcher(async ({ tick }) => tick());
  const r = await runWith(['watch', 'stop'], { hc, ...w.deps });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'the watcher in terminal percolator-watch did not stop within 30s; ended it\n');
  assert.deepEqual(hc.calls.filter((c) => c[0] === 'kill' || c[0] === 'rm'), [['kill', 'percolator-watch'], ['rm', 'percolator-watch']]);
  assert.equal(await w.gone(w.file), true);
  assert.equal(await w.gone(w.stop), true);
});

test('perc watch stop asks a foreground watcher with no terminal to stop', async () => {
  const graceful = await liveWatcher(async ({ home }) => fs.rm(path.join(home, '.percolator', 'watch', 'watch.json')));
  const ok = await runWith(['watch', 'stop'], { hc: new FakeHc(), ...graceful.deps });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, 'stopped the watcher (pid 9)\n');
  assert.equal(await graceful.gone(graceful.stop), true);
  const stuck = await liveWatcher(async ({ tick }) => tick());
  const late = await runWith(['watch', 'stop'], { hc: new FakeHc(), ...stuck.deps });
  assert.equal(late.code, 1);
  assert.equal(late.out, 'the watcher (pid 9) did not stop within 30s; end pid 9\n');
});
