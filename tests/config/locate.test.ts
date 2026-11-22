import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineCounter, parseDocument } from 'yaml';
import { indexLines, lineOf, locate, place } from '../../src/config/locate.ts';

const index = (text: string) => {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  return indexLines(doc, lineCounter);
};

test('indexLines indexes block map keys at the key line', () => {
  assert.deepEqual(index('a:\n  b:\n    c: 1\n'), { a: 1, 'a.b': 2, 'a.b.c': 3 });
});

test('indexLines indexes sequence items and flow collections on their own line', () => {
  const lines = index('use:\n  - { from: x, file: y }\n  - { from: z, file: w }\nlist: [p, q]\n');
  assert.equal(lines['use.0'], 2);
  assert.equal(lines['use.0.from'], 2);
  assert.equal(lines['use.0.file'], 2);
  assert.equal(lines['use.1.from'], 3);
  assert.equal(lines.list, 4);
  assert.equal(lines['list.1'], 4);
});

test('indexLines tolerates anchors, aliases and merge keys', () => {
  const lines = index('base: &b { x: 1 }\nuse: *b\nm:\n  <<: *b\n  y: 2\n');
  assert.equal(lines['m.y'], 5);
});

test('lineOf falls back to the nearest ancestor', () => {
  assert.equal(lineOf({ a: 1, 'a.b': 2 }, 'a.b.c.d'), 2);
  assert.equal(lineOf({}, 'x'), undefined);
  assert.equal(lineOf({ a: 1 }, ''), undefined);
});

test('locate joins the prefix and looks the line up', () => {
  assert.deepEqual(
    locate({ file: 'c.yaml', lines: { 'profiles.w': 3, 'profiles.w.bindings': 4 }, prefix: 'profiles.w' }, 'fb', 'bindings.plan'),
    { file: 'c.yaml', line: 4, path: 'profiles.w.bindings.plan' },
  );
  assert.deepEqual(locate(undefined, 'fb', 'bindings.plan'), { file: 'fb', path: 'bindings.plan' });
  assert.deepEqual(locate({ file: 'c.yaml', lines: { 'profiles.w': 3 }, prefix: 'profiles.w' }, 'fb'), {
    file: 'c.yaml',
    line: 3,
    path: 'profiles.w',
  });
});

test('place gives file:line, or the file alone', () => {
  assert.equal(place({ file: 'c.yaml', line: 4 }), 'c.yaml:4');
  assert.equal(place({ file: 'fb' }), 'fb');
});
