import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSections } from '../../src/util/sections.ts';

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
