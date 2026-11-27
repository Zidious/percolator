import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.ts';
import { loadState, saveState } from '../../src/engine/state.ts';
import { cliHc } from '../../src/herdr/hc.ts';
import type { RunState } from '../../src/engine/state.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { terminalName } from '../../src/runtime/herdr-runtime.ts';
import { GATE_MARKER } from '../../src/tracker/markers.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import type { FakeTerminal } from '../helpers/fake-hc.ts';
import { git } from '../helpers/git-repo.ts';
import { ENTRY, NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';
const BINDINGS = [
  '      intake: { builtin: github.intake }',
  "      groom: { command: [groom-script, '{outputs_dir}'] }",
  "      plan: { command: [plan-script, '{outputs_dir}'] }",
  "      implement: { command: [implement-script, '{outputs_dir}'] }",
  "      review: { command: [review-script, '{outputs_dir}'] }",
  '      deliver: { builtin: github.open_pr }',
];
const TRACKER = '    tracker: { kind: github, approvers: [alice] }';
const NL = String.fromCharCode(10);
const OUTPUT: Record<string, string> = { groom: 'groomed_ticket', plan: 'plan', implement: 'summary', review: 'findings' };

type Env = RunEnv & {
  clock: { t: number };
  onWait: { fn: (t: FakeTerminal) => boolean | Promise<boolean> };
  dir(id: string): string;
  /** prepares a run on `ticket` (default #5) */
  prepare(ticket?: string): Promise<RunMeta>;
  perc(argv: string[], deps?: Partial<DriverDeps>): Promise<{ code: number; out: string; err: string }>;
};

/** Every stage but the builtins is a script that writes its contract output and exits 0; alice approves each gate. */
async function setup(): Promise<Env> {
  const onWait = { fn: (_t: FakeTerminal): boolean | Promise<boolean> => false };
  const hc = new FakeHc(async (t) => {
    if (await onWait.fn(t)) return;
    const step = t.labels['percolator.step']!;
    await fs.writeFile(path.join(t.argv.at(-1)!, `${OUTPUT[step]}.md`), `${step} output\n`);
    t.state = 'finished';
    t.exitCode = 0;
  });
  const gh = new FakeGh({ readFile: (f) => fsSync.readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 5, { title: 'Fix the thing', body: 'It is broken.' });
  const base = await setupRunEnv({ hc, gh, bindings: BINDINGS, extra: TRACKER });
  const clock = { t: NOW.getTime() };
  // a gate posts once and edits its comment each round: answer each write, not the newest comment
  // a decision edit rewrites the round it answers: only a new round header (or the post) is a new wait
  const gateWrites = () => new Set(gh.bodies.filter((b) => b.startsWith(GATE_MARKER)).map((b) => b.split('\n')[1])).size;
  let replied = 0;
  Object.assign(base.deps, {
    now: () => new Date(clock.t),
    sleep: async () => {
      clock.t += 30000;
      if (gateWrites() > replied) {
        replied++;
        gh.addComment(REPO, 5, 'alice', '/percolator approve');
      }
    },
  });
  const dir = (id: string) => path.join(base.home, '.percolator', 'runs', id);
  return {
    ...base,
    clock,
    onWait,
    dir,
    prepare: (ticket = '#5') => prepareRun({ ticket, repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps),
    perc: async (argv, deps = base.deps) => {
      let out = '';
      let err = '';
      const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, deps);
      return { code, out, err };
    },
  };
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const runCalls = (hc: FakeHc) => hc.calls.filter((c) => c[0] === 'run');
const runArgv = (e: Env, ...more: string[]) => ['run', '#5', '--repo', e.root, '--config', e.configFile, '--profile', 'work', ...more];
const onlyRun = async (e: Env) => (await fs.readdir(path.join(e.home, '.percolator', 'runs')))[0]!;

async function withTerminalId<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
  const was = process.env['HC_TERMINAL_ID'];
  if (id === undefined) delete process.env['HC_TERMINAL_ID'];
  else process.env['HC_TERMINAL_ID'] = id;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env['HC_TERMINAL_ID'];
    else process.env['HC_TERMINAL_ID'] = was;
  }
}

async function writeJson(file: string, v: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(v));
}

test('run without --foreground launches the driver and prints the start block', async () => {
  const e = await setup();
  try {
    const r = await e.perc(runArgv(e));
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    const id = await onlyRun(e);
    const driver = terminalName(id, `${REPO}#5`, '@driver', 0);
    const worktree = path.join(e.root, '.worktrees', id);
    assert.equal(
      r.out,
      [
        `run ${id} started`,
        `  terminal ${driver}`,
        `  space "r #5 · ${id.slice(-4)}" (the driver stays hidden; "Driver pane ↗" in the Percolator panel peeks at it)`,
        `  worktree ${worktree}`,
        `  follow with: perc status ${id}`,
        '',
      ].join('\n'),
    );
    const calls = runCalls(e.deps.hc);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0]![1] as { argv: string[] }).argv, [process.execPath, ENTRY, 'drive', id]);
  } finally {
    await e.cleanup();
  }
});

