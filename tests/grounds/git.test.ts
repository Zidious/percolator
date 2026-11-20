import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gitEnv, runGit } from '../../src/grounds/git.ts';

test('runGit reports a failing command with redacted urls', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-rungit-'));
  try {
    await assert.rejects(runGit(['rev-parse', '--show-toplevel'], tmp), (e: unknown) => {
      assert.match((e as Error).message, /^git rev-parse --show-toplevel failed:/);
      return true;
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('gitEnv disables prompts', () => {
  const env = gitEnv();
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.PATH, process.env.PATH);
});
