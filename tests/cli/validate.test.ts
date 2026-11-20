import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
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
  assert.deepEqual(r.violations, []);
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

test('rule violations are returned, not thrown', async () => {
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
    const r = await validate({ ...opts(), configFile: cfg });
    assert.ok(r.violations.length > 0);
    assert.equal(r.violations[0]!.rule, 'allowed_agents');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
