import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueComment } from '../../src/tracker/gh.ts';
import { decisionNote, findPriorGroom } from '../../src/tracker/prior-groom.ts';

let n = 0;
const c = (author: string, body: string): IssueComment => ({
  author,
  body,
  createdAt: '2026-01-01T00:00:00.000Z',
  url: `https://github.com/o/r/issues/2#issuecomment-${++n}`,
});

const gate = (run: string, text: string, round = 1, extra = '') =>
  [
    `<!-- percolator:gate run=${run} step=approve-groom round=${round} -->`,
    `**Percolator** needs approval to continue run \`${run}\` (step \`approve-groom\`).`,
    '',
    '### groomed_ticket',
    '',
    text,
    '',
    ...(extra === '' ? [] : [extra, '']),
    'Reply `/percolator approve` to continue, or `/percolator reject <what to change>` to send it back.',
    `Locally: \`perc approve ${run}\` or \`perc reject ${run} "<what to change>"\`.`,
    '',
  ].join('\n');

test('no gate comment: no prior groom', () => {
  assert.equal(findPriorGroom([c('alice', 'hello'), c('bot', '/percolator approve')], ['bot']), undefined);
});

test('the latest groomed ticket without a decision is returned unapproved', () => {
  const first = c('bot', gate('r1', '# Old\n\nold text'));
  const second = c('bot', gate('r2', '# New\n\nnew text'));
  assert.deepEqual(findPriorGroom([first, c('alice', 'a remark'), second], ['bot']), {
    text: '# New\n\nnew text',
    gateUrl: second.url,
  });
});

test('an approver replying /percolator approve after it approves it', () => {
  const g = c('bot', gate('r1', 'the ticket'));
  const ok = c('Bot', '/percolator approve');
  assert.deepEqual(findPriorGroom([g, ok], ['bot']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'approve', by: 'Bot', url: ok.url },
  });
});

test('a non-approver, or a command before the gate comment, does not decide it', () => {
  const early = c('bot', '/percolator approve');
  const g = c('bot', gate('r1', 'the ticket'));
  assert.deepEqual(findPriorGroom([early, g, c('mallory', '/percolator approve')], ['bot']), {
    text: 'the ticket',
    gateUrl: g.url,
  });
});

test('the first command decides; a rejection carries its feedback', () => {
  const g = c('bot', gate('r1', 'the ticket'));
  const no = c('bot', '/percolator reject split it in two');
  assert.deepEqual(findPriorGroom([g, no, c('bot', '/percolator approve')], ['bot']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'reject', by: 'bot', url: no.url, feedback: 'split it in two' },
  });
});

test('a local decision note for the same run and round decides it, whoever approves', () => {
  const g = c('perc-bot', gate('r1', 'the ticket', 2));
  const other = c('perc-bot', decisionNote({ runId: 'r0', stepId: 'approve-groom', round: 2, decision: 'reject', by: 'x' }));
  const note = c('perc-bot', decisionNote({ runId: 'r1', stepId: 'approve-groom', round: 2, decision: 'approve', by: 'gabe' }));
  assert.deepEqual(findPriorGroom([g, other, note], ['alice']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'approve', by: 'gabe', url: note.url },
  });
});

test('a decision after a newer gate comment belongs to the newer one', () => {
  const g1 = c('bot', gate('r1', 'one'));
  const g2 = c('bot', gate('r2', 'two'));
  assert.deepEqual(findPriorGroom([g1, g2, c('bot', '/percolator approve')], ['bot'])?.text, 'two');
});

test('the groomed ticket stops at the next output section', () => {
  const g = c('bot', gate('r1', 'the ticket', 1, '### notes\n\nsome notes'));
  assert.equal(findPriorGroom([g], ['bot'])?.text, 'the ticket');
});

test('a truncated groomed ticket is skipped', () => {
  const g = c('bot', gate('r1', 'the tick\n… (truncated; full text in steps/groom/1/outputs/groomed_ticket.md of run r1)'));
  assert.equal(findPriorGroom([g], ['bot']), undefined);
});

test('decisionNote is marked and is not itself a command', () => {
  assert.equal(
    decisionNote({ runId: 'r1', stepId: 'approve-groom', round: 1, decision: 'reject', by: 'gabe', feedback: 'more tests' }),
    '<!-- percolator:decision run=r1 step=approve-groom round=1 decision=reject -->\nRejected locally by @gabe via `perc reject`: more tests\n',
  );
  assert.equal(
    decisionNote({ runId: 'r1', stepId: 'approve-groom', round: 1, decision: 'approve', by: 'gabe' }),
    '<!-- percolator:decision run=r1 step=approve-groom round=1 decision=approve -->\nApproved locally by @gabe via `perc approve`.\n',
  );
});
