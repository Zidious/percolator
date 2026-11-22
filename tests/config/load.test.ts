import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeJsonSchema } from '../../src/config/json-schema.ts';
import { ConfigError, loadFragment, loadLocated, loadUserConfig } from '../../src/config/load.ts';
import { effectiveKind, UserConfigSchema } from '../../src/config/schema.ts';

const fx = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', 'config', name);

test('loads a valid config with defaults applied', async () => {
  const c = await loadUserConfig(fx('valid.yaml'));
  assert.partialDeepStrictEqual(c.profiles.work.use![0], { as: 'policy', applies_to: ['*'], required: false });
});

test('YAML syntax error reports file and line', async () => {
  const err = await loadUserConfig(fx('bad-yaml.yaml')).catch((e) => e);
  assert.ok(err instanceof ConfigError);
  assert.equal(err.name, 'ConfigError');
  assert.equal(err.line, 4);
  assert.equal(err.file, fx('bad-yaml.yaml'));
});

test('schema error reports path and line', async () => {
  await assert.rejects(loadUserConfig(fx('bad-schema.yaml')), {
    name: 'ConfigError',
    path: 'profiles.work.use.0.as',
    line: 6,
  });
});

test('mapping with both file and dir is rejected', async () => {
  await assert.rejects(loadUserConfig(fx('mapping-both.yaml')), ConfigError);
});

test('node with both before and after is rejected', async () => {
  await assert.rejects(loadFragment(fx('node-both.yaml')), ConfigError);
});

test('loadFragment loads a valid fragment; effectiveKind infers script', async () => {
  const f = await loadFragment(fx('fragment.yaml'));
  assert.equal(effectiveKind(f.nodes!.lint), 'script');
});

test('node with no agent/builtin/command is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const file = path.join(dir, 'f.yaml');
    await fs.writeFile(file, 'nodes:\n  x:\n    model: m\n');
    await assert.rejects(loadFragment(file), ConfigError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function withYaml(text: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const file = path.join(dir, 'f.yaml');
    await fs.writeFile(file, text);
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('a malformed stage name in a hook lists the valid values', async () => {
  await withYaml('nodes:\n  x:\n    agent: a\n    before: foo bar\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.path, 'nodes.x.before');
    assert.equal(err.line, 4);
    assert.ok(err.message.includes('intake'));
    assert.ok(err.message.includes('all'));
  });
});

test('ground with neither git nor path gives a readable message', async () => {
  await withYaml('version: 1\ngrounds:\n  g: {}\nprofiles: {}\n', async (file) => {
    const err = await loadUserConfig(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.match(String(err.path), /^grounds\.g\./);
    assert.doesNotMatch(err.message, /Invalid input$/m);
    assert.match(err.message, /expected string/);
  });
});

for (const name of ['../x', 'a/b', '..\\x','-x', '.hidden', 'a b']) {
  test(`ground name ${JSON.stringify(name)} is rejected as unsafe`, async () => {
    await withYaml(`version: 1\ngrounds:\n  ${JSON.stringify(name)}:\n    path: /tmp/x\nprofiles: {}\n`, async (file) => {
      const err = await loadUserConfig(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.includes(file));
      assert.match(err.message, /ground names? .*letters, digits, "\.", "_" and "-"/);
      assert.doesNotMatch(err.message, /Invalid input$/m);
    });
  });
}

test('ordinary ground names are accepted', async () => {
  await withYaml('version: 1\ngrounds:\n  company-1.x_y:\n    path: /tmp/x\nprofiles: {}\n', async (file) => {
    assert.deepEqual(Object.keys((await loadUserConfig(file)).grounds!), ['company-1.x_y']);
  });
});

test('every schema issue appears in the message, first one in line/path', async () => {
  await withYaml('nodes:\n  a:\n    agent: x\n    before: foo bar\n  b:\n    agent: y\n    after: bar baz\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.equal(err.path, 'nodes.a.before');
    assert.equal(err.line, 4);
    const lines = err.message.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(`${file}:4: nodes.a.before:`));
    assert.ok(lines[1].includes(`${file}:7: nodes.b.after:`));
  });
});

test('every YAML error appears in the message', async () => {
  await withYaml('a: 1\na: 2\nb: 1\nb: 2\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.equal(err.message.split('\n').length, 2);
    assert.equal(err.line, 2);
  });
});

test('json schema is generated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-cfg-'));
  try {
    const out = path.join(dir, 's.json');
    await writeJsonSchema(out);
    const parsed = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.notEqual(parsed.properties.profiles, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('kind: agent without "agent" is rejected', async () => {
  await withYaml('bindings:\n  groom:\n    kind: agent\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message, `${file}:3: bindings.groom: agent nodes need "agent" (which agent runs this node)`);
  });
});

test('an unknown effort level is rejected at its line', async () => {
  await withYaml('bindings:\n  plan:\n    agent: claude\n    effort: extreme\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, new RegExp(`^${file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}:4: bindings\\.plan\\.effort: .*"low"\\|"medium"\\|"high"\\|"xhigh"\\|"max"`));
  });
});

