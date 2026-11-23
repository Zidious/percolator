import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubPrivateForkPr } from '../../../src/tracker/exits/private-fork.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const GHSA = 'GHSA-2345-6789-cfgh';
const FORK = 'github.com/o/r-ghsa-2345-6789-cfgh';
const CLONE = 'https://github.com/o/r-ghsa-2345-6789-cfgh.git';
const BRANCH = 'percolator/r1';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const readBody = (f: string) => readFileSync(f, 'utf8');
const step = { id: 'fix' } as Step;

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(o: { attempt?: number; prBody?: string; title?: string } = {}): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-fork-'));
  const stepDir = path.join(runDir, 'steps', 'fix', String(o.attempt ?? 1));
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  if (o.title !== undefined) {
    await fs.writeFile(path.join(runDir, 'issue.json'), JSON.stringify({ repo: REPO, number: 7, title: o.title, url: 'u' }));
  }
  const previousOutputs: Record<string, Record<string, string>> = {};
  if (o.prBody !== undefined) {
    const rel = 'steps/patch/1/outputs/pr_body.md';
    await fs.mkdir(path.join(runDir, 'steps', 'patch', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), o.prBody);
    previousOutputs['patch'] = { pr_body: rel };
  }
  const graph = {
    steps: [
      { id: 'patch', stage: 'patch', role: 'slot', slotLast: true },
      { id: 'fix', stage: 'fix', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {}, groundVersions: {} }, previousOutputs } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

function mk(s: Setup, gh: FakeGh, pushes: string[][], advisory = GHSA, onPush?: () => Promise<void>) {
  return githubPrivateForkPr({
    gh, runDir: s.runDir, worktree: '/wt', branch: BRANCH, base: 'origin/main', repo: REPO, inputs: { advisory },
    push: async (w, url, b) => {
      pushes.push([w, url, b]);
      await onPush?.();
    },
  });
}

test('private fork exit creates the fork, pushes and opens the PR there', async () => {
  const s = await setup({ prBody: '\nFixes the overflow.\n\n', title: 'Overflow in parser' });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    let recordedBeforePush: unknown;
    const out = await mk(s, gh, pushes, GHSA, async () => {
      recordedBeforePush = JSON.parse(await fs.readFile(path.join(s.io.stepDir, 'fork.json'), 'utf8'));
    })(step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'pass', outputs: { pr_url: 'steps/fix/1/outputs/pr_url.md' } });
    assert.deepEqual(gh.forks.map((f) => [f.repo, f.ghsa]), [[REPO, GHSA]]);
    assert.deepEqual(recordedBeforePush, { advisory: GHSA, fullName: 'o/r-ghsa-2345-6789-cfgh', cloneUrl: CLONE });
    assert.deepEqual(pushes, [['/wt', CLONE, BRANCH]]);
    assert.deepEqual(gh.prs.map((p) => ({ repo: p.repo, base: p.base, head: p.head, title: p.title, body: p.body })), [
      { repo: FORK, base: 'main', head: BRANCH, title: 'Overflow in parser', body: 'Fixes the overflow.\n' },
    ]);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'pr_url.md'), 'utf8'), `https://${FORK}/pull/1\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('private fork exit without a ticket titles the PR after the advisory', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh, [])(step, s.ctx, s.io)).status, 'pass');
    assert.deepEqual(gh.prs.map((p) => [p.title, p.body]), [[`Fix for ${GHSA}`, '']]);
  } finally {
    await rm(s.runDir);
  }
});

test('private fork exit titles the PR after the advisory when issue.json has no title', async () => {
  for (const issue of [{ repo: REPO, number: 7, url: 'u' }, { repo: REPO, number: 7, title: '  ', url: 'u' }]) {
    const s = await setup();
    try {
      await fs.writeFile(path.join(s.runDir, 'issue.json'), JSON.stringify(issue));
      const gh = new FakeGh({ readFile: readBody });
      assert.equal((await mk(s, gh, [])(step, s.ctx, s.io)).status, 'pass');
      assert.deepEqual(gh.prs.map((p) => p.title), [`Fix for ${GHSA}`]);
    } finally {
      await rm(s.runDir);
    }
  }
});

test('private fork exit takes its title from the latest pr_title output, over the issue title', async () => {
  const s = await setup({ title: 'Overflow in parser lets anyone read memory' });
  try {
    const rel = 'steps/patch/1/outputs/pr_title.md';
    await fs.mkdir(path.join(s.runDir, 'steps', 'patch', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(s.runDir, rel), '  Harden the parser  \n');
    s.ctx.previousOutputs['patch'] = { pr_title: rel };
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh, [])(step, s.ctx, s.io)).status, 'pass');
    assert.deepEqual(gh.prs.map((p) => p.title), ['Harden the parser']);
  } finally {
    await rm(s.runDir);
  }
});

test('private fork exit reuses the fork and PR from before a crash', async () => {
  const s = await setup({ attempt: 2 });
  try {
    const earlier = path.join(s.runDir, 'steps', 'fix', '1');
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(
      path.join(earlier, 'fork.json'),
      JSON.stringify({ advisory: GHSA, fullName: 'o/r-ghsa-2345-6789-cfgh', cloneUrl: CLONE }),
    );
    const gh = new FakeGh({ readFile: readBody });
    const pr = gh.addPr(FORK, { head: BRANCH });
    const pushes: string[][] = [];
    const out = await mk(s, gh, pushes)(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    assert.equal(gh.calls.filter((c) => c.method === 'advisoryFork' || c.method === 'createPr').length, 0);
    assert.deepEqual(pushes, [['/wt', CLONE, BRANCH]]);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'pr_url.md'), 'utf8'), `${pr.url}\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('a malformed advisory id escalates', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    assert.deepEqual(await mk(s, gh, pushes, 'x')(step, s.ctx, s.io), {
      status: 'escalate', outputs: {},
      reason: 'github.private_fork_pr: advisory "x" is not a GHSA id (GHSA-xxxx-xxxx-xxxx)',
    });
    assert.deepEqual(gh.calls, []);
    assert.deepEqual(pushes, []);
  } finally {
    await rm(s.runDir);
  }
});
