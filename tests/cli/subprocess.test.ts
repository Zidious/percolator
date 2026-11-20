import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..', '..');
const fx = (p: string) => path.join(root, 'tests', 'fixtures', p);

test('perc validate exits 1 and prints unbound stages on stderr', async () => {
  await assert.rejects(
    execFileP(process.execPath, ['src/cli.ts', 'validate', '--config', fx('e2e/unbound.yaml'), '--profile', 'work'], { cwd: root }),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr ?? '', /unbound/i);
      return true;
    },
  );
});

test('perc validate succeeds on the e2e fixture', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    ['src/cli.ts', 'validate', '--config', fx('e2e/config.yaml'), '--profile', 'work'],
    { cwd: root },
  );
  assert.match(stdout, /^profile: work$/m);
});
