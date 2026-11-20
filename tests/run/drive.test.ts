import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../../src/engine/state.ts';
import { checkResumable, drive } from '../../src/run/drive.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { terminalName } from '../../src/runtime/herdr-runtime.ts';
import { GATE_MARKER } from '../../src/tracker/intake.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import type { FakeTerminal } from '../helpers/fake-hc.ts';
import { git } from '../helpers/git-repo.ts';
import { NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';
const BINDINGS = [
  '      intake: { builtin: github.intake }',
  '      groom: { agent: command, command: [groom-agent] }',
  "      plan: { command: [plan-script, '{outputs_dir}'] }",
  "      implement: { command: [implement-script, '{outputs_dir}'] }",
  "      review: { command: [review-script, '{outputs_dir}'] }",
  '      deliver: { builtin: github.open_pr }',
];
const TRACKER = '    tracker: { kind: github, approvers: [alice] }';
const SCRIPT_OUTPUT: Record<string, string> = { plan: 'plan', implement: 'summary', review: 'findings' };

type Env = RunEnv & {
  out: string[];
  /** comments alice posts, one each time the newest comment is a gate comment */
  decisions: string[];
  /** set by a test to change one wait's behaviour; return true when it handled the wait */
  onWait: { fn: (t: FakeTerminal, n: number) => boolean | Promise<boolean> };
  /** runs before each sleep resolves */
  onSleep: { fn: () => void | Promise<void> };
  clock: { t: number };
  runDir(meta: RunMeta): string;
  prepare(): Promise<RunMeta>;
};

/**
 * Groom is an agent (`agent: command`): each wait writes its groomed ticket and done.json.
 * Plan, implement and review are scripts: each wait writes the output named by the stage contract and exits 0.
 */
async function setup(extra = TRACKER): Promise<Env> {
  const onWait = { fn: (_t: FakeTerminal, _n: number): boolean | Promise<boolean> => false };
  const hc = new FakeHc(async (t, n) => {
    if (await onWait.fn(t, n)) return;
    const step = t.labels['percolator.step']!;
    if (step === 'groom') {
      const dir = path.dirname(hc.taskFileOf(t));
      await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
      await fs.writeFile(path.join(dir, 'outputs', 'groomed_ticket.md'), 'Groomed.\n');
      await fs.writeFile(path.join(dir, 'done.json'), JSON.stringify({ status: 'pass' }));
      return;
    }
    await fs.writeFile(path.join(t.argv.at(-1)!, `${SCRIPT_OUTPUT[step]}.md`), `${step} output\n`);
    t.state = 'finished';
    t.exitCode = 0;
  });
  const gh = new FakeGh({ readFile: (f) => fsSync.readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 5, { title: 'Fix the thing', body: 'It is broken.' });
  const base = await setupRunEnv({ hc, gh, bindings: BINDINGS, extra });
  const out: string[] = [];
  const decisions: string[] = [];
  const clock = { t: NOW.getTime() };
  const onSleep = { fn: (): void | Promise<void> => {} };
  const lastIsGate = () => gh.issues.get(`${REPO}#5`)!.comments.at(-1)?.body.includes(GATE_MARKER) === true;
  Object.assign(base.deps, {
    out: (s: string) => out.push(s),
    now: () => new Date(clock.t),
    sleep: async () => {
      clock.t += 30000;
      await onSleep.fn();
      if (decisions.length > 0 && lastIsGate()) gh.addComment(REPO, 5, 'alice', decisions.shift()!);
    },
  });
  return {
    ...base,
    out,
    decisions,
    onWait,
    onSleep,
    clock,
    runDir: (meta) => path.join(base.home, '.percolator', 'runs', meta.runId),
    prepare: () => prepareRun({ ticket: '#5', repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps),
  };
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const gateComments = (e: Env) => e.deps.gh.issues.get(`${REPO}#5`)!.comments.filter((c) => c.body.includes(GATE_MARKER));
const calls = (e: Env, method: string) => e.deps.gh.calls.filter((c) => c.method === method);
const name = (meta: RunMeta, step: string, attempt = 1) => terminalName(meta.runId, meta.ticket, step, attempt);
const runs = (e: Env, step: string) => e.deps.hc.calls.filter((c) => c[0] === 'run' && (c[1] as { labels: Record<string, string> }).labels['percolator.step'] === step);

test('drive runs a ticket to a PR', async () => {
  const e = await setup(`${TRACKER}\n    runtime: { keep_terminals: true }`);
  try {
    const meta = await e.prepare();
    const driver = e.deps.hc.add({ name: meta.driver, labels: { 'percolator.run': meta.runId, 'percolator.role': 'driver' } });
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, { ...e.deps, selfTerminal: driver.address });
    assert.equal(state.status, 'completed');
    assert.equal(gateComments(e).length, 1);
    assert.equal(calls(e, 'createPr').length, 1);
    const pr = e.deps.gh.prs[0]!;
    assert.match(pr.body, /^Closes #5$/m);
    assert.equal(pr.head, meta.branch);
    assert.match(await git(e.bare, 'rev-parse', '--verify', `refs/heads/${meta.branch}`), /^[0-9a-f]{40}$/);
    const lastList = e.deps.hc.calls.findLastIndex((c) => c[0] === 'list');
    const swept = e.deps.hc.calls.slice(lastList).filter((c) => c[0] === 'rm').map((c) => c[1]);
    for (const step of ['groom', 'plan', 'implement', 'review']) assert.ok(swept.includes(name(meta, step)), `${step} swept: ${swept}`);
    assert.equal(swept.includes(meta.driver), false);
    assert.deepEqual([...e.deps.hc.terminals.keys()], [meta.driver]);
    assert.equal(e.out.at(-1), `run ${meta.runId} completed: ${pr.url}`);
  } finally {
    await e.cleanup();
  }
});

test('keepTerminals comes from run.json, not the config at resume', async () => {
  const e = await setup(`${TRACKER}\n    runtime: { keep_terminals: true }`);
  try {
    const meta = await e.prepare();
    await e.writeConfig(TRACKER, BINDINGS);
    e.decisions.push('/percolator approve');
    await drive(meta.runId, e.deps);
    // kept: the runtime never removed the plan terminal after its step, so only the end sweep did
    const planRm = e.deps.hc.calls.findIndex((c) => c[0] === 'rm' && c[1] === name(meta, 'plan'));
    const lastList = e.deps.hc.calls.findLastIndex((c) => c[0] === 'list');
    assert.ok(planRm > lastList, `plan removed at ${planRm}, sweep listed at ${lastList}`);
  } finally {
    await e.cleanup();
  }
});

test('a rejected groom goes back to groom with the feedback as input', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.decisions.push('/percolator reject tighten the scope', '/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(runs(e, 'groom').length, 2);
    // one gate comment per round: the rejected round and the approved one
    assert.equal(gateComments(e).length, 2);
    const task = await fs.readFile(path.join(e.runDir(meta), 'steps', 'groom', '2', 'task.md'), 'utf8');
    const findings = path.join(e.runDir(meta), 'steps', 'approve-groom', '1', 'outputs', 'findings.md');
    assert.ok(task.includes(`findings (from approve-groom): ${findings}`), task);
    assert.equal(await fs.readFile(findings, 'utf8'), 'Rejected by @alice: tighten the scope\n');
  } finally {
    await e.cleanup();
  }
});

test('resume after a driver crash at the gate re-posts nothing', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const waiting = path.join(e.runDir(meta), 'waiting.json');
    e.onSleep.fn = async () => {
      if (await exists(waiting)) throw new Error('driver killed');
    };
    await assert.rejects(drive(meta.runId, e.deps), { message: 'driver killed' });
    assert.equal(gateComments(e).length, 1);
    const crashed = await loadState(e.runDir(meta));
    assert.equal(crashed.status, 'running');
    assert.equal(crashed.currentStep, 'approve-groom');

    e.onSleep.fn = () => {};
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(gateComments(e).length, 1);
    assert.equal(calls(e, 'comment').length, 1);
  } finally {
    await e.cleanup();
  }
});

test('resume after a crash in deliver opens one PR', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const url = `https://${REPO}/pull/9`;
    e.deps.gh.prs.push({ number: 9, url, repo: REPO, base: 'main', head: meta.branch, title: 'Fix the thing', body: '' });
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(calls(e, 'createPr').length, 0);
    assert.equal(calls(e, 'editPr').length, 1);
    const rel = state.history.findLast((h) => h.stepId === 'deliver')!.outputs['pr_url']!;
    assert.equal(await fs.readFile(path.join(e.runDir(meta), rel), 'utf8'), `${url}\n`);
    assert.equal(e.out.at(-1), `run ${meta.runId} completed: ${url}`);
  } finally {
    await e.cleanup();
  }
});

