import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ConfigError } from '../../src/config/load.ts';
import { RuleViolationError } from '../../src/graph/rules.ts';
import { EXIT_KINDS, EXITS } from '../../src/tracker/index.ts';
import { groundVersion, validate, validateAll } from '../../src/validate.ts';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';
import { FakeGit } from '../helpers/fake-git.ts';

const fx = (p: string) => path.resolve(import.meta.dirname, '..', 'fixtures', p);

let tmpHome: string;
before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-home-'));
});
after(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 5 });
});

const opts = () => ({
  configFile: fx('e2e/config.yaml'),
  cwd: fx('e2e/repo'),
  profile: 'work',
  home: tmpHome,
  git: new FakeGit(),
});

const trusted = () => ({ ...opts(), configFile: fx('e2e/config-trusted.yaml') });

test('e2e fixture validates and lists steps (relative ground paths resolve against the config file)', async () => {
  const r = await validate(opts());
  assert.equal(r.profile, 'work');
  assert.ok(r.graph.steps.map((s) => s.id).includes('approve-groom'));
  assert.match(r.mappings.find((m) => m.as === 'policy')!.absPath, /policies[\\/]sdlc\.md$/);
  assert.deepEqual(r.groundVersions, { company: 'local', team: 'local' });
  assert.equal('violations' in r, false);
});

test('profile overriding locked review fails with locking ground named', async () => {
  await assert.rejects(validate({ ...opts(), configFile: fx('e2e/config-override.yaml') }), {
    message: `${fx('e2e/config-override.yaml')}:13: profiles.work.bindings.review: locked by ${fx('e2e/grounds/company/percolator.yaml')}:2 (required: true); remove this binding or restate it exactly`,
  });
});

