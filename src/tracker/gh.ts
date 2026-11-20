import { nodeExec } from '../util/exec.ts';
import type { Exec } from '../util/exec.ts';

export type IssueComment = { author: string; body: string; createdAt: string; url: string };
export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string;
  comments: IssueComment[];
};

export interface Gh {
  issue(repo: string, n: number): Promise<Issue>;
  /** Returns the new comment's URL. */
  comment(repo: string, n: number, bodyFile: string): Promise<string>;
  user(): Promise<string>;
  findPr(repo: string, head: string): Promise<{ number: number; url: string } | undefined>;
  createPr(repo: string, o: { base: string; head: string; title: string; bodyFile: string }): Promise<string>;
  editPr(repo: string, n: number, bodyFile: string): Promise<void>;
}

export class GhError extends Error {
  constructor(sub: string, message: string) {
    super(`gh ${sub} failed: ${message}`);
    this.name = 'GhError';
  }
}

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };

function noDash(sub: string, what: string, v: string): void {
  if (v.startsWith('-')) throw new Error(`gh ${sub}: ${what} must not start with "-": ${v}`);
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

  return {
    async issue(repo, n) {
      const out = await call('issue view', [
        'issue', 'view', '--repo', repo, '--json', 'number,title,body,url,state,author,comments', '--', String(n),
      ]);
      const j = parseJson('issue view', out) as Record<string, unknown>;
      const comments = Array.isArray(j['comments']) ? (j['comments'] as Record<string, unknown>[]) : [];
      return {
        number: Number(j['number']),
        title: String(j['title'] ?? ''),
        body: String(j['body'] ?? ''),
        url: String(j['url'] ?? ''),
        state: String(j['state'] ?? ''),
        author: login(j['author']),
        comments: comments.map((c) => ({
          author: login(c['author']),
          body: String(c['body'] ?? ''),
          createdAt: String(c['createdAt'] ?? ''),
          url: String(c['url'] ?? ''),
        })),
      };
    },
    async comment(repo, n, bodyFile) {
      const out = await call('issue comment', ['issue', 'comment', '--repo', repo, '--body-file', bodyFile, '--', String(n)]);
      return out.trim();
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
      noDash('pr create', 'title', p.title);
      const out = await call('pr create', [
        'pr', 'create', '--repo', repo, '--base', p.base, '--head', p.head, '--title', p.title, '--body-file', p.bodyFile,
      ]);
      return out.trim();
    },
    async editPr(repo, n, bodyFile) {
      await call('pr edit', ['pr', 'edit', '--repo', repo, '--body-file', bodyFile, '--', String(n)]);
    },
  };
}
