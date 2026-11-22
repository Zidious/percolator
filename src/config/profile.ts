import fs from 'node:fs';
import path from 'node:path';
import { expandHome, foldCase, toPosix } from '../util/paths.ts';
import { ConfigError } from './load.ts';
import { locate } from './locate.ts';
import type { LineIndex } from './locate.ts';
import type { Profile, UserConfig } from './schema.ts';

/** `host/owner/repo`, lower-cased, without scheme, user, `.git` or trailing slash. */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^@/]*@/, '');
  // scp-like `host:owner/repo`
  if (hasScheme) s = s.replace(/^([^/:]+):\d+(?=\/)/, '$1');
  else s = s.replace(/^([^/:]+):/, '$1/');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.toLowerCase();
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// `base/**` also matches `base` itself (like picomatch / gitignore).
function globMatch(subject: string, pattern: string): boolean {
  if (path.posix.matchesGlob(subject, pattern)) return true;
  return pattern.endsWith('/**') && path.posix.matchesGlob(subject, pattern.slice(0, -3));
}

/** The pattern with its static prefix (leading segments without glob characters) realpathed, when it exists. */
function realpathPrefix(pattern: string): string | undefined {
  const segs = pattern.split('/');
  let n = 0;
  while (n < segs.length && !/[*?[{]/.test(segs[n]!)) n++;
  if (n === 0) return undefined;
  let prefix = segs.slice(0, n).join('/');
  if (/^[A-Za-z]:$/.test(prefix)) prefix += '/';
  try {
    const real = toPosix(fs.realpathSync.native(prefix)).replace(/\/+$/, '');
    return [real, ...segs.slice(n)].join('/');
  } catch {
    return undefined;
  }
}

export function selectProfile(
  config: UserConfig,
  ctx: {
    remoteUrl?: string;
    cwd: string;
    override?: string;
    home?: string;
    configFile?: string;
    /** the config file's line index, so errors give the `profiles:` line */
    lines?: LineIndex;
    realCwd?: string;
    platform?: NodeJS.Platform;
  },
): { name: string; profile: Profile } {
  const file = ctx.configFile ?? 'config';
  const names = Object.keys(config.profiles);
  const fail = (message: string): ConfigError => {
    const w = locate(ctx.lines ? { file, lines: ctx.lines } : undefined, file, 'profiles');
    return new ConfigError(message, w.file, w.line, w.path);
  };

  if (ctx.override !== undefined) {
    const profile = config.profiles[ctx.override];
    if (!profile) {
      throw fail(`unknown profile "${ctx.override}" (profiles: ${names.join(', ')}); pass one of those to --profile`);
    }
    return { name: ctx.override, profile };
  }

  const remote = ctx.remoteUrl ? normalizeRemote(ctx.remoteUrl) : undefined;
  const fold = (s: string): string => foldCase(s, ctx.platform);
  const subjects = [ctx.cwd, ...(ctx.realCwd !== undefined ? [ctx.realCwd] : [])].map((c) => fold(toPosix(path.resolve(c))));

  for (const [name, profile] of Object.entries(config.profiles)) {
    const m = profile.match;
    if (!m) continue;
    const remoteHit = remote !== undefined && list(m.remote).some((p) => globMatch(remote, p.toLowerCase()));
    const pathHit = list(m.path).some((p) => {
      const written = toPosix(expandHome(p, ctx.home));
      const patterns = [written, realpathPrefix(written)].filter((x): x is string => x !== undefined).map(fold);
      return patterns.some((pat) => subjects.some((s) => globMatch(s, pat)));
    });
    if (remoteHit || pathHit) return { name, profile };
  }

  throw fail(
    `no profile matches this repository (profiles: ${names.join(', ')}); add a match (remote or path) to one of them, or pass --profile`,
  );
}