test('a repo layer changing a locked binding names the repo file', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    await fs.mkdir(path.dirname(repoFile));
    await fs.writeFile(repoFile, 'bindings:\n  review: { agent: codex }\n');
    await assert.rejects(validate({ ...trusted(), cwd }), {
      message: `${repoFile}:2: bindings.review: locked by ${fx('e2e/grounds/company/percolator.yaml')}:2 (required: true); remove this binding or restate it exactly`,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('unbound stages propagate as an error', async () => {
  await assert.rejects(validate({ ...opts(), configFile: fx('e2e/unbound.yaml') }), {
    name: 'GraphError',
    file: fx('e2e/unbound.yaml'),
    line: 4,
    message: `${fx('e2e/unbound.yaml')}:4: profile "work" leaves stages unbound: groom, plan, implement, review, deliver; bind each under bindings:`,
  });
});

test('a trusted repo layer is merged as the last layer', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    await fs.mkdir(path.join(cwd, '.percolator'));
    await fs.writeFile(
      path.join(cwd, '.percolator', 'percolator.yaml'),
      'nodes:\n  repo-check:\n    command: [echo, hi]\n    after: plan\n',
    );
    const r = await validate({ ...trusted(), cwd });
    assert.ok(r.graph.steps.map((s) => s.id).includes('repo-check'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('an untrusted repo layer is refused', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    await fs.mkdir(path.dirname(repoFile));
    await fs.writeFile(repoFile, 'nodes:\n  repo-check:\n    command: [echo, hi]\n    after: plan\n');
    const err = await validate({ ...opts(), cwd }).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.file, fx('e2e/config.yaml'));
    assert.equal(err.line, 6);
    assert.equal(
      err.message,
      `${fx('e2e/config.yaml')}:6: profiles.work: ${repoFile} exists, but profile "work" does not trust repo config (it can add nodes that run commands); set trust_repo_config: true in that profile to use it`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
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
    const r = await validate({ ...trusted(), git, cwd });
    assert.ok(r.graph.steps.map((s) => s.id).includes('repo-check'));
    assert.ok(git.calls.includes(`toplevel ${cwd}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('a repo layer whose existence cannot be checked is an error, not an absent layer', async () => {
  const denied = Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
  const lstatRepoLayer = async () => {
    throw denied;
  };
  await assert.rejects(validate({ ...trusted(), lstatRepoLayer }), (e) => e === denied);
});

test('a repo layer that cannot be read for a reason other than absence is an error', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    await fs.mkdir(path.dirname(repoFile));
    await fs.writeFile(repoFile, 'nodes: {}\n');
    const denied = Object.assign(new Error(`EACCES: permission denied, open '${repoFile}'`), { code: 'EACCES' });
    const loadRepoLayer = async (file: string) => {
      assert.equal(file, repoFile);
      throw denied;
    };
    await assert.rejects(validate({ ...trusted(), cwd, loadRepoLayer }), (e) => e === denied);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
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
      `${base.replace('./grounds/company', abs('company')).replace('./grounds/team', abs('team'))}    rules:\n      allowed_agents: [codex]\n`,
    );
    const err = await validate({ ...opts(), configFile: cfg }).catch((e) => e);
    assert.ok(err instanceof RuleViolationError);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.name, 'RuleViolationError');
    assert.equal(err.file, cfg);
    assert.deepEqual(
      err.violations.map((v) => v.target),
      ['bindings.groom', 'bindings.plan', 'bindings.implement', 'bindings.review'],
    );
    assert.equal(err.line, 12);
    const fix = `allowed_agents (from ${cfg}:21) allows: codex; use one of those`;
    assert.deepEqual(err.message.split('\n'), [
      `${cfg}:12: profiles.work.bindings.groom: uses agent "claude", but ${fix}`,
      `${cfg}:13: profiles.work.bindings.plan: uses agent "claude", but ${fix}`,
      `${cfg}:14: profiles.work.bindings.implement: uses agent "claude", but ${fix}`,
      `${fx('e2e/grounds/company/percolator.yaml')}:2: bindings.review: uses agent "claude", but ${fix}`,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function withConfig(body: (abs: (ground: string) => string) => string, fn: (cfg: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const cfg = path.join(dir, 'config.yaml');
    await fs.writeFile(cfg, body((g) => JSON.stringify(path.join(fx('e2e/grounds'), g))));
    await fn(cfg);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
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
      intake: { builtin: github.intake }
      groom: { agent: claude, prompt: { from: team, file: policies/sdlc.md } }
      plan: ${extra.plan ?? '{ agent: claude }'}
      implement: ${extra.implement ?? '{ agent: claude }'}
      deliver: { command: [echo, deliver] }
    nodes:
      lint: ${extra.lint ?? '{ agent: claude, after: implement }'}
`;

test('every node prompt file is resolved inside its ground before start, all problems at once', async () => {
  await withConfig(
    (abs) =>
      promptConfig(abs, {
        plan: '{ agent: claude, prompt: { from: company, file: prompts/missing.md } }',
        implement:
          '[{ agent: claude, prompt: { from: nope, file: x.md } }, { agent: codex, prompt: { from: company, file: "../team/policies/sdlc.md" } }]',
        lint: '{ agent: claude, after: implement, prompt: { from: team, file: "C:x" } }',
      }),
    async (cfg) => {
      const err = await validate({ ...opts(), configFile: cfg }).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(err.file, cfg);
      assert.deepEqual(err.message.split('\n'), [
        `${cfg}:13: profiles.work.bindings.plan.prompt.file: ground "company": prompts/missing.md does not exist; fix the path or add it to the ground`,
        `${cfg}:14: profiles.work.bindings.implement.0.prompt.from: ground "nope" is not declared; add it under grounds:`,
        `${cfg}:14: profiles.work.bindings.implement.1.prompt.file: ground "company": ../team/policies/sdlc.md is outside the ground; use a path inside the ground`,
        `${cfg}:17: profiles.work.nodes.lint.prompt.file: ground "team": C:x must not contain ":"; remove the ":"`,
      ]);
    },
  );
});

test('a valid prompt file passes', async () => {
  await withConfig(
    (abs) => promptConfig(abs, { plan: '{ agent: claude, prompt: { from: company, file: percolator.yaml } }' }),
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg });
      assert.equal(r.graph.steps.find((s) => s.id === 'plan')!.def.agent, 'claude');
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
        `${cfg}:9: profiles.work.use.1.applies_to.4: "reveiw" names no stage or node; use "*", a stage or a node name`,
        `${cfg}:9: profiles.work.use.1.applies_to.5: "nope" names no stage or node; use "*", a stage or a node name`,
      ]);
    },
  );
});

test('validate returns resolved grounds', async () => {
  const r = await validate(opts());
  assert.deepEqual(Object.keys(r.grounds).sort(), ['company', 'team']);
  assert.ok(path.isAbsolute(r.grounds.company!.dir));
});
test('validate rejects an unknown agent before any agent starts', async () => {
  await withConfig(
    (abs) =>
      promptConfig(abs, {})
        .replace('      - { from: company, file: percolator.yaml, as: graph }\n', '')
        .replace('      deliver:', '      review: { agent: gemini }\n      deliver:'),
    async (cfg) => {
      await assert.rejects(validate({ ...opts(), configFile: cfg }), {
        message: `${cfg}:14: profiles.work.bindings.review.agent: unknown agent "gemini" (known: claude, codex, command); use one of those`,
      });
    },
  );
});

test('an agent problem in the repo layer names the repo file and line', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    await fs.mkdir(path.dirname(repoFile));
    await fs.writeFile(repoFile, 'nodes:\n  rc:\n    agent: nope\n    after: plan\n');
    await assert.rejects(validate({ ...trusted(), cwd }), {
      message: `${repoFile}:3: nodes.rc.agent: unknown agent "nope" (known: claude, codex, command); use one of those`,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('validate walks fragment use', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const company = path.join(dir, 'company');
    await fs.mkdir(company);
    await fs.writeFile(
      path.join(company, 'percolator.yaml'),
      `bindings:\n  review: { agent: claude, skills: [code-review], max_rounds: 3 }\nuse:\n  - { from: team, file: policies/sdlc.md, as: policy, applies_to: ['*'] }\n`,
    );
    const cfg = path.join(dir, 'config.yaml');
    const base = await fs.readFile(fx('e2e/config.yaml'), 'utf8');
    await fs.writeFile(
      cfg,
      base
        .replace('./grounds/company', JSON.stringify(company))
        .replace('./grounds/team', JSON.stringify(fx('e2e/grounds/team')))
        .replace('      - { from: team, file: policies/sdlc.md, as: policy }\n', ''),
    );
    const r = await validate({ ...opts(), configFile: cfg });
    const m = r.mappings.find((x) => x.as === 'policy')!;
    assert.match(m.absPath, /policies[\\/]sdlc\.md$/);
    assert.equal(m.source, 'ground:company/percolator.yaml@local');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('groundVersion is "<ref> (<commit12>)" for git grounds and "local" for path grounds', () => {
  const commit = 'c0123456789abcdef0123456789abcdef0123456';
  const git: ResolvedGround = { name: 'x', dir: '/d', commit, source: { git: 'https://example.com/x.git', ref: 'v2.3.1' } };
  const local: ResolvedGround = { name: 'y', dir: '/d', commit: 'local', source: { path: '/d' } };
  assert.equal(groundVersion(git), 'v2.3.1 (c0123456789a)');
  assert.equal(groundVersion(local), 'local');
});

test('validate records a git ground version with its ref', async () => {
  const git = new FakeGit();
  const commit = 'c0123456789abcdef0123456789abcdef0123456';
  git.setRef('main', commit);
  git.onClone = async (_url, dir) => {
    if (dir.endsWith('.mirror')) return;
    await fs.cp(fx('e2e/grounds/company'), dir, { recursive: true });
  };
  await withConfig(
    (abs) => `version: 1
grounds:
  x: { git: https://example.com/x.git, ref: main }
  team: { path: ${abs('team')} }
profiles:
  work:
    use:
      - { from: x, file: percolator.yaml, as: graph }
      - { from: team, file: policies/sdlc.md, as: policy, applies_to: ["*"] }
    bindings:
      intake: { builtin: github.intake }
      groom: { agent: claude }
      plan: { agent: claude }
      implement: { agent: claude }
      deliver: { command: [echo, deliver] }
`,
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg, git });
      assert.equal(r.groundVersions.x, 'main (c0123456789a)');
      assert.equal(r.groundVersions.team, 'local');
    },
  );
});

test('validate exposes the selected profile runtime and tracker blocks (undefined when absent)', async () => {
  const r = await validate(opts());
  assert.equal(r.runtime, undefined);
  assert.equal(r.tracker, undefined);
});

test('validate passes the selected profile runtime and tracker blocks through as written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-vrt-'));
  try {
    const text = (await fs.readFile(fx('e2e/config.yaml'), 'utf8'))
      .replaceAll('./grounds', JSON.stringify(fx('e2e/grounds')).slice(1, -1))
      .replace(
        '  work:\n',
        '  work:\n    tracker: { kind: github, approvers: [bob] }\n    runtime: { worktree_root: ~/wt, base: origin/dev, keep_terminals: true, space: false }\n',
      );
    const cfg = path.join(dir, 'config.yaml');
    await fs.writeFile(cfg, text);
    const r = await validate({ ...opts(), configFile: cfg });
    assert.deepEqual(r.runtime, { worktree_root: '~/wt', base: 'origin/dev', keep_terminals: true, space: false });
    assert.deepEqual(r.tracker, { kind: 'github', approvers: ['bob'] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// A base profile and a child that extends it, written to a temp config; `child` is spliced in under `acme:`.
async function withExtends(
  child: string,
  fn: (cfg: string) => Promise<void>,
  base = '',
  plan = '      plan: { agent: claude, model: opus }',
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-ext-'));
  try {
    const cfg = path.join(dir, 'config.yaml');
    await fs.writeFile(
      cfg,
      [
        'version: 1',
        'grounds:',
        `  team: { path: ${JSON.stringify(fx('e2e/grounds/team'))} }`,
        'profiles:',
        '  base:',
        '    match: { remote: "github.com/*/*" }',
        '    tracker: { kind: github, approvers: [alice] }',
        '    runtime: { space: false }',
        '    use:',
        '      - { from: team, file: policies/sdlc.md, as: policy }',
        '    bindings:',
        '      intake: { builtin: github.intake }',
        '      groom: { agent: claude, model: opus }',
        plan,
        '      implement: { agent: claude, model: opus }',
        '      review: { agent: claude, model: opus }',
        '      deliver: { builtin: github.open_pr }',
        '    nodes:',
        '      lint: { command: [pnpm, lint], after: implement }',
        ...(base ? [base] : []),
        '  acme:',
        child,
        '',
      ].join('\n'),
    );
    await fn(cfg);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('a profile that extends another starts from its bindings, nodes, use, tracker and runtime', async () => {
  await withExtends(
    ['    extends: base', '    bindings:', '      implement: { agent: codex, model: gpt-5.5 }'].join('\n'),
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg, profile: 'acme' });
      const def = (id: string) => r.graph.steps.find((s) => s.id === id)!.def;
      assert.deepEqual(def('implement'), { agent: 'codex', model: 'gpt-5.5' });
      assert.deepEqual(def('plan'), { agent: 'claude', model: 'opus' });
      assert.deepEqual(def('lint').command, ['pnpm', 'lint']);
      assert.deepEqual(r.mappings.map((m) => m.as), ['policy']);
      assert.deepEqual(r.tracker, { kind: 'github', approvers: ['alice'] });
      assert.deepEqual(r.runtime, { space: false });
    },
  );
});

test('an extending profile replaces tracker and runtime as whole blocks and adds to use', async () => {
  await withExtends(
    [
      '    extends: base',
      '    tracker: { kind: github }',
      '    runtime: { keep_terminals: true }',
      '    use:',
      '      - { from: team, dir: policies, as: context }',
    ].join('\n'),
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg, profile: 'acme' });
      assert.deepEqual(r.tracker, { kind: 'github' });
      assert.deepEqual(r.runtime, { keep_terminals: true });
      assert.deepEqual(r.mappings.map((m) => m.as), ['policy', 'context']);
    },
  );
});

test('an extending profile does not inherit match: it is picked only by its own', async () => {
  await withExtends('    extends: base\n    match: { remote: "github.com/acme/*" }', async (cfg) => {
    const git = new FakeGit();
    git.urls.set(fx('e2e/repo'), 'https://github.com/other/repo.git');
    const { profile: _picked, ...auto } = opts();
    const r = await validate({ ...auto, configFile: cfg, git });
    assert.equal(r.profile, 'base');
  });
});

test('an extending profile does not inherit trust_repo_config', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-repo-'));
  try {
    const repoFile = path.join(cwd, '.percolator', 'percolator.yaml');
    await fs.mkdir(path.dirname(repoFile));
    await fs.writeFile(repoFile, 'nodes:\n  repo-check:\n    command: [echo, hi]\n    after: plan\n');
    await withExtends(
      '    extends: base',
      async (cfg) => {
        await assert.rejects(validate({ ...opts(), cwd, configFile: cfg, profile: 'acme' }), {
          message: `${cfg}:21: profiles.acme: ${repoFile} exists, but profile "acme" does not trust repo config (it can add nodes that run commands); set trust_repo_config: true in that profile to use it`,
        });
      },
      '    trust_repo_config: true',
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('an extending profile cannot change a binding its base locked', async () => {
  await withExtends(
    '    extends: base\n    bindings:\n      plan: { agent: codex }',
    async (cfg) => {
      await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'acme' }), {
        message: `${cfg}:23: profiles.acme.bindings.plan: locked by ${cfg}:14 (required: true); remove this binding or restate it exactly`,
      });
    },
    '',
    '      plan: { agent: claude, model: opus, required: true }',
  );
});

test('extends must name another existing profile', async () => {
  await withExtends('    extends: nope', async (cfg) => {
    await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'acme' }), {
      message: `${cfg}:21: profiles.acme.extends: unknown profile "nope" (profiles: base, acme); extend one of those`,
    });
  });
  await withExtends('    extends: acme', async (cfg) => {
    await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'acme' }), {
      message: `${cfg}:21: profiles.acme.extends: a profile cannot extend itself; extend another profile or remove extends`,
    });
  });
});

