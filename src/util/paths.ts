import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string, home?: string): string {
  const h = home ?? os.homedir();
  if (p === '~') return path.resolve(h);
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2).split(/[\\/]+/).filter(Boolean);
    return path.resolve(h, ...rest);
  }
  return path.resolve(p);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
}

export function samePath(a: string, b: string): boolean {
  const x = toPosix(path.resolve(a));
  const y = toPosix(path.resolve(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
