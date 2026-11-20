import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';
import type { ResolvedMapping } from '../../src/grounds/mappings.ts';
import { buildSkillPlugins, findSkill, materializeGrounds, runDir, stepDir } from '../../src/workspace/run-dir.ts';

async function tmp(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-rundir-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function put(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function ground(name: string, dir: string): ResolvedGround {
  return { name, dir, commit: 'local', source: { path: dir } } as ResolvedGround;
}

function mapping(g: ResolvedGround, as: ResolvedMapping['as'], rel: string, kind: 'file' | 'dir'): ResolvedMapping {
  return {
    from: g.name,
    [kind]: rel,
    as,
    applies_to: ['*'],
    required: false,
    absPath: path.join(g.dir, rel),
    ground: g.name,
    commit: g.commit,
  } as ResolvedMapping;
}

test('runDir and stepDir build the documented paths', () => {
  assert.equal(runDir('/h', 'r1'), path.join('/h', '.percolator', 'runs', 'r1'));
  assert.equal(stepDir('/x/run', 'plan', 2), path.join('/x/run', 'steps', 'plan', '2'));
});

test('materializeGrounds copies policies into the run record and is idempotent', async (t) => {
  const base = await tmp(t);
  const g = ground('acme', path.join(base, 'acme'));
  await put(path.join(g.dir, 'policy.md'), 'P1');
  await put(path.join(g.dir, 'ctx', 'a.md'), 'A1');
  await put(path.join(g.dir, 'skills', 's', 'SKILL.md'), 'S');
  const ms = [
    mapping(g, 'policy', 'policy.md', 'file'),
    mapping(g, 'context', 'ctx', 'dir'),
    mapping(g, 'skills', 'skills', 'dir'),
  ];
  const run = path.join(base, 'run');
  const out = await materializeGrounds(run, ms, { acme: g });
  assert.equal(out[0]!.runPath, path.join(run, 'grounds', 'acme', 'policy.md'));
  assert.equal(out[1]!.runPath, path.join(run, 'grounds', 'acme', 'ctx'));
  assert.equal(out[2]!.runPath, ms[2]!.absPath);
  assert.equal(await fs.readFile(out[0]!.runPath, 'utf8'), 'P1');
  assert.equal(await fs.readFile(path.join(out[1]!.runPath, 'a.md'), 'utf8'), 'A1');

  await put(path.join(g.dir, 'policy.md'), 'P2');
  const again = await materializeGrounds(run, ms, { acme: g });
  assert.deepEqual(again, out);
  assert.equal(await fs.readFile(again[0]!.runPath, 'utf8'), 'P1');
});

test('buildSkillPlugins builds one plugin per ground with plugin.json and skills', async (t) => {
  const base = await tmp(t);
  const a = ground('alpha', path.join(base, 'alpha'));
  const b = ground('beta', path.join(base, 'beta'));
  const c = ground('gamma', path.join(base, 'gamma'));
  await put(path.join(a.dir, 'one', 'SKILL.md'), 'ONE');
  await put(path.join(a.dir, 'one', 'extra.txt'), 'X');
  await put(path.join(a.dir, 'many', 'x', 'SKILL.md'), 'X');
  await put(path.join(a.dir, 'many', 'y', 'SKILL.md'), 'Y');
  await put(path.join(a.dir, 'many', 'notes', 'readme.md'), 'no skill');
  await put(path.join(b.dir, 'solo', 'SKILL.md'), 'SOLO');
  await put(path.join(c.dir, 'plug', '.claude-plugin', 'plugin.json'), '{"name":"gamma"}');
  const ms = [
    mapping(a, 'skills', 'one', 'dir'),
    mapping(a, 'skills', 'many', 'dir'),
    mapping(b, 'skills', 'solo', 'dir'),
    mapping(c, 'plugins', 'plug', 'dir'),
  ];
  const dir = path.join(base, 'step');
  const roots = await buildSkillPlugins(dir, ms, { alpha: a, beta: b, gamma: c });
  assert.deepEqual(roots, [path.join(dir, 'plugins', 'alpha'), path.join(dir, 'plugins', 'beta'), ms[3]!.absPath]);

  const manifest = JSON.parse(await fs.readFile(path.join(roots[0]!, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest, { name: 'alpha', version: '0.0.0' });
  assert.equal(await fs.readFile(path.join(roots[0]!, 'skills', 'one', 'SKILL.md'), 'utf8'), 'ONE');
  assert.equal(await fs.readFile(path.join(roots[0]!, 'skills', 'one', 'extra.txt'), 'utf8'), 'X');
  assert.equal(await fs.readFile(path.join(roots[0]!, 'skills', 'x', 'SKILL.md'), 'utf8'), 'X');
  assert.equal(await fs.readFile(path.join(roots[0]!, 'skills', 'y', 'SKILL.md'), 'utf8'), 'Y');
  await assert.rejects(fs.access(path.join(roots[0]!, 'skills', 'notes')));
  assert.equal(await fs.readFile(path.join(roots[1]!, 'skills', 'solo', 'SKILL.md'), 'utf8'), 'SOLO');

  // reuses existing output
  await put(path.join(a.dir, 'one', 'SKILL.md'), 'CHANGED');
  const again = await buildSkillPlugins(dir, ms, { alpha: a, beta: b, gamma: c });
  assert.deepEqual(again, roots);
  assert.equal(await fs.readFile(path.join(roots[0]!, 'skills', 'one', 'SKILL.md'), 'utf8'), 'ONE');
  assert.deepEqual((await fs.readdir(path.join(dir, 'plugins'))).sort(), ['alpha', 'beta']);
});

test('buildSkillPlugins rejects a skill mapped twice from one ground', async (t) => {
  const base = await tmp(t);
  const a = ground('alpha', path.join(base, 'alpha'));
  await put(path.join(a.dir, 'one', 'SKILL.md'), '1');
  await put(path.join(a.dir, 'many', 'one', 'SKILL.md'), '2');
  const ms = [mapping(a, 'skills', 'one', 'dir'), mapping(a, 'skills', 'many', 'dir')];
  const dir = path.join(base, 'step');
  await assert.rejects(buildSkillPlugins(dir, ms, { alpha: a }), /skill "one" is mapped twice from ground "alpha"/);
  await assert.rejects(fs.access(path.join(dir, 'plugins', 'alpha')));
});

test('findSkill resolves ns:name and bare names, and returns undefined when absent', async (t) => {
  const base = await tmp(t);
  const a = ground('alpha', path.join(base, 'alpha'));
  const c = ground('gamma', path.join(base, 'gamma'));
  await put(path.join(a.dir, 'one', 'SKILL.md'), '1');
  await put(path.join(a.dir, 'many', 'x', 'SKILL.md'), 'x');
  await put(path.join(c.dir, 'plug', '.claude-plugin', 'plugin.json'), '{"name":"nsplug"}');
  await put(path.join(c.dir, 'plug', 'skills', 'tdd', 'SKILL.md'), 'tdd');
  await put(path.join(c.dir, 'bare', 'skills', 'zed', 'SKILL.md'), 'zed');
  const ms = [
    mapping(a, 'skills', 'one', 'dir'),
    mapping(a, 'skills', 'many', 'dir'),
    mapping(c, 'plugins', 'plug', 'dir'),
    mapping(c, 'plugins', 'bare', 'dir'),
  ];
  assert.equal(await findSkill('alpha:one', ms), path.join(a.dir, 'one', 'SKILL.md'));
  assert.equal(await findSkill('alpha:x', ms), path.join(a.dir, 'many', 'x', 'SKILL.md'));
  assert.equal(await findSkill('x', ms), path.join(a.dir, 'many', 'x', 'SKILL.md'));
  assert.equal(await findSkill('nsplug:tdd', ms), path.join(c.dir, 'plug', 'skills', 'tdd', 'SKILL.md'));
  assert.equal(await findSkill('bare:zed', ms), path.join(c.dir, 'bare', 'skills', 'zed', 'SKILL.md'));
  assert.equal(await findSkill('tdd', ms), path.join(c.dir, 'plug', 'skills', 'tdd', 'SKILL.md'));
  assert.equal(await findSkill('beta:one', ms), undefined);
  assert.equal(await findSkill('alpha:nope', ms), undefined);
  assert.equal(await findSkill('nope', ms), undefined);
});
