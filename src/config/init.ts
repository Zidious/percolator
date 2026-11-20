import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, writeFileAtomic } from '../util/fs.ts';

/** The recommended config shipped with the package. */
export const templatePath = (): string => path.resolve(import.meta.dirname, '..', '..', 'templates', 'config.yaml');

/** Writes the recommended config to `file`; refuses to replace an existing file unless `force`. */
export async function initConfig(file: string, opts: { force?: boolean } = {}): Promise<void> {
  if ((await fs.stat(file).catch(() => undefined))?.isDirectory() === true) {
    throw new Error(`${file} is a directory; pass a file path to --config`);
  }
  if (opts.force !== true && (await exists(file))) {
    throw new Error(`${file} already exists; edit it, or rerun with --force to replace it`);
  }
  const template = await fs.readFile(templatePath(), 'utf8');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, template);
}
