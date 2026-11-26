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
  assert.deepEqual(rec.calls[0]!.args, ['issue', 'view', '--repo', R, '--json', 'number,title,body,url,state,author,comments,labels', '--', '5']);
  assert.equal(rec.calls[0]!.file, 'gh');
  assert.deepEqual(issue, {
    number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: 'me', labels: [],
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

test('deleteComment sends DELETE to the comment\'s REST path', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '' });
  const gh = cliGh({ exec: rec.exec });
  assert.equal(await gh.deleteComment('o/r', 7), true);
  assert.equal(await gh.deleteComment('ghe.x/o/r', 7), true);
  assert.deepEqual(rec.calls.map((c) => c.args), [
    ['api', '-X', 'DELETE', 'repos/o/r/issues/comments/7'],
    ['api', '--hostname', 'ghe.x', '-X', 'DELETE', 'repos/o/r/issues/comments/7'],
  ]);
});

test('deleteComment of a comment already gone returns false', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' });
  assert.equal(await cliGh({ exec: rec.exec }).deleteComment('o/r', 7), false);
});

test('deleteComment fails on any other error', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 1, stderr: 'HTTP 403: Resource not accessible\n' });
  await assert.rejects(cliGh({ exec: rec.exec }).deleteComment('o/r', 7),
    { name: 'GhError', message: 'gh api comment delete failed: HTTP 403: Resource not accessible' });
});

test('deleteComment refuses a dash-leading repo', async () => {
  await assert.rejects(cliGh({ exec: new ExecRecorder().exec }).deleteComment('-x/r', 7),
    { message: 'gh api comment delete: repo must not start with "-": -x/r' });
});

test('issue view reads labels', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, {
    stdout: JSON.stringify({
      number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: { login: 'me' }, comments: [],
      labels: [{ name: 'pipeline:hotfix', color: 'fff' }, { name: 'bug' }],
    }),
  });
  const issue = await cliGh({ exec: rec.exec }).issue(R, 5);
  assert.deepEqual(rec.calls[0]!.args, ['issue', 'view', '--repo', R, '--json', 'number,title,body,url,state,author,comments,labels', '--', '5']);
  assert.deepEqual(issue.labels, ['pipeline:hotfix', 'bug']);
});

test('createIssue passes the title as one token and returns the url', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://github.com/o/r/issues/8\n' });
  assert.equal(await cliGh({ exec: rec.exec }).createIssue(R, { title: '-x Fix', bodyFile: 'b.md' }), 'https://github.com/o/r/issues/8');
  assert.deepEqual(rec.calls[0]!.args, ['issue', 'create', '--repo', R, '--title=-x Fix', '--body-file', 'b.md']);
});

test('myIssues lists the user\'s latest issues in any state without a search', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"number":8,"url":"iu","body":"x <!-- percolator:issue run=r n=1 -->"}]' });
  const found = await cliGh({ exec: rec.exec }).myIssues(R);
  assert.deepEqual(rec.calls[0]!.args, [
    'issue', 'list', '--repo', R, '--state', 'all', '--author', '@me', '--json', 'number,url,body', '--limit', '50',
  ]);
  assert.deepEqual(found, [{ number: 8, url: 'iu', body: 'x <!-- percolator:issue run=r n=1 -->' }]);
});

test('findComment returns the first comment holding the marker', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, {
    stdout: JSON.stringify({
      number: 5, title: 'T', body: 'B', url: 'u', state: 'OPEN', author: { login: 'me' }, labels: [],
      comments: [
        { author: { login: 'bob' }, body: 'plain', createdAt: 't', url: 'https://github.com/o/r/issues/5#issuecomment-1' },
        { author: { login: 'bot' }, body: 'x <!-- m -->', createdAt: 't', url: 'https://github.com/o/r/issues/5#issuecomment-2' },
      ],
    }),
  });
  const gh = cliGh({ exec: rec.exec });
  assert.equal((await gh.findComment(R, 5, '<!-- m -->'))?.id, 2);
  assert.deepEqual(rec.calls[0]!.args, ['issue', 'view', '--repo', R, '--json', 'number,title,body,url,state,author,comments,labels', '--', '5']);
  assert.equal(await gh.findComment(R, 5, '<!-- other -->'), undefined);
});

