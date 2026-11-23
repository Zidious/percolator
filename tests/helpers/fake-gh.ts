import { checkGhsa, GhError } from '../../src/tracker/gh.ts';
import type {
  AdvisoryFork, FailedRun, Gh, Issue, IssueComment, IssueHit, IssueRef, PrRef, PrReview,
} from '../../src/tracker/gh.ts';

export type FakeGhMethod =
  | 'issue' | 'comment' | 'editComment' | 'user' | 'findPr' | 'createPr' | 'editPr'
  | 'createIssue' | 'myIssues' | 'findComment' | 'release' | 'createRelease' | 'prReviews' | 'postReview' | 'advisoryFork'
  | 'listIssues' | 'listPrs' | 'failedRuns';
export type FakePr = {
  number: number; url: string; repo: string; base: string; head: string; title: string; body: string;
  /** Defaults to the fake's user when unset. */
  author?: string;
};
export type FakeRun = FailedRun & { repo: string; branch: string; workflow?: string };
export type FakeRelease = { repo: string; tag: string; target: string; notes: string; url: string };
export type FakeReview = { repo: string; number: number; body: string; url: string };

/** In-memory `Gh`: issues with comments, a PR list, recorded `calls`, and `fail(method, message)`. */
export class FakeGh implements Gh {
  calls: { method: FakeGhMethod; args: unknown[] }[] = [];
  issues = new Map<string, Issue>();
  prs: FakePr[] = [];
  releases: FakeRelease[] = [];
  reviews: FakeReview[] = [];
  forks: ({ repo: string; ghsa: string } & AdvisoryFork)[] = [];
  runs: FakeRun[] = [];
  private nextRun = 1;
  /** Login that authors comments made through `comment()` and answers `user()`. */
  userLogin: string;
  /** Contents of each body file at the time of the call, in order (set by `readFile`). */
  bodies: string[] = [];
  private failures = new Map<FakeGhMethod, string>();
  private tick = 0;
  private nextPr = 1;
  private nextComment = 1;
  private nextReview = 1;

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
      labels: [],
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

  private inRepo(repo: string): Issue[] {
    return [...this.issues.entries()].filter(([k]) => k.startsWith(`${repo}#`)).map(([, i]) => i);
  }

  async createIssue(repo: string, o: { title: string; bodyFile: string }): Promise<string> {
    this.enter('createIssue', [repo, o]);
    const taken = [...this.inRepo(repo).map((i) => i.number), ...this.prs.filter((p) => p.repo === repo).map((p) => p.number)];
    const body = this.readFile(o.bodyFile);
    this.bodies.push(body);
    return this.addIssue(repo, Math.max(0, ...taken) + 1, { title: o.title, body, author: this.userLogin }).url;
  }

  async myIssues(repo: string): Promise<IssueHit[]> {
    this.enter('myIssues', [repo]);
    return this.inRepo(repo)
      .filter((i) => i.author === this.userLogin)
      .sort((a, b) => b.number - a.number)
      .slice(0, 50)
      .map((i) => ({ number: i.number, url: i.url, body: i.body }));
  }

  async findComment(repo: string, n: number, marker: string): Promise<IssueComment | undefined> {
    this.enter('findComment', [repo, n, marker]);
    const i = this.issues.get(this.key(repo, n));
    if (!i) throw new GhError('issue view', `Could not resolve to an issue with the number of ${n}.`);
    const c = i.comments.find((x) => x.body.includes(marker));
    return c ? structuredClone(c) : undefined;
  }

  async release(repo: string, tag: string): Promise<{ url: string; body: string } | undefined> {
    this.enter('release', [repo, tag]);
    const r = this.releases.find((x) => x.repo === repo && x.tag === tag);
    return r ? { url: r.url, body: r.notes } : undefined;
  }

