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

test('the config skill covers routers, triggers and fan-out', async () => {
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
  const fanOut = text.split('## Fan-out')[1]?.split('\n## ')[0];
  assert.ok(fanOut !== undefined, 'skill must have a "Fan-out" section');
  for (const key of ['fan_out:', 'stage:', 'slices:', 'from:', 'output:', 'max_parallel:', '## ', '-s<i>', 'fanout.json']) {
    assert.ok(fanOut.includes(key), `the Fan-out section must cover ${key}`);
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

test('the config skill answers what smoke agents got wrong about routes, hooks and fan-out', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const section = (name: string) => text.split(`\n## ${name}`)[1]?.split('\n## ')[0] ?? '';
  const keys = section('Where keys go');
  assert.ok(keys.includes('edit them where they already are'), 'feature bindings stay where an existing config has them');
  assert.ok(keys.includes('a new `pipelines:` block can sit beside them'), 'a new pipelines block may sit beside top-level bindings');
  assert.ok(
    section('Recipes').includes('`after: implement` and `before: review` both place a node between implement and review'),
    'the hook recipe must say before/after of neighbouring stages are the same place',
  );
  const routers = section('Routers');
  assert.ok(routers.includes('A matching `routes:` rule skips the pick-pipeline gate'), 'label routes never stop at the gate');
  assert.ok(routers.includes("`confirm` only covers the agent's pick"), 'confirm is about the agent only');
  const fanOut = section('Fan-out');
  assert.ok(fanOut.includes('Put `fan_out:` on a pipeline of its own'), 'fan_out goes on a named pipeline');
  assert.ok(fanOut.includes('routes:'), 'fan-out must say how a router sends big tickets there');
  assert.ok(fanOut.includes('slice runs (fan-out of implement, at most 3 at a time):'), 'fan-out must show the validate block for slice runs');
  assert.ok(
    fanOut.includes('percolator.fan_out: slice(s) <slice-ids> failed; perc delete each (its branch stays), then perc resume <parent-id> to run it again'),
    'fan-out must quote the failed-slice escalation',
  );
});

test('the config skill says which pipelines triggers need and quotes the refusal', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const triggers = text.split('\n## Triggers')[1]?.split('\n## ')[0] ?? '';
  for (const name of ['review-pr', 'fix-ci']) {
    const example = triggers.split(`  ${name}:\n`)[1]?.split(/\n {2}\S/)[0] ?? '';
    assert.ok(example.includes('ticket: none'), `the ${name} example must set ticket: none`);
  }
  assert.ok(
    triggers.includes('`pr_opened`, `dependabot` and `check_failed` start runs without a ticket, so they need `ticket: none` or `optional`'),
    'the Triggers section must say PR and check triggers need a ticketless pipeline',
  );
  assert.ok(
    triggers.includes('a <kind> trigger starts runs without a ticket; set ticket: none or ticket: optional'),
    'the Triggers section must quote the validate refusal',
  );
  assert.ok(triggers.includes('only within the last 7 days'), 'a schedule makes up its latest missed time only within 7 days');
  assert.ok(
    triggers.includes(
      'each time it starts, its first poll of a `pr_opened`, `dependabot` or `check_failed` trigger records what is already open or failed (including what appeared while it was stopped)',
    ),
    'a new or restarted watcher does not backfill PR and check triggers',
  );
  assert.ok(triggers.includes('A run you deleted is not started again'), 'deleted runs are not refired');
});

test('the config skill is right about outputs, names and the feature pipeline', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'), 'utf8');
  const section = (name: string) => text.split(`\n## ${name}`)[1]?.split('\n## ')[0] ?? '';
  const pipelines = section('Pipelines');
  assert.ok(
    pipelines.includes('a stage left out needs none, except groom, plan, implement and review, which keep their feature outputs unless listed'),
    'stages named like feature stages keep their contracts',
  );
  assert.ok(pipelines.includes('Names start with a lower-case letter'), 'pipeline names start with a letter');
  assert.ok(pipelines.includes('at most 32 characters'), 'input names are at most 32 characters');
  assert.ok(pipelines.includes('`all`, `before-all` and `after-all` are reserved'), 'reserved stage names');
  assert.ok(section('Exits').includes('must be declared with `required: true`'), 'exit inputs must be required');
  const ddAlert = pipelines.split('  dd-alert:\n')[1]?.split('\n```')[0] ?? '';
  assert.ok(ddAlert.includes('ticket: none'), 'the dd-alert example runs without a ticket, as in the template');
  const cannot = section('What the config cannot do');
  assert.ok(
    cannot.includes('a `feature` whose own `stages` leave out `groom` has no `approve-groom` gate'),
    'redefining feature without groom drops the gate',
  );
  assert.ok(
    cannot.includes('a `feature` with its own `stages` gets no default intake or exit binding'),
    'a redefined feature binds every stage itself',
  );
  const routers = section('Routers');
  assert.ok(
    routers.includes('takes required inputs a <router|next> cannot pass; make them optional or route elsewhere'),
    'route and next targets with required inputs are refused',
  );
  assert.ok(
    routers.includes('the router ignores a `pipeline:<name>` label or `/percolator run <name>` comment'),
    'routers ignore names they cannot run',
  );
  assert.ok(routers.includes('`next` may not lead back'), 'next cycles are refused');
});