test('a script node may not set agent, model, effort, skill or skills', async () => {
  await withYaml(
    'bindings:\n  plan:\n    kind: script\n    command: [x]\n    agent: codex\n    model: gpt-x\n    skill: s\n    skills: [t]\n    effort: high\n',
    async (file) => {
      const err = await loadFragment(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.message.split('\n'), [
        `${file}:5: bindings.plan.agent: "agent" only applies to agent nodes (this node is kind "script")`,
        `${file}:6: bindings.plan.model: "model" only applies to agent nodes (this node is kind "script")`,
        `${file}:7: bindings.plan.skill: "skill" only applies to agent nodes (this node is kind "script")`,
        `${file}:8: bindings.plan.skills: "skills" only applies to agent nodes (this node is kind "script")`,
        `${file}:9: bindings.plan.effort: "effort" only applies to agent nodes (this node is kind "script")`,
      ]);
    },
  );
});

test('inferred builtin and explicit gate nodes may not set model or skills', async () => {
  await withYaml('nodes:\n  a:\n    builtin: b\n    model: m\n    after: plan\n  g:\n    kind: gate\n    skills: [s]\n    after: plan\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.deepEqual(err.message.split('\n'), [
      `${file}:4: nodes.a.model: "model" only applies to agent nodes (this node is kind "builtin")`,
      `${file}:8: nodes.g.skills: "skills" only applies to agent nodes (this node is kind "gate")`,
    ]);
  });
});

test('agent nodes, explicit or inferred, keep agent/model/skills', async () => {
  await withYaml('bindings:\n  plan: { kind: agent, agent: claude, model: m, skills: [s] }\n  review: { agent: claude, skill: s }\n', async (file) => {
    const f = await loadFragment(file);
    assert.deepEqual(f.bindings, {
      plan: { kind: 'agent', agent: 'claude', model: 'm', skills: ['s'] },
      review: { agent: 'claude', skill: 's' },
    });
  });
});

for (const name of ['../x', '1', 'a.b', '-x']) {
  test(`node name ${JSON.stringify(name)} is rejected`, async () => {
    await withYaml(`nodes:\n  ${JSON.stringify(name)}:\n    kind: gate\n    after: plan\n`, async (file) => {
      const err = await loadFragment(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message,
        `${file}:3: nodes.${name}: node names must start with a letter and contain only letters, digits, "_" and "-"`,
      );
    });
  });
}

test('ordinary node names are accepted', async () => {
  await withYaml('nodes:\n  approve-groom:\n    kind: gate\n    after: groom\n  threat_model:\n    agent: a\n    after: plan\n', async (file) => {
    assert.deepEqual(Object.keys((await loadFragment(file)).nodes!), ['approve-groom', 'threat_model']);
  });
});

test('required_nodes object needs before or after', async () => {
  await withYaml('rules:\n  required_nodes:\n    - name: x\n', async (file) => {
    const err = await loadFragment(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.ok(err.message.includes('exactly one of "before" or "after" is required'));
  });
});

test('profile runtime block round-trips and tracker takes approvers', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-rt-')), 'c.yaml');
  try {
    await fs.writeFile(
      file,
      'version: 1\nprofiles:\n  p:\n    tracker: { kind: github, approvers: [bob] }\n    runtime: { worktree_root: ~/wt, base: origin/dev, keep_terminals: true, space: false }\n',
    );
    const c = await loadUserConfig(file);
    assert.deepEqual(c.profiles.p.runtime, {
      worktree_root: '~/wt',
      base: 'origin/dev',
      keep_terminals: true,
      space: false,
    });
    assert.deepEqual(c.profiles.p.tracker, { kind: 'github', approvers: ['bob'] });
    await fs.writeFile(file, 'version: 1\nprofiles:\n  p:\n    runtime: { bogus: 1 }\n');
    await assert.rejects(
      loadUserConfig(file),
      (e: any) => e.name === 'ConfigError' && e.path === 'profiles.p.runtime' && /bogus/.test(e.message),
    );
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true, maxRetries: 5 });
  }
});

test('loadLocated returns data and the line index', async () => {
  const { data, lines } = await loadLocated(fx('valid.yaml'), UserConfigSchema);
  assert.deepEqual(data, await loadUserConfig(fx('valid.yaml')));
  assert.equal(lines['profiles.work'], 3);
  assert.equal(lines['profiles.work.bindings.implement'], 9);
});

