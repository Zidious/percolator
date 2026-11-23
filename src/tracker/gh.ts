import { nodeExec } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';

export type IssueComment = { id: number; author: string; body: string; createdAt: string; url: string };
export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string;
  comments: IssueComment[];
  labels: string[];
};
export type IssueHit = { number: number; url: string; body: string };
export type PrReview = { body: string; url: string };
export type AdvisoryFork = { fullName: string; cloneUrl: string };
export type IssueRef = { number: number; url: string };
export type PrRef = { number: number; url: string; author: string };
/** `attempt` counts re-runs of the same run (1 for the first). */
export type FailedRun = { databaseId: number; attempt: number; url: string; workflowName: string };

export interface Gh {
  issue(repo: string, n: number): Promise<Issue>;
  /** Returns the new comment's URL. */
  comment(repo: string, n: number, bodyFile: string): Promise<string>;
  /** PATCHes a comment's body from a file; returns the server's `updated_at`. */
  editComment(repo: string, id: number, bodyFile: string): Promise<string>;
  user(): Promise<string>;
  findPr(repo: string, head: string): Promise<{ number: number; url: string } | undefined>;
  createPr(repo: string, o: { base: string; head: string; title: string; bodyFile: string }): Promise<string>;
  editPr(repo: string, n: number, bodyFile: string): Promise<void>;
  /** Returns the new issue's URL. */
  createIssue(repo: string, o: { title: string; bodyFile: string }): Promise<string>;
  /**
   * The latest issues (any state, newest first, up to 50) the gh user opened. A plain list, not a search:
   * GitHub's search index lags behind a just-created issue, and would read `percolator:` as a qualifier.
   */
  myIssues(repo: string): Promise<IssueHit[]>;
  /** The first comment on issue `n` whose body includes `marker`. */
  findComment(repo: string, n: number, marker: string): Promise<IssueComment | undefined>;
  /** The release with that tag (its URL and notes), or undefined when there is none. */
  release(repo: string, tag: string): Promise<{ url: string; body: string } | undefined>;
  /** Returns the new release's URL. */
  createRelease(repo: string, o: { tag: string; target: string; notesFile: string }): Promise<string>;
  prReviews(repo: string, n: number): Promise<PrReview[]>;
  /** Posts an `event=COMMENT` review; returns its URL. */
  postReview(repo: string, n: number, bodyFile: string): Promise<string>;
  /** Creates the temporary private fork of a security advisory. */
  advisoryFork(repo: string, ghsa: string): Promise<AdvisoryFork>;
  /** Open issues carrying `label` (up to 100). */
  listIssues(repo: string, o: { label: string }): Promise<IssueRef[]>;
  /** Open pull requests (up to 100) with their author's login. */
  listPrs(repo: string): Promise<PrRef[]>;
  /** Failed workflow runs on `branch` (up to 20), optionally of one workflow. */
  failedRuns(repo: string, o: { branch: string; workflow?: string }): Promise<FailedRun[]>;
}

export class GhError extends Error {
  constructor(sub: string, message: string) {
    super(`gh ${sub} failed: ${message}`);
    this.name = 'GhError';
  }
}

/** The most issues `listIssues` returns; a full list may have more past it. */
export const ISSUE_LIST_LIMIT = 100;

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** Refuses anything but a GitHub security advisory id. */
export function checkGhsa(ghsa: string): void {
  if (!GHSA.test(ghsa)) throw new Error(`advisory "${ghsa}" is not a GHSA id (GHSA-xxxx-xxxx-xxxx)`);
}

function noDash(sub: string, what: string, v: string): void {
  if (v.startsWith('-')) throw new Error(`gh ${sub}: ${what} must not start with "-": ${v}`);
}

