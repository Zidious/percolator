import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../../src/engine/runtime.ts';
import type { StepRecord } from '../../../src/engine/state.ts';
import { noticedNotes } from '../../../src/tracker/exits/notes.ts';

const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });

type Entry = { stepId: string; round?: number; status?: StepRecord['status']; notes?: string; text?: string };

/** A run dir with one history entry per `entries` item; `text` is written to that entry's notes file. */
async function setup(entries: Entry[], stages: Record<string, string> = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-notes-'));
  const history: StepRecord[] = [];
  for (const [n, e] of entries.entries()) {
    const outputs: Record<string, string> = {};
    if (e.notes !== undefined) {
      outputs['notes'] = e.notes;
      if (e.text !== undefined) {
        await fs.mkdir(path.dirname(path.join(runDir, e.notes)), { recursive: true });
        await fs.writeFile(path.join(runDir, e.notes), e.text);
      }
    }
    history.push({
      stepId: e.stepId,
      attempt: n + 1,
      startedAt: '',
      endedAt: '',
      status: e.status ?? 'pass',
      outputs,
      ...(e.round === undefined ? {} : { verifyRound: e.round }),
    });
  }
  const ids = [...new Set(entries.map((e) => e.stepId))];
  const steps = ids.map((id) => ({ id, stage: stages[id] ?? id, role: 'slot', slotLast: true }));
  const ctx = { graph: { steps }, state: { history }, previousOutputs: {} } as unknown as RunContext;
  return { runDir, ctx };
}

const rel = (step: string, round: number) => `steps/${step}/${round}/outputs/notes.md`;

test('no verify round notes gives undefined', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'review' }]);
  try {
    assert.equal(await noticedNotes(ctx, runDir), undefined);
  } finally {
    await rm(runDir);
  }
});

test('notes of every verify round, in round order, each under its round', async () => {
  const { runDir, ctx } = await setup([
    { stepId: 'review' },
    { stepId: 'review', round: 4, notes: rel('review', 4), text: 'Doubled numbers in labels.\n' },
    { stepId: 'review', round: 5, notes: rel('review', 5), text: 'Typo in docs.' },
  ]);
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in review, not fixed\n\n### Round 4\n\nDoubled numbers in labels.\n\n### Round 5\n\nTypo in docs.',
    );
  } finally {
    await rm(runDir);
  }
});

test('a notes output outside a verify round is left out', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'answer', notes: rel('answer', 1), text: 'Not a verify note.' }]);
  try {
    assert.equal(await noticedNotes(ctx, runDir), undefined);
  } finally {
    await rm(runDir);
  }
});

test('a contract error in a verify round is left out', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'review', round: 4, status: 'contract_error', notes: rel('review', 4), text: 'N.' }]);
  try {
    assert.equal(await noticedNotes(ctx, runDir), undefined);
  } finally {
    await rm(runDir);
  }
});

test('a missing or empty notes file is skipped', async () => {
  const one = await setup([
    { stepId: 'review', round: 4, notes: rel('review', 4) },
    { stepId: 'review', round: 5, notes: rel('review', 5), text: 'Typo in docs.' },
  ]);
  const none = await setup([
    { stepId: 'review', round: 4, notes: rel('review', 4) },
    { stepId: 'review', round: 5, notes: rel('review', 5), text: ' \n\n' },
  ]);
  try {
    assert.equal(await noticedNotes(one.ctx, one.runDir), '## Noticed in review, not fixed\n\n### Round 5\n\nTypo in docs.');
    assert.equal(await noticedNotes(none.ctx, none.runDir), undefined);
  } finally {
    await rm(one.runDir);
    await rm(none.runDir);
  }
});

test('a non-review stage names itself, and several nodes name their step', async () => {
  const { runDir, ctx } = await setup(
    [
      { stepId: 'audit', round: 3, notes: rel('audit', 3), text: 'A.' },
      { stepId: 'review.0', round: 4, notes: rel('review.0', 4), text: 'R0.' },
      { stepId: 'review.1', round: 4, notes: rel('review.1', 4), text: 'R1.' },
    ],
    { 'review.0': 'review', 'review.1': 'review' },
  );
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in audit, not fixed\n\n### Round 3\n\nA.\n\n## Noticed in review, not fixed\n\n### review.0, round 4\n\nR0.\n\n### review.1, round 4\n\nR1.',
    );
  } finally {
    await rm(runDir);
  }
});

test('headings in a note are pushed below its round heading, not inside code fences', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'review', round: 4, notes: rel('review', 4), text: '## Big\n\n```\n## code\n```\n# Top' }]);
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in review, not fixed\n\n### Round 4\n\n##### Big\n\n```\n## code\n```\n#### Top',
    );
  } finally {
    await rm(runDir);
  }
});

