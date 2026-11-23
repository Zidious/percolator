import { normalizeRemote } from '../config/profile.ts';
import { nodeExec } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';

/** The host an ssh host name or alias connects to; undefined when that cannot be told. */
export type SshHostname = (host: string) => Promise<string | undefined>;

/** Reads `ssh -G <host>` (prints the resolved config, connects nowhere) for its `hostname` line. */
export function sshHostname(exec: Exec = nodeExec): SshHostname {
  return async (host) => {
    const r = await exec('ssh', ['-G', '--', host]);
    if (r.code !== 0) return undefined;
    return /^hostname\s+(\S+)\s*$/im.exec(r.stdout)?.[1];
  };
}

/** `ssh://`, `git+ssh://` or scp-like `[user@]host:path` (a host of one letter is a Windows drive). */
const isSsh = (url: string): boolean => {
  const s = url.trim();
  if (/^(git\+)?ssh:\/\//i.test(s)) return true;
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^(?:[^@/:]+@)?[^@/:]{2,}:/.test(s);
};

/**
 * The lower-case `host/owner/repo` gh knows a remote as. An ssh remote may name a host alias from the
 * ssh config (`git@gh-work:o/r`), which gh resolves to its real host too; when ssh cannot tell, the host
 * stays as written. A host starting with "-" is never passed to ssh.
 */
export async function ghRepo(url: string, resolve: SshHostname): Promise<string> {
  const repo = normalizeRemote(url);
  if (!isSsh(url)) return repo;
  const [host, ...rest] = repo.split('/');
  if (host === undefined || host === '' || host.startsWith('-')) return repo;
  let real: string | undefined;
  try {
    real = await resolve(host);
  } catch {
    real = undefined;
  }
  return real === undefined || real === '' ? repo : [real.toLowerCase(), ...rest].join('/');
}
