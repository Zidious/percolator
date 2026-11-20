export { expandHome, toPosix, samePath } from './util/paths.ts';
export { writeFileAtomic, readYamlFile } from './util/fs.ts';

export { validate } from './validate.ts';
export type { ValidateOptions, ValidateResult } from './validate.ts';

export * from './config/schema.ts';
export { loadUserConfig, loadFragment, ConfigError } from './config/load.ts';
export { writeJsonSchema } from './config/json-schema.ts';
export { selectProfile, normalizeRemote } from './config/profile.ts';

export { cliGit } from './grounds/git.ts';
export type { Git } from './grounds/git.ts';
export { readLock, writeLock } from './grounds/lock.ts';
export type { Lock } from './grounds/lock.ts';
export { resolveGrounds } from './grounds/resolve.ts';
export type { ResolvedGround, ResolveOptions } from './grounds/resolve.ts';
export { resolveMappings, fragmentLayers } from './grounds/mappings.ts';
export type { ResolvedMapping, Layer } from './grounds/mappings.ts';

export { CORE_STAGES, STAGE_CONTRACTS, CORE_GROOM_GATE } from './graph/core.ts';
export { mergeLayers, LockViolation } from './graph/merge.ts';
export type { Merged, Sourced } from './graph/merge.ts';
export { checkRules, RuleViolationError } from './graph/rules.ts';
export type { Violation } from './graph/rules.ts';
export { buildGraph, GraphError } from './graph/build.ts';
export type { Graph, Step, BackEdge } from './graph/build.ts';

export { runGraph } from './engine/engine.ts';
export type { RunDeps } from './engine/engine.ts';
export type { Runtime, NodeOutcome, RunContext } from './engine/runtime.ts';
export { newState, saveState, loadState } from './engine/state.ts';
export type { RunState, StepRecord } from './engine/state.ts';

export { nodeExec } from './util/exec.ts';
export type { Exec } from './util/exec.ts';
export { cliHc, HcError } from './herdr/hc.ts';
export type { Hc, Terminal, AgentStatus } from './herdr/hc.ts';
export { cliHerdrApp } from './herdr/app.ts';
export type { HerdrApp } from './herdr/app.ts';
export { ensureWorktree, defaultWorktreeDir } from './workspace/worktree.ts';
export { runDir, stepDir, materializeGrounds, buildSkillPlugins } from './workspace/run-dir.ts';
export type { MaterializedMapping } from './workspace/run-dir.ts';
export { ADAPTERS } from './adapters/index.ts';
export type { AgentAdapter, LaunchSpec } from './adapters/index.ts';
export { checkAgents } from './adapters/check.ts';
export { buildTask, renderTemplate } from './runtime/task.ts';
export { HerdrRuntime, terminalName } from './runtime/herdr-runtime.ts';
export type { HerdrRuntimeOptions, StepHandler, Attention } from './runtime/herdr-runtime.ts';
export { mappingsFor } from './grounds/mappings.ts';
