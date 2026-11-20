import assert from 'node:assert/strict';
import test from 'node:test';
import { cliHc, HcError } from '../../src/herdr/hc.ts';
import { ExecRecorder } from '../helpers/exec-recorder.ts';

const notFound = JSON.stringify({ error: { kind: 'not_found', message: 'no terminal "x"', hint: 'see' } });

test('cliHc.run builds argv with labels and -- before the program', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"address":"t9","first_message":{"sent":false}}' });
  const hc = cliHc({ exec: rec.exec });
  const res = await hc.run({
    name: 'p-1',
    cwd: 'C:\\My Repo',
    argv: ['claude', '--model', 'opus', 'Your task…'],
    labels: { 'herdr.space': 's1' },
  });
  assert.deepEqual(rec.calls[0]!.args, [
    'run', '--bg', '--json', '--name', 'p-1', '--cwd', 'C:\\My Repo',
    '--label', 'herdr.space=s1', '--', 'claude', '--model', 'opus', 'Your task…',
  ]);
  assert.equal(rec.calls[0]!.file, 'hc');
  assert.deepEqual(res, { address: 't9', firstMessageSent: false });
});

test('cliHc.run adds --outlive-parent', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { stdout: '{"address":"t9"}' });
  await cliHc({ exec: rec.exec }).run({ name: 'a', cwd: '.', argv: ['x'], outliveParent: true });
  assert.deepEqual(rec.calls[0]!.args.slice(0, 9), ['run', '--bg', '--json', '--name', 'a', '--cwd', '.', '--outlive-parent', '--']);
});

test('cliHc.run rejects invalid names and option-like programs', async () => {
  const hc = cliHc({ exec: new ExecRecorder().exec });
  await assert.rejects(hc.run({ name: 'Plan.0', cwd: '.', argv: ['x'] }), { message: 'invalid hc terminal name "Plan.0"' });
  const long = 'a'.repeat(33);
  await assert.rejects(hc.run({ name: long, cwd: '.', argv: ['x'] }), { message: `invalid hc terminal name "${long}"` });
  await assert.rejects(hc.run({ name: 'ok', cwd: '.', argv: ['-x'] }), /must not start with "-"/);
  await assert.rejects(hc.run({ name: 'ok', cwd: '.', argv: [] }), /argv must not be empty/);
});

test('cliHc.get maps fields and returns undefined on not_found', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a.includes('perc-probe'), {
    stdout: '{"address":"t1b","argv":["node"],"exit_code":0,"name":"perc-probe","state":"finished","status":null,"turn":0,"labels":{}}',
  });
  rec.respond((a) => a.includes('x'), { code: 3, stderr: notFound });
  const hc = cliHc({ exec: rec.exec });
  const t = await hc.get('perc-probe');
  assert.equal(t?.exitCode, 0);
  assert.equal(t?.state, 'finished');
  assert.equal(t?.status, null);
  assert.equal(t?.address, 't1b');
  assert.deepEqual(rec.calls[0]!.args, ['get', '--json', '--', 'perc-probe']);
  assert.equal(await hc.get('x'), undefined);
});

test('cliHc.wait and read build argv and map results', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a[0] === 'wait', {
    stdout: '{"children":[],"ended":true,"exit_code":0,"reason":"exit","signal":null,"status":null,"terminal":"t1b","turn":0}',
  });
  rec.respond((a) => a[0] === 'read', { stdout: '{"complete":true,"how":"screen","text":"hi"}' });
  const hc = cliHc({ exec: rec.exec });
  assert.deepEqual(await hc.wait('t1b', { timeoutS: 5 }), { reason: 'exit', ended: true, exitCode: 0, status: null });
  assert.deepEqual(rec.calls[0]!.args, ['wait', '--json', '--timeout', '5', '--', 't1b']);
  assert.equal(await hc.read('t1b', 20), 'hi');
  assert.deepEqual(rec.calls[1]!.args, ['read', '--json', '--lines', '20', '--', 't1b']);
});

test('cliHc surfaces hc errors with kind and message', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a[0] === 'wait', { code: 9, stderr: JSON.stringify({ error: { kind: 'blocked', message: 'agent blocked', hint: 'h' } }) });
  rec.respond((a) => a[0] === 'read', { code: 1, stderr: ' boom \n' });
  const hc = cliHc({ exec: rec.exec });
  await assert.rejects(hc.wait('t'), (e: unknown) => {
    assert.ok(e instanceof HcError);
    assert.equal(e.message, 'hc wait failed: agent blocked (blocked)');
    assert.equal(e.kind, 'blocked');
    assert.equal(e.exitCode, 9);
    assert.equal(e.hint, 'h');
    return true;
  });
  await assert.rejects(hc.read('t', 1), { message: 'hc read failed: boom (unknown)' });
});

test('cliHc.kill ignores an already finished terminal; rm ignores not_found', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a[0] === 'kill', { code: 11, stderr: JSON.stringify({ error: { kind: 'finished', message: 'done' } }) });
  rec.respond((a) => a[0] === 'rm', { code: 3, stderr: notFound });
  const hc = cliHc({ exec: rec.exec });
  await hc.kill('t');
  await hc.rm('t');
  assert.deepEqual(rec.calls[0]!.args, ['kill', '--json', '--', 't']);
  assert.deepEqual(rec.calls[1]!.args, ['rm', '--json', '--', 't']);
});

test('cliHc.kill still throws other errors', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, { code: 9, stderr: JSON.stringify({ error: { kind: 'blocked', message: 'no' } }) });
  await assert.rejects(cliHc({ exec: rec.exec }).kill('t'), { message: 'hc kill failed: no (blocked)' });
});

test('cliHc.list passes label filters and --all and parses terminals', async () => {
  const rec = new ExecRecorder();
  rec.respond((a) => a[0] === 'ls', {
    stdout: JSON.stringify({
      terminals: [
        { address: 't1', name: 'a', state: 'live', status: 'working', turn: 2 },
        { address: 't2', name: 'b', state: 'finished', exit_code: 0, labels: { 'percolator.run': 'r1' } },
      ],
    }),
  });
  const hc = cliHc({ exec: rec.exec });
  const ts = await hc.list({ labels: { 'percolator.run': 'r1' }, all: true });
  assert.deepEqual(rec.calls[0]!.args, ['ls', '--json', '--all', '--label', 'percolator.run=r1']);
  assert.equal(ts.length, 2);
  assert.deepEqual(ts[0], { address: 't1', name: 'a', state: 'live', status: 'working', exitCode: null, turn: 2, labels: {} });
  assert.equal(ts[1]!.exitCode, 0);
  assert.deepEqual(ts[1]!.labels, { 'percolator.run': 'r1' });
  await hc.list();
  assert.deepEqual(rec.calls[1]!.args, ['ls', '--json']);
});

test('cliHc.get returns labels', async () => {
  const rec = new ExecRecorder();
  rec.respond(() => true, {
    stdout: '{"address":"t1","name":"n","state":"live","status":null,"turn":0,"labels":{"percolator.run":"r1","herdr.space":"s1"}}',
  });
  const t = await cliHc({ exec: rec.exec }).get('n');
  assert.deepEqual(t?.labels, { 'percolator.run': 'r1', 'herdr.space': 's1' });
});
