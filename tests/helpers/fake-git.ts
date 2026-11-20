import fs from 'node:fs/promises';
import type { Git } from '../../src/grounds/git.ts';

/** Records every call and serves fixed refs; clone creates the target dir. */
export class FakeGit implements Git {
  calls: string[] = [];
  refs = new Map<string, string>();
  /** origin url per cloned dir */
  urls = new Map<string, string>();
  /** commits the mirror lacks until the next fetch */
  missing = new Set<string>();
  checkoutError: Error | undefined;

  setRef(ref: string, commit: string): void {
    this.refs.set(ref, commit);
  }

  /** Pre-existing mirror dir cloned from `url`, without recording a call. */
  async seedMirror(dir: string, url: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    this.urls.set(dir, url);
  }

  async clone(url: string, dir: string, opts?: { mirror?: boolean }): Promise<void> {
    this.calls.push(`clone ${opts?.mirror ? '--mirror ' : ''}${url} ${dir}`);
    await fs.mkdir(dir, { recursive: true });
    this.urls.set(dir, url);
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
    return this.urls.get(cwd);
  }
}
