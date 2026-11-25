import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { pipeWriter } from '../../src/util/pipe.ts';

function sink(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, chunks };
}

const errWith = (code: string) => Object.assign(new Error(`write ${code}`), { code });

test('pipeWriter drops writes after EPIPE', () => {
  const { stream, chunks } = sink();
  const write = pipeWriter(stream);
  write('a');
  stream.emit('error', errWith('EPIPE'));
  write('b');
  assert.deepEqual(chunks, ['a']);
});

test('pipeWriter surfaces other write errors', () => {
  const { stream } = sink();
  pipeWriter(stream);
  assert.throws(() => stream.emit('error', errWith('EIO')), /EIO/);
});

test('pipeWriter drops writes after write throws EPIPE', () => {
  const chunks: string[] = [];
  let fail = true;
  const stream = {
    on() { return stream; },
    write(s: string) {
      if (fail) { fail = false; throw errWith('EPIPE'); }
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const write = pipeWriter(stream);
  write('a');
  write('b');
  assert.deepEqual(chunks, []);
});
