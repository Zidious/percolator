#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeJsonSchema } from './config/json-schema.ts';
import { isDirectRun } from './util/entry.ts';
import { validate } from './validate.ts';
import type { ValidateResult } from './validate.ts';

export type Io = { stdout(s: string): void; stderr(s: string): void };

const USAGE = `usage: perc <command> [options]

commands:
  validate [--config <file>] [--profile <name>] [--update]
      load the config, resolve grounds and mappings, and check the graph
      (default config: ~/.percolator/config.yaml)
  schema [--out <file>]
      write the JSON schema for the config (default: schema/percolator.schema.json)

options:
  -h, --help   show this help
`;

class UsageError extends Error {}

function parse<T extends Record<string, { type: 'string' | 'boolean' }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: false });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function describe(r: ValidateResult): string {
  const lines = [`profile: ${r.profile}`];
  for (const [name, version] of Object.entries(r.groundVersions)) lines.push(`ground ${name}@${version}`);
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

async function runValidate(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { config: { type: 'string' }, profile: { type: 'string' }, update: { type: 'boolean' } });
  const configFile = path.resolve(values.config ?? path.join(os.homedir(), '.percolator', 'config.yaml'));
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

/** Runs the CLI and returns the exit code: 0 ok, 1 config error or rule violations (RuleViolationError, printed one per line), 2 usage error. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (command === 'validate') return await runValidate(rest, io);
    if (command === 'schema') return await runSchema(rest, io);
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
