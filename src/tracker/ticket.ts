/** `repo` is lower-case `host/owner/repo`, the same form `normalizeRemote` produces. */
export type TicketRef = { repo: string; number: number };

const NUM = /^#?(\d+)$/;
const SHORT = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)\/?(?:[#?].*)?$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

const unreadable = (ref: string): Error =>
  new Error(`cannot read ticket "${ref}": use #123, owner/repo#123 or an issue URL`);

const okName = (s: string): boolean => NAME.test(s) && s !== '.' && s !== '..' && !s.startsWith('-');

/** Owner and repo become path segments (worktree dir), so only plain names pass; the number must be ≥ 1. */
function checked(ref: string, host: string, owner: string, repo: string, n: string): TicketRef {
  const number = Number(n);
  if (!HOST.test(host) || !okName(owner) || !okName(repo) || number < 1) throw unreadable(ref);
  return { repo: `${host}/${owner}/${repo}`.toLowerCase(), number };
}

export function parseTicket(ref: string, defaultRepo?: string): TicketRef {
  const s = ref.trim();
  const bare = NUM.exec(s);
  if (bare) {
    if (defaultRepo === undefined) {
      throw new Error(`ticket "${ref}" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123`);
    }
    const parts = defaultRepo.split('/');
    if (parts.length !== 3) throw unreadable(ref);
    return checked(ref, parts[0]!, parts[1]!, parts[2]!, bare[1]!);
  }
  const short = SHORT.exec(s);
  if (short) return checked(ref, short[1] ?? 'github.com', short[2]!, short[3]!, short[4]!);
  const url = URL_RE.exec(s);
  if (url) {
    if (url[4]!.toLowerCase() === 'pull') throw new Error(`"${ref}" is a pull request, not an issue`);
    return checked(ref, url[1]!, url[2]!, url[3]!, url[5]!);
  }
  throw unreadable(ref);
}

/** The canonical `state.ticket`; `terminalName` parses `#(\d+)$` from it. */
export function formatTicket(t: TicketRef): string {
  return `${t.repo}#${t.number}`;
}
