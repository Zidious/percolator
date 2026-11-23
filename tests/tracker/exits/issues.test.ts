import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubOpenIssues, openedIssues } from '../../../src/tracker/exits/issues.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const DRAFTS = 'Intro text is ignored.\n\n## Flaky login test\n\nIt fails on Windows.\n\n## Slow build\n\nTakes 10 minutes.\n';

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

async function setup(issues?: string, attempt = 1): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-issues-'));
  const stepDir = path.join(runDir, 'steps', 'file', String(attempt));
  const outputsDir = path.join(stepDir, 'outputs');
  const previousOutputs: Record<string, Record<string, string>> = { audit: { notes: 'steps/audit/1/outputs/notes.md' } };
  if (issues !== undefined) {
    const rel = 'steps/audit/1/outputs/issues.md';
    await fs.mkdir(path.join(runDir, 'steps', 'audit', '1', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(runDir, rel), issues);
    previousOutputs['audit'] = { issues: rel };
  }
  const graph = {
    steps: [
      { id: 'intake', stage: 'intake', role: 'slot', slotLast: true },
      { id: 'audit', stage: 'audit', role: 'slot', slotLast: true },
      { id: 'file', stage: 'file', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {} }, previousOutputs } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

const step = { id: 'file' } as Step;
const newGh = () => new FakeGh({ readFile: (f) => readFileSync(f, 'utf8') });
const mk = (s: Setup, gh: FakeGh) => githubOpenIssues({ gh, runDir: s.runDir, runId: 'r1', repo: REPO });
const marker = (n: number) => `<!-- percolator:issue run=r1 n=${n} -->`;

test('issue exit opens one issue per section', async () => {
  const s = await setup(DRAFTS);
  try {
    const gh = newGh();
    const out = await mk(s, gh)(step, s.ctx, s.io);
    const opened = [...gh.issues.values()];
    assert.deepEqual(
      opened.map((i) => [i.title, i.body]),
      [
        ['Flaky login test', `It fails on Windows.\n\n${marker(1)}\n`],
        ['Slow build', `Takes 10 minutes.\n\n${marker(2)}\n`],
      ],
    );
    assert.deepEqual(out, { status: 'pass', outputs: { issue_urls: 'steps/file/1/outputs/issue_urls.md' } });
    assert.equal(
      readFileSync(path.join(s.io.outputsDir, 'issue_urls.md'), 'utf8'),
      `https://${REPO}/issues/1\nhttps://${REPO}/issues/2\n`,
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(s.io.stepDir, 'created.json'), 'utf8')), {
      1: { url: `https://${REPO}/issues/1` },
      2: { url: `https://${REPO}/issues/2` },
    });
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit with no issues output passes and opens nothing', async () => {
  for (const drafts of [undefined, 'No drafts this time.\n']) {
    const s = await setup(drafts);
    try {
      const gh = newGh();
      const out = await mk(s, gh)(step, s.ctx, s.io);
      assert.deepEqual(out, { status: 'pass', outputs: {} });
      assert.deepEqual(gh.calls.filter((c) => c.method === 'createIssue'), []);
    } finally {
      await rm(s.runDir);
    }
  }
});

test('issue exit finds the issues it created before a crash', async () => {
  const s = await setup(DRAFTS);
  try {
    const gh = newGh();
    gh.addIssue(REPO, 5, { title: 'Flaky login test', body: `It fails on Windows.\n\n${marker(1)}\n`, author: gh.userLogin });
    const out = await mk(s, gh)(step, s.ctx, s.io);
    const created = gh.calls.filter((c) => c.method === 'createIssue');
    assert.equal(created.length, 1);
    assert.equal((created[0]!.args[1] as { title: string }).title, 'Slow build');
    assert.equal(out.status, 'pass');
    assert.equal(
      readFileSync(path.join(s.io.outputsDir, 'issue_urls.md'), 'utf8'),
      `https://${REPO}/issues/5\nhttps://${REPO}/issues/6\n`,
    );
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit does not take n=10 for n=1 when it searches', async () => {
  const s = await setup('## One\n\nFirst.\n');
  try {
    const gh = newGh();
    gh.addIssue(REPO, 3, { body: `Other.\n\n${marker(10)}\n`, author: gh.userLogin });
    await mk(s, gh)(step, s.ctx, s.io);
    assert.equal(readFileSync(path.join(s.io.outputsDir, 'issue_urls.md'), 'utf8'), `https://${REPO}/issues/4\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit looks for its marker among the user\'s own issues, without a search', async () => {
  const s = await setup('## One\n\nFirst.\n');
  try {
    const gh = newGh();
    // someone else quoting the marker is not the issue this run opened
    gh.addIssue(REPO, 3, { body: `Quoted: ${marker(1)}`, author: 'mallory' });
    await mk(s, gh)(step, s.ctx, s.io);
    assert.equal(readFileSync(path.join(s.io.outputsDir, 'issue_urls.md'), 'utf8'), `https://${REPO}/issues/4\n`);
    assert.deepEqual(gh.calls.filter((c) => c.method === 'myIssues').map((c) => c.args), [[REPO]]);
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit reuses what an earlier attempt recorded in created.json', async () => {
  const s = await setup(DRAFTS, 2);
  try {
    const earlier = path.join(s.runDir, 'steps', 'file', '1');
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(path.join(earlier, 'created.json'), JSON.stringify({ 1: `https://${REPO}/issues/9` }));
    const gh = newGh();
    await mk(s, gh)(step, s.ctx, s.io);
    assert.deepEqual(
      gh.calls.filter((c) => c.method === 'createIssue').map((c) => (c.args[1] as { title: string }).title),
      ['Slow build'],
    );
    assert.equal(readFileSync(path.join(s.io.outputsDir, 'issue_urls.md'), 'utf8').split('\n')[0], `https://${REPO}/issues/9`);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(s.io.stepDir, 'created.json'), 'utf8'))), ['1', '2']);
  } finally {
    await rm(s.runDir);
  }
});