test('a profile with pipelines loads', async () => {
  await withYaml(
    [
      'version: 1',
      'profiles:',
      '  default:',
      '    pipelines:',
      '      hotfix:',
      '        stages: [intake, reproduce, fix, review, deliver]',
      '        outputs: { reproduce: [failing_test] }',
      '        bindings: { reproduce: { agent: claude } }',
      '        exit: pr',
      '',
    ].join('\n'),
    async (file) => {
      const data = await loadUserConfig(file);
      assert.deepEqual(data.profiles.default!.pipelines!.hotfix!.stages, ['intake', 'reproduce', 'fix', 'review', 'deliver']);
    },
  );
});

test('a router pipeline loads', async () => {
  await withYaml(
    [
      'version: 1',
      'profiles:',
      '  default:',
      '    pipelines:',
      '      triage:',
      '        router: true',
      '        stages: [intake, route]',
      '        routes: [{ label: bug, to: hotfix }]',
      '        choose: { agent: claude, effort: high, from: [hotfix, feature], confirm: always }',
      '        fallback: feature',
      '',
    ].join('\n'),
    async (file) => {
      const t = (await loadUserConfig(file)).profiles.default!.pipelines!.triage!;
      assert.deepEqual(t.routes, [{ label: 'bug', to: 'hotfix' }]);
      assert.deepEqual(t.choose, { agent: 'claude', effort: 'high', from: ['hotfix', 'feature'], confirm: 'always' });
      assert.equal(t.fallback, 'feature');
    },
  );
});

test('a pipeline may name the next pipeline for its issues', async () => {
  await withYaml(
    'version: 1\nprofiles:\n  default:\n    pipelines:\n      split:\n        stages: [intake, deliver]\n        exit: issue\n        next: hotfix\n',
    async (file) => {
      assert.equal((await loadUserConfig(file)).profiles.default!.pipelines!.split!.next, 'hotfix');
    },
  );
});

test('a valid trigger list loads', async () => {
  await withYaml(
    [
      'version: 1',
      'profiles:',
      '  default:',
      '    pipelines:',
      '      nightly:',
      '        triggers:',
      '          - { schedule: "0 3 * * 1-5", timezone: Europe/London, inputs: { area: deps } }',
      '          - { label: needs-triage }',
      '          - { pr_opened: true }',
      '          - { pr_opened: { not_author: [dependabot] } }',
      '          - { dependabot: true }',
      '          - { check_failed: { branch: main, workflow: ci.yml } }',
      '',
    ].join('\n'),
    async (file) => {
      assert.deepEqual((await loadUserConfig(file)).profiles.default!.pipelines!.nightly!.triggers, [
        { schedule: '0 3 * * 1-5', timezone: 'Europe/London', inputs: { area: 'deps' } },
        { label: 'needs-triage' },
        { pr_opened: true },
        { pr_opened: { not_author: ['dependabot'] } },
        { dependabot: true },
        { check_failed: { branch: 'main', workflow: 'ci.yml' } },
      ]);
    },
  );
});

test('a malformed trigger is reported at its key', async () => {
  await withYaml(
    'version: 1\nprofiles:\n  default:\n    pipelines:\n      p:\n        triggers:\n          - check_failed: { workflow: ci.yml }\n',
    async (file) => {
      const err = await loadUserConfig(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(err.path, 'profiles.default.pipelines.p.triggers.0.check_failed.branch');
    },
  );
});

test('choose.confirm is unsure or always', async () => {
  await withYaml(
    'version: 1\nprofiles:\n  default:\n    pipelines:\n      triage:\n        choose: { agent: claude, from: [a], confirm: never }\n',
    async (file) => {
      const err = await loadUserConfig(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(err.path, 'profiles.default.pipelines.triage.choose.confirm');
    },
  );
});

test('pipeline names must be lower-case identifiers', async () => {
  await withYaml('version: 1\nprofiles:\n  default:\n    pipelines:\n      Hot_Fix:\n        stages: [intake, deliver]\n', async (file) => {
    const err = await loadUserConfig(file).catch((e) => e);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.path, 'profiles.default.pipelines.Hot_Fix');
    assert.equal(
      err.message,
      `${file}:6: profiles.default.pipelines.Hot_Fix: pipeline names must start with a lower-case letter and contain only a-z, 0-9 and "-" (at most 24 characters)`,
    );
  });
});

test('input names must be identifiers', async () => {
  await withYaml(
    'version: 1\nprofiles:\n  default:\n    pipelines:\n      dd:\n        inputs:\n          alert-url: {}\n',
    async (file) => {
      const err = await loadUserConfig(file).catch((e) => e);
      assert.ok(err instanceof ConfigError);
      assert.equal(err.path, 'profiles.default.pipelines.dd.inputs.alert-url');
      assert.equal(
        err.message,
        `${file}:7: profiles.default.pipelines.dd.inputs.alert-url: input names must start with a lower-case letter and contain only a-z, 0-9 and "_"`,
      );
    },
  );
});