test('release views the release and reads its url and notes', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"url":"https://github.com/o/r/releases/tag/v1","body":"notes"}' });
  assert.deepEqual(await cliGh({ exec: rec.exec }).release(R, 'v1'), { url: 'https://github.com/o/r/releases/tag/v1', body: 'notes' });
  assert.deepEqual(rec.calls[0]!.args, ['release', 'view', '--repo', R, '--json', 'url,body', '--', 'v1']);
});

test('release returns undefined when the release is not found', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 1, stderr: 'release not found\n' });
  assert.equal(await cliGh({ exec: rec.exec }).release(R, 'v1'), undefined);
});

test('release keeps other failures and refuses a dash-leading tag', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 1, stderr: 'HTTP 401: Bad credentials\n' });
  await assert.rejects(cliGh({ exec: rec.exec }).release(R, 'v1'), { message: 'gh release view failed: HTTP 401: Bad credentials' });
  await assert.rejects(cliGh({ exec: rec.exec }).release(R, '-x'), { message: 'gh release view: tag must not start with "-": -x' });
});

test('createRelease targets the commit with the notes file', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://github.com/o/r/releases/tag/v1\n' });
  const gh = cliGh({ exec: rec.exec });
  assert.equal(await gh.createRelease(R, { tag: 'v1', target: 'abc123', notesFile: 'n.md' }), 'https://github.com/o/r/releases/tag/v1');
  assert.deepEqual(rec.calls[0]!.args, ['release', 'create', '--repo', R, '--target', 'abc123', '--title=v1', '--notes-file', 'n.md', '--', 'v1']);
  const o = { tag: 'v1', target: 'abc123', notesFile: 'n.md' };
  await assert.rejects(gh.createRelease(R, { ...o, tag: '-x' }), { message: 'gh release create: tag must not start with "-": -x' });
  await assert.rejects(gh.createRelease(R, { ...o, target: '-x' }), { message: 'gh release create: target must not start with "-": -x' });
});

test('prReviews lists bodies and html urls through gh api', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"body":"b <!-- m -->","url":"ru"}]\n' });
  assert.deepEqual(await cliGh({ exec: rec.exec }).prReviews(R, 4), [{ body: 'b <!-- m -->', url: 'ru' }]);
  assert.deepEqual(rec.calls[0]!.args, [
    'api', '--hostname', 'github.com', '--paginate', 'repos/o/r/pulls/4/reviews', '--jq', '[.[]|{body,url:.html_url}]',
  ]);
});

test('prReviews joins the pages --paginate prints one array each', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"body":"a","url":"u1"}]\n[{"body":"b","url":"u2"}]\n' });
  assert.deepEqual(await cliGh({ exec: rec.exec }).prReviews(R, 4), [{ body: 'a', url: 'u1' }, { body: 'b', url: 'u2' }]);
});

test('postReview posts a COMMENT review and returns its url', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: 'https://github.com/o/r/pull/4#pullrequestreview-1\n' });
  assert.equal(await cliGh({ exec: rec.exec }).postReview('o/r', 4, 'r.md'), 'https://github.com/o/r/pull/4#pullrequestreview-1');
  assert.deepEqual(rec.calls[0]!.args, [
    'api', '-X', 'POST', 'repos/o/r/pulls/4/reviews', '-f', 'event=COMMENT', '-F', 'body=@r.md', '--jq', '.html_url',
  ]);
  await assert.rejects(cliGh({ exec: rec.exec }).postReview('-x/o/r', 4, 'r.md'),
    { message: 'gh api pr review: repo must not start with "-": -x/o/r' });
});

