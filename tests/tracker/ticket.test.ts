import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicket, formatTicket } from '../../src/tracker/ticket.ts';

const D = 'github.com/o/r';
const ok: [string, string | undefined, { repo: string; number: number }][] = [
  ['#123', D, { repo: D, number: 123 }],
  ['123', D, { repo: D, number: 123 }],
  ['a/b#7', undefined, { repo: 'github.com/a/b', number: 7 }],
  ['A/B#7', undefined, { repo: 'github.com/a/b', number: 7 }],
  ['ghe.acme.com/a/b#7', D, { repo: 'ghe.acme.com/a/b', number: 7 }],
  ['https://github.com/a/b/issues/9', undefined, { repo: 'github.com/a/b', number: 9 }],
  ['https://github.com/a/b/issues/9/', undefined, { repo: 'github.com/a/b', number: 9 }],
  ['https://github.com/a/b/issues/9#issuecomment-1', undefined, { repo: 'github.com/a/b', number: 9 }],
  ['https://github.com/a/b/issues/9?x=1', undefined, { repo: 'github.com/a/b', number: 9 }],
  ['https://ghe.acme.com/a/b/issues/7/', undefined, { repo: 'ghe.acme.com/a/b', number: 7 }],
];
for (const [ref, def, want] of ok) {
  test(`parseTicket accepts ${ref}`, () => assert.deepEqual(parseTicket(ref, def), want));
}

test('parseTicket needs a repository for bare numbers', () => {
  for (const ref of ['#123', '123']) {
    assert.throws(
      () => parseTicket(ref),
      { message: `ticket "${ref}" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123` },
    );
  }
});

test('parseTicket rejects pull requests', () => {
  const ref = 'https://github.com/a/b/pull/3';
  assert.throws(() => parseTicket(ref, D), { message: `"${ref}" is a pull request, not an issue` });
});

test('parseTicket rejects anything else', () => {
  for (const ref of ['', 'foo', 'a/b', '#0x', 'https://github.com/a/b']) {
    assert.throws(
      () => parseTicket(ref, D),
      { message: `cannot read ticket "${ref}": use #123, owner/repo#123 or an issue URL` },
    );
  }
});

test('formatTicket gives repo#n', () => {
  assert.equal(formatTicket({ repo: D, number: 5 }), 'github.com/o/r#5');
});