test('the driver runs cli.ts by default', async () => {
  const e = await setup();
  try {
    const { entry: _entry, ...deps } = e.deps;
    const r = await e.perc(runArgv(e), deps);
    assert.equal(r.code, 0, r.err);
    const argv = (runCalls(e.deps.hc)[0]![1] as { argv: string[] }).argv;
    assert.equal(argv[1], path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.ts'));
  } finally {
    await e.cleanup();
  }
});

test('run --foreground drives to completion', async () => {
  const e = await setup();
  try {
    const r = await e.perc(runArgv(e, '--foreground'));
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    const id = await onlyRun(e);
    assert.equal(r.out.split('\n').at(-2), `run ${id} completed: https://${REPO}/pull/1`);
    assert.equal((await loadState(e.dir(id))).status, 'completed');
  } finally {
    await e.cleanup();
  }
});

test('status lists runs with details', async () => {
  const e = await setup();
  try {
    const metas: RunMeta[] = [];
    for (let i = 0; i < 8; i++) {
      e.clock.t = NOW.getTime() + i * 1000;
      // one ticket each: a ticket has at most one live run
      metas.push(await e.prepare(`#${5 + i}`));
    }
    const [waiting, paused, dead, done, live, attended, waitingLive, attendedDead] = metas as RunMeta[] as [
      RunMeta, RunMeta, RunMeta, RunMeta, RunMeta, RunMeta, RunMeta, RunMeta,
    ];
    const liveDriver = (m: RunMeta) => e.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } });
    const waitAt = async (m: RunMeta) => {
      await edit(m, (s) => (s.currentStep = 'approve-groom'));
      await writeJson(path.join(e.dir(m.runId), 'waiting.json'), {
        stepId: 'approve-groom', stepDir: path.join(e.dir(m.runId), 'steps', 'approve-groom', '1'), since: NOW.toISOString(), commentUrl: url,
      });
    };
    const attend = async (m: RunMeta) => {
      await edit(m, (s) => (s.currentStep = 'groom'));
      const term = terminalName(m.runId, m.ticket!, 'groom', 1);
      await writeJson(path.join(e.dir(m.runId), 'attention.json'), { stepId: 'groom', terminal: term, kind: 'blocked', at: NOW.toISOString() });
      return term;
    };
    const url = `https://${REPO}/issues/5#issuecomment-7`;
    const edit = async (m: RunMeta, f: (s: Awaited<ReturnType<typeof loadState>>) => void) => {
      const s = await loadState(e.dir(m.runId));
      f(s);
      await saveState(e.dir(m.runId), s);
    };
    await waitAt(waiting);
    await waitAt(waitingLive);
    liveDriver(waitingLive);
    await edit(paused, (s) => {
      s.status = 'paused';
      s.currentStep = 'approve-groom';
      s.pausedReason = 'cap: approve-groom reached 3 rounds';
    });
    await edit(dead, (s) => (s.currentStep = 'plan'));
    await edit(done, (s) => {
      s.status = 'completed';
      delete s.currentStep;
      s.history.push({ stepId: 'deliver', attempt: 1, startedAt: '', endedAt: '', status: 'pass', outputs: { pr_url: 'steps/deliver/1/outputs/pr_url.md' } });
    });
    await fs.mkdir(path.join(e.dir(done.runId), 'steps', 'deliver', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(e.dir(done.runId), 'steps', 'deliver', '1', 'outputs', 'pr_url.md'), `https://${REPO}/pull/3\n`);
    await edit(live, (s) => (s.currentStep = 'implement'));
    liveDriver(live);
    const groomTerm = await attend(attended);
    liveDriver(attended);
    const deadGroomTerm = await attend(attendedDead);
    await fs.mkdir(e.dir('t9-broken'), { recursive: true });

    const r = await e.perc(['status']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    const runFile = path.join(e.dir('t9-broken'), 'run.json');
    assert.equal(
      r.out,
      [
        `${attendedDead.runId}  running  groom  ${attendedDead.ticket}  blocked: attend terminal ${deadGroomTerm}; driver not running; perc resume ${attendedDead.runId}`,
        `${waitingLive.runId}  running  approve-groom  ${waitingLive.ticket}  waiting for approval: ${url}`,
        `${attended.runId}  running  groom  ${attended.ticket}  blocked: attend terminal ${groomTerm}`,
        `${live.runId}  running  implement  ${live.ticket}  driver ${live.driver}`,
        `${done.runId}  completed  -  ${done.ticket}  https://${REPO}/pull/3`,
        `${dead.runId}  running  plan  ${dead.ticket}  driver not running; perc resume ${dead.runId}`,
        `${paused.runId}  paused  approve-groom  ${paused.ticket}  cap: approve-groom reached 3 rounds`,
        `${waiting.runId}  running  approve-groom  ${waiting.ticket}  waiting for approval: ${url}; driver not running; perc resume ${waiting.runId}`,
        `t9-broken  broken  -  -  error: Run metadata ${runFile} is missing or invalid: file not found`,
        '',
      ].join('\n'),
    );
  } finally {
    await e.cleanup();
  }
});

