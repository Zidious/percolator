import { GhError } from '../../src/tracker/gh.ts';
import type { Gh, Issue, IssueComment } from '../../src/tracker/gh.ts';

export type FakeGhMethod = 'issue' | 'comment' | 'editComment' | 'user' | 'findPr' | 'createPr' | 'editPr';
export type FakePr = { number: number; url: string; repo: string; base: string; head: string; title: string; body: string };

/** In-memory `Gh`: issues with comments, a PR list, recorded `calls`, and `fail(method, message)`. */
export class FakeGh implements Gh {
  calls: { method: FakeGhMethod; args: unknown[] }[] = [];
  issues = new Map<string, Issue>();
  prs: FakePr[] = [];
  /** Login that authors comments made through `comment()` and answers `user()`. */
  userLogin: string;
  /** Contents of each body file at the time of the call, in order (set by `readFile`). */
  bodies: string[] = [];
  private failures = new Map<FakeGhMethod, string>();
  private tick = 0;
  private nextPr = 1;
  private nextComment = 1;

  constructor(
    o: { user?: string; now?: () => Date; readFile?: (file: string) => string } = {},
  ) {
    this.userLogin = o.user ?? 'perc-bot';
    this.now = o.now ?? (() => new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)));
    this.readFile = o.readFile ?? (() => '');
  }

  private now: () => Date;
  private readFile: (file: string) => string;

  private key(repo: string, n: number): string {
    return `${repo}#${n}`;
  }

  /** Seed an issue; missing fields get defaults. */
  addIssue(repo: string, n: number, i: Partial<Issue> = {}): Issue {
    const issue: Issue = {
      number: n,
      title: `Issue ${n}`,
      body: '',
      url: `https://${repo}/issues/${n}`,
      state: 'OPEN',
      author: 'someone',
      comments: [],
      ...i,
    };
    this.issues.set(this.key(repo, n), issue);
    return issue;
  }

  /** Seed a comment by another author. */
  addComment(repo: string, n: number, author: string, body: string): IssueComment {
    return this.push(repo, n, author, body);
  }

  fail(method: FakeGhMethod, message: string): void {
    this.failures.set(method, message);
  }

  private enter(method: FakeGhMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method);
    if (f !== undefined) throw new GhError(method, f);
  }

  private push(repo: string, n: number, author: string, body: string): IssueComment {
    const issue = this.issues.get(this.key(repo, n));
    if (!issue) throw new GhError('issue comment', `issue ${repo}#${n} not found`);
    const id = this.nextComment++;
    const c: IssueComment = {
      id,
      author,
      body,
      createdAt: this.now().toISOString(),
      url: `${issue.url}#issuecomment-${id}`,
    };
    issue.comments.push(c);
    return c;
  }

  async issue(repo: string, n: number): Promise<Issue> {
    this.enter('issue', [repo, n]);
    const i = this.issues.get(this.key(repo, n));
    if (!i) throw new GhError('issue view', `Could not resolve to an issue with the number of ${n}.`);
    return structuredClone(i);
  }

  async comment(repo: string, n: number, bodyFile: string): Promise<string> {
    this.enter('comment', [repo, n, bodyFile]);
    const body = this.readFile(bodyFile);
    this.bodies.push(body);
    return this.push(repo, n, this.userLogin, body).url;
  }

  async editComment(repo: string, id: number, bodyFile: string): Promise<string> {
    this.enter('editComment', [repo, id, bodyFile]);
    const c = [...this.issues.entries()]
      .filter(([k]) => k.startsWith(`${repo}#`))
      .flatMap(([, i]) => i.comments)
      .find((x) => x.id === id);
    if (!c) throw new GhError('editComment', `comment ${id} not found`);
    c.body = this.readFile(bodyFile);
    this.bodies.push(c.body);
    return this.now().toISOString();
  }

  async user(): Promise<string> {
    this.enter('user', []);
    return this.userLogin;
  }

  async findPr(repo: string, head: string): Promise<{ number: number; url: string } | undefined> {
    this.enter('findPr', [repo, head]);
    const p = this.prs.find((x) => x.repo === repo && x.head === head);
    return p ? { number: p.number, url: p.url } : undefined;
  }

  async createPr(repo: string, o: { base: string; head: string; title: string; bodyFile: string }): Promise<string> {
    this.enter('createPr', [repo, o]);
    const number = this.nextPr++;
    const url = `https://${repo}/pull/${number}`;
    const body = this.readFile(o.bodyFile);
    this.bodies.push(body);
    this.prs.push({ number, url, repo, base: o.base, head: o.head, title: o.title, body });
    return url;
  }

  async editPr(repo: string, n: number, bodyFile: string): Promise<void> {
    this.enter('editPr', [repo, n, bodyFile]);
    const p = this.prs.find((x) => x.repo === repo && x.number === n);
    if (!p) throw new GhError('pr edit', `no pull request found for ${repo}#${n}`);
    p.body = this.readFile(bodyFile);
    this.bodies.push(p.body);
  }
}
