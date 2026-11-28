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
import { cleanRun, deleteFinished, deleteIds } from './run/delete.ts';
import { drive } from './run/drive.ts';
import { checkResumable } from './run/resumable.ts';
import { listRuns, readRunMeta, spaceName } from './run/meta.ts';
import { pipelinesJson, pipelinesText } from './run/pipelines-json.ts';
import { applyAnswer, askedItems, checkAnswer } from './run/answer.ts';
import { launchDriver, prepareRun } from './run/prepare.ts';
import { parseInputs } from './run/request.ts';
import type { DriverDeps } from './run/prepare.ts';
import { runStatusJson, statusJson } from './run/status.ts';
import { itemLine, questionLines, runDetail } from './run/status-text.ts';
import { attentionNext } from './run/next-steps.ts';
import { deciderLogin } from './tracker/gate.ts';
import { readWaiting, writeDecision } from './tracker/gate-store.ts';
import { cliGh } from './tracker/gh.ts';
import { askLine } from './util/ask.ts';
import { isDirectRun } from './util/entry.ts';
import { UsageError } from './util/errors.ts';
import { validate, validateAll, validateText } from './validate.ts';
import { startWatch, stopWatch, watchHere } from './watch/control.ts';
import { PICK_GATE } from './graph/core.ts';
import { runDir } from './workspace/run-dir.ts';
import { pipeWriter } from './util/pipe.ts';

export type Io = { stdout(s: string): void; stderr(s: string): void };

/** What a command gets: the output streams, the deps given to main, and the driver deps built from them on first use. */
type CommandContext = { io: Io; home: string; driver: () => DriverDeps };

/**
 * One perc command: its name, its help (the usage line, then description lines; none when another command's
 * entry shows it) and what it runs. The help and main's dispatch both come from COMMANDS, so a new command is
 * one entry here.
 */
export type Command = { name: string; usage?: readonly string[]; run(args: string[], c: CommandContext): Promise<number> };

export const COMMANDS: readonly Command[] = [
  {
    name: 'init',
    usage: ['init [--config <file>] [--force]', 'write the recommended config (default: ~/.percolator/config.yaml)'],
    run: (args, c) => runInit(args, c.io),
  },
  {
    name: 'validate',
    usage: [
      'validate [--config <file>] [--profile <name>] [--pipeline <name>] [--update]',
      'load the config, resolve grounds and mappings, and check the graph of each pipeline',
      '(--pipeline: that one only)',
      '(default config: ~/.percolator/config.yaml)',
    ],
    run: (args, c) => runValidate(args, c.io),
  },
  {
    name: 'schema',
    usage: ['schema [--out <file>]', 'write the JSON schema for the config (default: schema/percolator.schema.json)'],
    run: (args, c) => runSchema(args, c.io),
  },
  {
    name: 'pipelines',
    usage: [
      'pipelines [--repo <dir>] [--config <file>] [--profile <name>] [--json]',
      "list the pipelines a run in the repo can use, one line each (--json: the panel's contract)",
    ],
    run: (args, c) => runPipelines(args, c.io, c.home),
  },
  {
    name: 'watch',
    usage: [
      'watch [--repo <dir>]... [--config <file>] [--profile <name>] [--interval <s>] [--foreground] | watch stop',
      "start runs from the pipelines' triggers, polling each repo every --interval seconds (default 60, at least 15)",
      'in hc terminal percolator-watch (--foreground: in this one); watch stop ends it',
    ],
    run: (args, c) => runWatch(args, c.driver()),
  },
  {
    name: 'run',
    usage: [
      'run [<ticket>] [--pipeline <name>] [--input key=value]... [--repo <dir>] [--config <file>] [--profile <name>] [--foreground]',
      "start a run of a pipeline (default: the profile's; feature: groom, approval, plan, implement, review, PR)",
      'in its own hc terminal (--foreground: in this one)',
    ],
    run: (args, c) => runRun(args, c.driver()),
  },
  {
    name: 'resume',
    usage: ['resume <run-id> [--foreground]', 'continue a paused or interrupted run (grants one more round at a cap)'],
    run: (args, c) => runResume(args, c.driver()),
  },
  {
    name: 'answer',
    usage: [
      'answer <run-id> [--answer <n>=<text>]... [--na <n>]... [--agree <n>[,<n>…]]... [--foreground]',
      'answer the questions or the findings a paused run is asking about (perc status <run-id> lists them)',
    ],
    run: (args, c) => runAnswer(args, c.driver()),
  },
  {
    name: 'status',
    usage: ['status [<run-id>] [--json]', 'list runs, or show one (--json: the stable JSON contract)'],
    run: (args, c) => runStatus(args, c.driver()),
  },
  {
    name: 'approve',
    usage: [
      'approve <run-id> [--pipeline <name>] | reject <run-id> <feedback>',
      'answer the approval gate a run is waiting at (--pipeline: the pipeline a pick-pipeline gate goes with)',
    ],
    run: (args, c) => runDecide('approve', args, c.driver()),
  },
  { name: 'reject', run: (args, c) => runDecide('reject', args, c.driver()) },
  {
    name: 'clean',
    usage: [
      'clean <run-id> [--force]',
      "remove a finished run's terminals and worktree (keeps the branch and the run record; perc delete removes it all)",
    ],
    run: (args, c) => runClean(args, c.driver()),
  },
  {
    name: 'delete',
    usage: [
      'delete <run-id>... [--yes] | delete --finished [--yes]',
      'remove a run entirely: stop it, its terminals, worktree and record (keeps the branch)',
    ],
    run: (args, c) => runDelete(args, c.driver(), c.io),
  },
  {
    name: 'herdr',
    usage: ['herdr link', 'tell the Percolator Herdr panel how to run perc (writes perc.json)'],
    run: (args, c) => runHerdr(args, c.io, c.home),
  },
  {
    name: 'drive',
    usage: ['drive <run-id>', "internal: what a run's driver terminal executes"],
    run: (args, c) => runDrive(args, c.driver()),
  },
];

