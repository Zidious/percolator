import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('percolator-config skill has frontmatter and drives perc', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  assert.ok(text.startsWith('---\nname: percolator-config\ndescription: '), 'frontmatter must open with name and description');
  assert.ok(text.includes('perc init'), 'skill must tell the agent to run perc init');
  assert.ok(text.includes('perc validate'), 'skill must tell the agent to run perc validate');
});

test('percolator-config skill covers local development, the tracker kind and the approval gate', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('## Local development'), 'skill must have a local development section');
  assert.ok(text.includes('node src/cli.ts'), 'local development must say how to run perc from a checkout');
  assert.ok(text.includes('tracker: { kind: github, approvers:'), 'approvers must be shown with the required tracker kind');
  assert.ok(text.includes('approve-groom'), 'skill must explain the built-in approval gate');
});