test('resume refuses a changed config', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await e.writeConfig(TRACKER, BINDINGS.map((l) => l.replace('groom-agent', 'other-agent')));
    await assert.rejects(drive(meta.runId, e.deps), {
      message: `run ${meta.runId} was started with a different graph (config changed since); start a new run`,
    });
    assert.deepEqual(e.deps.hc.calls, [['get', meta.driver]]);
  } finally {
    await e.cleanup();
  }
});

test('resume refuses changed grounds', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const state = await loadState(e.runDir(meta));
    state.groundVersions = { team: 'main (0123456789ab)' };
    await saveState(e.runDir(meta), state);
    await assert.rejects(drive(meta.runId, e.deps), {
      message: `grounds changed since run ${meta.runId} started: team main (0123456789ab) → local; start a new run`,
    });
  } finally {
    await e.cleanup();
  }
});

test('resume refuses changed mappings, naming them', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const state = await loadState(e.runDir(meta));
    assert.match(state.mappingsFingerprint!, /^[0-9a-f]{64}$/);
    const text = await fs.readFile(e.configFile, 'utf8');
    await fs.writeFile(e.configFile, text.replace('as: policy }', 'as: context }'));
    await assert.rejects(checkResumable(meta.runId, e.deps), {
      message: `mappings changed since run ${meta.runId} started: +context team:policies/sdlc.md, -policy team:policies/sdlc.md; start a new run`,
    });
  } finally {
    await e.cleanup();
  }
});

