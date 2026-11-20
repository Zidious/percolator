import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Step } from '../../src/graph/build.ts';
import { GATE_MARKER, githubIntake, readIssueMeta } from '../../src/tracker/intake.ts';
import { FakeGh } from '../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });

async function setup(): Promise<{ runDir: string; io: { stepDir: string; outputsDir: string } }> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-intake-'));
  const stepDir = path.join(runDir, 'steps', 'intake');
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  return { runDir, io: { stepDir, outputsDir } };
}

const step = {} as Step;
const ctx = {} as RunContext;

test('github.intake writes ticket.md, issue.json and passes with the collected output', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 7, { title: 'Fix it', body: 'It is broken.', author: 'alice' });
    gh.addComment(REPO, 7, 'bob', 'Seen it too.');
    gh.addComment(REPO, 7, 'perc-bot', `${GATE_MARKER} v1 -->\nApprove?`);
    const h = githubIntake({ gh, runDir, ticket: { repo: REPO, number: 7 } });
    const out = await h(step, ctx, io);
    assert.equal(out.status, 'pass');
    const rel = path.relative(runDir, path.join(io.outputsDir, 'ticket.md')).split(path.sep).join('/');
    assert.deepEqual(out.outputs, { ticket: rel });
    assert.equal(
      await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8'),
      [
        '# Fix it',
        '',
        `https://${REPO}/issues/7 (${REPO}#7, opened by @alice)`,
        '',
        '## Body',
        '',
        'It is broken.',
        '',
        '## Comments',
        '',
        '### @bob at 2026-01-01T00:00:00.000Z',
        '',
        'Seen it too.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, 'issue.json'), 'utf8')), {
      repo: REPO,
      number: 7,
      title: 'Fix it',
      url: `https://${REPO}/issues/7`,
    });
    assert.deepEqual(await readIssueMeta(runDir), {
      repo: REPO,
      number: 7,
      title: 'Fix it',
      url: `https://${REPO}/issues/7`,
    });
  } finally {
    await rm(runDir);
  }
});

test('github.intake: empty body and no comments use placeholders', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 1, { title: 'T', author: 'a' });
    gh.addComment(REPO, 1, 'bot', `${GATE_MARKER} v1 -->`);
    await githubIntake({ gh, runDir, ticket: { repo: REPO, number: 1 } })(step, ctx, io);
    const md = await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8');
    assert.ok(md.includes('## Body\n\n_No description._\n\n## Comments\n\n_No comments._\n'));
    assert.ok(md.endsWith('_No comments._\n'));
  } finally {
    await rm(runDir);
  }
});

test('github.intake escalates for a closed issue and writes nothing', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 3, { state: 'CLOSED' });
    const out = await githubIntake({ gh, runDir, ticket: { repo: REPO, number: 3 } })(step, ctx, io);
    assert.deepEqual(out, {
      status: 'escalate',
      outputs: {},
      reason: `github.intake: ${REPO}#3 is closed; reopen it or pick another ticket`,
    });
    await assert.rejects(readIssueMeta(runDir), { message: `run ${runDir} has no issue.json (intake has not run)` });
  } finally {
    await rm(runDir);
  }
});

test('github.intake escalates on a gh failure instead of throwing', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.fail('issue', 'network down');
    const out = await githubIntake({ gh, runDir, ticket: { repo: REPO, number: 3 } })(step, ctx, io);
    assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'github.intake: gh issue failed: network down' });
  } finally {
    await rm(runDir);
  }
});

test('readIssueMeta names the run dir when issue.json is absent', async () => {
  const { runDir } = await setup();
  try {
    await assert.rejects(readIssueMeta(runDir), { message: `run ${runDir} has no issue.json (intake has not run)` });
  } finally {
    await rm(runDir);
  }
});