export const USAGE = `usage: perc <command> [options]

commands:
${COMMANDS.flatMap((c) => (c.usage === undefined ? [] : [`  ${c.usage[0]}`, ...c.usage.slice(1).map((l) => `      ${l}`)])).join('\n')}

options:
  -h, --help   show this help
`;

type Options = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

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

/** The config file (`--config`, resolved; default ~/.percolator/config.yaml) and `--profile` a command loads with. */
const configOpts = (values: { config?: string | undefined; profile?: string | undefined }) => ({
  configFile: path.resolve(values.config ?? defaultConfig()),
  ...(values.profile !== undefined ? { profile: values.profile } : {}),
});

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
  const { values } = parse(args, {
    config: { type: 'string' },
    profile: { type: 'string' },
    pipeline: { type: 'string' },
    update: { type: 'boolean' },
  });
  const opts = {
    ...configOpts(values),
    cwd: process.cwd(),
    ...(values.update ? { update: true } : {}),
  };
  const results = values.pipeline !== undefined ? [await validate({ ...opts, pipeline: values.pipeline })] : await validateAll(opts);
  io.stdout(validateText(results));
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

/** What run, resume and answer print once the driver terminal is launched; `more` goes between the terminal and how to follow. */
function printLaunched(deps: DriverDeps, runId: string, verb: 'started' | 'resumed', terminal: string, more: string[] = []): void {
  deps.out(`run ${runId} ${verb}`);
  deps.out(`  terminal ${terminal}`);
  for (const l of more) deps.out(l);
  deps.out(`  follow with: perc status ${runId}`);
}

