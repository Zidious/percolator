import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { samePath } from './paths.ts';

/** True when `moduleUrl` is the process entry point (`argv1`), also through a symlinked bin (npm/pnpm). */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return samePath(fs.realpathSync(argv1), fs.realpathSync(fileURLToPath(moduleUrl)));
  } catch {
    return false;
  }
}
