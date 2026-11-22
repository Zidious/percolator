import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Mapping } from '../../src/config/schema.ts';
import { ConfigError } from '../../src/config/load.ts';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';
import { buildGraph } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import { checkGraphReferences, resolveEach, resolveMappings } from '../../src/grounds/mappings.ts';

let tmp: string;
let grounds: Record<string, ResolvedGround>;

const mFile = (file: string, as: Mapping['as'] = 'policy', from = 'company'): Mapping => ({
  from,
  file,
  as,
  applies_to: ['*'],
  required: false,
});
const mDir = (dir: string, as: Mapping['as'] = 'skills', from = 'company'): Mapping => ({
  from,
  dir,
  as,
  applies_to: ['*'],
  required: false,
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-map-'));
  const company = path.join(tmp, 'company');
  const team = path.join(tmp, 'team');
  await fs.mkdir(path.join(company, 'policies'), { recursive: true });
  await fs.mkdir(path.join(company, 'skills'), { recursive: true });
  await fs.mkdir(team, { recursive: true });
  await fs.writeFile(path.join(company, 'policies', 'a.md'), '# a\n');
  await fs.writeFile(path.join(company, 'percolator.yaml'), 'rules:\n  max_rounds_ceiling: 2\n');
  await fs.writeFile(path.join(team, 'percolator.yaml'), 'nodes: {}\n');
  grounds = {
    company: { name: 'company', dir: company, commit: 'abc123', source: { git: 'x', ref: 'main' } },
    team: { name: 'team', dir: team, commit: 'local', source: { path: team } },
  } as Record<string, ResolvedGround>;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

describe('resolveMappings', () => {
  test('resolves file and dir mappings to absolute paths', async () => {
    const out = await resolveMappings([mFile('policies/a.md'), mDir('skills')], grounds);
    assert.equal(out[0]!.absPath, path.join(grounds.company!.dir, 'policies', 'a.md'));
    assert.equal(out[0]!.ground, 'company');
    assert.equal(out[0]!.commit, 'abc123');
    assert.equal(out[1]!.absPath, path.join(grounds.company!.dir, 'skills'));
    await fs.access(out[0]!.absPath);
  });

  test('reports every missing path at once', async () => {
    await assert.rejects(
      resolveMappings([mFile('policies/gone.md'), mDir('skills-gone/')], grounds),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.deepEqual(e.message.split('\n'), [
          'config: use.0.file: ground "company": policies/gone.md does not exist; fix the path or add it to the ground',
          'config: use.1.dir: ground "company": skills-gone/ does not exist; fix the path or add it to the ground',
        ]);
        return true;
      },
    );
  });

  test('unknown ground name errors', async () => {
    await assert.rejects(resolveMappings([mFile('x.md', 'policy', 'nope')], grounds), {
      message: 'config: use.0.from: ground "nope" is not declared; add it under grounds:',
    });
  });

  test('file mapping that is a directory, and dir mapping that is a file, are reported', async () => {
    await assert.rejects(
      resolveMappings([mFile('policies'), mDir('policies/a.md')], grounds, { configFile: 'prof.yaml' }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(e.file, 'prof.yaml');
        assert.deepEqual(e.message.split('\n'), [
          'prof.yaml: use.0.file: ground "company": policies is not a file; point it at a file',
          'prof.yaml: use.1.dir: ground "company": policies/a.md is not a directory; point it at a directory',
        ]);
        return true;
      },
    );
  });

  test('graph mapping must use file, not dir', async () => {
    await assert.rejects(resolveMappings([mDir('skills', 'graph')], grounds), {
      message: 'config: use.0.dir: ground "company": skills is a graph mapping and must use file, not dir; replace dir: with file:',
    });
  });

  test('paths escaping the ground are reported with the ground and path', async () => {
    const outside = path.join(tmp, 'team', 'percolator.yaml');
    await assert.rejects(
      resolveMappings(
        [mFile('../team/percolator.yaml'), mFile('..\\team\\percolator.yaml'), mFile(outside), mDir('skills/../../team')],
        grounds,
      ),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.deepEqual(e.message.split('\n'), [
          'config: use.0.file: ground "company": ../team/percolator.yaml is outside the ground; use a path inside the ground',
          'config: use.1.file: ground "company": ..\\team\\percolator.yaml is outside the ground; use a path inside the ground',
          `config: use.2.file: ground "company": ${outside} is outside the ground; use a path inside the ground`,
          'config: use.3.dir: ground "company": skills/../../team is outside the ground; use a path inside the ground',
        ]);
        return true;
      },
    );
  });

  test('paths containing ":" (drive-relative, alternate data streams) are each reported', async () => {
    await assert.rejects(
      resolveMappings([mFile('C:..\\..\\x'), mFile('D:x'), mFile('a:b')], grounds, { configFile: 'prof.yaml' }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.deepEqual(e.message.split('\n'), [
          'prof.yaml: use.0.file: ground "company": C:..\\..\\x must not contain ":"; remove the ":"',
          'prof.yaml: use.1.file: ground "company": D:x must not contain ":"; remove the ":"',
          'prof.yaml: use.2.file: ground "company": a:b must not contain ":"; remove the ":"',
        ]);
        return true;
      },
    );
  });

  test('a symlink inside the ground that points outside it is reported', async (t) => {
    const link = path.join(grounds.company!.dir, 'escape');
    try {
      await fs.symlink(path.join(tmp, 'team'), link, 'junction');
    } catch {
      t.skip('cannot create a directory symlink here');
      return;
    }
    await assert.rejects(
      resolveMappings([mDir('escape'), mFile('escape/percolator.yaml'), mFile('policies/a.md')], grounds),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.deepEqual(e.message.split('\n'), [
          'config: use.0.dir: ground "company": escape resolves outside the ground (through a symlink); point it at a path inside the ground',
          'config: use.1.file: ground "company": escape/percolator.yaml resolves outside the ground (through a symlink); point it at a path inside the ground',
        ]);
        return true;
      },
    );
  });
});