test('status <id> when hc is missing', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.currentStep = 'plan';
    s.history.push(
      { stepId: 'intake', attempt: 1, startedAt: '', endedAt: '', status: 'pass', outputs: {} },
      { stepId: 'groom', attempt: 1, startedAt: '', endedAt: '', status: 'pass', outputs: {} },
    );
    await saveState(e.dir(meta.runId), s);
    const hc = cliHc({ exec: async () => Promise.reject(new Error('hc not found on PATH')) });
    const r = await e.perc(['status', meta.runId], { ...e.deps, hc });
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      [
        `run ${meta.runId}`,
        `  ticket ${REPO}#5`,
        '  profile work',
        `  worktree ${meta.worktree}`,
        `  branch ${meta.branch}`,
        '  status running',
        '  step plan',
        '  detail driver unknown (hc: hc not found on PATH)',
        'history:',
        '  intake a1 pass',
        '  groom a1 pass',
        '',
      ].join('\n'),
    );
    const list = await e.perc(['status'], { ...e.deps, hc });
    assert.equal(list.out, `${meta.runId}  running  plan  ${REPO}#5  driver unknown (hc: hc not found on PATH)\n`);

    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir: e.dir(meta.runId), since: NOW.toISOString(), commentUrl: 'u' });
    const waiting = await e.perc(['status'], { ...e.deps, hc });
    assert.equal(waiting.out, `${meta.runId}  running  plan  ${REPO}#5  waiting for approval: u; driver unknown (hc: hc not found on PATH)\n`);
  } finally {
    await e.cleanup();
  }
});

/** `perc status <id>`'s detail line and its JSON's driver.alive, for a running run at plan. */
async function driverDetail(e: Env, meta: RunMeta, deps: DriverDeps): Promise<[string | undefined, unknown]> {
  const r = await e.perc(['status', meta.runId], deps);
  assert.equal(r.code, 0, r.err);
  const j = await e.perc(['status', meta.runId, '--json'], deps);
  return [r.out.split('\n')[7], (JSON.parse(j.out) as { driver: { alive: unknown } }).driver.alive];
}

test('status <id> says the driver stopped when hc fails but a dead lock decides, like the JSON', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.currentStep = 'plan';
    await saveState(e.dir(meta.runId), s);
    await writeJson(path.join(e.dir(meta.runId), 'driver.json'), { pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() });
    const hc = cliHc({ exec: async () => Promise.reject(new Error('hc not found on PATH')) });
    assert.deepEqual(await driverDetail(e, meta, { ...e.deps, hc, pidAlive: () => false }), [
      `  detail driver not running; perc resume ${meta.runId}`,
      false,
    ]);
  } finally {
    await e.cleanup();
  }
});

test('status <id> says the driver is unknown when its lock is on another host, like the JSON', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.currentStep = 'plan';
    await saveState(e.dir(meta.runId), s);
    await writeJson(path.join(e.dir(meta.runId), 'driver.json'), { pid: 4242, host: 'elsewhere', terminal: null, startedAt: NOW.toISOString() });
    assert.deepEqual(await driverDetail(e, meta, e.deps), ['  detail driver unknown (pid 4242 on elsewhere)', null]);
  } finally {
    await e.cleanup();
  }
});

test('status <id> of a run whose graph.json is corrupt prints the error', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const graph = path.join(e.dir(meta.runId), 'graph.json');
    await fs.writeFile(graph, '{"version": 2}');
    const r = await e.perc(['status', meta.runId]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[8], `error: Run graph ${graph} is invalid: version: Invalid input: expected 1; start a new run`);
  } finally {
    await e.cleanup();
  }
});

test('status <id> of a run waiting at a gate whose driver died says so', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.currentStep = 'approve-groom';
    await saveState(e.dir(meta.runId), s);
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir: e.dir(meta.runId), since: NOW.toISOString(), commentUrl: 'u' });
    const r = await e.perc(['status', meta.runId]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[7], `  detail waiting for approval: u; driver not running; perc resume ${meta.runId}`);
  } finally {
    await e.cleanup();
  }
});

test('status <id> of a gate that waits only locally says how to answer it', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'sign-off', stepDir: e.dir(meta.runId), since: NOW.toISOString() });
    const r = await e.perc(['status', meta.runId]);
    assert.equal(r.code, 0, r.err);
    const id = meta.runId;
    assert.equal(r.out.split('\n')[7], `  detail waiting for approval: perc approve ${id} | perc reject ${id} <feedback>; driver not running; perc resume ${id}`);
  } finally {
    await e.cleanup();
  }
});

test('status during a foreground drive reports the driver pid, not a dead driver', async () => {
  const e = await setup();
  try {
    let during: { code: number; out: string; err: string } | undefined;
    let id = '';
    e.onWait.fn = async (t) => {
      if (t.labels['percolator.step'] === 'plan' && during === undefined) {
        id = t.labels['percolator.run']!;
        during = await e.perc(['status', id]);
      }
      return false;
    };
    const r = await e.perc(runArgv(e, '--foreground'));
    assert.equal(r.code, 0, r.err);
    assert.equal(during?.code, 0, during?.err);
    assert.equal(during!.out.split('\n')[7], `  detail driver pid ${process.pid}`);
    assert.equal(await exists(path.join(e.dir(id), 'driver.json')), false);
  } finally {
    await e.cleanup();
  }
});

