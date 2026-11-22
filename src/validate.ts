import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadLocated } from './config/load.ts';
import type { Located } from './config/load.ts';
import { locate } from './config/locate.ts';
import type { Where } from './config/locate.ts';
import { checkGlobalStages, pickPipeline, pipelineSpecs } from './config/pipelines.ts';
import type { PipelineSpec } from './config/pipelines.ts';
import { GraphFragmentSchema, UserConfigSchema } from './config/schema.ts';
import type { GraphFragment, GroundSpec, Profile, UserConfig } from './config/schema.ts';
import type { LineIndex } from './config/locate.ts';
import { selectProfile } from './config/profile.ts';
import { buildGraph } from './graph/build.ts';
import type { Graph } from './graph/build.ts';
import { CORE_STAGES } from './graph/core.ts';
import { mergePipelines } from './graph/merge.ts';
import { checkRules, RuleViolationError } from './graph/rules.ts';
import { cliGit } from './grounds/git.ts';
import type { Git } from './grounds/git.ts';
import { checkAgents } from './adapters/check.ts';
import { collectLayers } from './grounds/layers.ts';
import type { LayerRoot } from './grounds/layers.ts';
import { checkGraphReferences } from './grounds/mappings.ts';
import type { Layer, ResolvedMapping } from './grounds/mappings.ts';
import type { ResolvedGround } from './grounds/resolve.ts';
import { resolveGrounds } from './grounds/resolve.ts';

export type ValidateOptions = {
  configFile: string;
  cwd: string;
  profile?: string;
  /** The pipeline to validate (default: the profile's default pipeline). */
  pipeline?: string;
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
  /** The validated pipeline. */
  pipeline: PipelineSpec;
  /** Every pipeline of the profile. */
  pipelines: Record<string, PipelineSpec>;
};

/** Validates one pipeline of the selected profile: `opts.pipeline`, or the profile's default. */
export async function validate(opts: ValidateOptions): Promise<ValidateResult> {
  const l = await load(opts);
  return validatePipeline(l, pickPipeline(l.specs, opts.pipeline, l.name, l.pipelinesWhere).name);
}

/** Validates every pipeline of the selected profile in order (grounds resolved once); throws the first error. */
export async function validateAll(opts: ValidateOptions): Promise<ValidateResult[]> {
  const l = await load(opts);
  const out: ValidateResult[] = [];
  for (const name of Object.keys(l.specs)) out.push(await validatePipeline(l, name));
  return out;
}

type Loaded = {
  configFile: string;
  name: string;
  profile: Profile;
  parent: { name: string; profile: Profile } | undefined;
  grounds: Record<string, ResolvedGround>;
  roots: LayerRoot[];
  profileLocator: { file: string; lines: LineIndex; prefix: string };
  /** Where errors about the profile's pipelines point: its `pipelines:` line, else the profile's. */
  pipelinesWhere: Where;
  /** The layers and mappings without any pipeline's own `use`. */
  base: { layers: Layer[]; mappings: ResolvedMapping[] };
  specs: Record<string, PipelineSpec>;
};

async function validatePipeline(l: Loaded, pipelineName: string): Promise<ValidateResult> {
  // a pipeline's own use maps like its layer's use, located under pipelines.<p>, just before that layer
  const roots = l.roots.flatMap((r): LayerRoot[] => {
    const use = r.fragment.pipelines?.[pipelineName]?.use ?? [];
    if (use.length === 0) return [r];
    const prefix = [r.locator?.prefix, 'pipelines', pipelineName].filter((x) => x !== undefined && x !== '').join('.');
    return [{ source: r.source, use, fragment: {}, ...(r.locator ? { locator: { ...r.locator, prefix } } : {}) }, r];
  });
  const { layers, mappings } =
    roots.length === l.roots.length ? l.base : await collectLayers({ roots, grounds: l.grounds, configFile: l.configFile });
  const merged = mergePipelines(layers);
  const pipelines = pipelineSpecs(merged, l.name, l.pipelinesWhere);
  const pipeline = pickPipeline(pipelines, pipelineName, l.name, l.pipelinesWhere);
  const selected = merged[pipelineName]!;
  // the header's stages are the graph's; rules are checked first, as before pipelines
  const violations = [...checkGlobalStages(merged, pipelines, l.name), ...checkRules(selected, pipeline.stages ?? CORE_STAGES)];
  if (violations.length > 0) throw new RuleViolationError(violations, l.configFile);
  const graph = buildGraph(selected, { profile: l.name, locator: l.profileLocator });
  await checkGraphReferences(graph, mappings, l.grounds, l.configFile);
  await checkAgents(graph, mappings, l.configFile);
  return {
    profile: l.name,
    graph,
    mappings,
    grounds: l.grounds,
    groundVersions: Object.fromEntries(Object.values(l.grounds).map((g) => [g.name, groundVersion(g)])),
    runtime: l.profile.runtime ?? l.parent?.profile.runtime,
    tracker: l.profile.tracker ?? l.parent?.profile.tracker,
    pipeline,
    pipelines,
  };
}

