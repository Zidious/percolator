// Manual smoke test against the REAL `hc` (and, with --space, `herdr-app`). Not part of `pnpm test`.
//   node tests/smoke/hc.smoke.ts [--space <herdr space id>]
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

const { values } = parseArgs({ options: { space: { type: 'string' } } });
const runId = `perc-smoke-${Date.now()}`;
const hc = cliHc();
const owned: string[] = [];

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
