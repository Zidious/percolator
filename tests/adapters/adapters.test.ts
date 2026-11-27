import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS } from '../../src/adapters/index.ts';

test('claude argv puts plugins, add-dirs and -- before the message', () => {
  assert.deepEqual(
    ADAPTERS.claude.argv({ model: 'opus', pluginDirs: ['C:\\g\\p one'], addDirs: ['C:\\runs\\r 1'], message: '-hi' }),
    ['claude', '--model', 'opus', '--plugin-dir', 'C:\\g\\p one', '--add-dir', 'C:\\runs\\r 1', '--', '-hi'],
  );
  assert.deepEqual(ADAPTERS.claude.argv({ pluginDirs: [], addDirs: [], message: 'm' }), ['claude', '--', 'm']);
  assert.equal(ADAPTERS.claude.nativeSkills, true);
  assert.equal(ADAPTERS.claude.plugins, true);
});

test('claude argv passes effort after the model', () => {
  assert.deepEqual(ADAPTERS.claude.argv({ model: 'opus', effort: 'medium', pluginDirs: [], addDirs: [], message: 'm' }), [
    'claude',
    '--model',
    'opus',
    '--effort',
    'medium',
    '--',
    'm',
  ]);
  assert.equal(ADAPTERS.claude.effort, true);
  assert.equal(ADAPTERS.codex.effort, false);
  assert.equal(ADAPTERS.command.effort, false);
});

test('codex argv always has --no-daemon and no plugin flags', () => {
  assert.deepEqual(ADAPTERS.codex.argv({ model: 'gpt', pluginDirs: ['/p'], addDirs: ['/a'], message: 'm' }), [
    'codex',
    '--no-daemon',
    '--model',
    'gpt',
    '--add-dir',
    '/a',
    '--',
    'm',
  ]);
  assert.deepEqual(ADAPTERS.codex.argv({ pluginDirs: [], addDirs: [], message: 'm' }), ['codex', '--no-daemon', '--', 'm']);
  assert.equal(ADAPTERS.codex.nativeSkills, false);
  assert.equal(ADAPTERS.codex.plugins, false);
});

test('command argv appends the message to the configured program', () => {
  assert.deepEqual(ADAPTERS.command.argv({ command: ['aider', '--yes'], pluginDirs: [], addDirs: [], message: 'do it' }), [
    'aider',
    '--yes',
    'do it',
  ]);
  assert.equal(ADAPTERS.command.nativeSkills, false);
  assert.equal(ADAPTERS.command.plugins, false);
});

test('the command adapter checks its own config: a command, whose program does not start with "-"', () => {
  const check = ADAPTERS.command.check!;
  assert.deepEqual(check({ agent: 'command' }), [
    { message: 'agent "command" needs "command" (the program to run); add command: [program, ...args]' },
  ]);
  assert.deepEqual(check({ agent: 'command', command: [] }), [
    { message: 'agent "command" needs "command" (the program to run); add command: [program, ...args]' },
  ]);
  assert.deepEqual(check({ agent: 'command', command: ['-x'] }), [{ message: 'command must not start with "-"; put the program first', key: 'command' }]);
  assert.deepEqual(check({ agent: 'command', command: ['node', 'x.js'] }), []);
});

test('only the command adapter has config of its own to check', () => {
  assert.deepEqual(Object.values(ADAPTERS).filter((a) => a.check !== undefined).map((a) => a.name), ['command']);
});
