// Manual smoke test against the REAL `hc` (and, with --space, `herdr-app`). Not part of `pnpm test`.
//   node tests/smoke/hc.smoke.ts [--space <herdr space id>] [--boot] [--codex] [--shim]
// With --boot, --codex or --shim alone only those checks run; --space (or no flag) runs the base checks too.
//   --boot   launches `claude` and an idle node program, printing get status/turn each second for 20 s
//   --shim   (Windows only) runs a .cmd shim (`pnpm`) as a script node would: `pnpm --version` must exit 0, a failing `pnpm test` its own code
//   --codex  (Windows only) runs `codex --no-daemon --help` through hc, prints the exit code and whether --add-dir shows
// Creates only terminals it names itself (run id `perc-smoke-<timestamp>`) and always kills and removes them.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { newState } from '../../src/engine/state.ts';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Step } from '../../src/graph/build.ts';
import { cliHc } from '../../src/herdr/hc.ts';
import { HerdrRuntime, terminalName } from '../../src/runtime/herdr-runtime.ts';
import { nodeExec } from '../../src/util/exec.ts';

const { values } = parseArgs({ options: { space: { type: 'string' }, boot: { type: 'boolean' }, codex: { type: 'boolean' }, shim: { type: 'boolean' } } });
const runId = `perc-smoke-${Date.now()}`;
const hc = cliHc();
const owned: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const runBase = values.space !== undefined || (!values.boot && !values.codex && !values.shim);

const scriptStep: Step = {
  id: 'smoke',
  name: 'smoke',
  stage: 'implement',
  role: 'slot',
  def: {
    command: ['node', '-e', "require('fs').writeFileSync(require('path').join(process.argv[1],'note.md'),'hello from smoke')", '{outputs_dir}'],
  } as Step['def'],
  slotLast: true,
  source: 'smoke',
  locked: false,
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-smoke-'));
try {
  if (runBase) {
    // 1. a script step through HerdrRuntime, no space: nothing appears in the owner's window
    const worktree = path.join(root, 'work');
    const dir = path.join(root, 'run');
    await fs.mkdir(worktree, { recursive: true });
    const state = newState({ runId, ticket: '#1', profile: 'smoke', groundVersions: {} });
    const ctx: RunContext = { state, graph: { steps: [scriptStep] } as RunContext['graph'], round: 1, maxRounds: 1, previousOutputs: {} };
    owned.push(terminalName(runId, '#1', scriptStep.id, 1));
    const runtime = new HerdrRuntime({
      hc, runId, ticket: '#1', runDir: dir, worktree, branch: 'smoke', base: 'main', mappings: [], grounds: {}, pollMs: 500,
    });
    const outcome = await runtime.executeStep(scriptStep, ctx);
    console.log('script step outcome:', JSON.stringify(outcome));
    const stepRoot = path.join(dir, 'steps', 'smoke', '1');
    if (outcome.status !== 'pass') {
      console.log('transcript:', await fs.readFile(path.join(stepRoot, 'transcript.txt'), 'utf8').catch(() => '(none)'));
    }
    assert.equal(outcome.status, 'pass');
    assert.equal(await fs.readFile(path.join(stepRoot, 'outputs', 'note.md'), 'utf8'), 'hello from smoke');
    const transcript = await fs.readFile(path.join(stepRoot, 'transcript.txt'), 'utf8');
    console.log('transcript.txt bytes:', transcript.length);

    // 2. plain argv launch with a task string: does hc report first_message?
    const argvName = `${runId}`.slice(0, 32);
    owned.push(argvName);
    const launched = await hc.run({
      name: argvName,
      cwd: worktree,
      argv: ['node', '-e', 'setTimeout(()=>{},3000)', 'task: say hello'],
      labels: { 'percolator.run': runId },
    });
    console.log(`argv launch: address=${launched.address} firstMessageSent=${String(launched.firstMessageSent)}`);

    // 3. only with --space: one labelled terminal in an existing space, and what herdr-app shows for it
    if (values.space !== undefined) {
      const name = `${runId.slice(0, 27)}-sp`;
      owned.push(name);
      const t = await hc.run({
        name,
        cwd: worktree,
        argv: ['node', '-e', 'setTimeout(()=>{},5000)'],
        labels: { 'percolator.run': runId, 'herdr.space': values.space },
      });
      await new Promise((r) => setTimeout(r, 1000));
      const ls = await nodeExec('herdr-app', ['ls']);
      const re = new RegExp(`(^|[^a-z0-9])(${name}|${t.address})([^a-z0-9]|$)`);
      console.log(`herdr-app ls entry for ${name} (${t.address}):`);
      for (const line of ls.stdout.split('\n')) if (re.test(line)) console.log('  ' + line);
    }
  }

  if (values.boot) {
    const idle = [process.execPath, '-e', 'setInterval(()=>{},1e3)'];
    for (const [label, suffix, argv] of [['claude', 'bc', ['claude']], ['idle program', 'bi', idle]] as const) {
      const name = `${runId}-${suffix}`;
      owned.push(name);
      await hc.run({ name, cwd: root, argv: [...argv], labels: { 'percolator.run': runId } });
      console.log(`--boot ${label} (${name}): get status/turn each second for 20 s`);
      for (let i = 1; i <= 20; i++) {
        await sleep(1000);
        const t = await hc.get(name);
        console.log(`  t=${i}s ${t ? `state=${t.state} status=${String(t.status)} turn=${t.turn}` : 'gone'}`);
        if (!t || t.state === 'finished') break;
      }
    }
  }

  if (values.codex) {
    if (process.platform !== 'win32') {
      console.log('--codex: skipped (not windows)');
    } else {
      const name = `${runId}-cx`;
      owned.push(name);
      await hc.run({ name, cwd: root, argv: ['codex', '--no-daemon', '--help'], labels: { 'percolator.run': runId } });
      let t = await hc.get(name);
      for (let i = 0; i < 30 && t && t.state !== 'finished'; i++) {
        await sleep(1000);
        t = await hc.get(name);
      }
      const screen = await hc.read(name, 200).catch((err: Error) => `(read failed: ${err.message})`);
      console.log(`--codex: state=${t?.state ?? 'gone'} exitCode=${String(t?.exitCode ?? null)} screenHasAddDir=${screen.includes('--add-dir')}`);
      console.log(screen.split('\n').slice(0, 40).join('\n'));
    }
  }
  if (values.shim) {
    if (process.platform !== 'win32') {
      console.log('--shim: skipped (not windows)');
    } else {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shim', scripts: { test: 'node -e "process.exit(3)"' } }));
      for (const [suffix, argv, want] of [
        ['sv', ['pnpm', '--version'], 0],
        ['st', ['pnpm', 'test'], 3],
      ] as const) {
        const name = `${runId}-${suffix}`;
        owned.push(name);
        await hc.run({ name, cwd: root, argv: [...argv], labels: { 'percolator.run': runId } });
        let t = await hc.get(name);
        for (let i = 0; i < 60 && t && t.state !== 'finished'; i++) {
          await sleep(1000);
          t = await hc.get(name);
        }
        assert.equal(t?.exitCode, want, `--shim: ${argv.join(' ')} exited ${String(t?.exitCode ?? null)}, want ${want}`);
        console.log(`--shim: ${argv.join(' ')} exit ${want} ok`);
      }
    }
  }
  console.log('smoke ok');
} finally {
  for (const n of owned) {
    try {
      await hc.kill(n);
      await hc.rm(n);
    } catch (err) {
      console.error(`cleanup of ${n} failed: ${(err as Error).message}`);
    }
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