test('a state without mappingsFingerprint (older run) skips the mappings check', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const state = await loadState(e.runDir(meta));
    delete state.mappingsFingerprint;
    delete state.mappingKeys;
    await saveState(e.runDir(meta), state);
    const text = await fs.readFile(e.configFile, 'utf8');
    await fs.writeFile(e.configFile, text.replace('as: policy }', 'as: context }'));
    const r = await checkResumable(meta.runId, e.deps);
    assert.equal(r.meta.runId, meta.runId);
  } finally {
    await e.cleanup();
  }
});

test('resume at a cap grants one round', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.decisions.push('/percolator reject a', '/percolator reject b', '/percolator reject c');
    const paused = await drive(meta.runId, e.deps);
    assert.equal(paused.status, 'paused');
    assert.deepEqual(e.out.slice(-2), [
      `run ${meta.runId} paused at approve-groom: cap: approve-groom reached 3 rounds`,
      `resume with: perc resume ${meta.runId}`,
    ]);
    assert.equal(gateComments(e).length, 3);

    e.out.length = 0;
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(e.out[0], 'granted one more round on approve-groom');
    assert.equal(state.status, 'completed');
    assert.equal(runs(e, 'groom').length, 4);
    assert.equal(gateComments(e).length, 4);
  } finally {
    await e.cleanup();
  }
});

test('a live driver elsewhere is refused', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.deps.hc.add({ name: meta.driver, labels: { 'percolator.run': meta.runId, 'percolator.role': 'driver' } });
    await assert.rejects(drive(meta.runId, e.deps), {
      message: `run ${meta.runId} is already being driven by terminal ${meta.driver}`,
    });
    await assert.rejects(drive(meta.runId, { ...e.deps, selfTerminal: 'w9:p9' }), {
      message: `run ${meta.runId} is already being driven by terminal ${meta.driver}`,
    });
    assert.equal(e.deps.gh.calls.length, 0);
  } finally {
    await e.cleanup();
  }
});

test('a completed run is refused', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.decisions.push('/percolator approve');
    await drive(meta.runId, e.deps);
    await assert.rejects(drive(meta.runId, e.deps), {
      message: `run ${meta.runId} already completed: https://${REPO}/pull/1`,
    });
  } finally {
    await e.cleanup();
  }
});

test('a failed run is refused', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const state = await loadState(e.runDir(meta));
    state.status = 'failed';
    state.currentStep = 'plan';
    await saveState(e.runDir(meta), state);
    await assert.rejects(drive(meta.runId, e.deps), {
      message: `run ${meta.runId} failed at plan; start a new run`,
    });
  } finally {
    await e.cleanup();
  }
});

test('a failing step fails the run and sweeps its terminals', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.decisions.push('/percolator approve');
    e.onWait.fn = (t) => {
      if (t.labels['percolator.step'] !== 'plan') return false;
      t.state = 'finished';
      t.exitCode = 1;
      return true;
    };
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'failed');
    assert.equal(e.out.at(-1), `run ${meta.runId} failed at plan`);
    assert.deepEqual(e.deps.hc.calls.at(-1), ['list', { labels: { 'percolator.run': meta.runId }, all: true }]);
  } finally {
    await e.cleanup();
  }
});

test('a deleted worktree is re-created on its branch', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await fs.rm(meta.worktree, { recursive: true, force: true, maxRetries: 5 });
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(await git(meta.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), meta.branch);
  } finally {
    await e.cleanup();
  }
});

test('attention is printed, recorded in attention.json and cleared after the step', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const file = path.join(e.runDir(meta), 'attention.json');
    const groom = name(meta, 'groom');
    e.onWait.fn = (t, n) => {
      if (t.labels['percolator.step'] !== 'groom' || n !== 1) return false;
      t.status = 'blocked';
      t.turn = 1;
      return true;
    };
    let seen: unknown;
    e.onSleep.fn = async () => {
      if (seen !== undefined || !(await exists(file))) return;
      seen = JSON.parse(await fs.readFile(file, 'utf8'));
      e.deps.hc.terminals.get(groom)!.status = 'working';
    };
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.ok(e.out.includes(`groom: blocked — attend terminal ${groom}`), e.out.join('\n'));
    assert.deepEqual(seen, { stepId: 'groom', terminal: groom, kind: 'blocked', at: (seen as { at: string }).at });
    assert.match((seen as { at: string }).at, /^2026-03-04T05:\d\d:\d\d\.000Z$/);
    assert.equal(await exists(file), false);
  } finally {
    await e.cleanup();
  }
});