async function runRun(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, {
    repo: { type: 'string' },
    config: { type: 'string' },
    profile: { type: 'string' },
    pipeline: { type: 'string' },
    input: { type: 'string', multiple: true },
    foreground: { type: 'boolean' },
  });
  if (positionals.length > 1) throw new UsageError('run takes at most one <ticket>');
  const inputs = parseInputs(values.input ?? []);
  const meta = await prepareRun(
    {
      ...(positionals[0] !== undefined ? { ticket: positionals[0] } : {}),
      ...(values.pipeline !== undefined ? { pipeline: values.pipeline } : {}),
      inputs,
      repoDir: path.resolve(values.repo ?? process.cwd()),
      ...configOpts(values),
    },
    deps,
  );
  if (values.foreground) {
    deps.out(`run ${meta.runId} started`);
    deps.out(`  worktree ${meta.worktree}`);
    return exitOf(await drive(meta.runId, deps));
  }
  const driver = await launchDriver(meta, deps);
  printLaunched(deps, meta.runId, 'started', driver, [
    ...(meta.space !== undefined
      ? [`  space "${spaceName(meta)}" (the driver stays hidden; "Driver pane ↗" in the Percolator panel peeks at it)`]
      : []),
    `  worktree ${meta.worktree}`,
  ]);
  return 0;
}

async function runPipelines(args: string[], io: Io, home: string): Promise<number> {
  const { values } = parse(args, {
    repo: { type: 'string' },
    config: { type: 'string' },
    profile: { type: 'string' },
    json: { type: 'boolean' },
  });
  const j = await pipelinesJson({
    repoDir: path.resolve(values.repo ?? process.cwd()),
    ...configOpts(values),
    home,
  });
  io.stdout(values.json ? `${JSON.stringify(j, null, 2)}\n` : pipelinesText(j));
  return 0;
}

async function runResume(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, { foreground: { type: 'boolean' } });
  const runId = onlyRunId('resume', positionals);
  if (values.foreground) return exitOf(await drive(runId, deps));
  // drive's own checks, run here first so a refusal reaches this terminal rather than the driver's
  const { meta } = await checkResumable(runId, deps);
  printLaunched(deps, runId, 'resumed', await launchDriver(meta, deps));
  return 0;
}

async function runAnswer(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, {
    answer: { type: 'string', multiple: true },
    na: { type: 'string', multiple: true },
    agree: { type: 'string', multiple: true },
    foreground: { type: 'boolean' },
  });
  const runId = onlyRunId('answer', positionals);
  const dir = runDir(deps.home, runId);
  const asked = await loadState(dir);
  if (asked.asking === undefined) {
    throw new Error(`run ${runId} is not waiting for answers; see where it is with perc status ${runId}`);
  }
  const items = await askedItems(dir, asked);
  const answer = checkAnswer(runId, asked.asking, items, {
    answer: values.answer ?? [],
    na: values.na ?? [],
    agree: values.agree ?? [],
  });
  // drive's own checks before anything is written, so a refused answer changes nothing
  const { meta, state, v } = await checkResumable(runId, deps, { answering: true });
  deps.out(await applyAnswer(dir, state, v.graph, answer, items));
  if (values.foreground) return exitOf(await drive(runId, deps));
  printLaunched(deps, runId, 'resumed', await launchDriver(meta, deps));
  return 0;
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
    if (meta.ticket !== undefined) deps.out(`  ticket ${meta.ticket}`);
    if (meta.pipeline !== 'feature') deps.out(`  pipeline ${meta.pipeline}`);
    deps.out(`  profile ${meta.profile}`);
    deps.out(`  worktree ${meta.worktree}`);
    deps.out(`  branch ${meta.branch}`);
    deps.out(`  status ${state.status}`);
    deps.out(`  step ${state.currentStep ?? '-'}`);
    deps.out(`  detail ${await runDetail(dir, meta, state, deps)}`);
    if (run.status === 'unreadable') deps.out(`error: ${run.error}`);
    if ('attention' in run && run.attention !== undefined) {
      const a = run.attention;
      deps.out(`your turn: ${a.message}`);
      if (a.detail !== undefined) deps.out(`  ${a.detail}`);
      for (const r of a.review ?? []) deps.out(`  read: ${r.path}`);
      for (const [i, item] of (a.asked?.items ?? []).entries()) {
        for (const l of a.kind === 'questions' ? questionLines(i + 1, item) : [`  ${i + 1}. ${itemLine(item)}`]) deps.out(l);
      }
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
    // a ticketless run is known by its pipeline
    const ticket = l.meta?.ticket ?? l.meta?.pipeline ?? '-';
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
  const { values, positionals } = parseWith(args, decision === 'approve' ? { pipeline: { type: 'string' } } : {});
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
  const meta = await readRunMeta(dir);
  const pipeline = values.pipeline as string | undefined;
  const waiting = await readWaiting(dir);
  if (waiting === undefined) throw new Error(`run ${runId} is not waiting at a gate; see where it is with perc status ${runId}`);
  if (pipeline !== undefined) {
    if (waiting.stepId !== PICK_GATE) {
      throw new Error(`--pipeline only answers a pick-pipeline gate; run ${runId} is waiting at ${waiting.stepId}`);
    }
    const v = await validate({ configFile: meta.configFile, cwd: meta.repoRoot, home: deps.home, profile: meta.profile, pipeline: meta.pipeline });
    const from = v.pipeline.choose?.from ?? [];
    if (!from.includes(pipeline)) {
      throw new Error(`pipeline "${pipeline}" is not one ${meta.pipeline} may pick (from: ${from.join(', ')})`);
    }
  }
  const w = await writeDecision(dir, {
    decision,
    ...(feedback !== undefined ? { feedback } : {}),
    ...(pipeline !== undefined ? { pipeline } : {}),
    by: await deciderLogin(deps.gh),
  });
  deps.out(`${decision === 'approve' ? 'approved' : 'rejected'} ${w.stepId} of run ${runId}`);
  return 0;
}

