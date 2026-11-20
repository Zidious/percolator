import fs from 'node:fs/promises';
import path from 'node:path';
import type { Git } from '../../src/grounds/git.ts';

const ORIGIN = '.fake-origin';

/**
 * Records every call and serves fixed refs; clone creates the target dir with an origin marker
 * file inside, so the origin url follows the dir through renames.
 */
export class FakeGit implements Git {
  calls: string[] = [];
  refs = new Map<string, string>();
  /** origin url per dir that has no marker file (e.g. a repo cwd) */
  urls = new Map<string, string>();
  /** commits the mirror lacks until the next fetch */
  missing = new Set<string>();
  checkoutError: Error | undefined;
  cloneError: Error | undefined;
  /** runs after a clone has created its dir (e.g. to simulate a concurrent run) */
  onClone: ((url: string, dir: string) => Promise<void>) | undefined;

  setRef(ref: string, commit: string): void {
    this.refs.set(ref, commit);
  }

  /** Pre-existing mirror dir cloned from `url`, without recording a call. */
  async seedMirror(dir: string, url: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ORIGIN), url);
  }

  /** Origin url of `dir`, without recording a call. */
  async originOf(dir: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(dir, ORIGIN), 'utf8');
    } catch {
      return this.urls.get(dir);
    }
  }

  async clone(url: string, dir: string, opts?: { mirror?: boolean }): Promise<void> {
    this.calls.push(`clone ${opts?.mirror ? '--mirror ' : ''}${url} ${dir}`);
    if (this.cloneError) throw this.cloneError;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ORIGIN), url);
    await this.onClone?.(url, dir);
  }

  async fetch(dir: string): Promise<void> {
    this.calls.push(`fetch ${dir}`);
    this.missing.clear();
  }

  async resolveRef(dir: string, ref: string): Promise<string> {
    this.calls.push(`resolveRef ${dir} ${ref}`);
    const c = this.refs.get(ref);
    if (!c) throw new Error(`unknown ref ${ref}`);
    return c;
  }

  async checkout(dir: string, commit: string): Promise<void> {
    this.calls.push(`checkout ${dir} ${commit}`);
    if (this.checkoutError) throw this.checkoutError;
    if (this.missing.has(commit)) throw new Error(`unknown commit ${commit}`);
  }

  async remoteUrl(cwd: string): Promise<string | undefined> {
    this.calls.push(`remoteUrl ${cwd}`);
    return this.originOf(cwd);
  }
}
