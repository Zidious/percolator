import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Mapping } from '../../src/config/schema.ts';
import { ConfigError } from '../../src/config/load.ts';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';
import { fragmentLayers, resolveMappings } from '../../src/grounds/mappings.ts';

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
  await fs.rm(tmp, { recursive: true, force: true });
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
        assert.match(e.message, /company.*policies\/gone\.md[\s\S]*company.*skills-gone/);
        return true;
      },
    );
  });

  test('unknown ground name errors', async () => {
    await assert.rejects(resolveMappings([mFile('x.md', 'policy', 'nope')], grounds), /nope.*unknown ground/);
  });

  test('file mapping that is a directory, and dir mapping that is a file, are reported', async () => {
    await assert.rejects(
      resolveMappings([mFile('policies'), mDir('policies/a.md')], grounds, { configFile: 'prof.yaml' }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(e.file, 'prof.yaml');
        assert.match(e.message, /company.*policies.*not a file[\s\S]*company.*policies\/a\.md.*not a directory/);
        return true;
      },
    );
  });

  test('graph mapping must use file, not dir', async () => {
    await assert.rejects(resolveMappings([mDir('skills', 'graph')], grounds), /company.*skills.*graph.*file/);
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
        assert.equal(e.message.split('\n').length, 4);
        assert.match(e.message, /company.*\.\.\/team\/percolator\.yaml.*outside/);
        return true;
      },
    );
  });
});

describe('fragmentLayers', () => {
  test('graph mappings become layers in use order', async () => {
    const ms = await resolveMappings(
      [mFile('percolator.yaml', 'graph', 'company'), mFile('policies/a.md'), mFile('percolator.yaml', 'graph', 'team')],
      grounds,
    );
    const layers = await fragmentLayers(ms);
    assert.deepEqual(
      layers.map((l) => l.source),
      ['ground:company/percolator.yaml@abc123', 'ground:team/percolator.yaml@local'],
    );
    assert.deepEqual(layers[0]!.fragment.rules, { max_rounds_ceiling: 2 });
  });
});
