import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh } from '../helpers/fake-gh.ts';
import { commentIdOf } from '../../src/tracker/gh.ts';

test('FakeGh comments are authored by the user with increasing createdAt', async () => {
  const gh = new FakeGh({ user: 'bot' });
  gh.addIssue('github.com/o/r', 1);
  const u1 = await gh.comment('github.com/o/r', 1, 'a.md');
  const u2 = await gh.comment('github.com/o/r', 1, 'b.md');
  assert.notEqual(u1, u2);
  const i = await gh.issue('github.com/o/r', 1);
  assert.deepEqual(i.comments.map((c) => c.author), ['bot', 'bot']);
  assert.ok(i.comments[0]!.createdAt < i.comments[1]!.createdAt);
  assert.equal(i.comments[0]!.url, u1);
});

test('FakeGh createPr is found by findPr and fail() throws GhError', async () => {
  const gh = new FakeGh();
  const url = await gh.createPr('github.com/o/r', { base: 'main', head: 'h', title: 't', bodyFile: 'b' });
  assert.deepEqual(await gh.findPr('github.com/o/r', 'h'), { number: 1, url });
  gh.fail('user', 'boom');
  await assert.rejects(gh.user(), { name: 'GhError', message: 'gh user failed: boom' });
});

test('FakeGh editComment replaces the body, records it and returns a later updatedAt', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh({ user: 'bot', readFile: (f) => `body of ${f}` });
  gh.addIssue(R, 1);
  const url = await gh.comment(R, 1, 'a.md');
  const c0 = (await gh.issue(R, 1)).comments[0]!;
  assert.equal(c0.id, commentIdOf(url));
  const at = await gh.editComment(R, c0.id, 'b.md');
  const c1 = (await gh.issue(R, 1)).comments[0]!;
  assert.equal(c1.body, 'body of b.md');
  assert.equal(c1.createdAt, c0.createdAt);
  assert.ok(at > c0.createdAt);
  assert.equal(gh.bodies.at(-1), 'body of b.md');
});

test('FakeGh editComment of an unknown id throws GhError', async () => {
  const gh = new FakeGh();
  gh.addIssue('github.com/o/r', 1);
  await assert.rejects(gh.editComment('github.com/o/r', 99, 'b.md'),
    { name: 'GhError', message: 'gh editComment failed: comment 99 not found' });
});

test('FakeGh issues carry labels, empty unless seeded', async () => {
  const gh = new FakeGh();
  gh.addIssue('github.com/o/r', 1);
  gh.addIssue('github.com/o/r', 2, { labels: ['pipeline:hotfix'] });
  assert.deepEqual((await gh.issue('github.com/o/r', 1)).labels, []);
  assert.deepEqual((await gh.issue('github.com/o/r', 2)).labels, ['pipeline:hotfix']);
});

test('FakeGh myIssues lists the issues its user opened, newest first, up to 50', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh({ user: 'bot', readFile: (f) => `draft ${f}` });
  gh.addIssue(R, 3);
  const url = await gh.createIssue(R, { title: 'New', bodyFile: '1' });
  assert.equal(url, 'https://github.com/o/r/issues/4');
  gh.addIssue(R, 5, { author: 'bot', state: 'CLOSED', body: 'closed one' });
  assert.deepEqual(await gh.myIssues(R), [
    { number: 5, url: 'https://github.com/o/r/issues/5', body: 'closed one' },
    { number: 4, url, body: 'draft 1' },
  ]);
  assert.deepEqual(await gh.myIssues('github.com/o/other'), []);
  for (let n = 6; n < 60; n++) gh.addIssue(R, n, { author: 'bot' });
  const many = await gh.myIssues(R);
  assert.equal(many.length, 50);
  assert.equal(many[0]!.number, 59);
  const i = await gh.issue(R, 4);
  assert.equal(i.title, 'New');
  assert.equal(i.author, 'bot');
});

test('FakeGh findComment finds the marked comment', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh();
  gh.addIssue(R, 1);
  gh.addComment(R, 1, 'alice', 'hello');
  const c = gh.addComment(R, 1, 'bot', 'done <!-- m -->');
  assert.deepEqual(await gh.findComment(R, 1, '<!-- m -->'), c);
  assert.equal(await gh.findComment(R, 1, '<!-- other -->'), undefined);
  assert.deepEqual(gh.calls.at(-1), { method: 'findComment', args: [R, 1, '<!-- other -->'] });
});

