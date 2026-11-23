import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { Graph, Step } from '../../../src/graph/build.ts';
import { githubRelease } from '../../../src/tracker/exits/release.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const SHA = 'a'.repeat(40);
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });
const readBody = (f: string) => readFileSync(f, 'utf8');
const step = { id: 'release' } as Step;
const MARK = '<!-- percolator:release run=r1 -->';

type Setup = { runDir: string; io: { stepDir: string; outputsDir: string }; ctx: RunContext };

/** `outputs` maps a step id to the outputs it wrote: key → file text. */
async function setup(outputs: Record<string, Record<string, string>> = {}): Promise<Setup> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-release-'));
  const stepDir = path.join(runDir, 'steps', 'release', '1');
  const outputsDir = path.join(stepDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  const previousOutputs: Record<string, Record<string, string>> = {};
  for (const [id, keys] of Object.entries(outputs)) {
    previousOutputs[id] = {};
    for (const [key, text] of Object.entries(keys)) {
      const rel = `steps/${id}/1/outputs/${key}.md`;
      await fs.mkdir(path.join(runDir, 'steps', id, '1', 'outputs'), { recursive: true });
      await fs.writeFile(path.join(runDir, rel), text);
      previousOutputs[id]![key] = rel;
    }
  }
  const graph = {
    steps: [
      { id: 'prepare', stage: 'prepare', role: 'slot', slotLast: true },
      { id: 'notes', stage: 'notes', role: 'slot', slotLast: true },
      { id: 'release', stage: 'release', role: 'slot', slotLast: true },
    ] as Step[],
    backEdges: {},
  } as unknown as Graph;
  const ctx = { graph, state: { runId: 'r1', rounds: {}, groundVersions: {} }, previousOutputs } as unknown as RunContext;
  return { runDir, io: { stepDir, outputsDir }, ctx };
}

function mk(s: Setup, gh: FakeGh, o: { inputs?: Record<string, string>; pushes?: string[][]; heads?: string[] } = {}) {
  return githubRelease({
    gh, runDir: s.runDir, worktree: '/wt', branch: 'percolator/r1', repo: REPO, inputs: o.inputs ?? {},
    push: async (w, b) => void o.pushes?.push([w, b]),
    head: async (w) => {
      o.heads?.push(w);
      return SHA;
    },
  });
}

test('release exit tags the pushed head with the notes', async () => {
  const s = await setup({ prepare: { tag: '  v1.2.0\n' }, notes: { release_notes: '## Changes\n\n- X\n' } });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    const heads: string[] = [];
    const out = await mk(s, gh, { inputs: { tag: 'v0.0.1' }, pushes, heads })(step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'pass', outputs: { release_url: 'steps/release/1/outputs/release_url.md' } });
    assert.deepEqual(pushes, [['/wt', 'percolator/r1']]);
    assert.deepEqual(heads, ['/wt']);
    assert.deepEqual(gh.releases, [
      { repo: REPO, tag: 'v1.2.0', target: SHA, notes: `## Changes\n\n- X\n\n${MARK}\n`, url: `https://${REPO}/releases/tag/v1.2.0` },
    ]);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'release_url.md'), 'utf8'), `https://${REPO}/releases/tag/v1.2.0\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('release exit takes the tag input and empty notes when no step wrote them', async () => {
  const s = await setup();
  try {
    const gh = new FakeGh({ readFile: readBody });
    const out = await mk(s, gh, { inputs: { tag: 'v2.0.0' } })(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    assert.deepEqual(gh.releases.map((r) => [r.tag, r.notes]), [['v2.0.0', `${MARK}\n`]]);
  } finally {
    await rm(s.runDir);
  }
});

test('release exit finds the release it created before a crash', async () => {
  const s = await setup({ prepare: { tag: 'v1.2.0' } });
  try {
    const gh = new FakeGh({ readFile: readBody });
    gh.releases.push({ repo: REPO, tag: 'v1.2.0', target: SHA, notes: `Notes.\n\n${MARK}\n`, url: `https://${REPO}/releases/tag/v1.2.0` });
    const out = await mk(s, gh)(step, s.ctx, s.io);
    assert.equal(out.status, 'pass');
    assert.equal(gh.calls.filter((c) => c.method === 'createRelease').length, 0);
    assert.equal(gh.releases.length, 1);
    assert.equal(await fs.readFile(path.join(s.io.outputsDir, 'release_url.md'), 'utf8'), `https://${REPO}/releases/tag/v1.2.0\n`);
  } finally {
    await rm(s.runDir);
  }
});

test('a tag another release already has escalates and creates nothing', async () => {
  const s = await setup({ prepare: { tag: 'v1.2.0' } });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const url = `https://${REPO}/releases/tag/v1.2.0`;
    gh.releases.push({ repo: REPO, tag: 'v1.2.0', target: SHA, notes: 'Hand-made.\n<!-- percolator:release run=r0 -->\n', url });
    const out = await mk(s, gh)(step, s.ctx, s.io);
    assert.deepEqual(out, {
      status: 'escalate',
      outputs: {},
      reason: `github.release: tag "v1.2.0" already has a release (${url}); pick another tag and resume`,
    });
    assert.equal(gh.calls.filter((c) => c.method === 'createRelease').length, 0);
    assert.equal(await fs.stat(path.join(s.io.outputsDir, 'release_url.md')).then(() => true, () => false), false);
  } finally {
    await rm(s.runDir);
  }
});

test('an invalid tag escalates', async () => {
  const s = await setup({ prepare: { tag: '-v1 --draft' } });
  try {
    const gh = new FakeGh({ readFile: readBody });
    const pushes: string[][] = [];
    const out = await mk(s, gh, { pushes })(step, s.ctx, s.io);
    assert.deepEqual(out, { status: 'escalate', outputs: {}, reason: 'github.release: tag "-v1 --draft" is not a valid tag name' });
    assert.deepEqual(pushes, []);
    assert.deepEqual(gh.calls, []);
  } finally {
    await rm(s.runDir);
  }
});
