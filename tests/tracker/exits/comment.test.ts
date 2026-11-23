import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubComment } from '../../../src/tracker/exits/comment.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const MARKER = '<!-- percolator:exit run=r1 step=deliver -->';

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(comment?: string): Promise<Setup> {
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
  const graph = {
    steps: [
      { id: 'intake', stage: 'intake', role: 'slot', slotLast: true },
      { id: 'answer', stage: 'answer', role: 'slot', slotLast: true },
      { id: 'deliver', stage: 'deliver', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {} }, previousOutputs } as unknown as RunContext;
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
