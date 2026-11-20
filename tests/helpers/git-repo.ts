import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const G = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'advice.detachedHead=false'];

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', [...G, ...args], { cwd })).stdout.trim();
}

/** A repo with one commit on `main`, and a bare `origin` with `origin/HEAD` set. */
export async function makeRepo(): Promise<{ root: string; origin: string; cleanup(): Promise<void> }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-')));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  await fs.mkdir(root);
  await git(base, 'init', '--quiet', '--bare', '-b', 'main', origin);
  await git(root, 'init', '--quiet', '-b', 'main');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'init');
  await git(root, 'remote', 'add', 'origin', origin);
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');
  await git(root, 'remote', 'set-head', 'origin', 'main');
  return { root, origin, cleanup: () => fs.rm(base, { recursive: true, force: true, maxRetries: 5 }) };
}