test('FakeGh createRelease is found by releaseUrl', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh({ readFile: () => 'notes' });
  assert.equal(await gh.releaseUrl(R, 'v1'), undefined);
  const url = await gh.createRelease(R, { tag: 'v1', target: 'abc', notesFile: 'n.md' });
  assert.equal(url, 'https://github.com/o/r/releases/tag/v1');
  assert.equal(await gh.releaseUrl(R, 'v1'), url);
  assert.deepEqual(gh.releases, [{ repo: R, tag: 'v1', target: 'abc', notes: 'notes', url }]);
});

test('FakeGh postReview is listed by prReviews', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh({ readFile: () => 'looks fine <!-- percolator:review run=r1 -->' });
  assert.deepEqual(await gh.prReviews(R, 4), []);
  const url = await gh.postReview(R, 4, 'r.md');
  assert.equal(url, 'https://github.com/o/r/pull/4#pullrequestreview-1');
  assert.deepEqual(await gh.prReviews(R, 4), [{ body: 'looks fine <!-- percolator:review run=r1 -->', url }]);
  assert.deepEqual(await gh.prReviews(R, 5), []);
});

test('FakeGh advisoryFork returns a fork and refuses a malformed id', async () => {
  const gh = new FakeGh();
  assert.deepEqual(await gh.advisoryFork('github.com/o/r', 'GHSA-2345-6789-cfgh'), {
    fullName: 'o/r-ghsa-2345-6789-cfgh', cloneUrl: 'https://github.com/o/r-ghsa-2345-6789-cfgh.git',
  });
  assert.equal(gh.forks.length, 1);
  await assert.rejects(gh.advisoryFork('github.com/o/r', 'x'), { message: 'advisory "x" is not a GHSA id (GHSA-xxxx-xxxx-xxxx)' });
});

test('FakeGh listIssues lists open issues with the label', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh();
  gh.addIssue(R, 1, { labels: ['perc:triage'] });
  gh.addIssue(R, 2, { labels: ['bug'] });
  gh.addIssue(R, 3, { labels: ['perc:triage'], state: 'CLOSED' });
  gh.addIssue('github.com/o/other', 4, { labels: ['perc:triage'] });
  assert.deepEqual(await gh.listIssues(R, { label: 'perc:triage' }), [{ number: 1, url: 'https://github.com/o/r/issues/1' }]);
  assert.deepEqual(gh.calls.at(-1), { method: 'listIssues', args: [R, { label: 'perc:triage' }] });
});

test('FakeGh listPrs lists the repo PRs with authors', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh({ user: 'bot' });
  const url = await gh.createPr(R, { base: 'main', head: 'h', title: 't', bodyFile: 'b' });
  gh.addPr(R, { head: 'dependabot/npm/x', author: 'app/dependabot' });
  await gh.createPr('github.com/o/other', { base: 'main', head: 'h', title: 't', bodyFile: 'b' });
  assert.deepEqual(await gh.listPrs(R), [
    { number: 1, url, author: 'bot' },
    { number: 2, url: 'https://github.com/o/r/pull/2', author: 'app/dependabot' },
  ]);
});

test('FakeGh failedRuns filters by repo, branch and workflow', async () => {
  const R = 'github.com/o/r';
  const gh = new FakeGh();
  const ci = gh.addFailedRun(R, { branch: 'main', workflowName: 'CI', workflow: 'ci.yml' });
  const lint = gh.addFailedRun(R, { branch: 'main', workflowName: 'Lint' });
  gh.addFailedRun(R, { branch: 'dev', workflowName: 'CI' });
  assert.deepEqual(ci, { databaseId: 1, url: 'https://github.com/o/r/actions/runs/1', workflowName: 'CI' });
  assert.deepEqual(await gh.failedRuns(R, { branch: 'main' }), [ci, lint]);
  assert.deepEqual(await gh.failedRuns(R, { branch: 'main', workflow: 'ci.yml' }), [ci]);
  assert.deepEqual(await gh.failedRuns(R, { branch: 'main', workflow: 'Lint' }), [lint]);
  assert.deepEqual(await gh.failedRuns('github.com/o/other', { branch: 'main' }), []);
});
