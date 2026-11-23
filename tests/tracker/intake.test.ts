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
    const h = githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 7 } });
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
      labels: [],
    });
    assert.deepEqual(await readIssueMeta(runDir), {
      repo: REPO,
      number: 7,
      title: 'Fix it',
      url: `https://${REPO}/issues/7`,
      labels: [],
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
    await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 1 } })(step, ctx, io);
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
    const out = await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 3 } })(step, ctx, io);
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
    const out = await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 3 } })(step, ctx, io);
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

const groomGate = (run: string, text: string) =>
  [
    `<!-- percolator:gate run=${run} step=approve-groom round=1 -->`,
    `**Percolator** needs approval to continue run \`${run}\` (step \`approve-groom\`).`,
    '',
    '### groomed_ticket',
    '',
    text,
    '',
    'Reply `/percolator approve` to continue, or `/percolator reject <what to change>` to send it back.',
    '',
  ].join('\n');

test('github.intake: an unapproved earlier groomed ticket becomes the previous_groom output', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 2, { title: 'T', author: 'a' });
    const g = gh.addComment(REPO, 2, 'perc-bot', groomGate('r1', '# Groomed\n\nold'));
    const out = await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 2 } })(step, ctx, io);
    assert.equal(out.status, 'pass');
    const rel = (f: string) => path.relative(runDir, path.join(io.outputsDir, f)).split(path.sep).join('/');
    assert.deepEqual(out.outputs, { previous_groom: rel('previous_groom.md'), ticket: rel('ticket.md') });
    assert.equal(
      await fs.readFile(path.join(io.outputsDir, 'previous_groom.md'), 'utf8'),
      `An earlier run groomed this ticket (${g.url}); it was not approved. Refine it, don't start over.\n\n# Groomed\n\nold\n`,
    );
    assert.equal(await fs.stat(path.join(runDir, 'prior-groom.json')).catch(() => undefined), undefined);
  } finally {
    await rm(runDir);
  }
});

test('github.intake: a rejected earlier groomed ticket carries the rejection feedback', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 2, { title: 'T', author: 'a' });
    const g = gh.addComment(REPO, 2, 'perc-bot', groomGate('r1', 'old'));
    const no = gh.addComment(REPO, 2, 'alice', '/percolator reject split it in two');
    await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 2 }, approvers: ['alice'] })(step, ctx, io);
    assert.equal(
      await fs.readFile(path.join(io.outputsDir, 'previous_groom.md'), 'utf8'),
      `An earlier run groomed this ticket (${g.url}); @alice rejected it (${no.url}): split it in two\n\nRefine it, don't start over.\n\nold\n`,
    );
  } finally {
    await rm(runDir);
  }
});

test('github.intake: an approved earlier groomed ticket is saved to prior-groom.json, not given to groom', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 2, { title: 'T', author: 'a' });
    const g = gh.addComment(REPO, 2, 'perc-bot', groomGate('r1', 'the ticket'));
    const ok = gh.addComment(REPO, 2, 'alice', '/percolator approve');
    const out = await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 2 }, approvers: ['alice'] })(step, ctx, io);
    assert.deepEqual(Object.keys(out.outputs), ['ticket']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, 'prior-groom.json'), 'utf8')), {
      text: 'the ticket',
      gateUrl: g.url,
      decision: { decision: 'approve', by: 'alice', url: ok.url },
    });
  } finally {
    await rm(runDir);
  }
});

test('github.intake: approvers default to the gh user', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 2, { title: 'T', author: 'a' });
    gh.addComment(REPO, 2, 'perc-bot', groomGate('r1', 'the ticket'));
    gh.addComment(REPO, 2, 'perc-bot', '/percolator approve');
    await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 2 } })(step, ctx, io);
    assert.equal(JSON.parse(await fs.readFile(path.join(runDir, 'prior-groom.json'), 'utf8')).text, 'the ticket');
  } finally {
    await rm(runDir);
  }
});

test('github.intake leaves decision notes out of ticket.md', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 2, { title: 'T', author: 'a' });
    gh.addComment(REPO, 2, 'perc-bot', '<!-- percolator:decision run=r1 step=approve-groom round=1 decision=approve -->\nApproved locally by @x via `perc approve`.\n');
    await githubIntake({ gh, runDir, pipeline: 'feature', runId: 'r1', inputs: {}, ticket: { repo: REPO, number: 2 } })(step, ctx, io);
    assert.ok((await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8')).endsWith('_No comments._\n'));
  } finally {
    await rm(runDir);
  }
});

test('ticketless intake renders inputs as the ticket', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    const h = githubIntake({ gh, runDir, pipeline: 'dd-alert', runId: 'dd-alert-20260304-050607-ab12', inputs: { service: 'api', alert_url: 'https://dd/x?a=b' } });
    const out = await h(step, ctx, io);
    assert.equal(out.status, 'pass');
    assert.equal(
      await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8'),
      '# dd-alert run dd-alert-20260304-050607-ab12\n\n## Inputs\n\n- alert_url: https://dd/x?a=b\n- service: api\n',
    );
    assert.equal(await fs.stat(path.join(runDir, 'issue.json')).then(() => true, () => false), false);
    assert.deepEqual(gh.calls, []);
  } finally {
    await rm(runDir);
  }
});

test('ticketless intake without inputs says so', async () => {
  const { runDir, io } = await setup();
  try {
    await githubIntake({ gh: new FakeGh(), runDir, pipeline: 'sweep', runId: 'sweep-1', inputs: {} })(step, ctx, io);
    assert.equal(await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8'), '# sweep run sweep-1\n\n## Inputs\n\n_No inputs._\n');
  } finally {
    await rm(runDir);
  }
});

test('intake appends inputs to a ticket', async () => {
  const { runDir, io } = await setup();
  try {
    const gh = new FakeGh();
    gh.addIssue(REPO, 1, { title: 'T', author: 'a', labels: ['bug', 'pipeline:hotfix'] });
    await githubIntake({ gh, runDir, pipeline: 'hotfix', runId: 'r1', inputs: { tag: 'v1' }, ticket: { repo: REPO, number: 1 } })(step, ctx, io);
    const md = await fs.readFile(path.join(io.outputsDir, 'ticket.md'), 'utf8');
    assert.ok(md.endsWith('## Comments\n\n_No comments._\n\n## Inputs\n\n- tag: v1\n'), md);
    assert.deepEqual((await readIssueMeta(runDir)).labels, ['bug', 'pipeline:hotfix']);
  } finally {
    await rm(runDir);
  }
});
