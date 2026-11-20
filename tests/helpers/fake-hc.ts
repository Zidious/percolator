import { HcError } from '../../src/herdr/hc.ts';
import type { AgentStatus, Hc, HcRunOptions, Terminal, WaitResult } from '../../src/herdr/hc.ts';

export type FakeTerminal = {
  address: string;
  name: string;
  argv: string[];
  cwd: string;
  labels: Record<string, string>;
  state: 'live' | 'finished';
  status: AgentStatus | null;
  exitCode: number | null;
  turn: number;
  screen: string;
};

type Behave = (t: FakeTerminal, waitCall: number) => void | Promise<void>;

/** In-memory `Hc`: records every call; `behave` runs on each `wait` and may change the terminal or write files. */
export class FakeHc implements Hc {
  calls: [string, ...unknown[]][] = [];
  terminals = new Map<string, FakeTerminal>();
  /** `firstMessageSent` returned by `run`; undefined leaves it out */
  firstMessageSent: boolean | undefined;
  readonly #behave: Behave | undefined;
  readonly #waits = new Map<string, number>();
  #next = 1;

  constructor(behave?: Behave) {
    this.#behave = behave;
  }

  /** Put a terminal in place without recording a call (a terminal left by an earlier process). */
  add(t: Partial<FakeTerminal> & { name: string }): FakeTerminal {
    const term: FakeTerminal = {
      address: `w1:p${this.#next++}`,
      argv: [],
      cwd: '',
      labels: {},
      state: 'live',
      status: null,
      exitCode: null,
      turn: 0,
      screen: `screen of ${t.name}`,
      ...t,
    };
    this.terminals.set(term.name, term);
    return term;
  }

  /** The task file path in the terminal's message (its last argv element). */
  taskFileOf(t: FakeTerminal): string {
    const m = /^Your task is in (.+)\. Read it and follow it exactly\.$/.exec(t.argv.at(-1) ?? '');
    if (!m) throw new Error(`terminal ${t.name} has no task message`);
    return m[1]!;
  }

  async run(o: HcRunOptions): Promise<{ address: string; firstMessageSent?: boolean }> {
    this.calls.push(['run', structuredClone(o)]);
    if (this.terminals.get(o.name)?.state === 'live') {
      throw new HcError('run', 'name_taken', `name ${o.name} is taken`, 1);
    }
    const t = this.add({ name: o.name, argv: [...o.argv], cwd: o.cwd, labels: { ...o.labels } });
    return this.firstMessageSent === undefined ? { address: t.address } : { address: t.address, firstMessageSent: this.firstMessageSent };
  }

  async get(name: string): Promise<Terminal | undefined> {
    this.calls.push(['get', name]);
    const t = this.terminals.get(name);
    if (!t) return undefined;
    return { address: t.address, name: t.name, state: t.state, status: t.status, exitCode: t.exitCode, turn: t.turn };
  }

  async wait(name: string, o?: { timeoutS?: number }): Promise<WaitResult> {
    this.calls.push(['wait', name, o]);
    const t = this.#must('wait', name);
    const n = (this.#waits.get(name) ?? 0) + 1;
    this.#waits.set(name, n);
    await this.#behave?.(t, n);
    return { reason: 'status', ended: t.state === 'finished', exitCode: t.exitCode, status: t.status };
  }

  async read(name: string, lines: number): Promise<string> {
    this.calls.push(['read', name, lines]);
    return this.#must('read', name).screen;
  }

  async kill(name: string): Promise<void> {
    this.calls.push(['kill', name]);
    const t = this.terminals.get(name);
    if (t) t.state = 'finished';
  }

  async rm(name: string): Promise<void> {
    this.calls.push(['rm', name]);
    this.terminals.delete(name);
  }

  #must(sub: string, name: string): FakeTerminal {
    const t = this.terminals.get(name);
    if (!t) throw new HcError(sub, 'not_found', `no terminal ${name}`, 3);
    return t;
  }
}
