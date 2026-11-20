import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Plain files at the repo root (AGENTS.md, package.json, …); dot-dirs, dist/ and node_modules/ are not walked. */
async function rootFiles(): Promise<string[]> {
  return (await fs.readdir(ROOT, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(ROOT, e.name));
}

// A raw NUL makes git treat a file as binary, which also turns off its EOL normalization.
test('no file under src/, tests/, schema/ or the repo root contains a NUL byte', async () => {
  const files = [
    ...(await rootFiles()),
    ...(await filesUnder(path.join(ROOT, 'src'))),
    ...(await filesUnder(path.join(ROOT, 'tests'))),
    ...(await filesUnder(path.join(ROOT, 'schema'))),
  ];
  assert.ok(files.some((f) => path.basename(f) === 'AGENTS.md'));
  const withNul: string[] = [];
  for (const f of files) if ((await fs.readFile(f)).indexOf(0) !== -1) withNul.push(path.relative(ROOT, f));
  assert.deepEqual(withNul, []);
});
