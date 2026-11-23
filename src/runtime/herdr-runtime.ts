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
import { HcError } from '../herdr/hc.ts';
import type { Hc, Terminal } from '../herdr/hc.ts';
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
  /** the run's ticket, or its pipeline on a ticketless run (terminal names, {{ticket}}) */
  ticket: string;
  runDir: string;
  worktree: string;
  branch: string;
  base: string;
  mappings: MaterializedMapping[];
  grounds: Record<string, ResolvedGround>;
  space?: string;
  parentTerminal?: string;
  /** the run's pipeline, for task briefs and {{pipeline}}; default the graph's pipeline */
  pipeline?: string;
  /** run inputs, for {{input_<name>}}; default none */
  inputs?: Record<string, string>;
  /** the inputs the pipeline declares: one the run was not given renders as '' in {{input_<name>}} */
  declaredInputs?: readonly string[];
  keepTerminals?: boolean;
  /** node terminals survive perc exiting (hc --outlive-parent), so a paused run can adopt them; default true */
  outliveParent?: boolean;
  pollMs?: number;
  /** an agent idle at turn 0 is still starting: not attention until this long after waiting starts; default 120 */
  bootGraceS?: number;
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
 * terminal it started. The hash covers run id and step id. Only the step part is shortened.
 */
export function terminalName(runId: string, ticket: string, stepId: string, attempt: number): string {
  const issue = /#(\d+)$/.exec(ticket) ?? /\/issues\/(\d+)$/.exec(ticket);
  const ticketPart = issue ? `t${issue[1]!.slice(-8)}` : slug(ticket).slice(0, 8).replace(/-+$/, '') || 't';
  // the step id is hashed too: ids with the same slug (plan.0 / plan-0, Lint / lint) get distinct names
  const h4 = createHash('sha256').update(`${runId}\0${stepId}`).digest('hex').slice(0, 4);
  const tail = `_a${attempt}_${h4}`;
  const room = NAME_MAX - ticketPart.length - 1 - tail.length;
  const stepPart = slug(stepId).slice(0, Math.max(room, 0)).replace(/-+$/, '');
  return `${ticketPart}_${stepPart}${tail}`;
}

function ioFor(runDir: string, stepId: string, attempt: number): StepIo {
  const dir = stepDir(runDir, stepId, attempt);
  return { stepDir: dir, outputsDir: path.join(dir, 'outputs') };
}

const escalate = (reason: string): NodeOutcome => ({ status: 'escalate', outputs: {}, reason });

/** Why terminal `n`, labelled `percolator.run=<owner>`, is left alone; undefined when it belongs to `runId`. */
export function foreignTerminal(t: Terminal, n: string, runId: string): string | undefined {
  const owner = t.labels['percolator.run'];
  if (owner === runId) return undefined;
  return `terminal ${n} is not part of run ${runId} (percolator.run=${owner ?? 'none'}); remove it with hc rm or rename it, then resume`;
}

/** A terminal not labelled with this run is never re-attached to, adopted, killed or removed. */
function notOurs(t: Terminal, n: string, runId: string): NodeOutcome | undefined {
  const reason = foreignTerminal(t, n, runId);
  return reason === undefined ? undefined : escalate(reason);
}

/**
 * Kill and remove every terminal of run `runId` (finished ones too), except those whose
 * `percolator.role` is `exceptRole`. Returns the names removed.
 */
