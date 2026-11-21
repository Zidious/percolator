import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueComment } from '../../src/tracker/gh.ts';
import { renderGateComment } from '../../src/tracker/gate-comment.ts';
import type { GateComment } from '../../src/tracker/gate-comment.ts';
import { findPriorGroom } from '../../src/tracker/prior-groom.ts';

let n = 0;
const c = (author: string, body: string): IssueComment => ({
  id: n + 1,
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

const edited = (run: string, text: string, extra: Partial<GateComment>) =>
  renderGateComment({ runId: run, stepId: 'approve-groom', round: 1, outputs: `### groomed_ticket

${text}`, rejected: [], ...extra });

const note = (run: string, round: number, decision: 'approve' | 'reject', by: string) =>
  `<!-- percolator:decision run=${run} step=approve-groom round=${round} decision=${decision} -->
${decision === 'approve' ? 'Approved' : 'Rejected'} locally by @${by} via \`perc ${decision}\`.
`;

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
  const other = c('perc-bot', note('r0', 2, 'reject', 'x'));
  const mine = c('perc-bot', note('r1', 2, 'approve', 'gabe'));
  assert.deepEqual(findPriorGroom([g, other, mine], ['alice']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'approve', by: 'gabe', url: mine.url },
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

test('an edited comment approved in place is approved', () => {
  const g = c('bot', edited('r1', 'the ticket', { approvedBy: 'gabe', round: 2 }));
  assert.deepEqual(findPriorGroom([g], ['alice']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'approve', by: 'gabe', url: g.url },
  });
});

test('an edited comment whose current round was rejected carries that feedback', () => {
  const g = c('bot', edited('r1', 'the ticket', {
    round: 2,
    rejected: [{ round: 1, by: 'a', feedback: 'old' }, { round: 2, by: 'b', feedback: 'new' }],
  }));
  assert.deepEqual(findPriorGroom([g], ['bot']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'reject', by: 'b', url: g.url, feedback: 'new' },
  });
});

test('an undecided edited comment ignores later rejects but takes a later approve', () => {
  const g = c('bot', edited('r1', 'the ticket', {}));
  const ok = c('bot', '/percolator approve');
  assert.deepEqual(findPriorGroom([g, c('bot', '/percolator reject old'), ok], ['bot']), {
    text: 'the ticket',
    gateUrl: g.url,
    decision: { decision: 'approve', by: 'bot', url: ok.url },
  });
  assert.deepEqual(findPriorGroom([g, c('bot', '/percolator reject old')], ['bot']), { text: 'the ticket', gateUrl: g.url });
});

test('an old multi-comment run followed by an edited comment: the newest wins', () => {
  const old = c('bot', gate('r0', 'one'));
  const oldNote = c('bot', note('r0', 1, 'approve', 'x'));
  const g = c('bot', edited('r1', 'two', {}));
  assert.deepEqual(findPriorGroom([old, oldNote, g], ['bot']), { text: 'two', gateUrl: g.url });
});

test('an edited comment for another gate step is not a groomed ticket', () => {
  const g = c('bot', edited('r1', 'the plan', { stepId: 'approve-plan' }));
  assert.equal(findPriorGroom([g], ['bot']), undefined);
});

test('a legacy decision note does not decide an edited comment', () => {
  const g = c('bot', edited('r1', 'x', {}));
  assert.deepEqual(findPriorGroom([g, c('bot', note('r1', 1, 'reject', 'z'))], ['bot']), { text: 'x', gateUrl: g.url });
});

test('a truncated edited ticket is skipped, and hides an older groom', () => {
  const cut = 'the tick\n… (truncated; full text in steps/groom/1/outputs/groomed_ticket.md of run r1)';
  assert.equal(findPriorGroom([c('bot', edited('r1', cut, {}))], ['bot']), undefined);
  assert.equal(findPriorGroom([c('bot', gate('r0', 'old')), c('bot', edited('r1', cut, {}))], ['bot']), undefined);
});
