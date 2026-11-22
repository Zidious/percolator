import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { EXITS, EXIT_KINDS } from '../src/tracker/index.ts';

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

test('percolator-config skill keeps the rules agents needed most', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const cannot = text.split('## What the config cannot do')[1]?.split('\n## ')[0];
  assert.ok(cannot !== undefined, 'skill must have a "What the config cannot do" section');
  assert.ok(cannot.includes('approve-groom'), 'the cannot-do section must say the groom approval stays');
  assert.ok(text.includes('extends:'), 'skill must show extends for "same as my normal setup, except…"');
  assert.ok(text.includes('perc validate --config <file> --profile <name>'), 'validate must always name the profile');
  assert.ok(text.includes('do not change git settings'), 'skill must forbid working around a failed ground fetch');
  assert.ok(
    text.includes('ask the user which repo (and ref) to add; do not pick one yourself'),
    'skill must make the agent ask before adding a git ground the user did not name',
  );
});

test('the config skill covers pipelines and inputs', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('pipelines:'), 'skill must show where pipelines go');
  assert.ok(text.includes('ticket: none'), 'skill must explain ticket: none');
  assert.ok(text.includes('--input'), 'skill must say how a run gets its inputs');
});

test('the config skill covers routers and triggers', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const routers = text.split('## Routers')[1]?.split('\n## ')[0];
  assert.ok(routers !== undefined, 'skill must have a "Routers" section');
  for (const key of ['router: true', 'routes:', 'choose:', 'fallback:', 'confirm:', 'pick-pipeline', 'perc approve <run-id> --pipeline <name>', 'next:']) {
    assert.ok(routers.includes(key), `the Routers section must cover ${key}`);
  }
  const triggers = text.split('## Triggers')[1]?.split('\n## ')[0];
  assert.ok(triggers !== undefined, 'skill must have a "Triggers" section');
  for (const key of ['triggers:', 'schedule:', 'timezone:', 'label:', 'pr_opened:', 'dependabot:', 'check_failed:', 'perc watch']) {
    assert.ok(triggers.includes(key), `the Triggers section must cover ${key}`);
  }
  assert.ok(!text.includes('cannot start it yet'), 'ticket: none pipelines can be started now');
});

test('the config skill covers every exit', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const exits = text.split('## Exits')[1]?.split('\n## ')[0];
  assert.ok(exits !== undefined, 'skill must have an "Exits" section');
  for (const kind of EXIT_KINDS) {
    assert.ok(exits.includes(`| \`${kind}\` | \`${EXITS[kind].builtin}\` |`), `the Exits section must have a row for ${kind}`);
  }
});
