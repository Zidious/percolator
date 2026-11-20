import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isDirectRun } from '../../src/util/entry.ts';

const execFileP = promisify(execFile);
const cliTs = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.ts');

async function withSymlink(fn: (link: string) => Promise<void>): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-link-'));
  try {
    // A directory link (junction on Windows, needs no privilege) makes argv1 differ from the real path.
    const linkDir = path.join(dir, 'bin');
    try {
      await fs.symlink(path.dirname(cliTs), linkDir, 'junction');
    } catch {
      return false;
    }
    await fn(path.join(linkDir, 'cli.ts'));
    return true;
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('isDirectRun is true for the module path itself', () => {
  assert.equal(isDirectRun(cliTs, pathToFileURL(cliTs).href), true);
});

test('isDirectRun is false for another file or a missing argv1', () => {
  assert.equal(isDirectRun(import.meta.filename, pathToFileURL(cliTs).href), false);
  assert.equal(isDirectRun(undefined, pathToFileURL(cliTs).href), false);
  assert.equal(isDirectRun(path.join(os.tmpdir(), 'does-not-exist-perc'), pathToFileURL(cliTs).href), false);
});

test('isDirectRun follows a symlinked bin', async (t) => {
  const ran = await withSymlink(async (link) => {
    assert.equal(isDirectRun(link, pathToFileURL(cliTs).href), true);
  });
  if (!ran) t.skip('cannot create symlinks here');
});

test('perc --help works when invoked through a symlink', async (t) => {
  const ran = await withSymlink(async (link) => {
    const { stdout } = await execFileP(process.execPath, [link, '--help']);
    assert.match(stdout, /usage: perc/i);
  });
  if (!ran) t.skip('cannot create symlinks here');
});

test('pnpm schema (json-schema.ts) runs when invoked through a symlink', async (t) => {
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-schema-')), 's.json');
  try {
    const ran = await withSymlink(async (link) => {
      await execFileP(process.execPath, [path.join(path.dirname(link), 'config', 'json-schema.ts'), out]);
      assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).type, 'object');
    });
    if (!ran) t.skip('cannot create symlinks here');
  } finally {
    await fs.rm(path.dirname(out), { recursive: true, force: true, maxRetries: 5 });
  }
});
