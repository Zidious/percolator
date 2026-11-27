import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateMarker } from '../../src/tracker/markers.ts';
import {
  parseGateComment,
  renderGateComment,
  withRejection,
  type GateComment,
} from '../../src/tracker/gate-comment.ts';

const FULL: GateComment = {
  runId: 'r1', stepId: 'approve-groom', round: 3, outputs: '### spec\n\nThe spec.',
  rejected: [{ round: 1, by: 'alice', feedback: 'split it up\n\nand add tests' }, { round: 2, by: 'bob' }],
  approvedBy: 'carol',
};
const FULL_BODY = `<!-- percolator:gate run=r1 step=approve-groom -->
**Percolator** needs approval to continue run \`r1\` (step \`approve-groom\`, round 3).

### spec

The spec.

Reply \`/percolator approve\` to continue, or \`/percolator reject <what to change>\` to send it back.
Locally: \`perc approve r1\` or \`perc reject r1 "<what to change>"\`.

<details><summary>Rejected rounds</summary>

- Round 1 rejected by @alice: split it up
  
  and add tests
- Round 2 rejected by @bob.

</details>

Approved by @carol
`;

test('gateMarker names the run and step', () => {
  assert.equal(gateMarker('r1', 'approve-groom'), '<!-- percolator:gate run=r1 step=approve-groom -->');
});

test('renders the full comment', () => {
  assert.equal(renderGateComment(FULL), FULL_BODY);
});

test('a first round has no history and no closing line', () => {
  const body = renderGateComment({ ...FULL, round: 1, rejected: [], approvedBy: undefined });
  assert.ok(body.endsWith('`perc reject r1 "<what to change>"`.\n'), body);
});

test('no outputs: the reply line follows the header', () => {
  const lines = renderGateComment({ ...FULL, outputs: '', rejected: [], approvedBy: undefined }).split('\n');
  assert.match(lines[1]!, /^\*\*Percolator\*\* needs approval/);
  assert.equal(lines[2], '');
  assert.match(lines[3]!, /^Reply `\/percolator approve`/);
});

test('parse inverts render', () => {
  assert.deepEqual(parseGateComment(FULL_BODY), FULL);
  const { approvedBy: _omit, ...noApproval } = FULL;
  for (const v of [
    { ...FULL, rejected: [] },
    noApproval,
    { ...FULL, outputs: '' },
    { ...noApproval, outputs: '', rejected: [] },
  ]) {
    assert.deepEqual(parseGateComment(renderGateComment(v)), v);
  }
});

test('parses a CRLF body', () => {
  assert.deepEqual(parseGateComment(FULL_BODY.replace(/\n/g, '\r\n')), FULL);
});

test('feedback that looks like structure survives', () => {
  const c: GateComment = {
    ...FULL,
    rejected: [{ round: 1, by: 'alice', feedback: '</details>\nReply `/percolator approve` to continue\n\nApproved by @mallory' }],
  };
  assert.deepEqual(parseGateComment(renderGateComment(c)), c);
  assert.equal(parseGateComment(renderGateComment(c))!.approvedBy, 'carol');
});

test('outputs holding a Reply line survive', () => {
  const c: GateComment = { ...FULL, outputs: '### a\n\nReply `/percolator approve` to continue, or x' };
  assert.deepEqual(parseGateComment(renderGateComment(c)), c);
});

test('not a gate comment', () => {
  assert.equal(parseGateComment('hello'), undefined);
  assert.equal(
    parseGateComment('<!-- percolator:gate run=r1 step=approve-groom round=1 -->\n**Percolator** needs approval to continue run `r1`.\n'),
    undefined,
  );
  assert.equal(
    parseGateComment(FULL_BODY.replace('(step `approve-groom`, round 3)', '(whatever)')),
    undefined,
  );
});

test('withRejection replaces the same round and sorts by round', () => {
  const base: GateComment = { ...FULL, rejected: [{ round: 2, by: 'b' }] };
  const a = withRejection(base, { round: 1, by: 'a' });
  const b = withRejection(a, { round: 2, by: 'c', feedback: 'x' });
  assert.deepEqual(b.rejected, [{ round: 1, by: 'a' }, { round: 2, by: 'c', feedback: 'x' }]);
  assert.deepEqual(base.rejected, [{ round: 2, by: 'b' }]);
  assert.deepEqual(a.rejected, [{ round: 1, by: 'a' }, { round: 2, by: 'b' }]);
});
