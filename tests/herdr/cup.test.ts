import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Herdr refuses imports from outside a mod's folder, so the cup carries copies of the panel's shared modules.
const MODS = path.resolve(import.meta.dirname, '..', '..', 'herdr', 'mods');
const SHARED = ['status.js', 'mark.js', 'source.js'];

for (const file of SHARED) {
  test(`the cup's ${file} is the panel's ${file}`, () => {
    const panel = fs.readFileSync(path.join(MODS, 'percolator', file), 'utf8');
    const cup = fs.readFileSync(path.join(MODS, 'percolator-cup', file), 'utf8');
    assert.equal(cup, panel, `copy herdr/mods/percolator/${file} to herdr/mods/percolator-cup/${file}`);
  });
}

test("the cup carries no copy of the panel's model.js (status.js holds what it needs)", () => {
  assert.equal(fs.existsSync(path.join(MODS, 'percolator-cup', 'model.js')), false, 'delete herdr/mods/percolator-cup/model.js');
});
