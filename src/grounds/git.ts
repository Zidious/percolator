import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface Git {
  /** Clone `url` into `dir`; `mirror` makes a fetchable bare mirror (refs/heads/* kept as-is). */
  clone(url: string, dir: string, opts?: { mirror?: boolean }): Promise<void>;
  fetch(dir: string): Promise<void>;
  /** Resolve `ref` to a full commit sha. */
  resolveRef(dir: string, ref: string): Promise<string>;
  checkout(dir: string, commit: string): Promise<void>;
  /** URL of the `origin` remote, or undefined when absent / not a repo. */
  remoteUrl(cwd: string): Promise<string | undefined>;
  /** Absolute root of the work tree containing `cwd`, or undefined when not in a repo. */
  toplevel(cwd: string): Promise<string | undefined>;
}

/** Replace the userinfo of every url in `message` (`https://user:token@host` → `https://***@host`). */
export function redactUrls(message: string): string {
  return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]+@/gi, '$1***@');
}

/** Environment for git children: never prompt for credentials (fail instead of hanging). */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

// Windows git stops at 260-character paths unless core.longpaths is set; grounds live deep under ~/.percolator.
const PLATFORM_ARGS = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];

export async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [...PLATFORM_ARGS, ...args], { env: gitEnv(), ...(cwd === undefined ? {} : { cwd }) });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(redactUrls(`git ${args.join(' ')} failed: ${stderr}`));
  }
}

// `--` cannot protect rev arguments, so a value that git would read as an option is refused.
function assertNotOption(label: string, value: string): void {
  if (value.startsWith('-')) throw new Error(`git ${label} must not start with "-": ${value}`);
}

export const cliGit: Git = {
  async clone(url, dir, opts) {
    await runGit(['clone', '--quiet', ...(opts?.mirror ? ['--mirror'] : []), '--', url, dir]);
  },
  async fetch(dir) {
    await runGit(['fetch', '--quiet', '--prune', 'origin'], dir);
  },
  async resolveRef(dir, ref) {
    assertNotOption('ref', ref);
    for (const candidate of [`origin/${ref}`, ref]) {
      try {
        return await runGit(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], dir);
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`git: cannot resolve ref "${ref}" in ${dir}`);
  },
  async checkout(dir, commit) {
    assertNotOption('commit', commit);
    await runGit(['checkout', '--quiet', '--detach', commit], dir);
  },
  async remoteUrl(cwd) {
    try {
      return (await runGit(['remote', 'get-url', 'origin'], cwd)) || undefined;
    } catch {
      return undefined;
    }
  },
  async toplevel(cwd) {
    try {
      const top = await runGit(['rev-parse', '--show-toplevel'], cwd);
      return top ? path.resolve(top) : undefined;
    } catch {
      return undefined;
    }
  },
};
