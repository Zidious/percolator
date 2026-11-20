import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ConfigError } from '../../src/config/load.ts';
import { RuleViolationError } from '../../src/graph/rules.ts';
import { validate } from '../../src/validate.ts';
import { FakeGit } from '../helpers/fake-git.ts';

const fx = (p: string) => path.resolve(import.meta.dirname, '..', 'fixtures', p);

let tmpHome: string;
before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-home-'));
});
after(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

const opts = () => ({
  configFile: fx('e2e/config.yaml'),
  cwd: fx('e2e/repo'),
  profile: 'work',
  home: tmpHome,
  git: new FakeGit(),
});

test('e2e fixture validates and lists steps (relative ground paths resolve against the config file)', async () => {
  const r = await validate(opts());
  assert.equal(r.profile, 'work');
  assert.ok(r.graph.steps.map((s) => s.id).includes('approve-groom'));
  assert.match(r.mappings.find((m) => m.as === 'policy')!.absPath, /policies[\\/]sdlc\.md$/);
  assert.deepEqual(r.groundVersions, { company: 'local', team: 'local' });
  assert.equal('violations' in r, false);
});

test('profile overriding locked review fails with locking ground named', async () => {
  await assert.rejects(validate({ ...opts(), configFile: fx('e2e/config-override.yaml') }), /locked by ground:company/);
});

test('unbound stages propagate as an error', async () => {
  await assert.rejects(validate({ ...opts(), configFile: fx('e2e/unbound.yaml') }), /unbound/i);
});

test('repo .percolator/percolator.yaml is the last layer', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    await fs.mkdir(path.join(cwd, '.percolator'));
    await fs.writeFile(
      path.join(cwd, '.percolator', 'percolator.yaml'),
      'nodes:\n  repo-check:\n    command: [echo, hi]\n    after: plan\n',
    );
    const r = await validate({ ...opts(), cwd });
    assert.ok(r.graph.steps.map((s) => s.id).includes('repo-check'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the repo layer is found at the git toplevel when run from a subdirectory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    await fs.mkdir(path.join(root, '.percolator'));
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.percolator', 'percolator.yaml'),
      'nodes:\n  repo-check:\n    command: [echo, hi]\n    after: plan\n',
    );
    const git = new FakeGit();
    const cwd = path.join(root, 'src', 'deep');
    git.toplevels.set(cwd, root);
    const r = await validate({ ...opts(), git, cwd });
    assert.ok(r.graph.steps.map((s) => s.id).includes('repo-check'));
    assert.ok(git.calls.includes(`toplevel ${cwd}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a repo layer that cannot be read for a reason other than absence is an error', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    const denied = Object.assign(new Error(`EACCES: permission denied, open '${repoFile}'`), { code: 'EACCES' });
    const loadRepoLayer = async (file: string) => {
      assert.equal(file, repoFile);
      throw denied;
    };
    await assert.rejects(validate({ ...opts(), cwd, loadRepoLayer }), (e) => e === denied);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('rule violations are thrown as one RuleViolationError against the config file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const cfg = path.join(dir, 'config.yaml');
    const base = await fs.readFile(fx('e2e/config.yaml'), 'utf8');
    const groundsDir = fx('e2e/grounds');
    const abs = (name: string) => JSON.stringify(path.join(groundsDir, name));
    await fs.writeFile(
      cfg,
      `${base.replace('./grounds/company', abs('company')).replace('./grounds/team', abs('team'))}    rules:\n      allowed_agents: [groomer]\n`,
    );
    const err = await validate({ ...opts(), configFile: cfg }).catch((e) => e);
    assert.ok(err instanceof RuleViolationError);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.name, 'RuleViolationError');
    assert.equal(err.file, cfg);
    assert.deepEqual(
      err.violations.map((v) => v.target),
      ['bindings.plan', 'bindings.implement', 'bindings.review'],
    );
    assert.deepEqual(err.message.split('\n'), [
      'bindings.plan uses agent "planner", but allowed_agents (from profile:work) allows: groomer',
      'bindings.implement uses agent "coder", but allowed_agents (from profile:work) allows: groomer',
      'bindings.review uses agent "reviewer", but allowed_agents (from profile:work) allows: groomer',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function withConfig(body: (abs: (ground: string) => string) => string, fn: (cfg: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const cfg = path.join(dir, 'config.yaml');
    await fs.writeFile(cfg, body((g) => JSON.stringify(path.join(fx('e2e/grounds'), g))));
    await fn(cfg);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const promptConfig = (abs: (g: string) => string, extra: { applies?: string; plan?: string; implement?: string; lint?: string }) => `version: 1
grounds:
  company: { path: ${abs('company')} }
  team: { path: ${abs('team')} }
profiles:
  work:
    use:
      - { from: company, file: percolator.yaml, as: graph }
      - { from: team, file: policies/sdlc.md, as: policy, applies_to: ${extra.applies ?? '["*"]'} }
    bindings:
      intake: { builtin: read-ticket }
      groom: { agent: groomer, prompt: { from: team, file: policies/sdlc.md } }
      plan: ${extra.plan ?? '{ agent: planner }'}
      implement: ${extra.implement ?? '{ agent: coder }'}
      deliver: { command: [echo, deliver] }
    nodes:
      lint: ${extra.lint ?? '{ agent: linter, after: implement }'}
`;

test('every node prompt file is resolved inside its ground before start, all problems at once', async () => {
  await withConfig(
    (abs) =>
      promptConfig(abs, {
        plan: '{ agent: planner, prompt: { from: company, file: prompts/missing.md } }',
        implement:
          '[{ agent: coder, prompt: { from: nope, file: x.md } }, { agent: coder2, prompt: { from: company, file: "../team/policies/sdlc.md" } }]',
        lint: '{ agent: linter, after: implement, prompt: { from: team, file: "C:x" } }',
      }),
    async (cfg) => {
      const err = await validate({ ...opts(), configFile: cfg }).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(err.file, cfg);
      assert.deepEqual(err.message.split('\n'), [
        `${cfg}: bindings.plan.prompt: ground "company": prompts/missing.md does not exist`,
        `${cfg}: bindings.implement.0.prompt: ground "nope": unknown ground (prompt x.md)`,
        `${cfg}: bindings.implement.1.prompt: ground "company": ../team/policies/sdlc.md is outside the ground`,
        `${cfg}: nodes.lint.prompt: ground "team": C:x must not contain ":"`,
      ]);
    },
  );
});

test('a valid prompt file passes', async () => {
  await withConfig(
    (abs) => promptConfig(abs, { plan: '{ agent: planner, prompt: { from: company, file: percolator.yaml } }' }),
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg });
      assert.equal(r.graph.steps.find((s) => s.id === 'plan')!.def.agent, 'planner');
    },
  );
});

test('mapping applies_to entries must name a stage, a node or "*"', async () => {
  await withConfig(
    (abs) => promptConfig(abs, { applies: '["*", review, lint, approve-groom, reveiw, nope]' }),
    async (cfg) => {
      const err = await validate({ ...opts(), configFile: cfg }).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.message.split('\n'), [
        `${cfg}: mapping team:policies/sdlc.md applies_to "reveiw": no such stage or node`,
        `${cfg}: mapping team:policies/sdlc.md applies_to "nope": no such stage or node`,
      ]);
    },
  );
});
