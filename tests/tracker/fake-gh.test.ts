import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh } from '../helpers/fake-gh.ts';

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
