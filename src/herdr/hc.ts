import { nodeExec } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';

export type AgentStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type Terminal = {
  address: string;
  name?: string;
  state: 'live' | 'finished';
  status: AgentStatus | null;
  exitCode: number | null;
  turn: number;
  /** `{}` when hc omits it (`ls` does not return labels; `get` does) */
  labels: Record<string, string>;
};
export type HcRunOptions = {
  name: string;
  cwd: string;
  argv: string[];
  labels?: Record<string, string>;
  outliveParent?: boolean;
};
export type WaitResult = { reason: string; ended: boolean; exitCode: number | null; status: AgentStatus | null };

export interface Hc {
  run(o: HcRunOptions): Promise<{ address: string; firstMessageSent?: boolean }>;
  get(t: string): Promise<Terminal | undefined>;
  list(o?: { labels?: Record<string, string>; all?: boolean }): Promise<Terminal[]>;
  wait(t: string, o?: { timeoutS?: number }): Promise<WaitResult>;
  read(t: string, lines: number): Promise<string>;
  kill(t: string): Promise<void>;
  rm(t: string): Promise<void>;
}

export class HcError extends Error {
  kind: string;
  exitCode: number;
  hint?: string;
  constructor(sub: string, kind: string, message: string, exitCode: number, hint?: string) {
    super(`hc ${sub} failed: ${message} (${kind})`);
    this.name = 'HcError';
    this.kind = kind;
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
  }
}

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

function toError(sub: string, code: number, stderr: string): HcError {
  try {
    const e = (JSON.parse(stderr) as { error?: { kind?: string; message?: string; hint?: string } }).error;
    if (e && typeof e.message === 'string') return new HcError(sub, e.kind ?? 'unknown', e.message, code, e.hint);
  } catch {
    // not JSON: fall through to the raw text
  }
  return new HcError(sub, 'unknown', stderr.trim(), code);
}

const STATUSES: readonly string[] = ['idle', 'working', 'done', 'blocked', 'error'] satisfies AgentStatus[];

/** `hc ls` reports status as a string, `hc get` as `{ app, kind, msg, state }`; anything else is null */
function toStatus(v: unknown): AgentStatus | null {
  const s = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)['state'] : v;
  return typeof s === 'string' && STATUSES.includes(s) ? (s as AgentStatus) : null;
}

function toTerminal(j: Record<string, unknown>): Terminal {
  const labels: Record<string, string> = {};
  const raw = j['labels'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) labels[k] = String(v);
  }
  return {
    address: String(j['address']),
    ...(typeof j['name'] === 'string' ? { name: j['name'] } : {}),
    state: j['state'] as Terminal['state'],
    status: toStatus(j['status']),
    exitCode: (j['exit_code'] ?? null) as number | null,
    turn: Number(j['turn'] ?? 0),
    labels,
  };
}

function parseJson(sub: string, stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`hc ${sub} returned invalid JSON: ${stdout.trim().slice(0, 200)}`);
  }
}

export function cliHc(o: { exec?: Exec; bin?: string } = {}): Hc {
  const exec = o.exec ?? nodeExec;
  const bin = o.bin ?? 'hc';

  async function call(sub: string, args: string[]): Promise<Record<string, unknown>> {
    const r = await exec(bin, args);
    if (r.code !== 0) throw toError(sub, r.code, r.stderr);
    return parseJson(sub, r.stdout);
  }

  async function ignoring(sub: string, args: string[], kinds: string[]): Promise<void> {
    try {
      await call(sub, args);
    } catch (err) {
      if (err instanceof HcError && kinds.includes(err.kind)) return;
      throw err;
    }
  }

  return {
    async run(opts) {
      if (!NAME_RE.test(opts.name)) throw new Error(`invalid hc terminal name "${opts.name}"`);
      if (opts.argv.length === 0) throw new Error('hc run: argv must not be empty');
      if (opts.argv[0]!.startsWith('-')) throw new Error(`hc run: program must not start with "-": ${opts.argv[0]}`);
      const labels = Object.entries(opts.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      const j = await call('run', [
        'run', '--bg', '--json', '--name', opts.name, '--cwd', opts.cwd,
        ...labels,
        ...(opts.outliveParent ? ['--outlive-parent'] : []),
        '--', ...opts.argv,
      ]);
      const first = j['first_message'] as { sent?: boolean } | undefined;
      return {
        address: String(j['address']),
        ...(first && typeof first.sent === 'boolean' ? { firstMessageSent: first.sent } : {}),
      };
    },
    async get(t) {
      let j: Record<string, unknown>;
      try {
        j = await call('get', ['get', '--json', '--', t]);
      } catch (err) {
        if (err instanceof HcError && err.kind === 'not_found') return undefined;
        throw err;
      }
      return toTerminal(j);
    },
    async list(opts) {
      const labels = Object.entries(opts?.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      const j = await call('ls', ['ls', '--json', ...(opts?.all ? ['--all'] : []), ...labels]);
      const ts = Array.isArray(j['terminals']) ? (j['terminals'] as Record<string, unknown>[]) : [];
      return ts.map(toTerminal);
    },
    async wait(t, opts) {
      const j = await call('wait', [
        'wait', '--json', ...(opts?.timeoutS ? ['--timeout', String(opts.timeoutS)] : []), '--', t,
      ]);
      return {
        reason: String(j['reason']),
        ended: Boolean(j['ended']),
        exitCode: (j['exit_code'] ?? null) as number | null,
        status: toStatus(j['status']),
      };
    },
    async read(t, lines) {
      const j = await call('read', ['read', '--json', '--lines', String(lines), '--', t]);
      return String(j['text'] ?? '');
    },
    kill: (t) => ignoring('kill', ['kill', '--json', '--', t], ['not_found', 'finished']),
    rm: (t) => ignoring('rm', ['rm', '--json', '--', t], ['not_found', 'finished']),
  };
}