test('status of a run waiting at a gate with a live driver lock keeps only the waiting text', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.currentStep = 'approve-groom';
    await saveState(e.dir(meta.runId), s);
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir: e.dir(meta.runId), since: NOW.toISOString(), commentUrl: 'u' });
    await writeJson(path.join(e.dir(meta.runId), 'driver.json'), { pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() });
    const r = await e.perc(['status', meta.runId], { ...e.deps, pidAlive: (p) => p === 4242 });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[7], '  detail waiting for approval: u');
  } finally {
    await e.cleanup();
  }
});

/** A run waiting at approve-groom with a live driver lock and a groom output to read. */
async function gateRun(e: Env) {
  const meta = await e.prepare();
  const s = await loadState(e.dir(meta.runId));
  s.currentStep = 'approve-groom';
  s.history.push({
    stepId: 'groom', attempt: 1, startedAt: '', endedAt: '', status: 'pass',
    outputs: { groomed_ticket: 'steps/groom/1/outputs/groomed_ticket.md' },
  });
  await saveState(e.dir(meta.runId), s);
  await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir: e.dir(meta.runId), since: NOW.toISOString(), commentUrl: 'u' });
  await writeJson(path.join(e.dir(meta.runId), 'driver.json'), { pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() });
  return { meta, deps: { ...e.deps, pidAlive: (p: number) => p === 4242 } };
}

test('status --json lists runs', async () => {
  const e = await setup();
  try {
    const { meta, deps } = await gateRun(e);
    const r = await e.perc(['status', '--json'], deps);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.ok(r.out.endsWith('}\n'));
    const j = JSON.parse(r.out) as { schema: number; runs: { id: string; status: string; attention?: { kind: string } }[] };
    assert.equal(j.schema, 2);
    assert.deepEqual(j.runs.map((x) => [x.id, x.status, x.attention?.kind]), [[meta.runId, 'waiting', 'gate']]);
  } finally {
    await e.cleanup();
  }
});

test('status <id> --json prints that run', async () => {
  const e = await setup();
  try {
    const { meta, deps } = await gateRun(e);
    const r = await e.perc(['status', meta.runId, '--json'], deps);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${JSON.stringify(JSON.parse(r.out), null, 2)}\n`);
    const j = JSON.parse(r.out) as { id: string; schema?: number };
    assert.equal(j.id, meta.runId);
    assert.equal(j.schema, undefined);
  } finally {
    await e.cleanup();
  }
});

test('status <id> --json of an unknown run fails like the text status', async () => {
  const e = await setup();
  try {
    const r = await e.perc(['status', 't1-nope', '--json']);
    assert.equal(r.code, 1);
    assert.equal(r.err, `Run metadata ${path.join(e.dir('t1-nope'), 'run.json')} is missing or invalid: file not found\n`);
    assert.equal(r.out, '');
  } finally {
    await e.cleanup();
  }
});

test('status <id> shows your turn at a gate', async () => {
  const e = await setup();
  try {
    const { meta, deps } = await gateRun(e);
    const r = await e.perc(['status', meta.runId], deps);
    assert.equal(r.code, 0, r.err);
    assert.equal(
      r.out,
      [
        `run ${meta.runId}`,
        `  ticket ${REPO}#5`,
        '  profile work',
        `  worktree ${meta.worktree}`,
        `  branch ${meta.branch}`,
        '  status running',
        '  step approve-groom',
        '  detail waiting for approval: u',
        'your turn: approve-groom is waiting for approval',
        '  Rejecting sends the run back to groom with your feedback.',
        `  read: ${path.join(e.dir(meta.runId), 'steps', 'groom', '1', 'outputs', 'groomed_ticket.md')}`,
        `  next: perc approve ${meta.runId}`,
        `  next: perc reject ${meta.runId} "<what to change>"`,
        'history:',
        '  groom a1 pass',
        '',
      ].join('\n'),
    );
  } finally {
    await e.cleanup();
  }
});

test('status --json rejects extra positionals', async () => {
  const e = await setup();
  try {
    const r = await e.perc(['status', 'a', 'b', '--json']);
    assert.equal(r.code, 2);
    assert.match(r.err, /^status takes at most one <run-id>\n/);
  } finally {
    await e.cleanup();
  }
});

test('resume is refused while a foreground drive holds the run', async () => {
  const e = await setup();
  try {
    let during: { code: number; out: string; err: string } | undefined;
    let id = '';
    e.onWait.fn = async (t) => {
      if (t.labels['percolator.step'] === 'plan' && during === undefined) {
        id = t.labels['percolator.run']!;
        // this process is the second caller; the drive runs as process 4242
        during = await e.perc(['resume', id], { ...e.deps, pidAlive: (p) => p === 4242 });
      }
      return false;
    };
    const r = await e.perc(runArgv(e, '--foreground'), { ...e.deps, pid: 4242, pidAlive: (p) => p === 4242 });
    assert.equal(r.code, 0, r.err);
    assert.equal(during?.code, 1);
    assert.equal(during!.err, `run ${id} is already being driven by process 4242\n`);
    // no second driver was launched
    assert.equal(runCalls(e.deps.hc).some((c) => (c[1] as { labels: Record<string, string> }).labels['percolator.role'] === 'driver'), false);
  } finally {
    await e.cleanup();
  }
});

