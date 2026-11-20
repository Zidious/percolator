import { nodeExec } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';

export interface HerdrApp {
  newSpace(name: string, folder: string): Promise<string>;
}

function errorText(j: Record<string, unknown> | undefined, stderr: string): string {
  const e = j?.['error'];
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return stderr.trim() || 'unknown error';
}

function tryParse(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// `space.close` is deliberately not wrapped: it ends the space's terminals.
export function cliHerdrApp(o: { exec?: Exec; bin?: string } = {}): HerdrApp {
  const exec = o.exec ?? nodeExec;
  const bin = o.bin ?? 'herdr-app';
  return {
    async newSpace(name, folder) {
      // One JSON object argument: no value can be read as a flag.
      const r = await exec(bin, ['do', 'space.new', JSON.stringify({ name, folder })]);
      const j = tryParse(r.stdout) ?? tryParse(r.stderr);
      if (r.code !== 0 || (j && j['error'] !== undefined)) {
        throw new Error(`herdr-app space.new failed: ${errorText(j, r.stderr)}`);
      }
      const space = j?.['space'];
      if (typeof space !== 'string' || space === '') {
        throw new Error(`herdr-app space.new returned no space id: ${r.stdout.trim()}`);
      }
      return space;
    },
  };
}
