import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Graph, Step } from '../../src/graph/build.ts';
import { githubOpenPr, prBody } from '../../src/tracker/pr.ts';
import { FakeGh } from '../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const issue = { repo: REPO, number: 7, title: 'Fix it', url: `https://${REPO}/issues/7` };
const readBody = (f: string) => readFileSync(f, 'utf8');

test('prBody is only the closing line without a description', () => {
  assert.equal(prBody(7), 'Closes #7\n');
  assert.equal(prBody(7, '  \n'), 'Closes #7\n');
});

test('prBody without an issue has no Closes line', () => {
  assert.equal(prBody(undefined), '');
  assert.equal(prBody(undefined, '\n## What\n\nDid it.\n\n'), '## What\n\nDid it.\n');
});

test('prBody puts the trimmed description after the closing line', () => {
  assert.equal(prBody(7, '\n## What\n\nDid it.\n\n'), 'Closes #7\n\n## What\n\nDid it.\n');
});

const MISSING = '<missing>';

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(o: { unresolved?: string; prBody?: { step: string; text: string }[] } = {}): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-pr-'));
  const stepDir = path.join(runDir, 'steps', 'deliver');
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'issue.json'), JSON.stringify(issue));
  await fs.mkdir(path.join(runDir, 'steps', 'implement.1'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'steps', 'implement.1', 'summary.md'), 'Implemented it.');
  let unresolvedFindings: string | undefined;
  if (o.unresolved !== undefined) {
    unresolvedFindings = 'steps/review/findings.md';
    await fs.mkdir(path.join(runDir, 'steps', 'review'), { recursive: true });
    await fs.writeFile(path.join(runDir, unresolvedFindings), o.unresolved);
  }
  const previousOutputs: Record<string, Record<string, string>> = {
    'implement.0': { summary: 'steps/implement.0/summary.md' },
    'implement.1': { summary: 'steps/implement.1/summary.md' },
  };
  for (const e of o.prBody ?? []) {
    const rel = `steps/${e.step}/outputs/pr_body.md`;
    if (e.text !== MISSING) {
      await fs.mkdir(path.join(runDir, 'steps', e.step, 'outputs'), { recursive: true });
      await fs.writeFile(path.join(runDir, rel), e.text);
    }
    previousOutputs[e.step] = { pr_body: rel };
  }
  const graph = {
    steps: [
      { id: 'implement.0', stage: 'implement', role: 'slot', slotLast: false },
      { id: 'implement.1', stage: 'implement', role: 'slot', slotLast: true },
      { id: 'review', stage: 'review', role: 'slot', slotLast: true },
      { id: 'pr-description', stage: 'deliver', role: 'hook', slotLast: false },
      { id: 'team-pr', stage: 'deliver', role: 'hook', slotLast: false },
      { id: 'deliver', stage: 'deliver', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {
      'groom-gate': { id: 'groom-gate', onCap: 'escalate', maxRounds: 5 },
      review: { id: 'review', onCap: 'continue', maxRounds: 3 },
    },
  } as unknown as Graph;
  const ctx = {
    graph,
    state: {
      runId: 'r1',
      rounds: { review: 1 },
      groundVersions: { g: 'local' },
      ...(unresolvedFindings ? { unresolvedFindings } : {}),
    },
    previousOutputs,
  } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

const step = { id: 'deliver' } as Step;

const mk = (s: Setup, gh: FakeGh) =>
  githubOpenPr({ gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1', base: 'origin/main', push: async () => {} });

test('open_pr without a pr_body output opens the PR with only the closing line', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1', base: 'origin/main',
      push: async (w, b) => void pushes.push([w, b]),
    });
    const out = await h(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    assert.deepEqual(pushes, [['/wt', 'percolator/r1']]);
    const creates = gh.calls.filter((c) => c.method === 'createPr');
    assert.equal(creates.length, 1);
    const [repo, args] = creates[0]!.args as [string, { base: string; head: string; title: string; bodyFile: string }];
    assert.equal(repo, REPO);
    assert.deepEqual(
      { base: args.base, head: args.head, title: args.title },
      { base: 'main', head: 'percolator/r1', title: 'Fix it' },
    );
    assert.equal(args.bodyFile, path.join(s.io.stepDir, 'pr-body.md'));
    assert.equal(gh.prs[0]!.body, 'Closes #7\n');
    assert.equal(
      await fs.readFile(path.join(s.io.outputsDir, 'pr_url.md'), 'utf8'),
      `https://${REPO}/pull/1\n`,
    );
    assert.deepEqual(out.outputs, { pr_url: 'steps/deliver/outputs/pr_url.md' });
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr uses the pr_body output after the closing line', async () => {
  const s = await setup({ prBody: [{ step: 'pr-description', text: 'Adds X.\n' }] });
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh)(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.body, 'Closes #7\n\nAdds X.\n');
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr leaves unresolved findings, summary, grounds and run id out of the body', async () => {
  const s = await setup({ unresolved: 'Still broken.' });
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh)(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.body, 'Closes #7\n');
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr takes the last pr_body in graph order', async () => {
  const s = await setup({
    prBody: [{ step: 'team-pr', text: 'B' }, { step: 'pr-description', text: 'A' }],
  });
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh)(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.body, 'Closes #7\n\nB\n');
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr treats a missing pr_body file as no description', async () => {
  const s = await setup({ prBody: [{ step: 'pr-description', text: MISSING }] });
  try {
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh)(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.body, 'Closes #7\n');
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr rerun edits the existing PR to the new pr_body', async () => {
  const s = await setup({ prBody: [{ step: 'pr-description', text: 'A' }] });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const h = mk(s, gh);
    await h(step, s.ctx, s.io);
    await fs.writeFile(path.join(s.runDir, 'steps', 'pr-description', 'outputs', 'pr_body.md'), 'B');
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.calls.filter((c) => c.method === 'createPr').length, 1);
    assert.equal(gh.calls.filter((c) => c.method === 'editPr').length, 1);
    assert.equal(gh.prs.length, 1);
    assert.equal(gh.prs[0]!.body, 'Closes #7\n\nB\n');
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr run twice opens one PR', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'b', base: 'main', push: async () => {},
    });
    await h(step, s.ctx, s.io);
    const again = await h(step, s.ctx, s.io);
    assert.equal(again.status, 'pass');
    assert.equal(gh.calls.filter((c) => c.method === 'createPr').length, 1);
    assert.equal(gh.calls.filter((c) => c.method === 'editPr').length, 1);
    assert.equal(gh.prs.length, 1);
    assert.equal(
      await fs.readFile(path.join(s.io.outputsDir, 'pr_url.md'), 'utf8'),
      `https://${REPO}/pull/1\n`,
    );
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr escalates on a push failure', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh();
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'b', base: 'main',
      push: async () => { throw new Error('remote rejected'); },
    });
    const out = await h(step, s.ctx, s.io);
    assert.equal(out.status, 'escalate');
    assert.equal(out.reason, 'github.open_pr: remote rejected');
    assert.equal(gh.calls.length, 0);
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr without an issue titles the PR <pipeline>: <runId> and closes nothing', async () => {
  const s = await setup({ prBody: [{ step: 'pr-description', text: 'Adds X.\n' }] });
  try {
    await fs.rm(path.join(s.runDir, 'issue.json'));
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1', base: 'origin/main', push: async () => {},
      repo: REPO, pipeline: 'dd-alert', runId: 'r1',
    });
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    const pr = gh.prs[0]!;
    assert.deepEqual({ repo: pr.repo, title: pr.title, body: pr.body }, { repo: REPO, title: 'dd-alert: r1', body: 'Adds X.\n' });
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr takes its title from the latest pr_title output', async () => {
  const s = await setup();
  try {
    await fs.mkdir(path.join(s.runDir, 'steps', 'team-pr', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(s.runDir, 'steps', 'team-pr', 'outputs', 'pr_title.md'), '  Fix the alert  \n');
    s.ctx.previousOutputs['team-pr'] = { pr_title: 'steps/team-pr/outputs/pr_title.md' };
    const gh = new FakeGh({ readFile: readBody });
    assert.equal((await mk(s, gh)(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.title, 'Fix the alert');
  } finally {
    await rm(s.runDir);
  }
});

test('prBody of a fan-out slice says Part of #<n>, which closes nothing', () => {
  assert.equal(prBody(7, 'Adds X.\n', { slice: true }), 'Part of #7\n\nAdds X.\n');
});

test('open_pr of a fan-out slice titles the PR <issue title>: <slice title> and leaves the issue open', async () => {
  const s = await setup({ prBody: [{ step: 'pr-description', text: 'Adds X.\n' }] });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1-s2', base: 'origin/main', push: async () => {},
      slice: { title: 'Parser' },
    });
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    assert.deepEqual({ title: gh.prs[0]!.title, body: gh.prs[0]!.body }, { title: 'Fix it: Parser', body: 'Part of #7\n\nAdds X.\n' });
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr of a fan-out slice without an issue titles the PR <pipeline>: <slice title>', async () => {
  const s = await setup();
  try {
    await fs.rm(path.join(s.runDir, 'issue.json'));
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1-s2', base: 'origin/main', push: async () => {},
      repo: REPO, pipeline: 'split', runId: 'r1-s2', slice: { title: 'Parser' },
    });
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    assert.equal(gh.prs[0]!.title, 'split: Parser');
  } finally {
    await rm(s.runDir);
  }
});