test('resume is refused when another host holds the driver lock', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await writeJson(path.join(e.dir(meta.runId), 'driver.json'), { pid: 1, host: 'elsewhere', terminal: null, startedAt: NOW.toISOString() });
    const r = await e.perc(['resume', meta.runId], { ...e.deps, pidAlive: () => false });
    assert.equal(r.code, 1);
    assert.equal(r.err, `run ${meta.runId} is already being driven by process 1 on elsewhere\n`);
  } finally {
    await e.cleanup();
  }
});

test('a stale driver lock (dead pid on this host) is replaced, then removed at the end', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const lockFile = path.join(e.dir(meta.runId), 'driver.json');
    await writeJson(lockFile, { pid: 999999, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() });
    let held: unknown;
    e.onWait.fn = async (t) => {
      if (t.labels['percolator.step'] === 'plan' && held === undefined) held = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      return false;
    };
    // a foreground drive outside any hc terminal records terminal: null
    const r = await withTerminalId(undefined, () =>
      e.perc(['resume', meta.runId, '--foreground'], { ...e.deps, pid: 4242, pidAlive: (p) => p === 4242 }),
    );
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(held, { pid: 4242, host: os.hostname(), terminal: null, startedAt: NOW.toISOString() });
    assert.equal(await exists(lockFile), false);
  } finally {
    await e.cleanup();
  }
});

test('status <id> shows only the last 10 history records', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.status = 'paused';
    s.currentStep = 'review';
    s.pausedReason = 'review: stuck';
    for (let i = 1; i <= 12; i++) s.history.push({ stepId: 'review', attempt: i, startedAt: '', endedAt: '', status: 'fail', outputs: {} });
    await saveState(e.dir(meta.runId), s);
    const r = await e.perc(['status', meta.runId]);
    const lines = r.out.split('\n');
    assert.equal(lines[7], '  detail review: stuck');
    assert.deepEqual(lines.slice(lines.indexOf('history:') + 1, -1), Array.from({ length: 10 }, (_, i) => `  review a${i + 3} fail`));
  } finally {
    await e.cleanup();
  }
});

test('approve writes the decision', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const stepDir = path.join(e.dir(meta.runId), 'steps', 'approve-groom', '1');
    await fs.mkdir(stepDir, { recursive: true });
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir, since: NOW.toISOString(), commentUrl: 'u' });
    const r = await e.perc(['approve', meta.runId]);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `approved approve-groom of run ${meta.runId}\n`);
    const d = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8'));
    assert.equal(d.decision, 'approve');
    assert.equal(d.by, 'perc-bot');
    assert.equal(d.via, 'local');

    const rej = await e.perc(['reject', meta.runId, 'tighten', 'the scope']);
    assert.equal(rej.code, 0, rej.err);
    assert.equal(rej.out, `rejected approve-groom of run ${meta.runId}\n`);
    const d2 = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8'));
    assert.equal(d2.decision, 'reject');
    assert.equal(d2.feedback, 'tighten the scope');
  } finally {
    await e.cleanup();
  }
});

test('approve records the OS user when gh cannot say who is logged in', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const stepDir = path.join(e.dir(meta.runId), 'steps', 'approve-groom', '1');
    await fs.mkdir(stepDir, { recursive: true });
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir, since: NOW.toISOString(), commentUrl: 'u' });
    (e.deps.gh as FakeGh).fail('user', 'not logged in');
    const r = await e.perc(['approve', meta.runId]);
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8'));
    assert.equal(d.by, os.userInfo().username.replace(/\s+/g, '-'));
  } finally {
    await e.cleanup();
  }
});

// the Herdr panel sends ["reject", id, "--", feedback] (herdr/mods/percolator/model.js actionArgv)
test('reject takes the feedback after -- as one value, even when it starts with -', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const stepDir = path.join(e.dir(meta.runId), 'steps', 'approve-groom', '1');
    await fs.mkdir(stepDir, { recursive: true });
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir, since: NOW.toISOString(), commentUrl: 'u' });
    const r = await e.perc(['reject', meta.runId, '--', '-x "quoted"\nline2']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `rejected approve-groom of run ${meta.runId}\n`);
    const d = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8'));
    assert.equal(d.feedback, '-x "quoted"\nline2');
  } finally {
    await e.cleanup();
  }
});

const TRIAGE = [
  TRACKER,
  '    pipelines:',
  '      hotfix:',
  '        stages: [intake, implement, deliver]',
  '        exit: pr',
  '        bindings:',
  '          implement: { command: [echo, implement] }',
  '      triage:',
  '        router: true',
  '        stages: [intake, route]',
  '        choose: { agent: claude, from: [hotfix, feature] }',
].join(NL);

