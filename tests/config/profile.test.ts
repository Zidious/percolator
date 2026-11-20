import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
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

for (const u of [
  'git@github.com:Acme/payments.git',
  'https://github.com/acme/payments',
  'https://github.com/acme/payments.git/',
  'ssh://git@github.com/acme/payments.git',
  'https://GitHub.com/Acme/Payments.GIT/',
  'https://user:token@github.com/acme/payments.git',
]) {
  test(`normalizeRemote(${u})`, () => {
    assert.equal(normalizeRemote(u), 'github.com/acme/payments');
  });
}

for (const u of [
  'ssh://git@github.com:2222/Acme/payments.git',
  'http://github.com/acme/payments.git',
  'git://github.com/acme/payments.git',
]) {
  test(`normalizeRemote(${u}) with port or other scheme`, () => {
    assert.equal(normalizeRemote(u), 'github.com/acme/payments');
  });
}

test('pattern ending in /** also matches its base directory', () => {
  assert.equal(selectProfile(cfg, { cwd: '/h/dev/side', home: '/h' }).name, 'personal');
});

test('remote glob selects work profile', () => {
  assert.equal(selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' }).name, 'work');
});

test('remote glob is case-insensitive and any list entry matches', () => {
  assert.equal(selectProfile(cfg, { remoteUrl: 'https://GitLab.com/Acme-Co/a/b.git', cwd: '/r' }).name, 'work');
});

test('returns the selected profile object', () => {
  const r = selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' });
  assert.equal(r.profile, cfg.profiles.work);
});

test('path glob with ~ matches', () => {
  assert.equal(selectProfile(cfg, { cwd: '/h/dev/side/thing', home: '/h' }).name, 'personal');
});

test('first profile in declaration order wins', () => {
  const both: UserConfig = {
    version: 1,
    profiles: {
      a: { match: { remote: 'github.com/acme/*' } },
      b: { match: { remote: 'github.com/acme/*' } },
    },
  };
  assert.equal(selectProfile(both, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r' }).name, 'a');
});

test('path match ignores drive case and slashes', { skip: process.platform !== 'win32' }, () => {
  assert.equal(selectProfile(cfg, { cwd: 'C:\\h\\dev\\side\\t', home: 'c:/h' }).name, 'personal');
  assert.equal(selectProfile(cfg, { cwd: 'C:\\H\\DEV\\side\\t', home: 'c:/h' }).name, 'personal');
});

test('override wins over matching', () => {
  const r = selectProfile(cfg, { remoteUrl: 'git@github.com:acme/x.git', cwd: '/r', override: 'personal' });
  assert.equal(r.name, 'personal');
});

test('unknown override errors and lists profiles', () => {
  const err = (() => {
    try {
      selectProfile(cfg, { cwd: '/r', override: 'nope', configFile: 'my.yaml' });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof ConfigError);
  assert.match((err as ConfigError).message, /nope/);
  assert.match((err as ConfigError).message, /personal, work/);
  assert.equal((err as ConfigError).file, 'my.yaml');
});

test('no match errors and lists profiles', () => {
  assert.throws(() => selectProfile(cfg, { cwd: '/nowhere' }), /personal, work/);
  assert.throws(() => selectProfile(cfg, { cwd: '/nowhere' }), ConfigError);
});

async function linked(t: TestContext): Promise<{ base: string; real: string; link: string } | undefined> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-profile-'));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  await fs.mkdir(path.join(real, 'sub'), { recursive: true });
  try {
    await fs.symlink(real, link, 'junction');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlinks need privilege');
      return undefined;
    }
    throw err;
  }
  return { base, real, link };
}

const pathCfg = (p: string): UserConfig => ({ version: 1, profiles: { p: { match: { path: p } } } });

test('path match follows a symlinked cwd', async (t) => {
  const d = await linked(t);
  if (!d) return;
  const r = selectProfile(pathCfg(path.join(d.real, '**')), {
    cwd: path.join(d.link, 'sub'),
    realCwd: path.join(d.real, 'sub'),
  });
  assert.equal(r.name, 'p');
});

test('path match follows a symlinked pattern base', async (t) => {
  const d = await linked(t);
  if (!d) return;
  assert.equal(selectProfile(pathCfg(path.join(d.link, '**')), { cwd: d.real }).name, 'p');
});

test('path match is case-insensitive on darwin', () => {
  const c = pathCfg('/Users/Me/Dev/**');
  assert.equal(selectProfile(c, { cwd: '/users/me/dev/x', platform: 'darwin' }).name, 'p');
  assert.throws(() => selectProfile(c, { cwd: '/users/me/dev/x', platform: 'linux' }), /no profile matches this repository/);
});
