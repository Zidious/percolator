import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ADAPTERS } from '../adapters/index.ts';
import { effectiveKind } from '../config/schema.ts';
import type { NodeOutcome, RunContext, Runtime } from '../engine/runtime.ts';
import type { Step } from '../graph/build.ts';
import { mappingsFor, resolveInGround } from '../grounds/mappings.ts';
import type { ResolvedGround } from '../grounds/resolve.ts';
import type { Hc } from '../herdr/hc.ts';
import { exists, writeFileAtomic } from '../util/fs.ts';
import { buildSkillPlugins, findSkill, stepDir } from '../workspace/run-dir.ts';
import type { MaterializedMapping } from '../workspace/run-dir.ts';
import { collectOutputs, readDone } from './outcome.ts';
import { buildTask } from './task.ts';

export type Attention = { stepId: string; terminal: string; kind: 'blocked' | 'error' | 'idle' };
export type StepIo = { stepDir: string; outputsDir: string };
export type StepHandler = (step: Step, ctx: RunContext, io: StepIo) => Promise<NodeOutcome>;

export type HerdrRuntimeOptions = {
  hc: Hc;
  runId: string;
  ticket: string;
  runDir: string;
  worktree: string;
  branch: string;
  base: string;
  mappings: MaterializedMapping[];
  grounds: Record<string, ResolvedGround>;
  space?: string;
  parentTerminal?: string;
  keepTerminals?: boolean;
  pollMs?: number;
  waitTimeoutS?: number;
  transcriptLines?: number;
  builtins?: Record<string, StepHandler>;
  gate?: StepHandler;
  onAttention?: (a: Attention) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const NAME_MAX = 32;

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * `<ticket>_<step>_a<attempt>_<hash4>`, at most 32 chars: deterministic, so a resumed run finds the
 * terminal it started. Only the step part is shortened.
 */
export function terminalName(runId: string, ticket: string, stepId: string, attempt: number): string {
  const issue = /#(\d+)$/.exec(ticket) ?? /\/issues\/(\d+)$/.exec(ticket);
  const ticketPart = issue ? `t${issue[1]}` : slug(ticket).slice(0, 8) || 't';
  const tail = `_a${attempt}_${createHash('sha256').update(runId).digest('hex').slice(0, 4)}`;
  const room = NAME_MAX - ticketPart.length - 1 - tail.length;
  const stepPart = slug(stepId).slice(0, Math.max(room, 0)).replace(/-+$/, '');
  return `${ticketPart}_${stepPart}${tail}`;
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

export class HerdrRuntime implements Runtime {
  readonly #o: HerdrRuntimeOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(o: HerdrRuntimeOptions) {
    this.#o = o;
    this.#sleep = o.sleep ?? ((ms) => delay(ms));
    this.#now = o.now ?? Date.now;
  }

  async executeStep(step: Step, ctx: RunContext): Promise<NodeOutcome> {
    const o = this.#o;
    const attempt = (ctx.state.executed[step.id] ?? 0) + 1;
    const dir = stepDir(o.runDir, step.id, attempt);
    const io: StepIo = { stepDir: dir, outputsDir: path.join(dir, 'outputs') };
    await fs.mkdir(io.outputsDir, { recursive: true });

    const kind = effectiveKind(step.def);
    if (kind === 'builtin') {
      const handler = o.builtins?.[step.def.builtin!];
      return handler ? handler(step, ctx, io) : escalate(`no builtin "${step.def.builtin}" is installed`);
    }
    if (kind === 'gate') return o.gate ? o.gate(step, ctx, io) : escalate(`gate ${step.id} needs approval`);

    let argv: string[];
    try {
      argv = kind === 'agent' ? await this.#prepareAgent(step, ctx, io) : this.#scriptArgv(step, io);
    } catch (err) {
      return escalate((err as Error).message);
    }
    return this.#runTerminal(step, kind === 'agent', argv, io, terminalName(o.runId, o.ticket, step.id, attempt));
  }

  async #prepareAgent(step: Step, ctx: RunContext, io: StepIo): Promise<string[]> {
    const o = this.#o;
    const def = step.def;
    const adapter = ADAPTERS[def.agent as keyof typeof ADAPTERS];
    if (!adapter) throw new Error(`unknown agent "${def.agent}"`);
    const mappings = mappingsFor(step, o.mappings);
    const taskFile = path.join(io.stepDir, 'task.md');

    if (!(await exists(taskFile))) {
      const refs = [...(def.skill !== undefined ? [def.skill] : []), ...(def.skills ?? [])];
      let skills: { native: string[] } | { files: string[] };
      if (adapter.nativeSkills) {
        skills = { native: refs };
      } else {
        const files: string[] = [];
        for (const ref of refs) {
          const file = await findSkill(ref, mappings);
          if (file === undefined) throw new Error(`${step.id}: skill "${ref}" not found in the skills or plugins mapped to it`);
          files.push(file);
        }
        skills = { files };
      }
      const text = buildTask({
        step,
        ctx,
        runId: o.runId,
        ticket: o.ticket,
        worktree: o.worktree,
        branch: o.branch,
        base: o.base,
        runDir: o.runDir,
        outputsDir: io.outputsDir,
        doneFile: path.join(io.stepDir, 'done.json'),
        ...(await this.#prompt(step)),
        mappings,
        skills,
        ...(o.parentTerminal !== undefined ? { parentTerminal: o.parentTerminal } : {}),
      });
      await writeFileAtomic(taskFile, text);
    }

    return adapter.argv({
      ...(def.model !== undefined ? { model: def.model } : {}),
      pluginDirs: adapter.plugins ? await buildSkillPlugins(io.stepDir, mappings, o.grounds) : [],
      addDirs: [o.runDir],
      ...(def.command !== undefined ? { command: def.command } : {}),
      message: `Your task is in ${taskFile}. Read it and follow it exactly.`,
    });
  }

  async #prompt(step: Step): Promise<{ prompt?: string }> {
    const p = step.def.prompt;
    if (p === undefined) return {};
    if (typeof p === 'string') return { prompt: p };
    const ground = this.#o.grounds[p.from];
    if (!ground) throw new Error(`ground "${p.from}": unknown ground`);
    const r = await resolveInGround(ground, p.file, 'file');
    if ('problem' in r) throw new Error(r.problem);
    return { prompt: await fs.readFile(r.absPath, 'utf8') };
  }

  #scriptArgv(step: Step, io: StepIo): string[] {
    const o = this.#o;
    return step.def.command!.map((a) =>
      a.replaceAll('{run_dir}', o.runDir).replaceAll('{outputs_dir}', io.outputsDir).replaceAll('{worktree}', o.worktree),
    );
  }

  async #runTerminal(step: Step, isAgent: boolean, argv: string[], io: StepIo, n: string): Promise<NodeOutcome> {
    const o = this.#o;
    const hc = o.hc;
    const doneFile = path.join(io.stepDir, 'done.json');

    // live: re-attach; finished with a done.json: collect it in the loop below
    const existing = await hc.get(n);
    let launch = existing === undefined;
    if (existing?.state === 'finished' && (await readDone(doneFile)).kind === 'absent') {
      await hc.rm(n);
      launch = true;
    }
    if (launch) {
      const labels: Record<string, string> = {
        'percolator.run': o.runId,
        'percolator.step': step.id,
        'percolator.worktree': o.worktree,
        ...(o.space !== undefined ? { 'herdr.space': o.space } : {}),
      };
      const launched = await hc.run({ name: n, cwd: o.worktree, argv, labels });
      if (launched.firstMessageSent === false) {
        const transcript = await this.#saveTranscript(n, io);
        await hc.kill(n);
        await hc.rm(n);
        return escalate(`task was not delivered to ${n}; check its screen in ${transcript}, then resume`);
      }
    }

    const started = this.#now();
    const seen = new Set<string>();
    const timeoutS = step.def.timeout_s;
    let result: { status: NodeOutcome['status']; reason?: string };
    for (;;) {
      const t = await hc.get(n);
      const done = await readDone(doneFile);
      if (done.kind === 'ok') {
        result = done;
        break;
      }
      if (!t || t.state === 'finished') {
        if (isAgent) return escalate(`${step.id}: agent exited without a valid done.json`);
        result = t?.exitCode === 0 ? { status: 'pass' } : { status: 'fail', reason: `exit code ${t?.exitCode ?? null}` };
        break;
      }
      if (t.status === 'working' || t.status === null) {
        await hc.wait(n, { timeoutS: o.waitTimeoutS ?? 60 });
      } else {
        if (done.kind === 'invalid') return escalate(`${doneFile} is invalid: ${done.error}`);
        const kind = t.status === 'done' ? 'idle' : t.status;
        const key = `${kind}:${t.turn}`;
        if (!seen.has(key)) {
          seen.add(key);
          o.onAttention?.({ stepId: step.id, terminal: n, kind });
        }
        await this.#sleep(o.pollMs ?? 2000);
      }
      if (timeoutS !== undefined && this.#now() - started >= timeoutS * 1000) {
        return escalate(`${step.id} timed out after ${timeoutS}s`);
      }
    }

    const collected = await collectOutputs(io.outputsDir, o.runDir);
    let outcome: NodeOutcome;
    if ('error' in collected) {
      outcome = escalate(collected.error);
    } else {
      outcome = { status: result.status, outputs: collected.outputs };
      if (result.status !== 'pass' && result.reason !== undefined) outcome.reason = result.reason;
    }
    await this.#saveTranscript(n, io);
    if (!o.keepTerminals) {
      await hc.kill(n);
      await hc.rm(n);
    }
    return outcome;
  }

  async #saveTranscript(n: string, io: StepIo): Promise<string> {
    const file = path.join(io.stepDir, 'transcript.txt');
    await writeFileAtomic(file, await this.#o.hc.read(n, this.#o.transcriptLines ?? 10000));
    return file;
  }
}