/** A triage run waiting at its pick-pipeline gate. */
async function waitingPick(e: Env): Promise<{ meta: RunMeta; stepDir: string }> {
  await e.writeConfig(TRIAGE, BINDINGS);
  const meta = await prepareRun({ ticket: '#5', pipeline: 'triage', repoDir: e.root, configFile: e.configFile, profile: 'work' }, e.deps);
  const stepDir = path.join(e.dir(meta.runId), 'steps', 'pick-pipeline', '1');
  await fs.mkdir(stepDir, { recursive: true });
  await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'pick-pipeline', stepDir, since: NOW.toISOString(), commentUrl: 'u' });
  return { meta, stepDir };
}

test('approve --pipeline records the pipeline a pick-pipeline gate goes with', async () => {
  const e = await setup();
  try {
    const { meta, stepDir } = await waitingPick(e);
    const r = await e.perc(['approve', meta.runId, '--pipeline', 'hotfix']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `approved pick-pipeline of run ${meta.runId}\n`);
    const d = JSON.parse(await fs.readFile(path.join(stepDir, 'decision.json'), 'utf8'));
    assert.deepEqual(d, { decision: 'approve', pipeline: 'hotfix', by: 'perc-bot', via: 'local' });
  } finally {
    await e.cleanup();
  }
});

test('approve --pipeline refuses a pipeline the router may not pick', async () => {
  const e = await setup();
  try {
    const { meta, stepDir } = await waitingPick(e);
    const r = await e.perc(['approve', meta.runId, '--pipeline', 'triage']);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'pipeline "triage" is not one triage may pick (from: hotfix, feature)\n');
    assert.equal(await exists(path.join(stepDir, 'decision.json')), false);
  } finally {
    await e.cleanup();
  }
});

test('approve --pipeline refuses a gate other than pick-pipeline', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const stepDir = path.join(e.dir(meta.runId), 'steps', 'approve-groom', '1');
    await fs.mkdir(stepDir, { recursive: true });
    await writeJson(path.join(e.dir(meta.runId), 'waiting.json'), { stepId: 'approve-groom', stepDir, since: NOW.toISOString(), commentUrl: 'u' });
    const r = await e.perc(['approve', meta.runId, '--pipeline', 'hotfix']);
    assert.equal(r.code, 1);
    assert.equal(r.err, `--pipeline only answers a pick-pipeline gate; run ${meta.runId} is waiting at approve-groom\n`);
    assert.equal(await exists(path.join(stepDir, 'decision.json')), false);
  } finally {
    await e.cleanup();
  }
});

test('approve when not waiting', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const want = `run ${meta.runId} is not waiting at a gate; see where it is with perc status ${meta.runId}\n`;
    const r = await e.perc(['approve', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.err, want);
    assert.equal(r.out, '');
    assert.equal((await e.perc(['approve', meta.runId, '--pipeline', 'hotfix'])).err, want);
    assert.equal((await e.perc(['reject', meta.runId, 'no'])).err, want);
  } finally {
    await e.cleanup();
  }
});

test('reject without feedback is a usage error', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const r = await e.perc(['reject', meta.runId]);
    assert.equal(r.code, 2);
    assert.match(r.err, /^reject needs <run-id> and <feedback>\n\nusage: perc/);
  } finally {
    await e.cleanup();
  }
});

test('a run id that is not a plain name is a usage error', async () => {
  const e = await setup();
  try {
    for (const cmd of ['status', 'approve', 'resume', 'clean', 'drive']) {
      const r = await e.perc([cmd, '../x']);
      assert.equal(r.code, 2, cmd);
      assert.match(r.err, /^invalid run id "\.\.\/x"\n\nusage: perc/, cmd);
    }
  } finally {
    await e.cleanup();
  }
});

test('resume refuses a changed config before launching', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await e.writeConfig(TRACKER, BINDINGS.map((l) => l.replace('groom-script', 'other-script')));
    const r = await e.perc(['resume', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `run ${meta.runId} was started with a different graph (its config or the Percolator version changed since); start a new run\n`);
    assert.deepEqual(runCalls(e.deps.hc), []);
  } finally {
    await e.cleanup();
  }
});

test('resume refuses a completed run with drive\'s message', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.status = 'completed';
    await saveState(e.dir(meta.runId), s);
    const r = await e.perc(['resume', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `run ${meta.runId} already completed\n`);
    assert.deepEqual(runCalls(e.deps.hc), []);
  } finally {
    await e.cleanup();
  }
});

test('resume relaunches a dead driver', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.deps.hc.add({ name: meta.driver, state: 'finished', labels: { 'percolator.run': meta.runId, 'percolator.role': 'driver' } });
    const r = await e.perc(['resume', meta.runId]);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      [`run ${meta.runId} resumed`, `  terminal ${meta.driver}`, `  follow with: perc status ${meta.runId}`, ''].join('\n'),
    );
    const calls = runCalls(e.deps.hc);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0]![1] as { argv: string[] }).argv, [process.execPath, ENTRY, 'drive', meta.runId]);
  } finally {
    await e.cleanup();
  }
});

