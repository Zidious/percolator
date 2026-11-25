import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitListItems, splitSections } from '../../src/util/sections.ts';

test('splitSections splits on h2 and skips code fences', () => {
  const md = [
    'Intro text that is ignored.',
    '',
    '## First issue  ',
    '',
    'Body one.',
    '```sh',
    '## not a heading',
    '```',
    '### a sub-heading stays in the body',
    '',
    '##Second without a space is body text',
    '## Second issue',
    '~~~',
    '## also not a heading',
    '~~~',
    '  ## indented is body text',
    '',
  ].join('\n');
  assert.deepEqual(splitSections(md), [
    {
      title: 'First issue',
      body: 'Body one.\n```sh\n## not a heading\n```\n### a sub-heading stays in the body\n\n##Second without a space is body text',
    },
    { title: 'Second issue', body: '~~~\n## also not a heading\n~~~\n  ## indented is body text' },
  ]);
});

test('splitSections reads CRLF and gives nothing without a heading', () => {
  assert.deepEqual(splitSections('## A\r\nbody\r\n## B\r\n'), [{ title: 'A', body: 'body' }, { title: 'B', body: '' }]);
  assert.deepEqual(splitSections('no headings\n```\n## fenced\n```\n'), []);
  assert.deepEqual(splitSections(''), []);
});

test('splitSections strips a closing ## sequence and keeps a bare heading as an empty title', () => {
  assert.deepEqual(splitSections('## Title ##\nA\n## C# tips\nB\n## Spaced  ###   \nC\n## ##\nD\n## \nE\n'), [
    { title: 'Title', body: 'A' },
    { title: 'C# tips', body: 'B' },
    { title: 'Spaced', body: 'C' },
    { title: '', body: 'D' },
    { title: '', body: 'E' },
  ]);
});

test('splitSections reads a bare ## and a tab after ## as headings', () => {
  assert.deepEqual(splitSections('## One\nA\n##\tTwo\nB\n##\nC\n'), [
    { title: 'One', body: 'A' },
    { title: 'Two', body: 'B' },
    { title: '', body: 'C' },
  ]);
});

test('splitListItems: one item per top-level numbered item, with its continuation lines and nested bullets', () => {
  assert.deepEqual(splitListItems('1. A\n   more A\n   - sub\n\n2. B\n'), ['1. A\n   more A\n   - sub', '2. B']);
});

test('splitListItems: intro text before item 1 is its own first item; a paragraph after the last item stays in it', () => {
  assert.deepEqual(splitListItems('Found these:\n\n1. A\n2. B\n\nAlso check B again.'), ['Found these:', '1. A', '2. B\n\nAlso check B again.']);
});

test('splitListItems: any number, . or ), one item per marker', () => {
  assert.deepEqual(splitListItems('1. A\n1. B\n1. C'), ['1. A', '1. B', '1. C']);
  assert.deepEqual(splitListItems('3) A\n4) B'), ['3) A', '4) B']);
});

test('splitListItems: a list nested at the continuation indent stays in its item', () => {
  assert.deepEqual(splitListItems('1. A\n   1. step one\n   2. step two\n2. B'), ['1. A\n   1. step one\n   2. step two', '2. B']);
});

test('splitListItems: the first marker sets the top level, so an indented list splits too', () => {
  assert.deepEqual(splitListItems('  1. A\n  2. B'), ['1. A', '2. B']);
});

test('splitListItems: marker-like lines inside a fenced block do not split', () => {
  assert.deepEqual(splitListItems('1. A\n```\n2. not an item\n```\n2. B'), ['1. A\n```\n2. not an item\n```', '2. B']);
});

test('splitListItems: no marker is one item, blank is none; 2024.x is not a marker without a space', () => {
  assert.deepEqual(splitListItems('just text\nmore'), ['just text\nmore']);
  assert.deepEqual(splitListItems(' \n'), []);
  assert.deepEqual(splitListItems('v2.5 is out'), ['v2.5 is out']);
});

test('splitListItems: a numbered list nested under a bullet is not the top level, so the text stays one item', () => {
  const md = '# Review\n\n- Bug A\n   1. repro step\n   2. second step\n- Bug B\n';
  assert.deepEqual(splitListItems(md), [md.trim()]);
});

test('splitListItems: a numbered list indented under a paragraph line is not the top level, so the text stays one item', () => {
  const md = 'Summary: two issues, see steps.\n   1. run it\n   2. see it fail\n';
  assert.deepEqual(splitListItems(md), [md.trim()]);
});

test('splitListItems: a heading ends an item, and an item that is only headings is dropped', () => {
  assert.deepEqual(splitListItems('### Bugs\n1. a\n2. b\n### Nits\n1. c\n'), ['1. a', '2. b', '1. c']);
});

test('splitListItems: headings without any marker keep the text one item', () => {
  assert.deepEqual(splitListItems('### Bugs\nnone\n### Nits\nnone'), ['### Bugs\nnone\n### Nits\nnone']);
});

test('splitListItems: a bullet summary before a column-0 list is intro text, not the list parent', () => {
  assert.deepEqual(splitListItems('Summary:\n- 2 bugs, 1 nit\n\n1. **Bug A**\n   x\n2. **Bug B**\n'), [
    'Summary:\n- 2 bugs, 1 nit',
    '1. **Bug A**\n   x',
    '2. **Bug B**',
  ]);
});

test('splitListItems: a thematic break is not a bullet', () => {
  assert.deepEqual(splitListItems('* * *\n\n1. A\n2. B'), ['* * *', '1. A', '2. B']);
  assert.deepEqual(splitListItems('- - -\n\n1. A\n2. B'), ['- - -', '1. A', '2. B']);
});
