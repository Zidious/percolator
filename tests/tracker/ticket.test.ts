import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicket, parsePr, formatTicket } from '../../src/tracker/ticket.ts';

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

test('parseTicket refuses path-like or invalid owner, repo, host and number', () => {
  const refs = [
    'o/..#1',
    'o/.#1',
    '../r#1',
    'o/..\\..\\..\\..\\Temp#1',
    '-x/r#1',
    'o/-r#1',
    '#0',
    '0',
    'o/r#0',
    'bad_host/o/r#1',
    'https://github.com/o/../issues/1',
    'https://github.com/o/r/issues/0',
    'https://gh\\x/o/r/issues/1',
  ];
  for (const ref of refs) {
    assert.throws(
      () => parseTicket(ref, D),
      { message: `cannot read ticket "${ref}": use #123, owner/repo#123 or an issue URL` },
      ref,
    );
  }
});

test('parseTicket accepts a host with a port', () => {
  assert.deepEqual(parseTicket('https://ghe.acme.com:8443/a/b/issues/7'), { repo: 'ghe.acme.com:8443/a/b', number: 7 });
});

test('parseTicket checks the default repo the same way', () => {
  for (const def of ['github.com/o/..', 'github.com/-x/r', 'c/users/me/origin', 'o/r']) {
    assert.throws(
      () => parseTicket('#5', def),
      { message: 'cannot read ticket "#5": use #123, owner/repo#123 or an issue URL' },
      def,
    );
  }
});

test('parsePr reads a pull URL', () => {
  assert.deepEqual(parsePr('https://github.com/A/b/pull/9/', D), { repo: 'github.com/a/b', number: 9 });
  assert.deepEqual(parsePr('https://ghe.acme.com/a/b/pull/3#discussion_r1'), { repo: 'ghe.acme.com/a/b', number: 3 });
  assert.deepEqual(parsePr('a/b#7'), { repo: 'github.com/a/b', number: 7 });
  assert.deepEqual(parsePr('#4', D), { repo: D, number: 4 });
});

test('parsePr refuses an issue URL', () => {
  const ref = 'https://github.com/a/b/issues/3';
  assert.throws(() => parsePr(ref, D), { message: `"${ref}" is an issue, not a pull request` });
});

test('parsePr names pull requests in its other errors', () => {
  assert.throws(() => parsePr('#4'), {
    message: 'pull request "#4" needs a repository: run inside a clone with a GitHub origin, or use owner/repo#123',
  });
  for (const ref of ['foo', 'o/..#1', 'https://github.com/a/b/pull/0']) {
    assert.throws(
      () => parsePr(ref, D),
      { message: `cannot read pull request "${ref}": use #123, owner/repo#123 or a pull request URL` },
      ref,
    );
  }
});
