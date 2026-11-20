import os from 'node:os';
import path from 'node:path';
import { loadFragment, loadUserConfig } from './config/load.ts';
import type { GraphFragment, GroundSpec } from './config/schema.ts';
import { selectProfile } from './config/profile.ts';
import { buildGraph } from './graph/build.ts';
import type { Graph } from './graph/build.ts';
import { mergeLayers } from './graph/merge.ts';
import { checkRules, RuleViolationError } from './graph/rules.ts';
import { cliGit } from './grounds/git.ts';
import type { Git } from './grounds/git.ts';
import { checkGraphReferences, fragmentLayers, resolveMappings } from './grounds/mappings.ts';
import type { Layer, ResolvedMapping } from './grounds/mappings.ts';
import { resolveGrounds } from './grounds/resolve.ts';

export type ValidateOptions = {
  configFile: string;
  cwd: string;
  profile?: string;
  update?: boolean;
  home?: string;
  git?: Git;
  /** Test hook: loads the repo layer (default loadFragment). */
  loadRepoLayer?: (file: string) => Promise<GraphFragment>;
};

export type ValidateResult = {
  profile: string;
  graph: Graph;
  mappings: ResolvedMapping[];
  groundVersions: Record<string, string>;
};

export async function validate(opts: ValidateOptions): Promise<ValidateResult> {
  const git = opts.git ?? cliGit;
  const config = await loadUserConfig(opts.configFile);
  const remoteUrl = opts.profile === undefined ? await git.remoteUrl(opts.cwd) : undefined;
  const { name, profile } = selectProfile(config, {
    cwd: opts.cwd,
    configFile: opts.configFile,
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(opts.profile !== undefined ? { override: opts.profile } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });

  const configDir = path.dirname(path.resolve(opts.configFile));
  const specs = Object.fromEntries(
    Object.entries(config.grounds ?? {}).map(([n, spec]): [string, GroundSpec] => [
      n,
      'path' in spec && !path.isAbsolute(spec.path) && !spec.path.startsWith('~')
        ? { path: path.resolve(configDir, spec.path) }
        : spec,
    ]),
  );
  const grounds = await resolveGrounds(specs, {
    lockFile: path.join(path.dirname(opts.configFile), 'percolator.lock'),
    cacheDir: path.join(opts.home ?? os.homedir(), '.percolator', 'grounds'),
    git,
    ...(opts.update !== undefined ? { update: opts.update } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  const mappings = await resolveMappings(profile.use ?? [], grounds, { configFile: opts.configFile });

  const layers: Layer[] = await fragmentLayers(mappings);
  layers.push({
    source: `profile:${name}`,
    fragment: {
      ...(profile.bindings ? { bindings: profile.bindings } : {}),
      ...(profile.nodes ? { nodes: profile.nodes } : {}),
      ...(profile.rules ? { rules: profile.rules } : {}),
    },
  });
  const repoRoot = (await git.toplevel(opts.cwd)) ?? opts.cwd;
  const repoFile = path.join(repoRoot, '.percolator', 'percolator.yaml');
  const repoLayer = await (opts.loadRepoLayer ?? loadFragment)(repoFile).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined; // the repo layer is optional; any other failure is real
    throw err;
  });
  if (repoLayer) layers.push({ source: 'repo:.percolator/percolator.yaml', fragment: repoLayer });

  const merged = mergeLayers(layers);
  const violations = checkRules(merged);
  if (violations.length > 0) throw new RuleViolationError(violations, opts.configFile);
  const graph = buildGraph(merged);
  await checkGraphReferences(graph, mappings, grounds, opts.configFile);
  return {
    profile: name,
    graph,
    mappings,
    groundVersions: Object.fromEntries(Object.values(grounds).map((g) => [g.name, g.commit === 'local' ? 'local' : g.commit.slice(0, 12)])),
  };
}
