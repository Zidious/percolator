import type { Document, LineCounter } from 'yaml';
import type { z } from 'zod';
import { readYamlFile } from '../util/fs.ts';
import { GraphFragmentSchema, UserConfigSchema } from './schema.ts';
import type { GraphFragment, UserConfig } from './schema.ts';

function formatIssue(message: string, file: string, line?: number, path?: string): string {
  const where = line === undefined ? file : `${file}:${line}`;
  return `${where}: ${path ? `${path}: ` : ''}${message}`;
}

type FlatIssue = { path: PropertyKey[]; message: string };

// Expand invalid_union issues into the issues of the closest branch (fewest issues),
// so the user sees what is actually wrong instead of "Invalid input".
function flatten(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): FlatIssue[] {
  return issues.flatMap((issue): FlatIssue[] => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const best = issue.errors.reduce((a, b) => (b.length < a.length ? b : a));
      if (best.length > 0) return flatten(best, path);
    }
    return [{ path, message: issue.message }];
  });
}

export class ConfigError extends Error {
  file: string;
  line?: number;
  path?: string;

  constructor(message: string, file: string, line?: number, path?: string, fullMessage?: string) {
    super(fullMessage ?? formatIssue(message, file, line, path));
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
  if (doc.errors.length > 0) {
    const found = doc.errors.map((e) => ({ message: e.message.split('\n')[0], line: e.linePos?.[0].line }));
    throw new ConfigError(
      found[0].message,
      file,
      found[0].line,
      undefined,
      found.map((f) => formatIssue(f.message, file, f.line)).join('\n'),
    );
  }
  const result = schema.safeParse(doc.toJS());
  if (!result.success) {
    const found = flatten(result.error.issues).map((i) => ({
      message: i.message,
      line: lineAt(doc, lineCounter, i.path),
      path: i.path.length > 0 ? i.path.join('.') : undefined,
    }));
    throw new ConfigError(
      found[0].message,
      file,
      found[0].line,
      found[0].path,
      found.map((f) => formatIssue(f.message, file, f.line, f.path)).join('\n'),
    );
  }
  return result.data;
}

export function loadUserConfig(file: string): Promise<UserConfig> {
  return load(file, UserConfigSchema);
}

export function loadFragment(file: string): Promise<GraphFragment> {
  return load(file, GraphFragmentSchema);
}
