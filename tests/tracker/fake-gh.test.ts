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
