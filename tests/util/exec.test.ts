import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeExec } from '../../src/util/exec.ts';

test('nodeExec returns exit code and output without a shell', async () => {
  const r = await nodeExec(process.execPath, ['-e', 'process.stdout.write("a b"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'a b');
});

test('nodeExec passes an argument with spaces and quotes as one argument', async () => {
  const input = 'C:\\My Dir\\"x"';
  const r = await nodeExec(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', input]);
  assert.equal(r.stdout, input);
});

test('nodeExec reports a missing binary', async () => {
  await assert.rejects(nodeExec('perc-no-such-bin', []), { message: 'perc-no-such-bin not found on PATH' });
});