test('openedIssues turns issue_urls into refs', () => {
  assert.deepEqual(
    openedIssues('https://github.com/O/r/issues/5\n\nhttps://ghe.example.com/o/r/issues/6\nnot a url\n'),
    [
      { ref: 'github.com/o/r#5', url: 'https://github.com/O/r/issues/5' },
      { ref: 'ghe.example.com/o/r#6', url: 'https://ghe.example.com/o/r/issues/6' },
    ],
  );
  assert.deepEqual(openedIssues(''), []);
});

/** A `next` that names each child after its issue and records what created.json held when it started. */
function nextRecorder(s: Setup) {
  const started: { url: string; child: string; recorded: unknown }[] = [];
  const ids: string[] = [];
  return {
    started,
    ids,
    next: {
      newId: (url: string) => {
        const id = `child-${url.split('/').at(-1)}`;
        ids.push(id);
        return id;
      },
      start: async (url: string, child: string) => {
        started.push({ url, child, recorded: JSON.parse(readFileSync(path.join(s.io.stepDir, 'created.json'), 'utf8')) });
      },
    },
  };
}

test('issue exit with next starts a linked run per new issue', async () => {
  const s = await setup(DRAFTS);
  try {
    const gh = newGh();
    const r = nextRecorder(s);
    const out = await githubOpenIssues({ gh, runDir: s.runDir, runId: 'r1', repo: REPO, next: r.next })(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    const one = { url: `https://${REPO}/issues/1`, child: 'child-1' };
    const two = { url: `https://${REPO}/issues/2`, child: 'child-2' };
    // each child id is in created.json before its run starts
    assert.deepEqual(r.started, [
      { url: one.url, child: 'child-1', recorded: { 1: one } },
      { url: two.url, child: 'child-2', recorded: { 1: one, 2: two } },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(s.io.stepDir, 'created.json'), 'utf8')), { 1: one, 2: two });
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit with next reuses the child ids recorded before a crash', async () => {
  const s = await setup(DRAFTS, 2);
  try {
    const earlier = path.join(s.runDir, 'steps', 'file', '1');
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(path.join(earlier, 'created.json'), JSON.stringify({ 1: { url: `https://${REPO}/issues/9`, child: 'child-old' } }));
    const gh = newGh();
    const r = nextRecorder(s);
    await githubOpenIssues({ gh, runDir: s.runDir, runId: 'r1', repo: REPO, next: r.next })(step, s.ctx, s.io);
    assert.equal(gh.calls.filter((c) => c.method === 'createIssue').length, 1);
    assert.deepEqual(r.ids, ['child-1']);
    assert.deepEqual(r.started.map((x) => [x.url, x.child]), [
      [`https://${REPO}/issues/9`, 'child-old'],
      [`https://${REPO}/issues/1`, 'child-1'],
    ]);
  } finally {
    await rm(s.runDir);
  }
});

test('issue exit escalates when a next run cannot start', async () => {
  const s = await setup(DRAFTS);
  try {
    const gh = newGh();
    const next = { newId: () => 'child-x', start: async () => Promise.reject(new Error('no space')) };
    const out = await githubOpenIssues({ gh, runDir: s.runDir, runId: 'r1', repo: REPO, next })(step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'github.open_issues: no space' });
  } finally {
    await rm(s.runDir);
  }
});
