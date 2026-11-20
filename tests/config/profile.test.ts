import { expect, test } from 'vitest';
import { ConfigError } from '../../src/config/load.ts';
import { normalizeRemote, selectProfile } from '../../src/config/profile.ts';
import type { UserConfig } from '../../src/config/schema.ts';

const cfg: UserConfig = {
  version: 1,
  profiles: {
    personal: { match: { path: '~/dev/side/**' } },
    work: { match: { remote: ['github.com/acme/*', 'gitlab.com/acme-co/**'] } },
  },
};

test.each([
  'git@github.com:Acme/payments.git',
  'https://github.com/acme/payments',
  'https://github.com/acme/payments.git/',
  'ssh://git@github.com/acme/payments.git',
  'https://GitHub.com/Acme/Payments.GIT/',
  'https://user:token@github.com/acme/payments.git',
])('normalizeRemote(%s)', (u) => {
  expect(normalizeRemote(u)).toBe('github.com/acme/payments');
});

test.each([
  'ssh://git@github.com:2222/Acme/payments.git',
  'http://github.com/acme/payments.git',
  'git://github.com/acme/payments.git',
])('normalizeRemote(%s) with port or other scheme', (u) => {
  expect(normalizeRemote(u)).toBe('github.com/acme/payments');
});

test('pattern ending in /** also matches its base directory', () => {
  expect(selectProfile(cfg, { cwd: '/h/dev/side', home: '/h' }).name).toBe('personal');
});

test('remote glob selects work profile', () => {
  expect(selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' }).name).toBe('work');
});

test('remote glob is case-insensitive and any list entry matches', () => {
  expect(selectProfile(cfg, { remoteUrl: 'https://GitLab.com/Acme-Co/a/b.git', cwd: '/r' }).name).toBe('work');
});

test('returns the selected profile object', () => {
  const r = selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' });
  expect(r.profile).toBe(cfg.profiles.work);
});

test('path glob with ~ matches', () => {
  expect(selectProfile(cfg, { cwd: '/h/dev/side/thing', home: '/h' }).name).toBe('personal');
});

test('first profile in declaration order wins', () => {
  const both: UserConfig = {
    version: 1,
    profiles: {
      a: { match: { remote: 'github.com/acme/*' } },
      b: { match: { remote: 'github.com/acme/*' } },
    },
  };
  expect(selectProfile(both, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' }).name).toBe('a');
});

test.runIf(process.platform === 'win32')('path match ignores drive case and slashes', () => {
  expect(selectProfile(cfg, { cwd: 'C:\\h\\dev\\side\\t', home: 'c:/h' }).name).toBe('personal');
  expect(selectProfile(cfg, { cwd: 'C:\\H\\DEV\\side\\t', home: 'c:/h' }).name).toBe('personal');
});

test('override wins over matching', () => {
  const r = selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r', override: 'personal' });
  expect(r.name).toBe('personal');
});

test('unknown override errors and lists profiles', () => {
  const err = (() => {
    try {
      selectProfile(cfg, { cwd: '/r', override: 'nope', configFile: 'my.yaml' });
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toMatch(/nope/);
  expect((err as ConfigError).message).toMatch(/personal, work/);
  expect((err as ConfigError).file).toBe('my.yaml');
});

test('no match errors and lists profiles', () => {
  expect(() => selectProfile(cfg, { cwd: '/nowhere' })).toThrow(/personal, work/);
  expect(() => selectProfile(cfg, { cwd: '/nowhere' })).toThrow(ConfigError);
});
