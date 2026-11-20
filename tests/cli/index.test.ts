import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../../src/index.ts';

test('public API exports the pipeline', () => {
  for (const name of [
    'validate', 'loadUserConfig', 'loadFragment', 'selectProfile', 'normalizeRemote', 'resolveGrounds',
    'readLock', 'writeLock', 'resolveMappings', 'fragmentLayers', 'mergeLayers', 'checkRules',
    'buildGraph', 'runGraph', 'newState', 'saveState', 'loadState', 'writeJsonSchema', 'expandHome',
  ]) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', name);
  }
  assert.ok(Array.isArray(api.CORE_STAGES));
  assert.ok(api.STAGE_CONTRACTS.review);
  assert.ok(new api.LockViolation('t', 'a', 'b') instanceof api.ConfigError);
  assert.equal(typeof api.GraphError, 'function');
  assert.ok(api.cliGit);
});