test('an escalated attempt of a verify round is left out for the attempt that re-ran it', async () => {
  const { runDir, ctx } = await setup([
    { stepId: 'review', round: 4, status: 'escalate', notes: 'steps/review/4/outputs/notes.md', text: 'Stale.' },
    { stepId: 'review', round: 4, status: 'pass', notes: 'steps/review/5/outputs/notes.md', text: 'Fresh.' },
  ]);
  try {
    assert.equal(await noticedNotes(ctx, runDir), '## Noticed in review, not fixed\n\n### Round 4\n\nFresh.');
  } finally {
    await rm(runDir);
  }
});

test('a round granted again after an enclosing loop jumps back keeps both passes, in history order', async () => {
  const { runDir, ctx } = await setup([
    { stepId: 'review', round: 4, status: 'pass', notes: 'steps/review/4/outputs/notes.md', text: 'A.' },
    { stepId: 'review', round: 5, status: 'fail', notes: 'steps/review/5/outputs/notes.md', text: 'B.' },
    { stepId: 'review', round: 4, status: 'pass', notes: 'steps/review/9/outputs/notes.md', text: 'C.' },
  ]);
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in review, not fixed\n\n### Round 4\n\nA.\n\n### Round 5\n\nB.\n\n### Round 4 (pass 2)\n\nC.',
    );
  } finally {
    await rm(runDir);
  }
});

test('a CRLF note has its headings demoted past a fence and comes out with LF only', async () => {
  const { runDir, ctx } = await setup([
    { stepId: 'review', round: 4, notes: rel('review', 4), text: '```\r\ncode\r\n```\r\n\r\n## Security\r\nText\r\n---\r\n' },
  ]);
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in review, not fixed\n\n### Round 4\n\n```\ncode\n```\n\n##### Security\n##### Text',
    );
  } finally {
    await rm(runDir);
  }
});

/** The section noticedNotes gives for one round-4 review note `text`. */
async function demoted(text: string): Promise<string | undefined> {
  const { runDir, ctx } = await setup([{ stepId: 'review', round: 4, notes: rel('review', 4), text }]);
  try {
    return await noticedNotes(ctx, runDir);
  } finally {
    await rm(runDir);
  }
}
const section = (body: string) => `## Noticed in review, not fixed\n\n### Round 4\n\n${body}`;

test('every note heading sits below its round heading', async () => {
  assert.equal(await demoted('# One\n## Two\n### Three\n#### Four\n###### Six'), section('#### One\n##### Two\n###### Three\n###### Four\n###### Six'));
});

test('an indented heading and a bare # line are demoted', async () => {
  assert.equal(await demoted('Text\n\n   ## Security\n#'), section('Text\n\n##### Security\n####'));
});

test('a heading needs a space after its #', async () => {
  assert.equal(await demoted('#hashtag\n####### seven'), section('#hashtag\n####### seven'));
});

test('a setext heading becomes a demoted heading', async () => {
  assert.equal(await demoted('Summary\n=======\n\nTwo lines\nof title\n---\n\nAfter.'), section('#### Summary\n\n##### Two lines of title\n\nAfter.'));
});

test('a rule after a blank line is not a setext heading', async () => {
  assert.equal(await demoted('Text\n\n---\n\nMore.'), section('Text\n\n---\n\nMore.'));
});

test('a fence closes only on a bare fence line, so an info-string line stays inside', async () => {
  assert.equal(
    await demoted('```\n## a\n```ts\n## b\n```\n## c'),
    section('```\n## a\n```ts\n## b\n```\n##### c'),
  );
});

test('a line indented four spaces does not open a fence', async () => {
  assert.equal(await demoted('Text\n\n    ```\n## real'), section('Text\n\n    ```\n##### real'));
});

test('a shorter or other-character fence line does not close a fence', async () => {
  assert.equal(await demoted('````\n```\n~~~~\n## in\n````\n## out'), section('````\n```\n~~~~\n## in\n````\n##### out'));
});

test('an unreadable notes file escalates naming the step and what to do', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'review', round: 4, notes: rel('review', 4) }]);
  try {
    const file = path.join(runDir, rel('review', 4));
    await fs.mkdir(file, { recursive: true });
    await assert.rejects(noticedNotes(ctx, runDir), {
      message: `cannot read the notes of review (${file}): EISDIR; fix or remove the file, then perc resume`,
    });
  } finally {
    await rm(runDir);
  }
});

test('a rule after a list item or a quote is not a setext heading', async () => {
  assert.equal(await demoted('- item\nmore\n---\n> quote\n---\n1. one\n==='), section('- item\nmore\n---\n> quote\n---\n1. one\n==='));
});

test('a list item that interrupts a paragraph ends its setext content', async () => {
  assert.equal(await demoted('Text\n- item\n---'), section('Text\n- item\n---'));
});