/** REST id from a comment url's `#issuecomment-<n>`, or 0 when it has none. */
export function commentIdOf(url: string): number {
  return Number(/#issuecomment-(\d+)$/.exec(url)?.[1] ?? 0);
}

export function cliGh(o: { exec?: Exec; bin?: string } = {}): Gh {
  const exec = o.exec ?? nodeExec;
  const bin = o.bin ?? 'gh';

  async function call(sub: string, args: string[]): Promise<string> {
    const r = await exec(bin, args, { env: GH_ENV });
    if (r.code !== 0) throw new GhError(sub, r.stderr.trim().slice(0, 500));
    return r.stdout;
  }

  function parseJson(sub: string, stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`gh ${sub} returned invalid JSON: ${stdout.trim().slice(0, 200)}`);
    }
  }

  const login = (a: unknown): string => String((a as { login?: unknown } | null | undefined)?.login ?? '');
  const list = (j: unknown): Record<string, unknown>[] => (Array.isArray(j) ? (j as Record<string, unknown>[]) : []);

  /** `gh api` addressing: `--hostname` when the repo names a host, and the owner/repo slug. */
  function apiRepo(sub: string, repo: string): { host: string[]; slug: string } {
    noDash(sub, 'repo', repo);
    const parts = repo.split('/');
    return { host: parts.length === 3 ? ['--hostname', parts[0]!] : [], slug: parts.slice(-2).join('/') };
  }

  async function issue(repo: string, n: number): Promise<Issue> {
    const out = await call('issue view', [
      'issue', 'view', '--repo', repo, '--json', 'number,title,body,url,state,author,comments,labels', '--', String(n),
    ]);
    const j = parseJson('issue view', out) as Record<string, unknown>;
    return {
      number: Number(j['number']),
      title: String(j['title'] ?? ''),
      body: String(j['body'] ?? ''),
      url: String(j['url'] ?? ''),
      state: String(j['state'] ?? ''),
      author: login(j['author']),
      comments: list(j['comments']).map((c) => ({
        id: commentIdOf(String(c['url'] ?? '')),
        author: login(c['author']),
        body: String(c['body'] ?? ''),
        createdAt: String(c['createdAt'] ?? ''),
        url: String(c['url'] ?? ''),
      })),
      labels: list(j['labels']).map((l) => String(l['name'] ?? '')),
    };
  }

  return {
    issue,
    async comment(repo, n, bodyFile) {
      const out = await call('issue comment', ['issue', 'comment', '--repo', repo, '--body-file', bodyFile, '--', String(n)]);
      return out.trim();
    },
    async editComment(repo, id, bodyFile) {
      const { host, slug } = apiRepo('api comment edit', repo);
      const out = await call('api comment edit', [
        'api', ...host, '-X', 'PATCH', `repos/${slug}/issues/comments/${id}`, '-F', `body=@${bodyFile}`, '--jq', '.updated_at',
      ]);
      const at = out.trim();
      if (!at) throw new Error(`gh api comment edit returned no updated_at for comment ${id}`);
      return at;
    },
    async user() {
      return (await call('api user', ['api', 'user', '--jq', '.login'])).trim();
    },
    async findPr(repo, head) {
      noDash('pr list', 'head', head);
      const out = await call('pr list', ['pr', 'list', '--repo', repo, '--head', head, '--state', 'open', '--json', 'number,url']);
      const j = parseJson('pr list', out);
      const first = Array.isArray(j) ? (j[0] as { number?: unknown; url?: unknown } | undefined) : undefined;
      return first ? { number: Number(first.number), url: String(first.url) } : undefined;
    },
    async createPr(repo, p) {
      noDash('pr create', 'base', p.base);
      noDash('pr create', 'head', p.head);
      const out = await call('pr create', [
        'pr', 'create', '--repo', repo, '--base', p.base, '--head', p.head, `--title=${p.title}`, '--body-file', p.bodyFile,
      ]);
      return out.trim();
    },
    async editPr(repo, n, bodyFile) {
      await call('pr edit', ['pr', 'edit', '--repo', repo, '--body-file', bodyFile, '--', String(n)]);
    },
    async createIssue(repo, p) {
      const out = await call('issue create', ['issue', 'create', '--repo', repo, `--title=${p.title}`, '--body-file', p.bodyFile]);
      return out.trim();
    },
    async myIssues(repo) {
      // 50: enough to hold the issues one exit opens before a crash, the only thing it is read for
      const out = await call('issue list', [
        'issue', 'list', '--repo', repo, '--state', 'all', '--author', '@me', '--json', 'number,url,body', '--limit', '50',
      ]);
      return list(parseJson('issue list', out)).map((i) => ({
        number: Number(i['number']), url: String(i['url'] ?? ''), body: String(i['body'] ?? ''),
      }));
    },
    async findComment(repo, n, marker) {
      return (await issue(repo, n)).comments.find((c) => c.body.includes(marker));
    },
    async release(repo, tag) {
      noDash('release view', 'tag', tag);
      const r = await exec(bin, ['release', 'view', '--repo', repo, '--json', 'url,body', '--', tag], { env: GH_ENV });
      if (r.code !== 0) {
        if (/release not found/i.test(r.stderr)) return undefined;
        throw new GhError('release view', r.stderr.trim().slice(0, 500));
      }
      const j = parseJson('release view', r.stdout) as { url?: unknown; body?: unknown } | null;
      return j?.url ? { url: String(j.url), body: String(j.body ?? '') } : undefined;
    },
    async createRelease(repo, p) {
      noDash('release create', 'tag', p.tag);
      noDash('release create', 'target', p.target);
      const out = await call('release create', [
        'release', 'create', '--repo', repo, '--target', p.target, `--title=${p.tag}`, '--notes-file', p.notesFile, '--', p.tag,
      ]);
      return out.trim();
    },
    async prReviews(repo, n) {
      const { host, slug } = apiRepo('api pr reviews', repo);
      const out = await call('api pr reviews', [
        'api', ...host, '--paginate', `repos/${slug}/pulls/${n}/reviews`, '--jq', '[.[]|{body,url:.html_url}]',
      ]);
      // --paginate runs the jq filter per page: one compact array per line
      const pages = out.split('\n').filter((l) => l.trim() !== '').map((l) => list(parseJson('api pr reviews', l)));
      return pages.flat().map((r) => ({ body: String(r['body'] ?? ''), url: String(r['url'] ?? '') }));
    },
    async postReview(repo, n, bodyFile) {
      const { host, slug } = apiRepo('api pr review', repo);
      const out = await call('api pr review', [
        'api', ...host, '-X', 'POST', `repos/${slug}/pulls/${n}/reviews`, '-f', 'event=COMMENT', '-F', `body=@${bodyFile}`, '--jq', '.html_url',
      ]);
      return out.trim();
    },
    async advisoryFork(repo, ghsa) {
      checkGhsa(ghsa);
      const { host, slug } = apiRepo('api advisory fork', repo);
      const out = await call('api advisory fork', ['api', ...host, '-X', 'POST', `repos/${slug}/security-advisories/${ghsa}/forks`]);
      const j = parseJson('api advisory fork', out) as { full_name?: unknown; clone_url?: unknown } | null;
      if (!j?.full_name || !j.clone_url) throw new Error(`gh api advisory fork returned no full_name or clone_url for ${ghsa}`);
      return { fullName: String(j.full_name), cloneUrl: String(j.clone_url) };
    },
    // the watcher's lists are capped (100 issues, 100 PRs, 20 failed runs) and not paginated: they are
    // polled every interval and gh lists the newest first, so a new one is always seen; an older one past
    // the cap is seen only once enough newer ones are closed (or, for failed runs, superseded)
    async listIssues(repo, p) {
      noDash('issue list', 'label', p.label);
      const out = await call('issue list', [
        'issue', 'list', '--repo', repo, '--label', p.label, '--state', 'open', '--json', 'number,url', '--limit', String(ISSUE_LIST_LIMIT),
      ]);
      return list(parseJson('issue list', out)).map((i) => ({ number: Number(i['number']), url: String(i['url'] ?? '') }));
    },
    async listPrs(repo) {
      const out = await call('pr list', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,url,author', '--limit', '100']);
      return list(parseJson('pr list', out)).map((p) => ({
        number: Number(p['number']), url: String(p['url'] ?? ''), author: login(p['author']),
      }));
    },
    async failedRuns(repo, p) {
      noDash('run list', 'branch', p.branch);
      if (p.workflow !== undefined) noDash('run list', 'workflow', p.workflow);
      const out = await call('run list', [
        'run', 'list', '--repo', repo, '--branch', p.branch, '--status', 'failure', '--json', 'databaseId,attempt,url,workflowName', '--limit', '20',
        ...(p.workflow === undefined ? [] : ['--workflow', p.workflow]),
      ]);
      return list(parseJson('run list', out)).map((r) => ({
        databaseId: Number(r['databaseId']), attempt: Number(r['attempt'] ?? 1), url: String(r['url'] ?? ''), workflowName: String(r['workflowName'] ?? ''),
      }));
    },
  };
}
