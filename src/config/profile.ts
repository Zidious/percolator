import path from 'node:path';
import { expandHome, toPosix } from '../util/paths.ts';
import { ConfigError } from './load.ts';
import type { Profile, UserConfig } from './schema.ts';

/** `host/owner/repo`, lower-cased, without scheme, user, `.git` or trailing slash. */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^@/]*@/, '');
  // scp-like `host:owner/repo`
  if (!hasScheme) s = s.replace(/^([^/:]+):/, '$1/');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.toLowerCase();
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);

export function selectProfile(
  config: UserConfig,
  ctx: { remoteUrl?: string; cwd: string; override?: string; home?: string; configFile?: string },
): { name: string; profile: Profile } {
  const file = ctx.configFile ?? 'config';
  const names = Object.keys(config.profiles);

  if (ctx.override !== undefined) {
    const profile = config.profiles[ctx.override];
    if (!profile) {
      throw new ConfigError(`unknown profile "${ctx.override}" (profiles: ${names.join(', ')})`, file);
    }
    return { name: ctx.override, profile };
  }

  const remote = ctx.remoteUrl ? normalizeRemote(ctx.remoteUrl) : undefined;
  const cwd = fold(toPosix(path.resolve(ctx.cwd)));

  for (const [name, profile] of Object.entries(config.profiles)) {
    const m = profile.match;
    if (!m) continue;
    const remoteHit = remote !== undefined && list(m.remote).some((p) => path.posix.matchesGlob(remote, p.toLowerCase()));
    const pathHit = list(m.path).some((p) => path.posix.matchesGlob(cwd, fold(toPosix(expandHome(p, ctx.home)))));
    if (remoteHit || pathHit) return { name, profile };
  }

  throw new ConfigError(`no profile matches this repository (profiles: ${names.join(', ')})`, file);
}
