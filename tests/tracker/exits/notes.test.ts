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

test('headings in a note are pushed down two levels, not inside code fences', async () => {
  const { runDir, ctx } = await setup([{ stepId: 'review', round: 4, notes: rel('review', 4), text: '## Big\n\n```\n## code\n```\n# Top' }]);
  try {
    assert.equal(
      await noticedNotes(ctx, runDir),
      '## Noticed in review, not fixed\n\n### Round 4\n\n#### Big\n\n```\n## code\n```\n### Top',
    );
  } finally {
    await rm(runDir);
  }
});
