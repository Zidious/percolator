import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, USAGE } from '../../src/cli.ts';

test('COMMANDS lists every perc command, in the order the help shows them', () => {
  assert.deepEqual(
    COMMANDS.map((c) => c.name),
    ['init', 'validate', 'schema', 'pipelines', 'watch', 'run', 'resume', 'answer', 'status', 'approve', 'reject', 'clean', 'delete', 'herdr', 'drive'],
  );
});

test('the help is built from COMMANDS: each usage line, then its description lines indented', () => {
  for (const c of COMMANDS) {
    if (c.usage === undefined) continue;
    const [first, ...rest] = c.usage;
    assert.ok(USAGE.includes([`  ${first}`, ...rest.map((l) => `      ${l}`)].join('\n')), c.name);
  }
  assert.ok(USAGE.startsWith('usage: perc <command> [options]\n\ncommands:\n'));
  assert.ok(USAGE.endsWith('\noptions:\n  -h, --help   show this help\n'));
});
