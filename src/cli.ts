#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { initConfig } from './config/init.ts';
import { writeJsonSchema } from './config/json-schema.ts';
import { loadState } from './engine/state.ts';
import type { RunState } from './engine/state.ts';
import { cliHerdrApp } from './herdr/app.ts';
import { cliHc } from './herdr/hc.ts';
import { herdrAppHome, linkHerdr } from './herdr/link.ts';
import { checkResumable, drive, prUrl } from './run/drive.ts';
import { listRuns, readRunMeta } from './run/meta.ts';
import type { RunMeta } from './run/meta.ts';
import { launchDriver, prepareRun } from './run/prepare.ts';
import type { DriverDeps } from './run/prepare.ts';
import { attentionNext, driverLiveness, readAttention, runStatusJson, statusJson } from './run/status.ts';
import { sweepTerminals } from './runtime/herdr-runtime.ts';
import { readWaiting, writeDecision } from './tracker/gate.ts';
import { cliGh } from './tracker/gh.ts';
import { isDirectRun } from './util/entry.ts';
import { validate } from './validate.ts';
import type { ValidateResult } from './validate.ts';
import { runDir } from './workspace/run-dir.ts';
import { removeWorktree } from './workspace/worktree.ts';

export type Io = { stdout(s: string): void; stderr(s: string): void };

const USAGE = `usage: perc <command> [options]

commands:
  init [--config <file>] [--force]
      write the recommended config (default: ~/.percolator/config.yaml)
  validate [--config <file>] [--profile <name>] [--update]
      load the config, resolve grounds and mappings, and check the graph
      (default config: ~/.percolator/config.yaml)
  schema [--out <file>]
      write the JSON schema for the config (default: schema/percolator.schema.json)
  run <ticket> [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]
      start a run: groom, approval, plan, implement, review, PR (default: in its own hc terminal)
  resume <run-id> [--foreground]
      continue a paused or interrupted run (grants one more round at a cap)
  status [<run-id>] [--json]
      list runs, or show one (--json: the stable JSON contract)
  approve <run-id> | reject <run-id> <feedback>
      answer the approval gate a run is waiting at
  clean <run-id> [--force]
      remove a finished run's terminals and worktree (keeps the branch and the run record)
  herdr link
      tell the Percolator Herdr panel how to run perc (writes perc.json)
  drive <run-id>
      internal: what a run's driver terminal executes

options:
  -h, --help   show this help
`;

class UsageError extends Error {}

type Options = Record<string, { type: 'string' | 'boolean' }>;

function parse<T extends Options>(args: string[], options: T, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** `parse`, with positionals allowed. */
const parseWith = <T extends Options>(args: string[], options: T) => parse(args, options, true);

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A run id from the command line: a plain name, so it never points outside the runs dir. */
function runIdArg(id: string): string {
  if (!RUN_ID.test(id)) throw new UsageError(`invalid run id "${id}"`);
  return id;
}

/** The single `<run-id>` positional of `command`. */
function onlyRunId(command: string, positionals: string[]): string {
  if (positionals.length !== 1) throw new UsageError(`${command} needs <run-id>`);
  return runIdArg(positionals[0]!);
}

const defaultConfig = () => path.join(os.homedir(), '.percolator', 'config.yaml');

function describe(r: ValidateResult): string {
  const lines = [`profile: ${r.profile}`];
  for (const [name, version] of Object.entries(r.groundVersions)) lines.push(`ground ${name} ${version}`);
  for (const m of r.mappings) lines.push(`${m.as} ${m.absPath}`);
  lines.push('', 'steps:');
  r.graph.steps.forEach((s, i) => {
    const pos = s.role === 'hook' ? ` (${s.def.before !== undefined ? `before ${s.def.before}` : `after ${s.def.after}`})` : '';
    lines.push(`${i + 1}. ${s.id}${pos}`);
  });
  lines.push('', 'back-edges:');
  for (const e of Object.values(r.graph.backEdges)) {
    const target = r.graph.steps[e.toStepIndex]!.stage;
    lines.push(`${e.fromStepId} → ${target} (max ${e.maxRounds}, ${e.onCap})`);
  }
  return `${lines.join('\n')}\n`;
}

async function runInit(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { config: { type: 'string' }, force: { type: 'boolean' } });
  const file = path.resolve(values.config ?? defaultConfig());
  await initConfig(file, { force: values.force === true });
  io.stdout(`wrote ${file}
next: perc validate --config ${file} --profile default
`);
  return 0;
}

async function runValidate(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { config: { type: 'string' }, profile: { type: 'string' }, update: { type: 'boolean' } });
  const configFile = path.resolve(values.config ?? defaultConfig());
  const r = await validate({
    configFile,
    cwd: process.cwd(),
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    ...(values.update ? { update: true } : {}),
  });
  io.stdout(describe(r));
  return 0;
}

async function runSchema(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { out: { type: 'string' } });
  const out = path.resolve(values.out ?? path.join('schema', 'percolator.schema.json'));
  await writeJsonSchema(out);
  io.stdout(`${out}\n`);
  return 0;
}

