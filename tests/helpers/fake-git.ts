import fs from 'node:fs/promises';
import type { Git } from '../../src/grounds/git.ts';

/** Records every call and serves fixed refs; clone creates the target dir. */
export class FakeGit implements Git {
  calls: string[] = [];
  refs = new Map<string, string>();

  setRef(ref: string, commit: string): void {
    this.refs.set(ref, commit);
  }

  async clone(url: string, dir: string, _opts?: { mirror?: boolean }): Promise<void> {
    this.calls.push(`clone ${url} ${dir}`);
    await fs.mkdir(dir, { recursive: true });
  }

  async fetch(dir: string): Promise<void> {
    this.calls.push(`fetch ${dir}`);
  }

  async resolveRef(dir: string, ref: string): Promise<string> {
    this.calls.push(`resolveRef ${dir} ${ref}`);
    const c = this.refs.get(ref);
    if (!c) throw new Error(`unknown ref ${ref}`);
    return c;
  }

  async checkout(dir: string, commit: string): Promise<void> {
    this.calls.push(`checkout ${dir} ${commit}`);
  }

  async remoteUrl(cwd: string): Promise<string | undefined> {
    this.calls.push(`remoteUrl ${cwd}`);
    return undefined;
  }
}