test('advisoryFork creates the private fork and reads its name and clone url', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"full_name":"o/r-ghsa-abcd","clone_url":"https://github.com/o/r-ghsa-abcd.git","id":1}' });
  const fork = await cliGh({ exec: rec.exec }).advisoryFork(R, 'GHSA-2345-6789-cfgh');
  assert.deepEqual(rec.calls[0]!.args, ['api', '--hostname', 'github.com', '-X', 'POST', 'repos/o/r/security-advisories/GHSA-2345-6789-cfgh/forks']);
  assert.deepEqual(fork, { fullName: 'o/r-ghsa-abcd', cloneUrl: 'https://github.com/o/r-ghsa-abcd.git' });
});

test('advisoryFork refuses a malformed GHSA id before calling gh', async () => {
  const rec = new ExecRecorder();
  for (const x of ['x', 'GHSA-1234-5678-abcd', '-GHSA-2345-6789-cfgh']) {
    await assert.rejects(cliGh({ exec: rec.exec }).advisoryFork(R, x), { message: `advisory "${x}" is not a GHSA id (GHSA-xxxx-xxxx-xxxx)` });
  }
  assert.equal(rec.calls.length, 0);
});

test('advisoryFork without full_name or clone_url in the reply fails', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"id":1}' });
  await assert.rejects(cliGh({ exec: rec.exec }).advisoryFork(R, 'GHSA-2345-6789-cfgh'),
    { message: 'gh api advisory fork returned no full_name or clone_url for GHSA-2345-6789-cfgh' });
});

test('listIssues lists open issues with a label', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"number":3,"url":"iu"}]' });
  assert.deepEqual(await cliGh({ exec: rec.exec }).listIssues(R, { label: 'perc:triage' }), [{ number: 3, url: 'iu' }]);
  assert.deepEqual(rec.calls[0]!.args, [
    'issue', 'list', '--repo', R, '--label', 'perc:triage', '--state', 'open', '--json', 'number,url', '--limit', '100',
  ]);
  await assert.rejects(cliGh({ exec: rec.exec }).listIssues(R, { label: '-x' }), { message: 'gh issue list: label must not start with "-": -x' });
});

test('listPrs lists open pull requests with their author login', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"number":4,"url":"pu","author":{"login":"app/dependabot","is_bot":true}}]' });
  assert.deepEqual(await cliGh({ exec: rec.exec }).listPrs(R), [{ number: 4, url: 'pu', author: 'app/dependabot' }]);
  assert.deepEqual(rec.calls[0]!.args, ['pr', 'list', '--repo', R, '--state', 'open', '--json', 'number,url,author', '--limit', '100']);
});

test('failedRuns lists failed workflow runs on a branch', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '[{"databaseId":77,"attempt":2,"url":"ru","workflowName":"CI"},{"databaseId":78,"url":"rv","workflowName":"CI"}]' });
  const gh = cliGh({ exec: rec.exec });
  assert.deepEqual(await gh.failedRuns(R, { branch: 'main' }), [
    { databaseId: 77, attempt: 2, url: 'ru', workflowName: 'CI' },
    { databaseId: 78, attempt: 1, url: 'rv', workflowName: 'CI' },
  ]);
  assert.deepEqual(rec.calls[0]!.args, [
    'run', 'list', '--repo', R, '--branch', 'main', '--status', 'failure', '--json', 'databaseId,attempt,url,workflowName', '--limit', '20',
  ]);
  await gh.failedRuns(R, { branch: 'main', workflow: 'ci.yml' });
  assert.deepEqual(rec.calls[1]!.args.slice(-2), ['--workflow', 'ci.yml']);
  await assert.rejects(gh.failedRuns(R, { branch: '-x' }), { message: 'gh run list: branch must not start with "-": -x' });
  await assert.rejects(gh.failedRuns(R, { branch: 'main', workflow: '-x' }), { message: 'gh run list: workflow must not start with "-": -x' });
});