export async function sweepTerminals(hc: Hc, runId: string, o: { exceptRole?: string } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const t of await hc.list({ labels: { 'percolator.run': runId }, all: true })) {
    const n = t.name ?? t.address;
    // hc ls returns no labels: get them, and re-check ownership rather than trusting the server-side filter
    const labels = Object.keys(t.labels).length > 0 ? t.labels : (await hc.get(n))?.labels;
    if (labels?.['percolator.run'] !== runId) continue;
    if (o.exceptRole !== undefined && labels['percolator.role'] === o.exceptRole) continue;
    await hc.kill(n);
    await hc.rm(n);
    removed.push(n);
  }
  return removed;
}

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
    const kind = effectiveKind(step.def);
    const isTerminal = kind === 'agent' || kind === 'script';

    // an escalation (timeout_s, invalid done.json) left an earlier attempt's terminal running: resume adopts
    // the newest one (each escalation bumps the attempt, so the newest live one may be several attempts back).
    // One that already wrote a valid done.json is adopted too (collected, then cleaned up, so no second agent
    // starts), unless terminals are kept: a kept terminal is expected to stay live after its step.
    if (isTerminal) {
      for (let prev = attempt - 1; prev >= 1; prev--) {
        const prevIo = ioFor(o.runDir, step.id, prev);
        const prevName = terminalName(o.runId, o.ticket, step.id, prev);
        const t = await o.hc.get(prevName);
        if (t?.state !== 'live') continue;
        if (o.keepTerminals && (await readDone(path.join(prevIo.stepDir, 'done.json'))).kind === 'ok') continue;
        const foreign = notOurs(t, prevName, o.runId);
        if (foreign) return foreign;
        return this.#await(step, kind === 'agent', prevIo, prevName);
      }
    }

    const io = ioFor(o.runDir, step.id, attempt);
    await fs.mkdir(io.outputsDir, { recursive: true });
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
        pipeline: o.pipeline ?? ctx.graph.pipeline,
        inputs: o.inputs ?? {},
        ...(o.declaredInputs !== undefined ? { declaredInputs: o.declaredInputs } : {}),
      });
      await writeFileAtomic(taskFile, text);
    }

    return adapter.argv({
      ...(def.model !== undefined ? { model: def.model } : {}),
      ...(def.effort !== undefined ? { effort: def.effort } : {}),
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

    // live: re-attach; finished with a done.json, or a finished script (its exit code): collect it in #await
    const existing = await hc.get(n);
    if (existing === undefined) {
      // the step completed but perc stopped before the engine saved it: collect, don't relaunch
      const done = await readDone(doneFile);
      if (done.kind === 'ok') return this.#collect(done, io);
    } else {
      const foreign = notOurs(existing, n, o.runId);
      if (foreign) return foreign;
    }
    let launch = existing === undefined;
    if (isAgent && existing?.state === 'finished' && (await readDone(doneFile)).kind === 'absent') {
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
      const launched = await hc.run({ name: n, cwd: o.worktree, argv, labels, outliveParent: o.outliveParent ?? true });
      if (launched.firstMessageSent === false) {
        const transcript = await this.#saveTranscript(n, io);
        await hc.kill(n);
        await hc.rm(n);
        return escalate(`task was not delivered to ${n}; check its screen in ${transcript}, then resume`);
      }
    }

    return this.#await(step, isAgent, io, n);
  }

  /** Wait for terminal `n` to complete the step, then collect its outcome and clean up. */
  async #await(step: Step, isAgent: boolean, io: StepIo, n: string): Promise<NodeOutcome> {
    const o = this.#o;
    const hc = o.hc;
    const doneFile = path.join(io.stepDir, 'done.json');
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
        if (isAgent) return escalate(await this.#exitedReason(step, io, n, t?.exitCode ?? null));
        result = t?.exitCode === 0 ? { status: 'pass' } : { status: 'fail', reason: `exit code ${t?.exitCode ?? null}` };
        break;
      }
      if (t.status === 'working' || t.status === null) {
        const waitS = o.waitTimeoutS ?? 60;
        const leftS = timeoutS === undefined ? waitS : Math.ceil((timeoutS * 1000 - (this.#now() - started)) / 1000);
        try {
          const w = await hc.wait(n, { timeoutS: Math.max(1, Math.min(waitS, leftS)) });
          // plain programs report no status, so wait can return at once: don't spin
          if (w.status === null) await this.#sleep(o.pollMs ?? 2000);
        } catch (err) {
          // blocked, finished, timeout…: hc exits non-zero; the next get re-classifies the terminal
          if (!(err instanceof HcError)) throw err;
          await this.#sleep(o.pollMs ?? 2000);
        }
      } else {
        if (done.kind === 'invalid') return escalate(`${doneFile} is invalid: ${done.error}`);
        const kind = t.status === 'done' ? 'idle' : t.status;
        const key = `${kind}:${t.turn}`;
        // an agent that is still starting up looks idle at turn 0: not attention during the boot grace
        const booting = kind === 'idle' && t.turn === 0 && this.#now() - started < (o.bootGraceS ?? 120) * 1000;
        if (!booting && !seen.has(key)) {
          seen.add(key);
          o.onAttention?.({ stepId: step.id, terminal: n, kind });
        }
        await this.#sleep(o.pollMs ?? 2000);
      }
      if (timeoutS !== undefined && this.#now() - started >= timeoutS * 1000) {
        return escalate(`${step.id} timed out after ${timeoutS}s`);
      }
    }

    const outcome = await this.#collect(result, io);
    await this.#saveTranscript(n, io);
    if (!o.keepTerminals) {
      await hc.kill(n);
      await hc.rm(n);
    }
    return outcome;
  }

  async #collect(result: { status: NodeOutcome['status']; reason?: string }, io: StepIo): Promise<NodeOutcome> {
    const collected = await collectOutputs(io.outputsDir, this.#o.runDir);
    if ('error' in collected) return escalate(collected.error);
    const outcome: NodeOutcome = { status: result.status, outputs: collected.outputs };
    if (result.status !== 'pass' && result.reason !== undefined) outcome.reason = result.reason;
    return outcome;
  }

  /** One line saying why an agent stopped without completing: exit code, its last screen lines, the saved screen. */
  async #exitedReason(step: Step, io: StepIo, n: string, exitCode: number | null): Promise<string> {
    const transcript = await this.#saveTranscript(n, io);
    const text = await fs.readFile(transcript, 'utf8').catch(() => '');
    const last = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .slice(-3)
      .join(' | ');
    const code = exitCode === null ? '' : ` with code ${exitCode}`;
    const lines = last === '' ? '' : `; last lines: "${last}"`;
    return `${step.id}: agent exited${code} without a valid done.json${lines}; full screen in ${transcript}`;
  }

  /** Best-effort: a terminal that has vanished leaves no transcript. */
  async #saveTranscript(n: string, io: StepIo): Promise<string> {
    const file = path.join(io.stepDir, 'transcript.txt');
    let text: string;
    try {
      text = await this.#o.hc.read(n, this.#o.transcriptLines ?? 10000);
    } catch (err) {
      if (!(err instanceof HcError)) throw err;
      return file;
    }
    await writeFileAtomic(file, text);
    return file;
  }
}
