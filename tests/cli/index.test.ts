import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../../src/index.ts';

test('public API exports the pipeline', () => {
  for (const name of [
    'validate', 'loadUserConfig', 'loadFragment', 'selectProfile', 'normalizeRemote', 'resolveGrounds',
    'readLock', 'writeLock', 'resolveMappings', 'collectLayers', 'mergeMappings', 'mergeLayers', 'checkRules',
    'buildGraph', 'runGraph', 'newState', 'saveState', 'loadState', 'writeJsonSchema', 'expandHome',
    'nodeExec', 'cliHc', 'cliHerdrApp', 'ensureWorktree', 'defaultWorktreeDir', 'runDir', 'stepDir',
    'materializeGrounds', 'buildSkillPlugins', 'checkAgents', 'buildTask', 'renderTemplate', 'terminalName',
    'mappingsFor', 'drive', 'prepareRun', 'cliGh', 'parseTicket', 'githubIntake', 'githubGate', 'githubOpenPr',
  ]) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', name);
  }
  assert.ok(Array.isArray(api.CORE_STAGES));
  assert.ok(api.STAGE_CONTRACTS.review);
  const lock = { target: 't', noun: 'node' as const, lockedBy: 'a', attemptedBy: 'b', attempt: { file: 'b' }, lock: { file: 'a' } };
  assert.ok(new api.LockViolation(lock) instanceof api.ConfigError);
  assert.equal(typeof api.GraphError, 'function');
  assert.ok(api.cliGit);
  assert.equal(typeof api.HcError, 'function');
  assert.equal(typeof api.HerdrRuntime, 'function');
  assert.equal(typeof api.ADAPTERS.claude.argv, 'function');
});