test('extends is one level only', async () => {
  await withExtends(
    '    extends: mid',
    async (cfg) => {
      await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'acme' }), {
        message: `${cfg}:23: profiles.acme.extends: profile "mid" extends "base" itself; extends is one level only, so extend "base" directly`,
      });
    },
    '  mid:\n    extends: base',
  );
});

test('a broken extends is reported even when another profile is selected', async () => {
  await withExtends('    extends: nope', async (cfg) => {
    await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'base' }), {
      message: `${cfg}:21: profiles.acme.extends: unknown profile "nope" (profiles: base, acme); extend one of those`,
    });
  });
});

// profile `default`: bare feature bindings plus a hotfix pipeline (and `more` lines after its bindings)
const pipelinesConfig = (abs: (g: string) => string, more = '') => `version: 1
grounds:
  team: { path: ${abs('team')} }
profiles:
  default:
    bindings:
      intake: { builtin: github.intake }
      groom: { agent: claude }
      plan: { agent: claude }
      implement: { agent: claude }
      review: { agent: claude }
      deliver: { builtin: github.open_pr }
    pipelines:
      hotfix:
        stages: [intake, implement, deliver]
        exit: pr
        ticket: optional
        inputs:
          why: { required: true, description: what broke }
        bindings:
          implement: { agent: claude }
${more}`;

