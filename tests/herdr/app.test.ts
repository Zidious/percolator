import assert from 'node:assert/strict';
import test from 'node:test';
import { cliHerdrApp } from '../../src/herdr/app.ts';
import { ExecRecorder } from '../helpers/exec-recorder.ts';

test('newSpace sends one JSON argument and returns the space id', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"space":"s4","tab":"b1","pane":"p2","terminal":"t3"}' });
  const id = await cliHerdrApp({ exec: rec.exec }).newSpace('p-1', 'C:\My Repo');
  assert.equal(id, 's4');
  assert.equal(rec.calls[0]!.file, 'herdr-app');
  assert.equal(rec.calls[0]!.args.length, 3);
  assert.deepEqual(rec.calls[0]!.args.slice(0, 2), ['do', 'space.new']);
  assert.deepEqual(JSON.parse(rec.calls[0]!.args[2]!), { name: 'p-1', folder: 'C:\My Repo' });
});

test('newSpace reports app errors', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 1, stdout: '{"error":"no window"}' });
  await assert.rejects(
    cliHerdrApp({ exec: rec.exec }).newSpace('a', '.'),
    /^Error: herdr-app space\.new failed: no window$/,
  );
});

test('newSpace reports a reply without a space id', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"tab":"b1"}' });
  await assert.rejects(
    cliHerdrApp({ exec: rec.exec }).newSpace('a', '.'),
    /^Error: herdr-app space\.new returned no space id: \{"tab":"b1"\}$/,
  );
});
