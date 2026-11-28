import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '../../src/herdr/hc.ts';
import { isWatcherTerminal } from '../../src/watch/control.ts';

const terminal = (labels: Record<string, string>): Terminal => ({
  address: 't1',
  name: 'percolator-watch',
  state: 'live',
  status: null,
  exitCode: null,
  turn: 0,
  labels,
});

test('isWatcherTerminal: only a terminal labelled percolator.role=watcher, whatever its name', () => {
  assert.equal(isWatcherTerminal(terminal({ 'percolator.role': 'watcher' })), true);
  assert.equal(isWatcherTerminal(terminal({ 'percolator.role': 'driver' })), false);
  assert.equal(isWatcherTerminal(terminal({})), false);
});