  async createRelease(repo: string, o: { tag: string; target: string; notesFile: string }): Promise<string> {
    this.enter('createRelease', [repo, o]);
    if (this.releases.some((r) => r.repo === repo && r.tag === o.tag)) {
      throw new GhError('release create', `a release with tag ${o.tag} already exists`);
    }
    const notes = this.readFile(o.notesFile);
    this.bodies.push(notes);
    const url = `https://${repo}/releases/tag/${o.tag}`;
    this.releases.push({ repo, tag: o.tag, target: o.target, notes, url });
    return url;
  }

  async prReviews(repo: string, n: number): Promise<PrReview[]> {
    this.enter('prReviews', [repo, n]);
    return this.reviews.filter((r) => r.repo === repo && r.number === n).map((r) => ({ body: r.body, url: r.url }));
  }

  async postReview(repo: string, n: number, bodyFile: string): Promise<string> {
    this.enter('postReview', [repo, n, bodyFile]);
    const body = this.readFile(bodyFile);
    this.bodies.push(body);
    const url = `https://${repo}/pull/${n}#pullrequestreview-${this.nextReview++}`;
    this.reviews.push({ repo, number: n, body, url });
    return url;
  }

  async advisoryFork(repo: string, ghsa: string): Promise<AdvisoryFork> {
    this.enter('advisoryFork', [repo, ghsa]);
    checkGhsa(ghsa);
    const parts = repo.split('/');
    const host = parts.length === 3 ? parts[0]! : 'github.com';
    const fullName = `${parts.slice(-2).join('/')}-${ghsa.toLowerCase()}`;
    const fork = { fullName, cloneUrl: `https://${host}/${fullName}.git` };
    this.forks.push({ repo, ghsa, ...fork });
    return fork;
  }

  /** Seed an open PR by another author; missing fields get defaults. */
  addPr(repo: string, p: Partial<FakePr> = {}): FakePr {
    const number = p.number ?? this.nextPr++;
    const pr: FakePr = {
      number, url: `https://${repo}/pull/${number}`, repo, base: 'main', head: `branch-${number}`, title: `PR ${number}`, body: '', ...p,
    };
    this.prs.push(pr);
    return pr;
  }

  /** Seed a failed workflow run; `workflow` is the file name `--workflow` may also match. */
  addFailedRun(repo: string, r: { branch: string; workflowName: string; workflow?: string }): FailedRun {
    const databaseId = this.nextRun++;
    const run: FakeRun = { databaseId, attempt: 1, url: `https://${repo}/actions/runs/${databaseId}`, workflowName: r.workflowName, repo, branch: r.branch };
    if (r.workflow !== undefined) run.workflow = r.workflow;
    this.runs.push(run);
    return { databaseId, attempt: 1, url: run.url, workflowName: run.workflowName };
  }

  /** Re-run a seeded failed run, which fails again: same id, next attempt. */
  rerun(databaseId: number): void {
    const run = this.runs.find((r) => r.databaseId === databaseId);
    if (run === undefined) throw new Error(`FakeGh: no run ${databaseId}`);
    run.attempt++;
  }

  async listIssues(repo: string, o: { label: string }): Promise<IssueRef[]> {
    this.enter('listIssues', [repo, o]);
    return this.inRepo(repo)
      .filter((i) => i.state === 'OPEN' && i.labels.includes(o.label))
      .map((i) => ({ number: i.number, url: i.url }));
  }

  async listPrs(repo: string): Promise<PrRef[]> {
    this.enter('listPrs', [repo]);
    return this.prs.filter((p) => p.repo === repo).map((p) => ({ number: p.number, url: p.url, author: p.author ?? this.userLogin }));
  }

  async failedRuns(repo: string, o: { branch: string; workflow?: string }): Promise<FailedRun[]> {
    this.enter('failedRuns', [repo, o]);
    return this.runs
      .filter((r) => r.repo === repo && r.branch === o.branch)
      .filter((r) => o.workflow === undefined || r.workflow === o.workflow || r.workflowName === o.workflow)
      .map((r) => ({ databaseId: r.databaseId, attempt: r.attempt, url: r.url, workflowName: r.workflowName }));
  }
}
