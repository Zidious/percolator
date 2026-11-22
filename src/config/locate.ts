import { isMap, isPair, isScalar, isSeq } from 'yaml';
import type { Document, LineCounter } from 'yaml';

/** Dot-joined key path (`profiles.work.bindings.plan`, `use.0`) → 1-based line of that key. */
export type LineIndex = Record<string, number>;
/** Where a layer's keys live: its file, that file's line index, and the key path the layer sits under. */
export type Locator = { file: string; lines: LineIndex; prefix?: string };
export type Where = { file: string; line?: number; path?: string };
export type Problem = Where & { message: string };

/**
 * Lines of every map key and sequence item in `doc`. A pair indexes at its key's line, an item at
 * its first line. Aliases are not followed and non-scalar keys are skipped, so anchors and merge
 * keys cannot loop or crash the walk.
 */
export function indexLines(doc: Document, lineCounter: LineCounter): LineIndex {
  const out: LineIndex = {};
  const lineAt = (node: unknown): number | undefined => {
    const range = (node as { range?: number[] | null } | null)?.range;
    return range ? lineCounter.linePos(range[0]!).line : undefined;
  };
  const walk = (node: unknown, prefix: string): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair) || !isScalar(pair.key)) continue;
        const key = String(pair.key.value);
        const p = prefix ? `${prefix}.${key}` : key;
        const line = lineAt(pair.key);
        if (line !== undefined) out[p] = line;
        walk(pair.value, p);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const p = prefix ? `${prefix}.${i}` : String(i);
        const line = lineAt(item);
        if (line !== undefined) out[p] = line;
        walk(item, p);
      });
    }
  };
  walk(doc.contents, '');
  return out;
}

/** Line of `path`, or of its nearest indexed ancestor; undefined for the root. */
export function lineOf(lines: LineIndex, path: string): number | undefined {
  const parts = path === '' ? [] : path.split('.');
  for (let n = parts.length; n > 0; n--) {
    const line = lines[parts.slice(0, n).join('.')];
    if (line !== undefined) return line;
  }
  return undefined;
}

/** The file, line and displayed key path of `path` in a layer; without a locator, `fallbackFile` and no line. */
export function locate(loc: Locator | undefined, fallbackFile: string, path?: string): Where {
  const full = [loc?.prefix, path].filter((s) => s !== undefined && s !== '').join('.');
  const w: Where = { file: loc?.file ?? fallbackFile };
  const line = loc ? lineOf(loc.lines, full) : undefined;
  if (line !== undefined) w.line = line;
  if (full !== '') w.path = full;
  return w;
}

/** `file:line`, or `file` when there is no line. */
export function place(w: Where): string {
  return w.line === undefined ? w.file : `${w.file}:${w.line}`;
}

export function formatIssue(message: string, file: string, line?: number, path?: string): string {
  return `${place(line === undefined ? { file } : { file, line })}: ${path ? `${path}: ` : ''}${message}`;
}
