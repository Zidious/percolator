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

test('prBody renders the passed variant exactly', () => {
  assert.equal(
    prBody({
      issue,
      runId: 'r1',
      summary: 'Did the thing.',
      review: { used: 2, max: 3 },
      groundVersions: { zeta: 'local', alpha: 'git@x (abcdef123456)' },
    }),
    [
      'Closes #7',
      '',
      '## Summary',
      '',
      'Did the thing.',
      '',
      '## Review',
      '',
      'Self-review passed in round 2 of 3.',
      '',
      '## Built under',
      '',
      '- alpha git@x (abcdef123456)',
      '- zeta local',
      '',
      '<sub>Percolator run `r1`</sub>',
      '',
    ].join('\n'),
  );
});

test('prBody renders the capped variant, the empty summary and no grounds', () => {
  assert.equal(
    prBody({
      issue,
      runId: 'r1',
      review: { used: 3, max: 3, unresolved: 'Bug A\nBug B' },
      groundVersions: {},
    }),
    [
      'Closes #7',
      '',
      '## Summary',
      '',
      '_No summary was written._',
      '',
      '## Review',
      '',
      'Self-review stopped at the cap of 3 rounds with unresolved findings:',
      '',
      'Bug A\nBug B',
      '',
      '## Built under',
      '',
      '- no grounds',
      '',
      '<sub>Percolator run `r1`</sub>',
      '',
    ].join('\n'),
  );
});

test('prBody keeps the whole body under 60000 chars by cutting the findings', () => {
  const body = prBody({
    issue,
    runId: 'r1',
    review: { used: 3, max: 3, unresolved: 'x'.repeat(100000) },
    groundVersions: { a: 'local' },
    findingsPath: 'steps/review/1/outputs/findings.md',
  });
  assert.ok(body.length < 60000, `length ${body.length}`);
  assert.ok(body.includes('… (truncated; full findings in steps/review/1/outputs/findings.md of run r1)'));
  assert.ok(body.endsWith('<sub>Percolator run `r1`</sub>\n'));
});

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(o: { unresolved?: string } = {}): Promise<Setup> {
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
  const graph = {
    steps: [
      { id: 'implement.0', stage: 'implement', role: 'slot', slotLast: false },
      { id: 'implement.1', stage: 'implement', role: 'slot', slotLast: true },
      { id: 'review', stage: 'review', role: 'slot', slotLast: true },
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
    previousOutputs: {
      'implement.0': { summary: 'steps/implement.0/summary.md' },
      'implement.1': { summary: 'steps/implement.1/summary.md' },
    },
  } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

const step = { id: 'deliver' } as Step;

test('open_pr creates a PR and records pr_url', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    const h = githubOpenPr({
      gh,
      runDir: s.runDir,
      worktree: '/wt',
      branch: 'percolator/r1',
      base: 'origin/main',
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
    const body = await fs.readFile(args.bodyFile, 'utf8');
    assert.ok(body.includes('Implemented it.'));
    assert.ok(body.includes('Self-review passed in round 2 of 3.'));
    assert.ok(body.includes('- g local'));
    assert.ok(body.includes('<sub>Percolator run `r1`</sub>'));
    assert.equal(
      await fs.readFile(path.join(s.io.outputsDir, 'pr_url.md'), 'utf8'),
      `https://${REPO}/pull/1\n`,
    );
    assert.deepEqual(out.outputs, { pr_url: 'steps/deliver/outputs/pr_url.md' });
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr with unresolved findings reports the cap and the findings text', async () => {
  const s = await setup({ unresolved: 'Still broken.' });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'b', base: 'main', push: async () => {},
    });
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    assert.ok(
      gh.prs[0]!.body.includes('Self-review stopped at the cap of 3 rounds with unresolved findings:\n\nStill broken.'),
    );
  } finally {
    await rm(s.runDir);
  }
});

test('open_pr truncation names the run-relative findings path, never a local absolute one', async () => {
  const s = await setup({ unresolved: 'x'.repeat(100000) });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const h = githubOpenPr({
      gh, runDir: s.runDir, worktree: '/wt', branch: 'b', base: 'main', push: async () => {},
    });
    assert.equal((await h(step, s.ctx, s.io)).status, 'pass');
    const body = gh.prs[0]!.body;
    assert.ok(body.includes('… (truncated; full findings in steps/review/findings.md of run r1)'), body.slice(-300));
    assert.equal(body.includes(s.runDir), false);
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