const exitOf = (s: RunState): number => (s.status === 'failed' ? 1 : 0);

async function runRun(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, {
    repo: { type: 'string' },
    config: { type: 'string' },
    profile: { type: 'string' },
    foreground: { type: 'boolean' },
  });
  if (positionals.length !== 1) throw new UsageError('run needs <ticket>');
  const meta = await prepareRun(
    {
      ticket: positionals[0]!,
      repoDir: path.resolve(values.repo ?? process.cwd()),
      configFile: values.config ?? defaultConfig(),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
    },
    deps,
  );
  if (values.foreground) {
    deps.out(`run ${meta.runId} started`);
    deps.out(`  worktree ${meta.worktree}`);
    return exitOf(await drive(meta.runId, deps));
  }
  const driver = await launchDriver(meta, deps);
  const space = meta.space !== undefined ? ` (space "${meta.repo.split('/').at(-1)} #${meta.issue}")` : '';
  deps.out(`run ${meta.runId} started`);
  deps.out(`  terminal ${driver}${space}`);
  deps.out(`  worktree ${meta.worktree}`);
  deps.out(`  follow with: perc status ${meta.runId}`);
  return 0;
}

async function runResume(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, { foreground: { type: 'boolean' } });
  const runId = onlyRunId('resume', positionals);
  if (values.foreground) return exitOf(await drive(runId, deps));
  // drive's own checks, run here first so a refusal reaches this terminal rather than the driver's
  const { meta } = await checkResumable(runId, deps);
  const driver = await launchDriver(meta, deps);
  deps.out(`run ${runId} resumed`);
  deps.out(`  terminal ${driver}`);
  deps.out(`  follow with: perc status ${runId}`);
  return 0;
}

/** What a run is doing or waiting for, in one line; an hc failure is reported, never thrown. */
async function runDetail(dir: string, meta: RunMeta, state: RunState, deps: DriverDeps): Promise<string> {
  const waiting = await readWaiting(dir).catch(() => undefined);
  const waitingText = waiting && `waiting for approval: ${waiting.commentUrl}`;
  if (state.status === 'running') {
    // a killed driver leaves waiting.json and attention.json behind, so liveness is always reported
    const a = await readAttention(dir);
    const what = waitingText ?? (a !== undefined && a.stepId === state.currentStep ? `${a.kind}: attend terminal ${a.terminal}` : undefined);
    const d = await driverLiveness(dir, meta, deps);
    // a foreground drive has no driver terminal; its driver.json says it is alive
    const live = d.lock === undefined ? `driver ${meta.driver}` : `driver pid ${d.lock.pid}${d.lock.host === os.hostname() ? '' : ` on ${d.lock.host}`}`;
    const unknown = d.hcError !== undefined && d.lock === undefined && d.alive !== true;
    const driver = unknown
      ? `driver unknown (hc: ${d.hcError})`
      : d.alive !== false
        ? undefined
        : d.hcError !== undefined
          ? `driver unknown (hc: ${d.hcError})`
          : `driver not running; perc resume ${meta.runId}`;
    if (what === undefined) return driver ?? live;
    return driver === undefined ? what : `${what}; ${driver}`;
  }
  if (waitingText) return waitingText;
  if (state.status === 'paused') return state.pausedReason ?? '';
  if (state.status === 'completed') return (await prUrl(dir, state)) ?? '';
  return '';
}

async function runStatus(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, { json: { type: 'boolean' } });
  if (positionals.length > 1) throw new UsageError('status takes at most one <run-id>');
  const printJson = (x: unknown) => deps.out(JSON.stringify(x, null, 2));
  if (positionals.length === 1) {
    const runId = runIdArg(positionals[0]!);
    const dir = runDir(deps.home, runId);
    const meta = await readRunMeta(dir);
    const state = await loadState(dir);
    const run = await runStatusJson({ dir, meta, state }, deps);
    if (values.json) {
      printJson(run);
      return 0;
    }
    deps.out(`run ${runId}`);
    deps.out(`  ticket ${meta.ticket}`);
    deps.out(`  profile ${meta.profile}`);
    deps.out(`  worktree ${meta.worktree}`);
    deps.out(`  branch ${meta.branch}`);
    deps.out(`  status ${state.status}`);
    deps.out(`  step ${state.currentStep ?? '-'}`);
    deps.out(`  detail ${await runDetail(dir, meta, state, deps)}`);
    if ('attention' in run && run.attention !== undefined) {
      const a = run.attention;
      deps.out(`your turn: ${a.message}`);
      if (a.detail !== undefined) deps.out(`  ${a.detail}`);
      for (const r of a.review ?? []) deps.out(`  read: ${r.path}`);
      for (const n of attentionNext(a, run)) deps.out(`  next: ${n}`);
    }
    deps.out('history:');
    for (const h of state.history.slice(-10)) deps.out(`  ${h.stepId} a${h.attempt} ${h.status}`);
    return 0;
  }
  if (values.json) {
    printJson(await statusJson(deps));
    return 0;
  }
  for (const l of await listRuns(deps.home)) {
    const id = l.meta?.runId ?? path.basename(l.dir);
    const ticket = l.meta?.ticket ?? '-';
    if (l.error !== undefined || l.meta === undefined) {
      deps.out(`${id}  broken  -  ${ticket}  error: ${l.error}`);
      continue;
    }
    const detail = l.state === undefined ? '' : await runDetail(l.dir, l.meta, l.state, deps);
    deps.out(`${id}  ${l.state?.status ?? '-'}  ${l.state?.currentStep ?? '-'}  ${ticket}  ${detail}`.trimEnd());
  }
  return 0;
}

