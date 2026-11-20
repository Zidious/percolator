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

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, cwd === undefined ? {} : { cwd });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

// `--` cannot protect rev arguments, so a value that git would read as an option is refused.
function assertNotOption(label: string, value: string): void {
  if (value.startsWith('-')) throw new Error(`git ${label} must not start with "-": ${value}`);
}

export const cliGit: Git = {
  async clone(url, dir, opts) {
    await git(['clone', '--quiet', ...(opts?.mirror ? ['--mirror'] : []), '--', url, dir]);
  },
  async fetch(dir) {
    await git(['fetch', '--quiet', '--prune', 'origin'], dir);
  },
  async resolveRef(dir, ref) {
    assertNotOption('ref', ref);
    for (const candidate of [`origin/${ref}`, ref]) {
      try {
        return await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], dir);
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`git: cannot resolve ref "${ref}" in ${dir}`);
  },
  async checkout(dir, commit) {
    assertNotOption('commit', commit);
    await git(['checkout', '--quiet', '--detach', commit], dir);
  },
  async remoteUrl(cwd) {
    try {
      return (await git(['remote', 'get-url', 'origin'], cwd)) || undefined;
    } catch {
      return undefined;
    }
  },
  async toplevel(cwd) {
    try {
      const top = await git(['rev-parse', '--show-toplevel'], cwd);
      return top ? path.resolve(top) : undefined;
    } catch {
      return undefined;
    }
  },
};
