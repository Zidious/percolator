import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ConfigError } from '../../src/config/load.ts';
import type { Mapping } from '../../src/config/schema.ts';
import { LockViolation } from '../../src/graph/merge.ts';
import { collectLayers, mergeMappings } from '../../src/grounds/layers.ts';
import type { ResolvedMapping } from '../../src/grounds/mappings.ts';
import type { ResolvedGround } from '../../src/grounds/resolve.ts';

let tmp: string;
let grounds: Record<string, ResolvedGround>;

const graphUse = (from: string, file = 'percolator.yaml'): Mapping => ({
  from,
  file,
  as: 'graph',
  applies_to: ['*'],
  required: false,
});
const policy = (over: Partial<Mapping> = {}): Mapping => ({
  from: 'team',
  file: 'p.md',
  as: 'policy',
  applies_to: ['*'],
  required: false,
  ...over,
});
const yamlUse = (m: Mapping): string =>
  `  - { from: ${m.from}, file: ${m.file}, as: ${m.as}, required: ${m.required}, applies_to: ${JSON.stringify(m.applies_to)} }\n`;

const COMPANY = 'ground:company/percolator.yaml@abc123def456';
const TEAM = 'ground:team/percolator.yaml@local';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-layers-')));
  grounds = {};
  for (const [name, commit] of [
    ['company', 'abc123def456789'],
    ['team', 'local'],
  ] as const) {
    const dir = path.join(tmp, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'p.md'), '# p\n');
    grounds[name] = { name, dir, commit, source: { path: dir } } as ResolvedGround;
  }
  await fs.writeFile(path.join(tmp, 'team', 'percolator.yaml'), 'nodes: {}\n');
  await fs.writeFile(path.join(tmp, 'company', 'percolator.yaml'), 'rules:\n  max_rounds_ceiling: 2\n');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const root = (use: Mapping[], source = 'profile:p') => ({ source, use, fragment: {} });

describe('collectLayers', () => {
  test('graph mappings become layers in use order', async () => {
    const { layers } = await collectLayers({
      roots: [root([graphUse('company'), policy(), graphUse('team')])],
      grounds,
      configFile: 'config.yaml',
    });
    assert.deepEqual(
      layers.map((l) => l.source),
      [COMPANY, TEAM, 'profile:p'],
    );
    assert.deepEqual(layers[0]!.fragment.rules, { max_rounds_ceiling: 2 });
  });

  test('fragment use pulls a second fragment, dependencies first', async () => {
    await fs.writeFile(path.join(tmp, 'company', 'percolator.yaml'), `use:\n${yamlUse(graphUse('team'))}`);
    const { layers } = await collectLayers({ roots: [root([graphUse('company')])], grounds, configFile: 'config.yaml' });
    assert.deepEqual(
      layers.map((l) => l.source),
      [TEAM, COMPANY, 'profile:p'],
    );
  });

  test('fragment cycle is visited once', async () => {
    await fs.writeFile(path.join(tmp, 'company', 'percolator.yaml'), `use:\n${yamlUse(graphUse('team'))}`);
    await fs.writeFile(path.join(tmp, 'team', 'percolator.yaml'), `use:\n${yamlUse(graphUse('company'))}`);
    const { layers } = await collectLayers({ roots: [root([graphUse('company')])], grounds, configFile: 'config.yaml' });
    assert.deepEqual(
      layers.map((l) => l.source),
      [TEAM, COMPANY, 'profile:p'],
    );
  });

  test('an unknown ground in a fragment names the fragment and the config', async () => {
    const frag = path.join(tmp, 'company', 'percolator.yaml');
    await fs.writeFile(frag, `use:\n${yamlUse(graphUse('nope'))}`);
    await assert.rejects(
      collectLayers({ roots: [root([graphUse('company')])], grounds, configFile: 'config.yaml' }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(
          e.message,
          `${frag}:2: use.0.from: ground "nope" is not declared; add it under grounds: in config.yaml`,
        );
        return true;
      },
    );
  });

  test('an unknown ground in the user config itself has no "in" hint', async () => {
    await assert.rejects(
      collectLayers({ roots: [root([graphUse('nope')])], grounds, configFile: 'config.yaml' }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(e.message, 'config.yaml: use.0.from: ground "nope" is not declared; add it under grounds:');
        return true;
      },
    );
  });

  test('a repo-layer unknown ground names the repo layer', async () => {
    const repo = 'repo:.percolator/percolator.yaml';
    await assert.rejects(
      collectLayers({
        roots: [root([]), { ...root([policy({ from: 'nope' })], repo), locator: { file: 'repo.yaml', lines: { 'use.0.from': 3 } } }],
        grounds,
        configFile: 'config.yaml',
      }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.equal(
          e.message,
          'repo.yaml:3: use.0.from: ground "nope" is not declared; add it under grounds: in config.yaml',
        );
        return true;
      },
    );
  });

  test('mappings carry the source of the layer that declared them', async () => {
    await fs.writeFile(path.join(tmp, 'company', 'percolator.yaml'), `use:\n${yamlUse(policy())}`);
    const { mappings } = await collectLayers({
      roots: [root([graphUse('company'), policy({ from: 'company' })])],
      grounds,
      configFile: 'config.yaml',
    });
    assert.deepEqual(
      mappings.map((m) => [m.ground, m.file, m.source]),
      [
        ['team', 'p.md', COMPANY],
        ['company', 'percolator.yaml', 'profile:p'],
        ['company', 'p.md', 'profile:p'],
      ],
    );
  });
});

