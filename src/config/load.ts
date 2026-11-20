import type { Document, LineCounter } from 'yaml';
import type { z } from 'zod';
import { readYamlFile } from '../util/fs.ts';
import { GraphFragmentSchema, UserConfigSchema } from './schema.ts';
import type { GraphFragment, UserConfig } from './schema.ts';

export class ConfigError extends Error {
  file: string;
  line?: number;
  path?: string;

  constructor(message: string, file: string, line?: number, path?: string) {
    const where = line === undefined ? file : `${file}:${line}`;
    super(`${where}: ${path ? `${path}: ` : ''}${message}`);
    this.name = 'ConfigError';
    this.file = file;
    if (line !== undefined) this.line = line;
    if (path !== undefined) this.path = path;
  }
}

// Line of the node at `path`, falling back to the nearest existing ancestor.
function lineAt(doc: Document, lineCounter: LineCounter, path: PropertyKey[]): number | undefined {
  for (let n = path.length; n >= 0; n--) {
    const node = doc.getIn(path.slice(0, n) as (string | number)[], true) as { range?: number[] | null } | undefined;
    if (node && typeof node === 'object' && node.range) {
      return lineCounter.linePos(node.range[0]).line;
    }
  }
  return undefined;
}

async function load<T extends z.ZodType>(file: string, schema: T): Promise<z.output<T>> {
  const { doc, lineCounter } = await readYamlFile(file);
  const yamlErr = doc.errors[0];
  if (yamlErr) {
    throw new ConfigError(yamlErr.message.split('\n')[0], file, yamlErr.linePos?.[0].line);
  }
  const result = schema.safeParse(doc.toJS());
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : undefined;
    throw new ConfigError(issue.message, file, lineAt(doc, lineCounter, issue.path as PropertyKey[]), path);
  }
  return result.data;
}

export function loadUserConfig(file: string): Promise<UserConfig> {
  return load(file, UserConfigSchema);
}

export function loadFragment(file: string): Promise<GraphFragment> {
  return load(file, GraphFragmentSchema);
}