async function runClean(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, { force: { type: 'boolean' } });
  const runId = onlyRunId('clean', positionals);
  return cleanRun(runId, values.force === true, deps);
}

async function runDelete(args: string[], deps: DriverDeps, io: Io): Promise<number> {
  const { values, positionals } = parseWith(args, { yes: { type: 'boolean' }, finished: { type: 'boolean' } });
  if (values.finished === true && positionals.length > 0) throw new UsageError('delete takes <run-id> or --finished, not both');
  if (values.finished !== true && positionals.length === 0) throw new UsageError('delete needs <run-id> or --finished');
  const ids = positionals.map((p) => runIdArg(p));
  const yes = values.yes === true;
  if (!yes && (deps.ask ?? null) === null) throw new UsageError('delete needs --yes when stdin is not a terminal');
  if (values.finished === true) return deleteFinished(yes, deps, io);
  return deleteIds(ids, yes, deps, io);
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

/** The `--interval` of perc watch, in whole seconds, at least 15. */
function intervalArg(v: string | undefined): number {
  if (v === undefined) return 60;
  if (!/^\d+$/.test(v)) throw new UsageError(`--interval must be a whole number of seconds, got "${v}"`);
  const s = Number(v);
  if (s < 15) throw new UsageError('--interval must be at least 15 seconds');
  return s;
}

async function runWatch(args: string[], deps: DriverDeps): Promise<number> {
  const { values, positionals } = parseWith(args, {
    repo: { type: 'string', multiple: true },
    config: { type: 'string' },
    profile: { type: 'string' },
    interval: { type: 'string' },
    foreground: { type: 'boolean' },
  });
  if (positionals.length > 0 && !(positionals.length === 1 && positionals[0] === 'stop')) {
    throw new UsageError(`watch takes no arguments other than stop, got "${positionals.join(' ')}"`);
  }
  if (positionals[0] === 'stop') return stopWatch(deps);
  const intervalS = intervalArg(values.interval);
  const repos = (values.repo ?? [process.cwd()]).map((r) => path.resolve(r));
  const o = { repos, ...configOpts(values), intervalS };
  if (values.foreground) return watchHere(o, deps);
  return startWatch(o, deps);
}

const ttyAsk = (question: string) => askLine(question, { input: process.stdin, output: process.stdout });

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
    ask: d.ask !== undefined ? d.ask : process.stdin.isTTY ? ttyAsk : null,
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
    const found = COMMANDS.find((c) => c.name === command);
    if (found !== undefined) return await found.run(rest, { io, home: deps.home ?? os.homedir(), driver: () => driverDeps(io, deps) });
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
    stdout: pipeWriter(process.stdout),
    stderr: pipeWriter(process.stderr),
  });
}
