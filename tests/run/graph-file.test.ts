import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildGraph } from '../../src/graph/build.ts';
import { mergePipelines } from '../../src/graph/merge.ts';
import { readRunGraph, toRunGraph, writeRunGraph } from '../../src/run/graph-file.ts';
import { validate } from '../../src/validate.ts';
import { setupRunEnv } from '../helpers/run-env.ts';

async function defaultGraph() {
  const e = await setupRunEnv();
  try {
    const v = await validate({ configFile: e.configFile, cwd: e.root, home: e.home, profile: 'work' });
    return v.graph;
  } finally {
    await e.cleanup();
  }
}

test('toRunGraph maps the default graph', async () => {
  const rg = toRunGraph(await defaultGraph());
  assert.equal(rg.version, 1);
  assert.deepEqual(
    rg.steps.map((s) => [s.id, s.stage, s.role, s.kind]),
    [
      ['intake', 'intake', 'core', 'builtin'],
      ['groom', 'groom', 'core', 'script'],
      ['approve-groom', 'groom', 'node', 'gate'],
      ['plan', 'plan', 'core', 'script'],
      ['implement', 'implement', 'core', 'script'],
      ['review', 'review', 'core', 'script'],
      ['deliver', 'deliver', 'core', 'builtin'],
    ],
  );
  assert.ok(rg.loops.some((l) => l.id === 'review' && l.from === 'review' && l.to === 'implement' && l.max === 3 && l.atCap === 'continue'));
  assert.ok(rg.loops.some((l) => l.id === 'approve-groom' && l.from === 'approve-groom' && l.to === 'groom' && l.atCap === 'escalate'));
});

test("a router's pick-pipeline gate records the pipelines it may pick, and round-trips", async () => {
  const triage = mergePipelines([
    {
      source: 'profile:default',
      fragment: { pipelines: { triage: { router: true, stages: ['intake', 'route'], choose: { agent: 'claude', from: ['hotfix', 'feature'] } } } },
      locator: { file: 'c.yaml', lines: {}, prefix: 'profiles.default' },
    },
  ]).triage!;
  const g = buildGraph(triage);
  const rg = toRunGraph(g);
  assert.deepEqual(rg.steps.find((s) => s.id === 'pick-pipeline'), { id: 'pick-pipeline', stage: 'route', role: 'core', kind: 'gate', choices: ['hotfix', 'feature'] });
  assert.ok(rg.steps.filter((s) => s.id !== 'pick-pipeline').every((s) => !('choices' in s)));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-graph-'));
  try {
    await writeRunGraph(dir, g);
    assert.deepEqual(await readRunGraph(dir), rg);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readRunGraph returns undefined when absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-graph-'));
  try {
    assert.equal(await readRunGraph(dir), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeRunGraph then readRunGraph round-trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-graph-'));
  try {
    const g = await defaultGraph();
    await writeRunGraph(dir, g);
    assert.deepEqual(await readRunGraph(dir), toRunGraph(g));
    assert.ok((await fs.readFile(path.join(dir, 'graph.json'), 'utf8')).endsWith('}\n'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readRunGraph rejects a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-graph-'));
  try {
    const file = path.join(dir, 'graph.json');
    await fs.writeFile(file, '{"version":1,"steps":"x"}\n');
    await assert.rejects(
      readRunGraph(dir),
      (err: Error) => err.message === `Run graph ${file} is invalid: steps: Invalid input: expected array, received string; start a new run`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readRunGraph names a root-level problem "value"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-graph-'));
  try {
    const file = path.join(dir, 'graph.json');
    await fs.writeFile(file, '[]\n');
    await assert.rejects(readRunGraph(dir), {
      message: `Run graph ${file} is invalid: value: Invalid input: expected object, received array; start a new run`,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('toRunGraph lists the implicit loop of a gate without on_fail', () => {
  const merged = mergePipelines([
    {
      source: 'profile:default',
      fragment: {
        pipelines: {
          feature: {
            bindings: {
              intake: { builtin: 'github.intake' },
              groom: { agent: 'claude' },
              plan: { agent: 'claude' },
              implement: { agent: 'claude' },
              review: { agent: 'claude' },
              deliver: { builtin: 'github.open_pr' },
            },
            nodes: { 'approve-plan': { kind: 'gate', after: 'plan' } },
          },
        },
      },
      locator: { file: 'c.yaml', lines: {}, prefix: 'profiles.default' },
    },
  ]).feature!;
  const rg = toRunGraph(buildGraph(merged));
  assert.deepEqual(rg.loops.find((l) => l.id === 'approve-plan'), { id: 'approve-plan', from: 'approve-plan', to: 'plan', max: 3, atCap: 'escalate' });
});
