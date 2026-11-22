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
import { writeDecision } from '../../src/tracker/gate.ts';
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
const SCRIPT_OUTPUT: Record<string, string> = { plan: 'plan', implement: 'summary', review: 'findings', triage: 'triage' };

type Env = RunEnv & {
  out: string[];
  /** comments alice posts, one after each time a gate posts or edits its comment */
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
  // a gate posts once and edits its comment each round: count its writes, not the comments
  // a decision edit rewrites the round it answers: only a new round header (or the post) is a new wait
  const gateWrites = () => new Set(gh.bodies.filter((b) => b.startsWith(GATE_MARKER)).map((b) => b.split('\n')[1])).size;
  let replied = 0;
  Object.assign(base.deps, {
    out: (s: string) => out.push(s),
    now: () => new Date(clock.t),
    sleep: async () => {
      clock.t += 30000;
      await onSleep.fn();
      if (decisions.length > 0 && gateWrites() > replied) {
        replied++;
        gh.addComment(REPO, 5, 'alice', decisions.shift()!);
      }
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
const name = (meta: RunMeta, step: string, attempt = 1) => terminalName(meta.runId, meta.ticket ?? meta.pipeline, step, attempt);
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

test('the driver prints each step as it starts and ends, and where a gate waits', async () => {
  const e = await setup(TRACKER);
  try {
    const meta = await e.prepare();
    e.decisions.push('/percolator approve');
    await drive(meta.runId, e.deps);
    const gateUrl = gateComments(e)[0]!.url;
    const at = (line: string) => {
      const i = e.out.indexOf(line);
      assert.ok(i >= 0, `missing "${line}" in ${JSON.stringify(e.out)}`);
      return i;
    };
    const lines = [
      'intake: started',
      'intake: pass',
      'groom: started',
      'groom: pass',
      'approve-groom: started',
      `approve-groom: waiting for approval: ${gateUrl}`,
      'approve-groom: pass',
      'plan: started',
      'deliver: pass',
    ];
    const idx = lines.map(at);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
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
    // one gate comment per run and step: the approved round edited the rejected one's
    assert.equal(gateComments(e).length, 1);
    // the rejection, round 2, then the approval
    assert.equal(calls(e, 'editComment').length, 3);
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
    // three rounds, one comment: rounds 2 and 3 edited it
    assert.equal(gateComments(e).length, 1);

    e.out.length = 0;
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(e.out[0], 'granted one more round on approve-groom');
    assert.equal(state.status, 'completed');
    assert.equal(runs(e, 'groom').length, 4);
    assert.equal(gateComments(e).length, 1);
    // per round: its edit and the rejection, then the approval
    assert.equal(calls(e, 'editComment').length, 7);
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

const priorGate = (run: string, text: string) =>
  [
    `${GATE_MARKER} run=${run} step=approve-groom round=1 -->`,
    `**Percolator** needs approval to continue run \`${run}\` (step \`approve-groom\`).`,
    '',
    '### groomed_ticket',
    '',
    text,
    '',
    'Reply `/percolator approve` to continue, or `/percolator reject <what to change>` to send it back.',
    '',
  ].join('\n');

test('an approved groomed ticket from an earlier run is reused: no groom agent, no new gate comment', async () => {
  const e = await setup();
  try {
    e.deps.gh.addComment(REPO, 5, 'perc-bot', priorGate('old-run', '# Reused\n\nthe approved ticket'));
    const ok = e.deps.gh.addComment(REPO, 5, 'alice', '/percolator approve');
    const meta = await e.prepare();
    // only used if the gate (wrongly) posts a new comment: the run then ends and the asserts say why
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(runs(e, 'groom').length, 0);
    assert.equal(gateComments(e).length, 1);
    const groomed = state.history.find((h) => h.stepId === 'groom')!.outputs['groomed_ticket']!;
    assert.equal(await fs.readFile(path.join(e.runDir(meta), groomed), 'utf8'), '# Reused\n\nthe approved ticket\n');
    const approval = state.history.find((h) => h.stepId === 'approve-groom')!.outputs['approval']!;
    assert.match(await fs.readFile(path.join(e.runDir(meta), approval), 'utf8'), new RegExp(`^Approved earlier by @alice: ${ok.url} `));
  } finally {
    await e.cleanup();
  }
});

test('an unapproved groomed ticket from an earlier run is given to groom to refine', async () => {
  const e = await setup();
  try {
    e.deps.gh.addComment(REPO, 5, 'perc-bot', priorGate('old-run', 'the draft'));
    e.deps.gh.addComment(REPO, 5, 'alice', 'not quite');
    const meta = await e.prepare();
    e.decisions.push('/percolator approve');
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed');
    assert.equal(runs(e, 'groom').length, 1);
    const task = await fs.readFile(path.join(e.runDir(meta), 'steps', 'groom', '1', 'task.md'), 'utf8');
    const prev = path.join(e.runDir(meta), 'steps', 'intake', '1', 'outputs', 'previous_groom.md');
    assert.ok(task.includes(`previous_groom (from intake): ${prev}`), task);
  } finally {
    await e.cleanup();
  }
});

const DD_ALERT = [
  TRACKER,
  '    pipelines:',
  '      dd-alert:',
  '        stages: [intake, triage, deliver]',
  '        exit: pr',
  '        ticket: none',
  '        inputs:',
  '          alert_url: { required: true }',
  '        bindings:',
  "          triage: { command: [triage-script, '{outputs_dir}'] }",
].join('\n');

test('a ticketless run drives to its PR', async () => {
  const e = await setup(DD_ALERT);
  try {
    const meta = await prepareRun(
      { pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x' }, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.deepEqual(state.history.map((h) => h.stepId), ['intake', 'triage', 'deliver']);
    const ticket = await fs.readFile(path.join(e.runDir(meta), state.history[0]!.outputs['ticket']!), 'utf8');
    assert.equal(ticket, `# dd-alert run ${meta.runId}\n\n## Inputs\n\n- alert_url: https://dd/x\n`);
    const pr = e.deps.gh.prs[0]!;
    assert.deepEqual({ repo: pr.repo, title: pr.title, head: pr.head }, { repo: REPO, title: `dd-alert: ${meta.runId}`, head: meta.branch });
    assert.doesNotMatch(pr.body, /Closes/);
    assert.deepEqual(calls(e, 'issue'), []);
    assert.equal(e.out.at(-1), `run ${meta.runId} completed: ${pr.url}`);
    // the triage terminal is named after the pipeline, as the run has no ticket
    assert.equal(runs(e, 'triage').length, 1);
    assert.equal((runs(e, 'triage')[0]![1] as { name: string }).name, name(meta, 'triage'));
  } finally {
    await e.cleanup();
  }
});

test('a gate on a ticketless run waits locally and says how to answer it', async () => {
  const e = await setup(DD_ALERT.replace("          triage: { command: [triage-script, '{outputs_dir}'] }", "          triage: { command: [triage-script, '{outputs_dir}'] }\n        nodes:\n          sign-off: { kind: gate, after: triage }"));
  try {
    const meta = await prepareRun(
      { pipeline: 'dd-alert', inputs: { alert_url: 'https://dd/x' }, repoDir: e.root, configFile: e.configFile, profile: 'work' },
      e.deps,
    );
    e.onSleep.fn = async () => {
      if (await exists(path.join(e.runDir(meta), 'waiting.json'))) await writeDecision(e.runDir(meta), { decision: 'approve', by: 'bob' });
    };
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.ok(e.out.includes(`sign-off: waiting for approval: perc approve ${meta.runId} | perc reject ${meta.runId} <feedback>`), e.out.join('\n'));
    assert.deepEqual(calls(e, 'comment'), []);
  } finally {
    await e.cleanup();
  }
});

/**
 * Profile `work` with pipeline `x`: intake, a `draft` script that writes `files` to its outputs, then the
 * exit stage `ship` bound by `exit: <kind>`. `header` adds lines to the pipeline (ticket, inputs).
 */
async function exitRun(kind: string, header: string[], files: Record<string, string>, request: { ticket?: string; inputs?: Record<string, string> }) {
  const e = await setup(
    [
      TRACKER,
      '    pipelines:',
      '      x:',
      '        stages: [intake, draft, ship]',
      `        exit: ${kind}`,
      ...header.map((l) => `        ${l}`),
      '        bindings:',
      "          draft: { command: [draft-script, '{outputs_dir}'] }",
    ].join('\n'),
  );
  e.onWait.fn = async (t) => {
    if (t.labels['percolator.step'] !== 'draft') return false;
    for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(t.argv.at(-1)!, f), text);
    t.state = 'finished';
    t.exitCode = 0;
    return true;
  };
  const meta = await prepareRun({ ...request, pipeline: 'x', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
  return { e, meta };
}

/** The output `key` the exit step `ship` recorded, as text. */
async function shipOutput(e: Env, meta: RunMeta, state: Awaited<ReturnType<typeof drive>>, key: string): Promise<string> {
  const rel = state.history.findLast((h) => h.stepId === 'ship')!.outputs[key]!;
  return (await fs.readFile(path.join(e.runDir(meta), rel), 'utf8')).trim();
}

test('a pipeline with exit comment runs github.comment', async () => {
  const { e, meta } = await exitRun('comment', ['ticket: required'], { 'comment.md': 'Looks fine.\n' }, { ticket: '#5' });
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    const posted = e.deps.gh.issues.get(`${REPO}#5`)!.comments.at(-1)!;
    assert.equal(posted.body, `Looks fine.\n\n<!-- percolator:exit run=${meta.runId} step=ship -->\n`);
    assert.equal(await shipOutput(e, meta, state, 'comment_url'), posted.url);
  } finally {
    await e.cleanup();
  }
});

test('a pipeline with exit issue runs github.open_issues', async () => {
  const { e, meta } = await exitRun('issue', ['ticket: none'], { 'issues.md': '## First\n\nOne.\n\n## Second\n\nTwo.\n' }, {});
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.deepEqual(calls(e, 'createIssue').map((c) => (c.args[1] as { title: string }).title), ['First', 'Second']);
    assert.equal((await shipOutput(e, meta, state, 'issue_urls')).split('\n').length, 2);
  } finally {
    await e.cleanup();
  }
});

test('a pipeline with exit none runs percolator.report', async () => {
  const { e, meta } = await exitRun('none', ['ticket: none'], { 'report.md': 'All quiet.\n' }, {});
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.deepEqual(state.history.at(-1), { ...state.history.at(-1)!, stepId: 'ship', status: 'pass', outputs: {} });
    assert.deepEqual(e.deps.gh.calls, []);
  } finally {
    await e.cleanup();
  }
});

test('a pipeline with exit release runs github.release', async () => {
  const { e, meta } = await exitRun(
    'release',
    ['ticket: none', 'inputs:', '  tag: { required: true }'],
    { 'release_notes.md': 'Notes.\n' },
    { inputs: { tag: 'v1.2.3' } },
  );
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    const head = await git(meta.worktree, 'rev-parse', 'HEAD');
    assert.deepEqual(e.deps.gh.releases.map((r) => [r.repo, r.tag, r.target, r.notes]), [[REPO, 'v1.2.3', head, 'Notes.\n']]);
    assert.equal(await git(e.bare, 'rev-parse', `refs/heads/${meta.branch}`), head);
    assert.equal(await shipOutput(e, meta, state, 'release_url'), `https://${REPO}/releases/tag/v1.2.3`);
  } finally {
    await e.cleanup();
  }
});

test('a pipeline with exit pr_review runs github.pr_review', async () => {
  const { e, meta } = await exitRun(
    'pr_review',
    ['ticket: none', 'inputs:', '  pr: { required: true }'],
    { 'review.md': 'Nice change.\n' },
    { inputs: { pr: '#3' } },
  );
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.deepEqual(e.deps.gh.reviews.map((r) => [r.repo, r.number, r.body]), [
      [REPO, 3, `Nice change.\n\n<!-- percolator:review run=${meta.runId} -->\n`],
    ]);
    assert.equal(await shipOutput(e, meta, state, 'review_url'), e.deps.gh.reviews[0]!.url);
  } finally {
    await e.cleanup();
  }
});

test('a pipeline with exit private_fork_pr runs github.private_fork_pr', async () => {
  const ghsa = 'GHSA-2345-6789-cfgh';
  const { e, meta } = await exitRun(
    'private_fork_pr',
    ['ticket: none', 'inputs:', '  advisory: { required: true }'],
    { 'pr_body.md': 'Fixes the hole.\n' },
    { inputs: { advisory: ghsa } },
  );
  try {
    // the fork's clone url pushes to the local bare repo, so no network is touched
    const forkUrl = `https://github.com/o/r-${ghsa.toLowerCase()}.git`;
    await git(e.root, 'config', `url.${e.bare}.pushInsteadOf`, forkUrl);
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.deepEqual(e.deps.gh.forks.map((f) => [f.repo, f.ghsa]), [[REPO, ghsa]]);
    const pr = e.deps.gh.prs[0]!;
    assert.deepEqual([pr.repo, pr.title, pr.body, pr.head], [`github.com/o/r-${ghsa.toLowerCase()}`, `Fix for ${ghsa}`, 'Fixes the hole.\n', meta.branch]);
    assert.equal(await shipOutput(e, meta, state, 'pr_url'), pr.url);
  } finally {
    await e.cleanup();
  }
});

/** Pipeline `audit` (ticketless) drafts two issues and files them; `next: fix` starts a fix run on each. */
async function nextRun() {
  const e = await setup(
    [
      TRACKER,
      '    pipelines:',
      '      fix:',
      '        stages: [intake, implement, deliver]',
      '        exit: pr',
      '        bindings:',
      '          implement: { command: [echo, implement] }',
      '      audit:',
      '        stages: [intake, draft, file]',
      '        exit: issue',
      '        ticket: none',
      '        next: fix',
      '        bindings:',
      "          draft: { command: [draft-script, '{outputs_dir}'] }",
    ].join('\n'),
  );
  e.onWait.fn = async (t) => {
    if (t.labels['percolator.step'] !== 'draft') return false;
    await fs.writeFile(path.join(t.argv.at(-1)!, 'issues.md'), '## First\n\nOne.\n\n## Second\n\nTwo.\n');
    t.state = 'finished';
    t.exitCode = 0;
    return true;
  };
  const meta = await prepareRun({ pipeline: 'audit', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
  const drivers = () =>
    e.deps.hc.calls
      .filter((c) => c[0] === 'run' && (c[1] as { labels: Record<string, string> }).labels['percolator.role'] === 'driver')
      .map((c) => (c[1] as { argv: string[] }).argv.at(-1)!)
      .sort();
  return { e, meta, drivers };
}

/** `<pipeline> <run id>` of each run linked to `parent`, by ticket. */
async function linkedRuns(e: Env, parent: RunMeta): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of await fs.readdir(path.join(e.home, '.percolator', 'runs'))) {
    const m = JSON.parse(await fs.readFile(path.join(e.home, '.percolator', 'runs', id, 'run.json'), 'utf8')) as RunMeta;
    if (m.parent === parent.runId) out[m.ticket!] = `${m.pipeline} ${m.runId}`;
  }
  return out;
}

const linkedIds = (linked: Record<string, string>) => Object.values(linked).map((v) => v.split(' ')[1]!).sort();

test('issue exit with next starts a linked run per new issue', async () => {
  const { e, meta, drivers } = await nextRun();
  try {
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    const linked = await linkedRuns(e, meta);
    assert.deepEqual(Object.keys(linked).sort(), [`${REPO}#6`, `${REPO}#7`]);
    for (const v of Object.values(linked)) assert.match(v, /^fix t[67]-fix-\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.deepEqual(drivers(), linkedIds(linked));
  } finally {
    await e.cleanup();
  }
});

test('issue exit with next starts only the missing runs after a crash', async () => {
  const { e, meta, drivers } = await nextRun();
  try {
    // the first fix run's driver starts, then this run's driver dies before it records the step
    const run = e.deps.hc.run.bind(e.deps.hc);
    let crash = true;
    e.deps.hc.run = async (o) => {
      const r = await run(o);
      if (crash && o.labels?.['percolator.role'] === 'driver') {
        crash = false;
        throw new Error('driver killed');
      }
      return r;
    };
    assert.equal((await drive(meta.runId, e.deps)).status, 'paused');
    assert.equal(drivers().length, 1);
    const state = await drive(meta.runId, e.deps);
    assert.equal(state.status, 'completed', JSON.stringify(state.history));
    assert.equal(calls(e, 'createIssue').length, 2);
    const linked = await linkedRuns(e, meta);
    assert.deepEqual(Object.keys(linked).sort(), [`${REPO}#6`, `${REPO}#7`]);
    assert.deepEqual(drivers(), linkedIds(linked));
  } finally {
    await e.cleanup();
  }
});

test('a v1 run resumes against the same feature graph', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const state = await loadState(e.runDir(meta));
    assert.ok(state.graphFingerprint !== undefined, 'prepare records the graph fingerprint');
    // run.json as a v1 run wrote it: no pipeline, no inputs
    const { pipeline: _p, inputs: _i, ...rest } = meta;
    await fs.writeFile(path.join(e.runDir(meta), 'run.json'), JSON.stringify({ ...rest, version: 1 }, null, 2));
    const r = await checkResumable(meta.runId, e.deps);
    assert.equal(r.meta.pipeline, 'feature');
    assert.equal(r.v.graph.pipeline, 'feature');
  } finally {
    await e.cleanup();
  }
});
