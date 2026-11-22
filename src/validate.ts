import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadLocated } from './config/load.ts';
import type { Located } from './config/load.ts';
import { locate } from './config/locate.ts';
import { GraphFragmentSchema, UserConfigSchema } from './config/schema.ts';
import type { GraphFragment, GroundSpec, Profile } from './config/schema.ts';
import { selectProfile } from './config/profile.ts';
import { buildGraph } from './graph/build.ts';
import type { Graph } from './graph/build.ts';
import { mergeLayers } from './graph/merge.ts';
import { checkRules, RuleViolationError } from './graph/rules.ts';
import { cliGit } from './grounds/git.ts';
import type { Git } from './grounds/git.ts';
import { checkAgents } from './adapters/check.ts';
import { collectLayers } from './grounds/layers.ts';
import type { LayerRoot } from './grounds/layers.ts';
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
  /** Test hook: loads the repo layer (default loadLocated with the fragment schema). */
  loadRepoLayer?: (file: string) => Promise<Located<GraphFragment>>;
  /** Test hook: stats the repo layer (default fs.lstat); only ENOENT means absent. */
  lstatRepoLayer?: (file: string) => Promise<unknown>;
};

export type ValidateResult = {
  profile: string;
  graph: Graph;
  mappings: ResolvedMapping[];
  grounds: Record<string, ResolvedGround>;
  groundVersions: Record<string, string>;
  /** The selected profile's blocks as written (undefined when absent). */
  runtime: Profile['runtime'];
  tracker: Profile['tracker'];
};

export async function validate(opts: ValidateOptions): Promise<ValidateResult> {
  const git = opts.git ?? cliGit;
  const { data: config, lines } = await loadLocated(opts.configFile, UserConfigSchema);
  const remoteUrl = opts.profile === undefined ? await git.remoteUrl(opts.cwd) : undefined;
  const { name, profile } = selectProfile(config, {
    cwd: opts.cwd,
    realCwd: await fs.realpath(opts.cwd).catch(() => opts.cwd),
    configFile: opts.configFile,
    lines,
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
    lines,
    ...(opts.update !== undefined ? { update: opts.update } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  const profileLocator = { file: opts.configFile, lines, prefix: `profiles.${name}` };
  const profileRoot: LayerRoot = {
    source: `profile:${name}`,
    locator: profileLocator,
    use: profile.use ?? [],
    fragment: {
      ...(profile.bindings ? { bindings: profile.bindings } : {}),
      ...(profile.nodes ? { nodes: profile.nodes } : {}),
      ...(profile.rules ? { rules: profile.rules } : {}),
    },
  };
  const repoRoot = (await git.toplevel(opts.cwd)) ?? opts.cwd;
  const repoFile = path.join(repoRoot, '.percolator', 'percolator.yaml');
  let repoLayer: Located<GraphFragment> | undefined;
  const repoPresent = await (opts.lstatRepoLayer ?? fs.lstat)(repoFile).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false; // only ENOENT means absent
      throw err;
    },
  );
  if (repoPresent) {
    if (profile.trust_repo_config !== true) {
      const w = locate({ file: opts.configFile, lines }, opts.configFile, `profiles.${name}`);
      throw new ConfigError(
        `${repoFile} exists, but profile "${name}" does not trust repo config (it can add nodes that run commands); set trust_repo_config: true in that profile to use it`,
        w.file,
        w.line,
        w.path,
      );
    }
    repoLayer = await (opts.loadRepoLayer ?? ((f: string) => loadLocated(f, GraphFragmentSchema)))(repoFile).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined; // vanished since the check; any other failure is real
      throw err;
    });
  }
  const roots = [profileRoot];
  if (repoLayer) {
    roots.push({
      source: 'repo:.percolator/percolator.yaml',
      use: repoLayer.data.use ?? [],
      fragment: repoLayer.data,
      locator: { file: repoFile, lines: repoLayer.lines },
    });
  }
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
    runtime: profile.runtime,
    tracker: profile.tracker,
  };
}

/** Human-readable ground version: `<ref> (<commit12>)` for git grounds, `local` for path grounds. */
export function groundVersion(g: ResolvedGround): string {
  return 'git' in g.source ? `${g.source.ref} (${g.commit.slice(0, 12)})` : 'local';
}