describe('mergeMappings', () => {
  const resolved = (m: Mapping, source: string): ResolvedMapping => ({
    ...m,
    absPath: '/x',
    ground: m.from,
    commit: 'local',
    source,
  });

  test('a required mapping cannot be weakened by a later layer', () => {
    assert.throws(
      () =>
        mergeMappings([
          { source: COMPANY, mappings: [resolved(policy({ required: true }), COMPANY)] },
          { source: 'profile:p', mappings: [resolved(policy({ applies_to: ['review'] }), 'profile:p')] },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof LockViolation);
        assert.equal(
          e.message,
          `profile:p: mapping team:p.md (policy) is locked by ${COMPANY} (required: true); remove this mapping or restate it exactly`,
        );
        return true;
      },
    );
  });

  test('a required mapping restated identically is fine', () => {
    const out = mergeMappings([
      { source: 'a', mappings: [resolved(policy({ required: true }), 'a')] },
      { source: 'b', mappings: [resolved(policy({ required: true }), 'b')] },
    ]);
    assert.equal(out.length, 1);
  });

  test('a lock restated identically still names the original locker', () => {
    assert.throws(
      () =>
        mergeMappings([
          { source: COMPANY, mappings: [resolved(policy({ required: true }), COMPANY)] },
          { source: 'profile:p', mappings: [resolved(policy({ required: true }), 'profile:p')] },
          { source: 'repo:r', mappings: [resolved(policy({ applies_to: ['review'], required: true }), 'repo:r')] },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof LockViolation);
        assert.equal(
          e.message,
          `repo:r: mapping team:p.md (policy) is locked by ${COMPANY} (required: true); remove this mapping or restate it exactly`,
        );
        return true;
      },
    );
  });

  test('a mapping lock names the attempting and locking files and lines', () => {
    const at = (file: string, line: number) => ({ locator: { file, lines: { 'use.1': line } }, path: 'use.1' });
    assert.throws(
      () =>
        mergeMappings([
          { source: COMPANY, mappings: [{ ...resolved(policy({ required: true }), COMPANY), ...at('g.yaml', 4) }] },
          { source: 'profile:p', mappings: [{ ...resolved(policy({ applies_to: ['review'] }), 'profile:p'), ...at('c.yaml', 9) }] },
        ]),
      {
        message:
          'c.yaml:9: use.1: mapping team:p.md (policy) is locked by g.yaml:4 (required: true); remove this mapping or restate it exactly',
      },
    );
  });

  test('an identical required mapping from another layer still passes', () => {
    const out = mergeMappings([
      { source: 'a', mappings: [{ ...resolved(policy({ required: true }), 'a'), locator: { file: 'a.yaml', lines: {} }, path: 'use.0' }] },
      { source: 'b', mappings: [{ ...resolved(policy({ required: true }), 'b'), locator: { file: 'b.yaml', lines: {} }, path: 'use.3' }] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.source, 'a');
  });

  test('an unlocked mapping is overridden in place by a later layer', () => {
    const out = mergeMappings([
      { source: 'a', mappings: [resolved(policy(), 'a'), resolved(policy({ file: 'q.md' }), 'a')] },
      { source: 'b', mappings: [resolved(policy({ applies_to: ['review'] }), 'b')] },
    ]);
    assert.deepEqual(
      out.map((m) => [m.file, m.applies_to, m.source]),
      [
        ['p.md', ['review'], 'b'],
        ['q.md', ['*'], 'a'],
      ],
    );
  });
});
