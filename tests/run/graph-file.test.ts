import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
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
