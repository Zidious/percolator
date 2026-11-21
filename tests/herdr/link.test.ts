import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { herdrAppHome, linkHerdr } from '../../src/herdr/link.ts';

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-link-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('herdrAppHome prefers HERDR_APP_HOME, else <home>/.config/herdr-app', () => {
  assert.equal(herdrAppHome({ HERDR_APP_HOME: '/x/app' }, '/h'), '/x/app');
  assert.equal(herdrAppHome({}, '/h'), path.join('/h', '.config', 'herdr-app'));
  assert.equal(herdrAppHome({ HERDR_APP_HOME: '' }, '/h'), path.join('/h', '.config', 'herdr-app'));
});

test('linkHerdr writes perc.json into the existing mod folder and returns its path', async () => {
  const appHome = path.join(tmp, 'ok');
  await fs.mkdir(path.join(appHome, 'mods', 'percolator'), { recursive: true });
  const file = await linkHerdr({ appHome, node: '/n/node', cli: '/c/cli.ts' });
  assert.equal(file, path.join(appHome, 'mods', 'percolator', 'perc.json'));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { node: '/n/node', cli: '/c/cli.ts' });
});

test('linkHerdr without a Herdr config says to install Herdr', async () => {
  const appHome = path.join(tmp, 'missing');
  await assert.rejects(
    linkHerdr({ appHome, node: 'n', cli: 'c' }),
    { message: `perc herdr link: no Herdr config at ${appHome}; install Herdr first` },
  );
});

test('linkHerdr without the mod folder does not create it', async () => {
  const appHome = path.join(tmp, 'nomod');
  await fs.mkdir(appHome, { recursive: true });
  await assert.rejects(linkHerdr({ appHome, node: 'n', cli: 'c' }), {
    message: `perc herdr link: ${path.join(appHome, 'mods', 'percolator')} not found; add the Percolator layout to Herdr first (see herdr/RECIPE.md)`,
  });
  await assert.rejects(fs.stat(path.join(appHome, 'mods')));
});
