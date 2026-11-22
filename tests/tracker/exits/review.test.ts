import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubPrReview } from '../../../src/tracker/exits/review.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const MARKER = '<!-- percolator:review run=r1 -->';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const readBody = (f: string) => readFileSync(f, 'utf8');
const step = { id: 'post' } as Step;

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(review?: string): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-review-'));
  const stepDir = path.join(runDir, 'steps', 'post', '1');
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  const previousOutputs: Record<string, Record<string, string>> = {};
  if (review !== undefined) {
    const rel = 'steps/read/1/outputs/review.md';
    await fs.mkdir(path.join(runDir, 'steps', 'read', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), review);
    previousOutputs['read'] = { review: rel };
  }
  const graph = {
    steps: [
      { id: 'read', stage: 'read', role: 'slot', slotLast: true },
      { id: 'post', stage: 'post', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {}, groundVersions: {} }, previousOutputs } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

const mk = (s: Setup, gh: FakeGh, pr = 'https://github.com/o/r/pull/4') =>
  githubPrReview({ gh, runDir: s.runDir, runId: 'r1', inputs: { pr }, repo: REPO });

test('pr_review posts a COMMENT review with the review output', async () => {
  const s = await setup('\nLooks fine; one nit in a.ts.\n\n');
  try {
    const gh = new FakeGh({ readFile: readBody });
    const out = await mk(s, gh)(step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'pass', outputs: { review_url: 'steps/post/1/outputs/review_url.md' } });
    assert.deepEqual(gh.reviews, [
      { repo: REPO, number: 4, body: `Looks fine; one nit in a.ts.\n\n${MARKER}\n`, url: `https://${REPO}/pull/4#pullrequestreview-1` },
    ]);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'review_url.md'), 'utf8'), `https://${REPO}/pull/4#pullrequestreview-1\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('pr_review reads a bare pull number against the run repo', async () => {
  const s = await setup('ok');
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh, '#9')(step, s.ctx, s.io)).status, 'pass');
    assert.deepEqual(gh.reviews.map((r) => [r.repo, r.number]), [[REPO, 9]]);
  } finally {
    await rm(s.runDir);
  }
});

test('pr_review finds the review it posted before a crash', async () => {
  const s = await setup('ok');
  try {
    const gh = new FakeGh({ readFile: readBody });
    gh.reviews.push({ repo: REPO, number: 4, body: 'someone else', url: 'u0' });
    gh.reviews.push({ repo: REPO, number: 4, body: `ok\n\n${MARKER}\n`, url: 'u1' });
    const out = await mk(s, gh)(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    assert.equal(gh.calls.filter((c) => c.method === 'postReview').length, 0);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'review_url.md'), 'utf8'), 'u1\n');
  } finally {
    await rm(s.runDir);
  }
});

test('pr_review without a review output escalates', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.deepEqual(await mk(s, gh)(step, s.ctx, s.io), {
      status: 'escalate', outputs: {},
      reason: 'github.pr_review: no step wrote a review output; write review.md in the stage before the exit',
    });
    assert.deepEqual(gh.calls, []);
  } finally {
    await rm(s.runDir);
  }
});

test('pr_review on an issue URL escalates', async () => {
  const s = await setup('ok');
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.deepEqual(await mk(s, gh, 'https://github.com/o/r/issues/4')(step, s.ctx, s.io), {
      status: 'escalate', outputs: {},
      reason: 'github.pr_review: "https://github.com/o/r/issues/4" is an issue, not a pull request',
    });
  } finally {
    await rm(s.runDir);
  }
});