test('validate --pipeline hotfix builds the hotfix graph', async () => {
  await withConfig(pipelinesConfig, async (cfg) => {
    const r = await validate({ ...opts(), configFile: cfg, profile: 'default', pipeline: 'hotfix' });
    assert.equal(r.graph.pipeline, 'hotfix');
    assert.equal(r.pipeline.name, 'hotfix');
    assert.equal(r.pipeline.ticket, 'optional');
    assert.deepEqual(r.pipeline.inputs, { why: { required: true, description: 'what broke' } });
    assert.deepEqual(Object.keys(r.pipelines), ['feature', 'hotfix']);
  });
});

test('validate without a pipeline builds the default one', async () => {
  await withConfig(pipelinesConfig, async (cfg) => {
    const r = await validate({ ...opts(), configFile: cfg, profile: 'default' });
    assert.equal(r.graph.pipeline, 'feature');
    assert.equal(r.pipeline.default, true);
  });
});

test("validate of an unknown pipeline points at the profile's pipelines line", async () => {
  await withConfig(pipelinesConfig, async (cfg) => {
    await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'default', pipeline: 'nope' }), {
      name: 'ConfigError',
      message: `${cfg}:13: unknown pipeline "nope" in profile "default" (pipelines: feature, hotfix); pass one of those to --pipeline`,
    });
  });
});