describe('checkGraphReferences', () => {
  test('applies_to accepts a step id', async () => {
    const graph = buildGraph(
      mergeLayers([
        {
          source: 'test',
          fragment: {
            bindings: {
              intake: { agent: 'claude' },
              groom: { agent: 'claude' },
              plan: [{ agent: 'claude' }, { agent: 'codex' }],
              implement: { agent: 'claude' },
              review: { agent: 'claude' },
              deliver: { builtin: 'github.open_pr' },
            },
          },
        },
      ]),
    );
    const ms = await resolveMappings([{ ...mFile('policies/a.md'), applies_to: ['plan.0'] }], grounds);
    await checkGraphReferences(graph, ms, grounds, 'config.yaml');
    const bad = await resolveMappings([{ ...mFile('policies/a.md'), applies_to: ['plan.9'] }], grounds);
    await assert.rejects(checkGraphReferences(graph, bad, grounds, 'config.yaml'), {
      message: 'config.yaml: use.0.applies_to.0: "plan.9" names no stage or node; use "*", a stage or a node name',
    });
  });

  test('checkGraphReferences reports applies_to with the entry line', async () => {
    const graph = buildGraph(
      mergeLayers([
        {
          source: 'test',
          fragment: {
            bindings: {
              intake: { agent: 'claude' },
              groom: { agent: 'claude' },
              plan: { agent: 'claude' },
              implement: { agent: 'claude' },
              review: { agent: 'claude' },
              deliver: { builtin: 'github.open_pr' },
            },
          },
        },
      ]),
    );
    const [m] = await resolveMappings([{ ...mFile('policies/a.md'), applies_to: ['*', 'nope'] }], grounds);
    const located = { ...m!, locator: { file: 'c.yaml', lines: { 'use.0': 4, 'use.0.applies_to.1': 6 } } };
    await assert.rejects(checkGraphReferences(graph, [located], grounds, 'config.yaml'), {
      message: 'c.yaml:6: use.0.applies_to.1: "nope" names no stage or node; use "*", a stage or a node name',
    });
  });

  test('resolveEach locates problems through the locator', async () => {
    const { problems } = await resolveEach([mFile('x.md', 'policy', 'corp')], grounds, {
      source: 'profile:w',
      configFile: 'c.yaml',
      locator: { file: 'c.yaml', lines: { 'profiles.w.use.0.from': 5 }, prefix: 'profiles.w' },
    });
    assert.deepEqual(problems, [
      { file: 'c.yaml', line: 5, path: 'profiles.w.use.0.from', message: 'ground "corp" is not declared; add it under grounds:' },
    ]);
  });
});