test('resume --foreground drives in this process', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const r = await e.perc(['resume', meta.runId, '--foreground']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n').at(-2), `run ${meta.runId} completed: https://${REPO}/pull/1`);
    assert.equal(runCalls(e.deps.hc).some((c) => (c[1] as { name: string }).name === meta.driver), false);
  } finally {
    await e.cleanup();
  }
});

test('drive through main does not refuse its own terminal (HC_TERMINAL_ID)', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const driver = e.deps.hc.add({ name: meta.driver, labels: { 'percolator.run': meta.runId, 'percolator.role': 'driver' } });
    const other = await withTerminalId('w9:p9', () => e.perc(['drive', meta.runId]));
    assert.equal(other.code, 1);
    assert.equal(other.err, `run ${meta.runId} is already being driven by terminal ${meta.driver}\n`);
    const self = await withTerminalId(driver.address, () => e.perc(['drive', meta.runId]));
    assert.equal(self.code, 0, self.err);
    assert.equal(self.out.split('\n').at(-2), `run ${meta.runId} completed: https://${REPO}/pull/1`);
  } finally {
    await e.cleanup();
  }
});

test('drive exits 1 when the run fails', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.onWait.fn = (t) => {
      if (t.labels['percolator.step'] !== 'plan') return false;
      t.state = 'finished';
      t.exitCode = 1;
      return true;
    };
    const r = await e.perc(['drive', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.out.split('\n').at(-2), `run ${meta.runId} failed at plan`);
  } finally {
    await e.cleanup();
  }
});

test('clean refuses a live driver', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    e.deps.hc.add({ name: meta.driver, labels: { 'percolator.run': meta.runId, 'percolator.role': 'driver' } });
    const r = await e.perc(['clean', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `run ${meta.runId} is being driven by terminal ${meta.driver}; stop it first (or perc delete ${meta.runId})\n`);
    assert.equal(await exists(meta.worktree), true);
    assert.equal(e.deps.hc.terminals.has(meta.driver), true);
  } finally {
    await e.cleanup();
  }
});

async function setStatus(dir: string, status: RunState['status']): Promise<void> {
  const s = await loadState(dir);
  s.status = status;
  await saveState(dir, s);
}

test('clean of a running or paused run needs --force', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    for (const status of ['running', 'paused'] as const) {
      await setStatus(e.dir(meta.runId), status);
      const r = await e.perc(['clean', meta.runId]);
      assert.equal(r.code, 1);
      assert.equal(r.err, `run ${meta.runId} is ${status}; finish it or use perc clean ${meta.runId} --force, or perc delete ${meta.runId} to remove it entirely` + NL);
      assert.equal(await exists(meta.worktree), true);
    }
    const forced = await e.perc(['clean', meta.runId, '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(await exists(meta.worktree), false);
  } finally {
    await e.cleanup();
  }
});

test('clean removes terminals and worktree', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await setStatus(e.dir(meta.runId), 'completed');
    const labels = { 'percolator.run': meta.runId };
    e.deps.hc.add({ name: meta.driver, state: 'finished', labels: { ...labels, 'percolator.role': 'driver' } });
    e.deps.hc.add({ name: 'step-term', labels });
    e.deps.hc.add({ name: 'foreign', labels: { 'percolator.run': 'other' } });
    const r = await e.perc(['clean', meta.runId]);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `removed 2 terminal(s) and worktree ${meta.worktree}\n`);
    assert.deepEqual([...e.deps.hc.terminals.keys()], ['foreign']);
    assert.equal(await exists(meta.worktree), false);
    assert.match(await git(e.root, 'rev-parse', '--verify', `refs/heads/${meta.branch}`), /^[0-9a-f]{40}$/);
    assert.equal(await exists(path.join(e.dir(meta.runId), 'run.json')), true);
  } finally {
    await e.cleanup();
  }
});

test('clean of a dirty worktree needs --force', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await setStatus(e.dir(meta.runId), 'failed');
    await fs.writeFile(path.join(meta.worktree, 'dirty.txt'), 'x');
    const r = await e.perc(['clean', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `worktree ${meta.worktree} has uncommitted changes; commit them or use --force\n`);
    const forced = await e.perc(['clean', meta.runId, '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(await exists(meta.worktree), false);
  } finally {
    await e.cleanup();
  }
});

test('clean succeeds when the worktree dir was deleted by hand', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    await setStatus(e.dir(meta.runId), 'completed');
    await fs.rm(meta.worktree, { recursive: true, force: true, maxRetries: 5 });
    const r = await e.perc(['clean', meta.runId]);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(r.out, `removed 0 terminal(s) and worktree ${meta.worktree}\n`);
    assert.equal((await git(e.root, 'worktree', 'list', '--porcelain')).includes(meta.runId), false);
  } finally {
    await e.cleanup();
  }
});

test('approve of an unknown run names the missing run record', async () => {
  const e = await setup();
  try {
    const r = await e.perc(['approve', 't1-nope']);
    assert.equal(r.code, 1);
    assert.equal(r.err, `Run metadata ${path.join(e.dir('t1-nope'), 'run.json')} is missing or invalid: file not found\n`);
  } finally {
    await e.cleanup();
  }
});