async function runDecide(decision: 'approve' | 'reject', args: string[], deps: DriverDeps): Promise<number> {
  const { positionals } = parseWith(args, {});
  let runId: string;
  let feedback: string | undefined;
  if (decision === 'approve') {
    runId = onlyRunId('approve', positionals);
  } else {
    feedback = positionals.slice(1).join(' ').trim();
    if (feedback === '') throw new UsageError('reject needs <run-id> and <feedback>');
    runId = runIdArg(positionals[0]!);
  }
  const dir = runDir(deps.home, runId);
  await readRunMeta(dir);
  const w = await writeDecision(dir, { decision, ...(feedback !== undefined ? { feedback } : {}) });
  deps.out(`${decision === 'approve' ? 'approved' : 'rejected'} ${w.stepId} of run ${runId}`);
  return 0;
}

async function runClean(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, { force: { type: 'boolean' } });
  const runId = onlyRunId('clean', positionals);
  const dir = runDir(deps.home, runId);
  const meta = await readRunMeta(dir);
  const driver = await deps.hc.get(meta.driver);
  if (driver?.state === 'live') throw new Error(`run ${runId} is being driven by terminal ${meta.driver}; stop it first`);
  if (values.force !== true) {
    // a paused or running run still has live node terminals the owner may want
    const { status } = await loadState(dir);
    if (status !== 'completed' && status !== 'failed') {
      throw new Error(`run ${runId} is ${status}; finish it or use perc clean ${runId} --force`);
    }
  }
  const removed = await sweepTerminals(deps.hc, runId);
  await removeWorktree({ repoRoot: meta.repoRoot, dir: meta.worktree, force: values.force === true });
  deps.out(`removed ${removed.length} terminal(s) and worktree ${meta.worktree}`);
  return 0;
}

async function runHerdr(args: string[], io: Io, home: string): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'link') throw new UsageError('herdr needs a subcommand: link');
  parse(rest, {});
  const file = await linkHerdr({
    appHome: herdrAppHome(process.env, home),
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
  });
  io.stdout(`wrote ${file}
`);
  return 0;
}

async function runDrive(args: string[], deps: DriverDeps): Promise<number> {
  const { positionals } = parseWith(args, {});
  return exitOf(await drive(onlyRunId('drive', positionals), deps));
}

/** Fills in the real clients for missing deps; `out` always writes lines to `io.stdout`. */
function driverDeps(io: Io, d: Partial<DriverDeps>): DriverDeps {
  const self = d.selfTerminal ?? process.env['HC_TERMINAL_ID'];
  return {
    hc: d.hc ?? cliHc(),
    app: d.app ?? cliHerdrApp(),
    gh: d.gh ?? cliGh(),
    home: d.home ?? os.homedir(),
    ...(d.now !== undefined ? { now: d.now } : {}),
    ...(d.sleep !== undefined ? { sleep: d.sleep } : {}),
    out: (s) => io.stdout(`${s}\n`),
    ...(self !== undefined && self !== '' ? { selfTerminal: self } : {}),
    entry: d.entry ?? fileURLToPath(import.meta.url),
    ...(d.pid !== undefined ? { pid: d.pid } : {}),
    ...(d.pidAlive !== undefined ? { pidAlive: d.pidAlive } : {}),
  };
}

/**
 * Runs the CLI and returns the exit code: 0 ok, 1 error, rule violations (printed one per line) or a failed run,
 * 2 usage error. Missing `deps` default to the real hc, herdr-app and gh clients, `os.homedir()`,
 * `HC_TERMINAL_ID` and this file as the driver entry.
 */
export async function main(argv: string[], io: Io, deps: Partial<DriverDeps> = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (command === 'init') return await runInit(rest, io);
    if (command === 'validate') return await runValidate(rest, io);
    if (command === 'schema') return await runSchema(rest, io);
    if (command === 'herdr') return await runHerdr(rest, io, deps.home ?? os.homedir());
    const d = () => driverDeps(io, deps);
    if (command === 'run') return await runRun(rest, d());
    if (command === 'resume') return await runResume(rest, d());
    if (command === 'status') return await runStatus(rest, d());
    if (command === 'approve' || command === 'reject') return await runDecide(command, rest, d());
    if (command === 'clean') return await runClean(rest, d());
    if (command === 'drive') return await runDrive(rest, d());
    io.stderr(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}
