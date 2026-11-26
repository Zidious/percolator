import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { StepRecord } from '../../../src/engine/state.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubComment } from '../../../src/tracker/exits/comment.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const MARKER = '<!-- percolator:exit run=r1 step=deliver -->';

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(comment?: string, o: { notes?: { round: number; text: string }[]; answerNotes?: string } = {}): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-comment-'));
  const stepDir = path.join(runDir, 'steps', 'deliver', '1');
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.writeFile(
    path.join(runDir, 'issue.json'),
    JSON.stringify({ repo: REPO, number: 7, title: 'Explain it', url: `https://${REPO}/issues/7` }),
  );
  const previousOutputs: Record<string, Record<string, string>> = { answer: { notes: 'steps/answer/1/outputs/notes.md' } };
  if (comment !== undefined) {
    const rel = 'steps/answer/1/outputs/comment.md';
    await fs.mkdir(path.join(runDir, 'steps', 'answer', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), comment);
    previousOutputs['answer'] = { comment: rel };
  }
  const history: StepRecord[] = [];
  const note = async (stepId: string, round: number, text: string, verify: boolean) => {
    const rel = `steps/${stepId}/${round}/outputs/notes.md`;
    await fs.mkdir(path.join(runDir, 'steps', stepId, String(round), 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), text);
    history.push({ stepId, attempt: round, startedAt: '', endedAt: '', status: 'pass', outputs: { notes: rel }, ...(verify ? { verifyRound: round } : {}) });
  };
  if (o.answerNotes !== undefined) await note('answer', 1, o.answerNotes, false);
  for (const n of o.notes ?? []) await note('review', n.round, n.text, true);
  const graph = {
    steps: [
      { id: 'intake', stage: 'intake', role: 'slot', slotLast: true },
      { id: 'answer', stage: 'answer', role: 'slot', slotLast: true },
      { id: 'review', stage: 'review', role: 'slot', slotLast: true },
      { id: 'deliver', stage: 'deliver', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {}, history }, previousOutputs } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

const step = { id: 'deliver' } as Step;
const newGh = () => {
  const gh = new FakeGh({ readFile: (f) => readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 7);
  return gh;
};

test('comment exit posts the comment output with its marker', async () => {
  const s = await setup('It works like this.\n');
  try {
    const gh = newGh();
    const out = await githubComment({ gh, runDir: s.runDir, runId: 'r1' })(step, s.ctx, s.io);
    const posted = gh.issues.get(`${REPO}#7`)!.comments;
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.body, `It works like this.\n\n${MARKER}\n`);
    assert.deepEqual(out, { status: 'pass', outputs: { comment_url: 'steps/deliver/1/outputs/comment_url.md' } });
    assert.equal(readFileSync(path.join(s.io.outputsDir, 'comment_url.md'), 'utf8'), `${posted[0]!.url}\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('comment exit finds the comment it created before a crash', async () => {
  const s = await setup('Second try.');
  try {
    const gh = newGh();
    const old = gh.addComment(REPO, 7, 'perc-bot', `First try.\n\n${MARKER}\n`);
    const out = await githubComment({ gh, runDir: s.runDir, runId: 'r1' })(step, s.ctx, s.io);
    assert.deepEqual(gh.calls.filter((c) => c.method === 'comment'), []);
    assert.equal(gh.calls.filter((c) => c.method === 'editComment').length, 1);
    const posted = gh.issues.get(`${REPO}#7`)!.comments;
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.body, `Second try.\n\n${MARKER}\n`);
    assert.equal(out.status, 'pass');
    assert.equal(readFileSync(path.join(s.io.outputsDir, 'comment_url.md'), 'utf8'), `${old.url}\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('comment exit without a comment output escalates', async () => {
  const s = await setup();
  try {
    const gh = newGh();
    const out = await githubComment({ gh, runDir: s.runDir, runId: 'r1' })(step, s.ctx, s.io);
    assert.deepEqual(out, {
      status: 'escalate',
      outputs: {},
      reason: 'github.comment: no step wrote a comment output; write comment.md in the stage before the exit',
    });
    assert.deepEqual(gh.calls.filter((c) => c.method === 'comment' || c.method === 'editComment'), []);
  } finally {
    await rm(s.runDir);
  }
});

test('comment exit adds the notes before its marker', async () => {
  const s = await setup('Answer.\n', { notes: [{ round: 4, text: 'N4.\n' }] });
  try {
    const gh = newGh();
    assert.equal((await githubComment({ gh, runDir: s.runDir, runId: 'r1' })(step, s.ctx, s.io)).status, 'pass');
    const posted = gh.issues.get(`${REPO}#7`)!.comments;
    assert.equal(posted[0]!.body, `Answer.\n\n## Noticed in review, not fixed\n\n### Round 4\n\nN4.\n\n${MARKER}\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('comment exit leaves a notes output outside a verify round out', async () => {
  const s = await setup('Answer.', { answerNotes: 'Not for the body.' });
  try {
    const gh = newGh();
    await githubComment({ gh, runDir: s.runDir, runId: 'r1' })(step, s.ctx, s.io);
    assert.equal(gh.issues.get(`${REPO}#7`)!.comments[0]!.body, `Answer.\n\n${MARKER}\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('comment exit re-run edits its comment to one notes section', async () => {
  const s = await setup('Answer.', { notes: [{ round: 4, text: 'N4.' }] });
  try {
    const gh = newGh();
    const h = githubComment({ gh, runDir: s.runDir, runId: 'r1' });
    await h(step, s.ctx, s.io);
    await h(step, s.ctx, s.io);
    const posted = gh.issues.get(`${REPO}#7`)!.comments;
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.body, `Answer.\n\n## Noticed in review, not fixed\n\n### Round 4\n\nN4.\n\n${MARKER}\n`);
  } finally {
    await rm(s.runDir);
  }
});
