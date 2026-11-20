import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadFragment, loadUserConfig } from './config/load.ts';
import type { GraphFragment, GroundSpec } from './config/schema.ts';
import { selectProfile } from './config/profile.ts';
import { buildGraph } from './graph/build.ts';
import type { Graph } from './graph/build.ts';
import { mergeLayers } from './graph/merge.ts';
import { checkRules, RuleViolationError } from './graph/rules.ts';
import { cliGit } from './grounds/git.ts';
import type { Git } from './grounds/git.ts';
import { checkAgents } from './adapters/check.ts';
import { collectLayers } from './grounds/layers.ts';
import { checkGraphReferences } from './grounds/mappings.ts';
import type { ResolvedMapping } from './grounds/mappings.ts';
import type { ResolvedGround } from './grounds/resolve.ts';
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
  /** Test hook: stats the repo layer (default fs.lstat); only ENOENT means absent. */
  lstatRepoLayer?: (file: string) => Promise<unknown>;
};

export type ValidateResult = {
  profile: string;
  graph: Graph;
  mappings: ResolvedMapping[];
  grounds: Record<string, ResolvedGround>;
  groundVersions: Record<string, string>;
};

export async function validate(opts: ValidateOptions): Promise<ValidateResult> {
  const git = opts.git ?? cliGit;
  const config = await loadUserConfig(opts.configFile);
  const remoteUrl = opts.profile === undefined ? await git.remoteUrl(opts.cwd) : undefined;
  const { name, profile } = selectProfile(config, {
    cwd: opts.cwd,
    realCwd: await fs.realpath(opts.cwd).catch(() => opts.cwd),
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
    configFile: opts.configFile,
    ...(opts.update !== undefined ? { update: opts.update } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  const profileRoot = {
    source: `profile:${name}`,
    use: profile.use ?? [],
    fragment: {
      ...(profile.bindings ? { bindings: profile.bindings } : {}),
      ...(profile.nodes ? { nodes: profile.nodes } : {}),
      ...(profile.rules ? { rules: profile.rules } : {}),
    },
  };
  const repoRoot = (await git.toplevel(opts.cwd)) ?? opts.cwd;
  const repoFile = path.join(repoRoot, '.percolator', 'percolator.yaml');
  let repoLayer: GraphFragment | undefined;
  const repoPresent = await (opts.lstatRepoLayer ?? fs.lstat)(repoFile).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false; // only ENOENT means absent
      throw err;
    },
  );
  if (repoPresent) {
    if (profile.trust_repo_config !== true) {
      throw new ConfigError(
        `${repoFile} exists, but profile "${name}" does not trust repo config (it can add nodes that run commands); set trust_repo_config: true in that profile to use it`,
        opts.configFile,
      );
    }
    repoLayer = await (opts.loadRepoLayer ?? loadFragment)(repoFile).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined; // vanished since the check; any other failure is real
      throw err;
    });
  }
  const roots = [profileRoot];
  if (repoLayer) roots.push({ source: 'repo:.percolator/percolator.yaml', use: repoLayer.use ?? [], fragment: repoLayer });
  const { layers, mappings } = await collectLayers({ roots, grounds, configFile: opts.configFile });

  const merged = mergeLayers(layers);
  const violations = checkRules(merged);
  if (violations.length > 0) throw new RuleViolationError(violations, opts.configFile);
  const graph = buildGraph(merged);
  await checkGraphReferences(graph, mappings, grounds, opts.configFile);
  await checkAgents(graph, mappings, opts.configFile);
  return {
    profile: name,
    graph,
    mappings,
    grounds,
    groundVersions: Object.fromEntries(Object.values(grounds).map((g) => [g.name, groundVersion(g)])),
  };
}

/** Human-readable ground version: `<ref> (<commit12>)` for git grounds, `local` for path grounds. */
export function groundVersion(g: ResolvedGround): string {
  return 'git' in g.source ? `${g.source.ref} (${g.commit.slice(0, 12)})` : 'local';
}
