import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_MARKER, exitMarker, GATE_MARKER, gateMarker, issueMarker, releaseMarker, reviewMarker } from '../../src/tracker/markers.ts';

test('the comment markers keep their exact text, so a resume finds what an earlier attempt posted', () => {
  assert.equal(GATE_MARKER, '<!-- percolator:gate');
  assert.equal(DECISION_MARKER, '<!-- percolator:decision');
  assert.equal(gateMarker('r1', 'approve-groom'), '<!-- percolator:gate run=r1 step=approve-groom -->');
  assert.equal(exitMarker('r1', 'deliver'), '<!-- percolator:exit run=r1 step=deliver -->');
  assert.equal(issueMarker('r1', '2'), '<!-- percolator:issue run=r1 n=2 -->');
  assert.equal(releaseMarker('r1'), '<!-- percolator:release run=r1 -->');
  assert.equal(reviewMarker('r1'), '<!-- percolator:review run=r1 -->');
});