test('validate of an unknown pipeline points at the profile line when it has no pipelines', async () => {
  await assert.rejects(validate({ ...opts(), pipeline: 'nope' }), {
    message: `${fx('e2e/config.yaml')}:6: unknown pipeline "nope" in profile "work" (pipelines: feature); pass one of those to --pipeline`,
  });
});

test('validateAll validates every pipeline of the profile, in order', async () => {
  await withConfig(pipelinesConfig, async (cfg) => {
    const all = await validateAll({ ...opts(), configFile: cfg, profile: 'default' });
    assert.deepEqual(
      all.map((r) => r.graph.pipeline),
      ['feature', 'hotfix'],
    );
    assert.deepEqual(
      all.map((r) => r.pipeline.default),
      [true, false],
    );
  });
});

test('validateAll throws the first pipeline error', async () => {
  await withConfig(
    (abs) => pipelinesConfig(abs, '      broken:\n        stages: [intake, fix, deliver]\n'),
    async (cfg) => {
      await assert.rejects(validateAll({ ...opts(), configFile: cfg, profile: 'default' }), {
        message: `${cfg}:22: profiles.default.pipelines.broken: pipeline "broken" has no exit: bind its last stage "deliver" to one of ${EXIT_KINDS.map((k) => EXITS[k].builtin).join(', ')} or set exit:`,
      });
    },
  );
});

