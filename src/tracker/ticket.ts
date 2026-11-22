/** `repo` is lower-case `host/owner/repo`, the same form `normalizeRemote` produces. */
export type TicketRef = { repo: string; number: number };

const NUM = /^#?(\d+)$/;
const SHORT = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)\/?(?:[#?].*)?$/i;
const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

type Kind = { noun: string; url: string; path: 'issues' | 'pull'; other: string };
const ISSUE: Kind = { noun: 'ticket', url: 'an issue URL', path: 'issues', other: 'is a pull request, not an issue' };
const PULL: Kind = { noun: 'pull request', url: 'a pull request URL', path: 'pull', other: 'is an issue, not a pull request' };

const unreadable = (k: Kind, ref: string): Error =>
  new Error(`cannot read ${k.noun} "${ref}": use #123, owner/repo#123 or ${k.url}`);

const okName = (s: string): boolean => NAME.test(s) && s !== '.' && s !== '..' && !s.startsWith('-');

/** Owner and repo become path segments (worktree dir), so only plain names pass; the number must be ≥ 1. */
function checked(k: Kind, ref: string, host: string, owner: string, repo: string, n: string): TicketRef {
  const number = Number(n);
  if (!HOST.test(host) || !okName(owner) || !okName(repo) || number < 1) throw unreadable(k, ref);
  return { repo: `${host}/${owner}/${repo}`.toLowerCase(), number };
}

function parseRef(k: Kind, ref: string, defaultRepo?: string): TicketRef {
  const s = ref.trim();
  const bare = NUM.exec(s);
  if (bare) {
    if (defaultRepo === undefined) {
      throw new Error(`${k.noun} "${ref}" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123`);
    }
    const parts = defaultRepo.split('/');
    if (parts.length !== 3) throw unreadable(k, ref);
    return checked(k, ref, parts[0]!, parts[1]!, parts[2]!, bare[1]!);
  }
  const short = SHORT.exec(s);
  if (short) return checked(k, ref, short[1] ?? 'github.com', short[2]!, short[3]!, short[4]!);
  const url = URL_RE.exec(s);
  if (url) {
    if (url[4]!.toLowerCase() !== k.path) throw new Error(`"${ref}" ${k.other}`);
    return checked(k, ref, url[1]!, url[2]!, url[3]!, url[5]!);
  }
  throw unreadable(k, ref);
}

export function parseTicket(ref: string, defaultRepo?: string): TicketRef {
  return parseRef(ISSUE, ref, defaultRepo);
}

/** `parseTicket` for pull requests: `/pull/<n>` URLs, and issue URLs refused. */
export function parsePr(ref: string, defaultRepo?: string): TicketRef {
  return parseRef(PULL, ref, defaultRepo);
}

/** The canonical `state.ticket`; `terminalName` parses `#(\d+)$` from it. */
export function formatTicket(t: TicketRef): string {
  return `${t.repo}#${t.number}`;
}
