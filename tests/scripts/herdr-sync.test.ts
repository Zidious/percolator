import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { syncMods } from '../../scripts/herdr-sync.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perc-herdr-sync-'));
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tree = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();

function setup() {
  const src = tmp();
  const home = tmp();
  put(path.join(src, 'percolator', 'main.js'), 'new main');
  put(path.join(src, 'percolator', 'art', 'glyph.svg'), 'glyph');
  put(path.join(src, 'percolator-cup', 'main.js'), 'cup main');
  return { src, home };
}

test('syncMods mirrors each mod: copies every source file and removes installed files the source no longer has', () => {
  const { src, home } = setup();
  const mod = path.join(home, 'mods', 'percolator');
  put(path.join(mod, 'main.js'), 'old main');
  put(path.join(mod, 'train.js'), 'stale');
  put(path.join(mod, 'old', 'train.svg'), 'stale');
  put(path.join(mod, 'art', 'gone.svg'), 'stale');
  const said = syncMods(src, home);
  assert.deepEqual(tree(mod), ['art/glyph.svg', 'main.js']);
  assert.equal(fs.readFileSync(path.join(mod, 'main.js'), 'utf8'), 'new main');
  assert.deepEqual(tree(path.join(home, 'mods', 'percolator-cup')), ['main.js']);
  assert.deepEqual(said, [
    `synced percolator -> ${mod} (removed art/gone.svg, old, train.js)`,
    `synced percolator-cup -> ${path.join(home, 'mods', 'percolator-cup')}`,
  ]);
});

test('syncMods keeps perc.json and leaves other mods alone', () => {
  const { src, home } = setup();
  put(path.join(home, 'mods', 'percolator', 'perc.json'), '{"fixtures": "x"}');
  put(path.join(home, 'mods', 'other', 'main.js'), 'theirs');
  syncMods(src, home);
  assert.equal(fs.readFileSync(path.join(home, 'mods', 'percolator', 'perc.json'), 'utf8'), '{"fixtures": "x"}');
  assert.equal(fs.readFileSync(path.join(home, 'mods', 'other', 'main.js'), 'utf8'), 'theirs');
});
