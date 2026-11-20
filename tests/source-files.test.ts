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

// A raw NUL makes git treat a file as binary, which also turns off its EOL normalization.
test('no file under src/ or tests/ contains a NUL byte', async () => {
  const files = [...(await filesUnder(path.join(ROOT, 'src'))), ...(await filesUnder(path.join(ROOT, 'tests')))];
  assert.ok(files.length > 0);
  const withNul: string[] = [];
  for (const f of files) if ((await fs.readFile(f)).indexOf(0) !== -1) withNul.push(path.relative(ROOT, f));
  assert.deepEqual(withNul, []);
});
