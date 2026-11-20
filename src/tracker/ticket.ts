/** `repo` is lower-case `host/owner/repo`, the same form `normalizeRemote` produces. */
export type TicketRef = { repo: string; number: number };

const NUM = /^#?(\d+)$/;
const SHORT = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)\/?(?:[#?].*)?$/i;

export function parseTicket(ref: string, defaultRepo?: string): TicketRef {
  const s = ref.trim();
  const bare = NUM.exec(s);
  if (bare) {
    if (defaultRepo === undefined) {
      throw new Error(`ticket "${ref}" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123`);
    }
    return { repo: defaultRepo.toLowerCase(), number: Number(bare[1]) };
  }
  const short = SHORT.exec(s);
  if (short) {
    return { repo: `${short[1] ?? 'github.com'}/${short[2]}/${short[3]}`.toLowerCase(), number: Number(short[4]) };
  }
  const url = URL_RE.exec(s);
  if (url) {
    if (url[4]!.toLowerCase() === 'pull') throw new Error(`"${ref}" is a pull request, not an issue`);
    return { repo: `${url[1]}/${url[2]}/${url[3]}`.toLowerCase(), number: Number(url[5]) };
  }
  throw new Error(`cannot read ticket "${ref}": use #123, owner/repo#123 or an issue URL`);
}

/** The canonical `state.ticket`; `terminalName` parses `#(\d+)$` from it. */
export function formatTicket(t: TicketRef): string {
  return `${t.repo}#${t.number}`;
}