async function load(opts: ValidateOptions): Promise<Loaded> {
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
  const rootOf = (n: string, p: Profile): LayerRoot => ({
    source: `profile:${n}`,
    locator: { file: opts.configFile, lines, prefix: `profiles.${n}` },
    use: p.use ?? [],
    fragment: {
      ...(p.bindings ? { bindings: p.bindings } : {}),
      ...(p.nodes ? { nodes: p.nodes } : {}),
      ...(p.rules ? { rules: p.rules } : {}),
      ...(p.pipelines ? { pipelines: p.pipelines } : {}),
    },
  });
  // every profile's extends is checked, so a broken one shows up whichever profile is selected
  for (const [n, p] of Object.entries(config.profiles)) {
    if (p.extends !== undefined) extendedProfile(config, n, p.extends, opts.configFile, lines);
  }
  const parent = profile.extends === undefined ? undefined : extendedProfile(config, name, profile.extends, opts.configFile, lines);
  const profileRoot = rootOf(name, profile);
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
  const roots = parent ? [rootOf(parent.name, parent.profile), profileRoot] : [profileRoot];
  if (repoLayer) {
    roots.push({
      source: 'repo:.percolator/percolator.yaml',
      use: repoLayer.data.use ?? [],
      fragment: repoLayer.data,
      locator: { file: repoFile, lines: repoLayer.lines },
    });
  }
  const base = await collectLayers({ roots, grounds, configFile: opts.configFile });
  const { path: _path, ...pipelinesWhere } = locate({ file: opts.configFile, lines }, opts.configFile, `profiles.${name}.pipelines`);
  return {
    configFile: opts.configFile,
    name,
    profile,
    parent,
    grounds,
    roots,
    profileLocator,
    pipelinesWhere,
    base,
    specs: pipelineSpecs(mergePipelines(base.layers), name, pipelinesWhere),
  };
}

/** The profile `name` extends, checked: it exists, is not `name` itself, and does not extend another. */
function extendedProfile(
  config: UserConfig,
  name: string,
  parentName: string,
  configFile: string,
  lines: LineIndex,
): { name: string; profile: Profile } {
  const fail = (message: string): ConfigError => {
    const w = locate({ file: configFile, lines }, configFile, `profiles.${name}.extends`);
    return new ConfigError(message, w.file, w.line, w.path);
  };
  if (parentName === name) throw fail('a profile cannot extend itself; extend another profile or remove extends');
  const parent = config.profiles[parentName];
  if (!parent) {
    throw fail(`unknown profile "${parentName}" (profiles: ${Object.keys(config.profiles).join(', ')}); extend one of those`);
  }
  if (parent.extends !== undefined) {
    throw fail(
      `profile "${parentName}" extends "${parent.extends}" itself; extends is one level only, so extend "${parent.extends}" directly`,
    );
  }
  return { name: parentName, profile: parent };
}

/** Human-readable ground version: `<ref> (<commit12>)` for git grounds, `local` for path grounds. */
export function groundVersion(g: ResolvedGround): string {
  return 'git' in g.source ? `${g.source.ref} (${g.commit.slice(0, 12)})` : 'local';
}