const PIPELINES = [
  TRACKER,
  '    pipelines:',
  '      dd-alert:',
  '        stages: [intake, triage, deliver]',
  '        exit: pr',
  '        ticket: none',
  '        inputs:',
  '          alert_url: { required: true }',
  '        bindings:',
  '          triage: { command: [echo, triage] }',
  '      hotfix:',
  '        stages: [intake, implement, deliver]',
  '        exit: pr',
  '        ticket: optional',
  '        bindings:',
  '          implement: { command: [echo, implement] }',
].join('\n');

/** `perc run` with `args` against a config with the dd-alert and hotfix pipelines; asserts nothing was created. */
async function runPipelines(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const e = await setup();
  try {
    await e.writeConfig(PIPELINES, BINDINGS);
    const r = await e.perc(['run', ...args, '--repo', e.root, '--config', e.configFile, '--profile', 'work']);
    assert.equal(await exists(path.join(e.home, '.percolator', 'runs')), false);
    assert.equal(await exists(path.join(e.root, '.worktrees')), false);
    assert.equal(runCalls(e.deps.hc).length, 0);
    return r;
  } finally {
    await e.cleanup();
  }
}

test('perc run --pipeline dd-alert without alert_url exits 2', async () => {
  const r = await runPipelines(['--pipeline', 'dd-alert']);
  assert.equal(r.code, 2);
  assert.ok(r.err.startsWith('pipeline "dd-alert" needs input alert_url; pass --input alert_url=<value>\n\nusage: perc'), r.err);
});

test('perc run with a ticket on a ticket: none pipeline exits 2', async () => {
  const r = await runPipelines(['#5', '--pipeline', 'dd-alert', '--input', 'alert_url=https://dd/x?a=b']);
  assert.equal(r.code, 2);
  assert.ok(
    r.err.startsWith(
      'pipeline "dd-alert" takes no ticket (ticket: none); drop the ticket or pick another pipeline with --pipeline\n\nusage: perc',
    ),
    r.err,
  );
});

test('perc run --input that is not key=value exits 2', async () => {
  const r = await runPipelines(['#5', '--input', 'oops']);
  assert.equal(r.code, 2);
  assert.ok(r.err.startsWith('--input needs key=value, got "oops"\n\nusage: perc'), r.err);
});

test('perc run takes at most one ticket', async () => {
  const r = await runPipelines(['#5', '#6']);
  assert.equal(r.code, 2);
  assert.ok(r.err.startsWith('run takes at most one <ticket>\n\nusage: perc'), r.err);
});

test('perc run of an unknown pipeline names the pipelines', async () => {
  const r = await runPipelines(['#5', '--pipeline', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.err, /: unknown pipeline "nope" in profile "work" \(pipelines: feature, dd-alert, hotfix\); pass one of those to --pipeline\n$/);
});

test('a valid ticketless request starts a run named after its pipeline', async () => {
  const e = await setup();
  try {
    await e.writeConfig(PIPELINES, BINDINGS);
    const r = await e.perc(['run', '--pipeline', 'dd-alert', '--input', 'alert_url=u', '--repo', e.root, '--config', e.configFile, '--profile', 'work']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    const id = await onlyRun(e);
    assert.match(id, /^dd-alert-20260304-050607-[0-9a-f]{4}$/);
    assert.ok(r.out.includes(`  terminal ${terminalName(id, 'dd-alert', '@driver', 0)}\n`), r.out);
    assert.ok(r.out.includes(`  space "r dd-alert · ${id.slice(-4)}"`), r.out);
  } finally {
    await e.cleanup();
  }
});

test('status of a ticketless run shows its pipeline instead of a ticket', async () => {
  const e = await setup();
  try {
    await e.writeConfig(PIPELINES, BINDINGS);
    await e.perc(['run', '--pipeline', 'dd-alert', '--input', 'alert_url=u', '--repo', e.root, '--config', e.configFile, '--profile', 'work']);
    const id = await onlyRun(e);
    const one = await e.perc(['status', id]);
    assert.equal(one.err, '');
    assert.deepEqual(one.out.split('\n').slice(0, 3), [`run ${id}`, '  pipeline dd-alert', '  profile work']);
    const list = await e.perc(['status']);
    assert.match(list.out, new RegExp(`^${id}  running  -  dd-alert  `));
  } finally {
    await e.cleanup();
  }
});

test('status <id> of a failed run says why it failed', async () => {
  const e = await setup();
  try {
    const meta = await e.prepare();
    const s = await loadState(e.dir(meta.runId));
    s.status = 'failed';
    s.currentStep = 'lint';
    await saveState(e.dir(meta.runId), s);
    assert.equal((await e.perc(['status', meta.runId])).out.split('\n')[7], '  detail lint failed');
    s.failedReason = 'exit code 1';
    await saveState(e.dir(meta.runId), s);
    assert.equal((await e.perc(['status', meta.runId])).out.split('\n')[7], '  detail lint failed (exit code 1)');
  } finally {
    await e.cleanup();
  }
});
