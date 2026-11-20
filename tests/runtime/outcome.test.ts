import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectOutputs, readDone } from '../../src/runtime/outcome.ts';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'perc-outcome-'));
}
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });

test('readDone: absent, invalid (truncated JSON, unknown status), ok', async () => {
  const d = await tmp();
  try {
    const f = path.join(d, 'done.json');
    assert.deepEqual(await readDone(f), { kind: 'absent' });
    await fs.writeFile(f, '{"status":"pa');
    assert.equal((await readDone(f)).kind, 'invalid');
    await fs.writeFile(f, '{"status":"maybe"}');
    assert.equal((await readDone(f)).kind, 'invalid');
    await fs.writeFile(f, '{"status":"escalate","reason":"need a human","extra":1}');
    assert.deepEqual(await readDone(f), { kind: 'ok', status: 'escalate', reason: 'need a human' });
    await fs.writeFile(f, '{"status":"pass"}');
    assert.deepEqual(await readDone(f), { kind: 'ok', status: 'pass' });
  } finally {
    await rm(d);
  }
});

test('collectOutputs keys files by name, ignores empty files and subdirs, and reports duplicate keys', async () => {
  const d = await tmp();
  try {
    const out = path.join(d, 'steps', 's', '1', 'outputs');
    assert.deepEqual(await collectOutputs(out, d), { outputs: {} });
    await fs.mkdir(path.join(out, 'sub'), { recursive: true });
    await fs.writeFile(path.join(out, 'plan.md'), 'x');
    await fs.writeFile(path.join(out, 'empty.md'), '');
    await fs.writeFile(path.join(out, 'sub', 'n.md'), 'x');
    assert.deepEqual(await collectOutputs(out, d), { outputs: { plan: 'steps/s/1/outputs/plan.md' } });
    await fs.writeFile(path.join(out, 'plan.txt'), 'y');
    assert.deepEqual(await collectOutputs(out, d), {
      error: 'outputs/plan.md and outputs/plan.txt both produce "plan"',
    });
  } finally {
    await rm(d);
  }
});

test('collectOutputs ignores symlinks', async (t) => {
  const d = await tmp();
  try {
    const out = path.join(d, 'steps', 's', '1', 'outputs');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'plan.md'), 'x');
    try {
      await fs.symlink(path.join(out, 'plan.md'), path.join(out, 'link.md'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      t.skip('symlinks need privilege');
      return;
    }
    assert.ok((await fs.lstat(path.join(out, 'link.md'))).isSymbolicLink());
    assert.deepEqual(await collectOutputs(out, d), { outputs: { plan: 'steps/s/1/outputs/plan.md' } });
  } finally {
    await rm(d);
  }
});