test("a pipeline's own use maps into that pipeline only", async () => {
  await withConfig(
    (abs) => pipelinesConfig(abs, '        use:\n          - { from: team, file: policies/sdlc.md, as: context }\n'),
    async (cfg) => {
      const hotfix = await validate({ ...opts(), configFile: cfg, profile: 'default', pipeline: 'hotfix' });
      assert.deepEqual(
        hotfix.mappings.map((m) => m.as),
        ['context'],
      );
      const feature = await validate({ ...opts(), configFile: cfg, profile: 'default' });
      assert.deepEqual(feature.mappings, []);
    },
  );
});

test("a pipeline's rules are checked against that pipeline's stages", async () => {
  await withConfig(
    (abs) =>
      pipelinesConfig(
        abs,
        [
          '      alert:',
          '        stages: [intake, triage, deliver]',
          '        exit: pr',
          '        bindings:',
          '          triage: { agent: claude, skills: [ops] }',
          '        rules:',
          '          require_skills: [{ stage: triage, skills: [ops] }]',
          '',
        ].join('\n'),
      ),
    async (cfg) => {
      const r = await validate({ ...opts(), configFile: cfg, profile: 'default', pipeline: 'alert' });
      assert.deepEqual(r.graph.stages, ['intake', 'triage', 'deliver']);
    },
  );
});

test('a top-level require_skills naming a stage no pipeline has is a violation', async () => {
  await withConfig(
    (abs) => pipelinesConfig(abs, '    rules:\n      require_skills: [{ stage: tirage, skills: [ops] }]\n'),
    async (cfg) => {
      await assert.rejects(validate({ ...opts(), configFile: cfg, profile: 'default', pipeline: 'hotfix' }), {
        name: 'RuleViolationError',
        message: `${cfg}:23: profiles.default.rules.require_skills.0.stage: names stage "tirage", which no pipeline in profile "default" has; use one of their stages or *`,
      });
    },
  );
});
