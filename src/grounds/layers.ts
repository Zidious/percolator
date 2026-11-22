import { loadLocated } from '../config/load.ts';
import { locate } from '../config/locate.ts';
import type { Locator, Problem } from '../config/locate.ts';
import { GraphFragmentSchema } from '../config/schema.ts';
import type { GraphFragment, Mapping } from '../config/schema.ts';
import { LockViolation } from '../graph/merge.ts';
import { resolveEach, throwProblems } from './mappings.ts';
import type { Layer, ResolvedMapping } from './mappings.ts';
import type { ResolvedGround } from './resolve.ts';

export type LayerRoot = { source: string; use: Mapping[]; fragment: GraphFragment; locator?: Locator };

/**
 * Walks each root's `use` depth-first. An `as: graph` mapping loads its fragment, recurses into the
 * fragment's own `use`, then pushes the fragment's layer, so dependencies come before the fragment
 * that uses them and a root's layer comes after all its fragments. Graph mappings are visited once
 * per `<ground>:<file>` (first visit wins, which also ends cycles). Fragments may only use grounds
 * declared in the user config: new grounds are never resolved here, so every pin stays in
 * `percolator.lock`. Returns the layers and the mappings merged across them (see mergeMappings).
 */
export async function collectLayers(o: {
  roots: LayerRoot[];
  grounds: Record<string, ResolvedGround>;
  configFile: string;
}): Promise<{ layers: Layer[]; mappings: ResolvedMapping[] }> {
  const layers: Layer[] = [];
  const perLayer: { source: string; mappings: ResolvedMapping[] }[] = [];
  const problems: Problem[] = [];
  const visited = new Set<string>();

  async function walk(layerSource: string, use: Mapping[], locator: Locator | undefined): Promise<void> {
    const resolved = await resolveEach(use, o.grounds, {
      source: layerSource,
      configFile: o.configFile,
      ...(locator ? { locator } : {}),
    });
    problems.push(...resolved.problems);
    for (const m of resolved.mappings) {
      if (m.as !== 'graph') continue;
      const key = `${m.ground}:${m.file}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const source = `ground:${m.ground}/${m.file}@${m.commit.slice(0, 12)}`;
      const { data: fragment, lines } = await loadLocated(m.absPath, GraphFragmentSchema);
      const fragmentLocator = { file: m.absPath, lines };
      await walk(source, fragment.use ?? [], fragmentLocator);
      layers.push({ source, fragment, locator: fragmentLocator });
    }
    perLayer.push({ source: layerSource, mappings: resolved.mappings });
  }

  for (const root of o.roots) {
    await walk(root.source, root.use, root.locator);
    layers.push({ source: root.source, fragment: root.fragment, ...(root.locator ? { locator: root.locator } : {}) });
  }
  throwProblems(problems);
  return { layers, mappings: mergeMappings(perLayer) };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

// Deep equality ignoring which layer, file and key declared the mapping.
function sameMapping(a: ResolvedMapping, b: ResolvedMapping): boolean {
  const { source: _a, locator: _la, path: _pa, ...x } = a;
  const { source: _b, locator: _lb, path: _pb, ...y } = b;
  return JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));
}

/**
 * Merges per-layer mappings in layer order. The key is `<as>:<ground>:<file|dir>`; a duplicate keeps
 * the first position and the later mapping replaces the earlier, unless the earlier is `required`
 * and the later differs (ignoring `source`): then LockViolation.
 */
export function mergeMappings(perLayer: { source: string; mappings: ResolvedMapping[] }[]): ResolvedMapping[] {
  const out = new Map<string, ResolvedMapping>();
  for (const layer of perLayer) {
    for (const m of layer.mappings) {
      const rel = (m.file ?? m.dir)!;
      const key = `${m.as}:${m.ground}:${rel}`;
      const earlier = out.get(key);
      if (earlier?.required === true) {
        if (!sameMapping(earlier, m)) {
          throw new LockViolation({
            target: `${m.ground}:${rel} (${m.as})`,
            noun: 'mapping',
            lockedBy: earlier.source,
            attemptedBy: m.source,
            attempt: locate(m.locator, m.source, m.path),
            lock: locate(earlier.locator, earlier.source, earlier.path),
          });
        }
        continue; // restated identically: the original locker stays the locker
      }
      out.set(key, m);
    }
  }
  return [...out.values()];
}
