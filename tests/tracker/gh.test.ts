import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliGh, GhError } from '../../src/tracker/gh.ts';
import { ExecRecorder } from '../helpers/exec-recorder.ts';

const R = 'github.com/o/r';

test('issue runs gh issue view and parses the result', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, {
    stdout: JSON.stringify({
      number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: { login: 'me' },
      comments: [{ author: { login: 'bob' }, body: 'hi', createdAt: '2026-01-01T00:00:00Z', url: 'cu' }],
    }),
  });
  const issue = await cliGh({ exec: rec.exec }).issue(R, 5);
  assert.deepEqual(rec.calls[0]!.args, ['issue', 'view', '--repo', R, '--json', 'number,title,body,url,state,author,comments', '--', '5']);
  assert.equal(rec.calls[0]!.file, 'gh');
  assert.deepEqual(issue, {
    number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: 'me',
    comments: [{ id: 0, author: 'bob', body: 'hi', createdAt: '2026-01-01T00:00:00Z', url: 'cu' }],
  });
});

test('every call carries the prompt-free env', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'me\n' });
  assert.equal(await cliGh({ exec: rec.exec }).user(), 'me');
  assert.deepEqual(rec.calls[0]!.args, ['api', 'user', '--jq', '.login']);
  assert.equal(rec.calls[0]!.opts?.env?.['GH_PROMPT_DISABLED'], '1');
  assert.equal(rec.calls[0]!.opts?.env?.['GH_NO_UPDATE_NOTIFIER'], '1');
  assert.equal(rec.calls[0]!.opts?.env?.['NO_COLOR'], '1');
});

test('comment returns the trimmed url', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://x/c/1\n' });
  assert.equal(await cliGh({ exec: rec.exec }).comment(R, 5, 'f.md'), 'https://x/c/1');
  const a = rec.calls[0]!.args;
  assert.deepEqual(a.slice(-4), ['--body-file', 'f.md', '--', '5']);
  assert.deepEqual(a.slice(0, 4), ['issue', 'comment', '--repo', R]);
});

test('findPr returns undefined for none and the first match otherwise', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[]' });
  const gh = cliGh({ exec: rec.exec });
  assert.equal(await gh.findPr(R, 'br'), undefined);
  assert.deepEqual(rec.calls[0]!.args, ['pr', 'list', '--repo', R, '--head', 'br', '--state', 'open', '--json', 'number,url']);
  const rec2 = new ExecRecorder();
  rec2.respond(() => true, { stdout: '[{"number":3,"url":"pu"}]' });
  assert.deepEqual(await cliGh({ exec: rec2.exec }).findPr(R, 'br'), { number: 3, url: 'pu' });
});

test('createPr passes values and returns the url; editPr uses body-file', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://x/pull/9\n' });
  const gh = cliGh({ exec: rec.exec });
  assert.equal(await gh.createPr(R, { base: 'main', head: 'h', title: 'Ti', bodyFile: 'b.md' }), 'https://x/pull/9');
  assert.deepEqual(rec.calls[0]!.args, ['pr', 'create', '--repo', R, '--base', 'main', '--head', 'h', '--title=Ti', '--body-file', 'b.md']);
  await gh.editPr(R, 9, 'b.md');
  assert.deepEqual(rec.calls[1]!.args, ['pr', 'edit', '--repo', R, '--body-file', 'b.md', '--', '9']);
});

test('createPr refuses dash-leading values', async () => {
  const gh = cliGh({ exec: new ExecRecorder().exec });
  const o = { base: 'main', head: 'h', title: 't', bodyFile: 'b' };
  await assert.rejects(gh.createPr(R, { ...o, head: '-x' }), { message: 'gh pr create: head must not start with "-": -x' });
  await assert.rejects(gh.createPr(R, { ...o, base: '-x' }), { message: 'gh pr create: base must not start with "-": -x' });
  await assert.rejects(gh.findPr(R, '-x'), { message: 'gh pr list: head must not start with "-": -x' });
});

test('createPr passes a dash-leading title as one --title= token', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://x/pull/9\n' });
  const gh = cliGh({ exec: rec.exec });
  assert.equal(await gh.createPr(R, { base: 'main', head: 'h', title: '-x fix', bodyFile: 'b.md' }), 'https://x/pull/9');
  assert.deepEqual(rec.calls[0]!.args, ['pr', 'create', '--repo', R, '--base', 'main', '--head', 'h', '--title=-x fix', '--body-file', 'b.md']);
});

test('a non-zero exit throws GhError keeping the stderr text', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 4, stderr: '  To get started with GitHub CLI, please run: gh auth login\n' });
  await assert.rejects(cliGh({ exec: rec.exec }).issue(R, 5), (e: unknown) => {
    assert.ok(e instanceof GhError);
    assert.equal(e.message, 'gh issue view failed: To get started with GitHub CLI, please run: gh auth login');
    return true;
  });
});

test('invalid JSON from gh is reported', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'nope' });
  await assert.rejects(cliGh({ exec: rec.exec }).issue(R, 5), { message: 'gh issue view returned invalid JSON: nope' });
});

test('issue gives each comment the REST id from its url', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, {
    stdout: JSON.stringify({
      number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: { login: 'me' },
      comments: [
        { author: { login: 'bob' }, body: 'a', createdAt: 't', url: 'https://github.com/o/r/issues/5#issuecomment-123' },
        { author: { login: 'bob' }, body: 'b', createdAt: 't', url: 'cu' },
      ],
    }),
  });
  const issue = await cliGh({ exec: rec.exec }).issue(R, 5);
  assert.deepEqual(issue.comments.map((c) => c.id), [123, 0]);
});

test('editComment PATCHes the comment through gh api and returns updated_at', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '2026-01-01T00:00:09Z\n' });
  assert.equal(await cliGh({ exec: rec.exec }).editComment('github.com/o/r', 42, 'f.md'), '2026-01-01T00:00:09Z');
  assert.deepEqual(rec.calls[0]!.args, [
    'api', '--hostname', 'github.com', '-X', 'PATCH', 'repos/o/r/issues/comments/42', '-F', 'body=@f.md', '--jq', '.updated_at',
  ]);
});

test('editComment on an owner/repo omits --hostname', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '2026-01-01T00:00:09Z\n' });
  await cliGh({ exec: rec.exec }).editComment('o/r', 42, 'f.md');
  assert.deepEqual(rec.calls[0]!.args, [
    'api', '-X', 'PATCH', 'repos/o/r/issues/comments/42', '-F', 'body=@f.md', '--jq', '.updated_at',
  ]);
});

test('editComment refuses a dash-leading repo', async () => {
  await assert.rejects(cliGh({ exec: new ExecRecorder().exec }).editComment('-x/o/r', 1, 'f.md'),
    { message: 'gh api comment edit: repo must not start with "-": -x/o/r' });
});

test('editComment with no updated_at in the reply fails', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '\n' });
  await assert.rejects(cliGh({ exec: rec.exec }).editComment('o/r', 42, 'f.md'),
    { message: 'gh api comment edit returned no updated_at for comment 42' });
});
