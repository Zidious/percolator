import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadState, newState, saveState } from '../../src/engine/state.ts';
import type { Asking, RunState } from '../../src/engine/state.ts';
import { buildGraph } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import { AnswerError, applyAnswer, askedItems, checkAnswer, findingItems, numberFindings } from '../../src/run/answer.ts';
import type { AnswerFlags } from '../../src/run/answer.ts';

const init = { runId: 'r1', ticket: 'T-1', profile: 'default', groundVersions: {} };

const graph = buildGraph(
  mergeLayers([
    {
      source: 'test',
      fragment: {
        bindings: {
          intake: { agent: 'claude' },
          groom: { agent: 'claude' },
          plan: [{ agent: 'claude' }, { agent: 'codex' }],
          implement: { agent: 'claude' },
          review: { agent: 'claude' },
          deliver: { builtin: 'github.open_pr' },
        },
      },
    },
  ]),
);
const reviewAt = graph.steps.findIndex((s) => s.id === 'review');

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'perc-answer-'));
}
const rm = (d: string) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 });

const flags = (f: Partial<AnswerFlags> = {}): AnswerFlags => ({ answer: [], na: [], agree: [], ...f });
const questions: Asking = { kind: 'questions', stepId: 'plan.0', attempt: 1, items: ['a?', 'b?', 'c?'] };
const findings: Asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', findings: 'steps/review/3/outputs/findings.md' };

function refuses(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AnswerError, String(err));
    assert.equal(err.message, message);
    return true;
  });
}

test('findingItems: one item per ## section, the whole text without any, none when blank', () => {
  assert.deepEqual(findingItems('## A\n\nwhy\n\n## B\nmore'), ['## A\n\nwhy', '## B\n\nmore']);
  assert.deepEqual(findingItems('  \n## A\nx'), ['## A\n\nx']);
  assert.deepEqual(findingItems('1. bug A\n2. bug B\n\n## Policy compliance\nok'), ['1. bug A\n2. bug B', '## Policy compliance\n\nok']);
  assert.deepEqual(findingItems('1. one\n2. two'), ['1. one\n2. two']);
  assert.deepEqual(findingItems('  \n'), []);
  assert.deepEqual(findingItems('## Policy compliance\n\nok\n## Bug\n'), ['## Policy compliance\n\nok', '## Bug']);
});

test('checkAnswer refuses incomplete or malformed answers to questions', () => {
  const items = questions.kind === 'questions' ? questions.items : [];
  refuses(() => checkAnswer('r1', questions, items, flags()), 'run r1: answer every question or mark it N/A; unanswered: 1, 2, 3 (--answer <n>=<text>, --na <n>)');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['4=x'] })), 'run r1: there is no question 4 (it asks 1–3)');
  refuses(() => checkAnswer('r1', questions, items, flags({ na: ['0'] })), 'run r1: there is no question 0 (it asks 1–3)');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['1=a'], na: ['1'] })), 'run r1: question 1 is answered twice');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['1='] })), 'run r1: answer 1 is empty; give text or use --na 1');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['x=a'] })), 'run r1: --answer needs <n>=<text>, got "x=a"');
  refuses(() => checkAnswer('r1', questions, items, flags({ na: ['x'] })), 'run r1: --na needs a question number, got "x"');
  refuses(
    () => checkAnswer('r1', questions, items, flags({ agree: ['1'] })),
    'run r1 is asking questions; answer them with --answer <n>=<text> or --na <n>',
  );
});

test('checkAnswer returns answers in question order, N/A as null, keeping later = in the text', () => {
  const items = ['a?', 'b?', 'c?'];
  assert.deepEqual(checkAnswer('r1', questions, items, flags({ answer: ['1=a=b', '3=c'], na: ['2'] })), {
    kind: 'questions',
    answers: ['a=b', null, 'c'],
  });
});

test('checkAnswer for findings: ticked numbers sorted and unique, none by default, range and format checked', () => {
  const items = ['## A', '## B', '## C', '## D'];
  assert.deepEqual(checkAnswer('r1', findings, items, flags({ agree: ['3,1', '3'] })), { kind: 'findings', agree: [1, 3] });
  assert.deepEqual(checkAnswer('r1', findings, items, flags()), { kind: 'findings', agree: [] });
  refuses(() => checkAnswer('r1', findings, items, flags({ agree: ['5'] })), 'run r1: there is no finding 5 (it lists 1–4)');
  refuses(() => checkAnswer('r1', findings, items, flags({ agree: ['a'] })), 'run r1: --agree needs finding numbers like 1,3, got "a"');
  refuses(
    () => checkAnswer('r1', findings, items, flags({ na: ['1'] })),
    'run r1 is asking about findings; tick them with --agree <n>[,<n>…]',
  );
  refuses(() => checkAnswer('r1', findings, [], flags({ agree: ['1'] })), 'run r1: there is no finding 1 (it lists none)');
});

function askingState(asking: Asking): RunState {
  const s = newState(init);
  s.status = 'paused';
  // a step not in the test graph (review.1) sits at review
  const at = graph.steps.findIndex((x) => x.id === asking.stepId);
  s.cursor = at === -1 ? reviewAt : at;
  if (asking.kind === 'findings') s.rounds = { review: 3 };
  s.asking = structuredClone(asking);
  return s;
}

test('applyAnswer writes the answers file, records it and saves state', async () => {
  const d = await tmp();
  try {
    const s = askingState({ kind: 'questions', stepId: 'plan.0', attempt: 1, items: ['Which DB?', 'Keep v1?'] });
    await saveState(d, s);
    const summary = await applyAnswer(d, s, graph, { kind: 'questions', answers: ['Postgres', null] }, ['Which DB?', 'Keep v1?']);
    assert.equal(summary, 'answered 2 questions of plan.0');
    assert.equal(
      await fs.readFile(path.join(d, 'steps', 'plan.0', '1', 'answers.md'), 'utf8'),
      '# Answers to plan.0\'s questions\n\n## Question 1\n\nWhich DB?\n\n**Answer:** Postgres\n\n## Question 2\n\nKeep v1?\n\n**Answer:** N/A\n',
    );
    const saved = await loadState(d);
    assert.deepEqual(saved.answered, { 'plan.0': { answers: 'steps/plan.0/1/answers.md' } });
    assert.ok(!('asking' in saved));
  } finally {
    await rm(d);
  }
});

test('applyAnswer with ticked findings writes only those and sends the run back', async () => {
  const d = await tmp();
  try {
    const s = askingState(findings);
    const items = ['## A\n\nx', '## B\n\ny', '## C'];
    const summary = await applyAnswer(d, s, graph, { kind: 'findings', agree: [2] }, items);
    assert.equal(summary, 'agreed with 1 of 3 findings of review; the run goes back to implement');
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review', '3', 'agreed-findings.md'), 'utf8'), '## B\n\ny\n');
    const saved = await loadState(d);
    assert.equal(saved.grantedRound, 'review');
    assert.deepEqual(saved.answered, { review: { findings: 'steps/review/3/agreed-findings.md' } });
  } finally {
    await rm(d);
  }
});

test('applyAnswer with no findings ticked writes nothing and moves on', async () => {
  const d = await tmp();
  try {
    const s = askingState(findings);
    const summary = await applyAnswer(d, s, graph, { kind: 'findings', agree: [] }, ['## A', '## B', '## C']);
    assert.equal(summary, 'agreed with none of 3 findings of review; the run moves on to deliver');
    await assert.rejects(fs.access(path.join(d, 'steps', 'review', '3', 'agreed-findings.md')));
    const saved = await loadState(d);
    assert.equal(saved.cursor, reviewAt + 1);
    assert.equal(saved.unresolvedFindings, 'steps/review/3/outputs/findings.md');
    assert.ok(!('asking' in saved));
  } finally {
    await rm(d);
  }
});

const twoFailing: Asking = {
  ...findings,
  stepId: 'review.1',
  edgeId: 'review',
  findings: 'steps/review.1/3/outputs/findings.md',
  also: [{ stepId: 'review.0', attempt: 3, findings: 'steps/review.0/3/outputs/findings.md' }],
};

async function writeFindings(d: string, stepId: string, text: string): Promise<void> {
  await fs.mkdir(path.join(d, 'steps', stepId, '3', 'outputs'), { recursive: true });
  await fs.writeFile(path.join(d, 'steps', stepId, '3', 'outputs', 'findings.md'), text);
}

test('askedItems lists the findings of every step that failed in the last round, the others first', async () => {
  const d = await tmp();
  try {
    await writeFindings(d, 'review.0', '## A0\n## B0\n');
    await writeFindings(d, 'review.1', '## A1\n');
    assert.deepEqual(await askedItems(d, askingState(twoFailing)), ['## A0', '## B0', '## A1']);
  } finally {
    await rm(d);
  }
});

test('applyAnswer with ticks across two failing steps writes an agreed file for each, empty when none of theirs is ticked', async () => {
  const d = await tmp();
  try {
    const s = askingState({ ...twoFailing, items: ['## A0', '## B0', '## A1'], itemSteps: ['review.0', 'review.0', 'review.1'] });
    const summary = await applyAnswer(d, s, graph, { kind: 'findings', agree: [2] }, ['## A0', '## B0', '## A1']);
    assert.equal(summary, 'agreed with 1 of 3 findings of review.0, review.1; the run goes back to implement');
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.0', '3', 'agreed-findings.md'), 'utf8'), '## B0\n');
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.1', '3', 'agreed-findings.md'), 'utf8'), '');
    assert.deepEqual((await loadState(d)).answered, {
      'review.0': { findings: 'steps/review.0/3/agreed-findings.md' },
      'review.1': { findings: 'steps/review.1/3/agreed-findings.md' },
    });
  } finally {
    await rm(d);
  }
});

test('applyAnswer splits the files again when the items carry no steps', async () => {
  const d = await tmp();
  try {
    await writeFindings(d, 'review.0', '## A0\n');
    await writeFindings(d, 'review.1', '## A1\n');
    const s = askingState(twoFailing);
    await applyAnswer(d, s, graph, { kind: 'findings', agree: [2] }, ['## A0', '## A1']);
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.1', '3', 'agreed-findings.md'), 'utf8'), '## A1\n');
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.0', '3', 'agreed-findings.md'), 'utf8'), '');
  } finally {
    await rm(d);
  }
});

test('applyAnswer at the end of the graph says the run moves on to the end', async () => {
  const d = await tmp();
  try {
    const g = { ...graph, steps: graph.steps.slice(0, reviewAt + 1) };
    const summary = await applyAnswer(d, askingState(findings), g, { kind: 'findings', agree: [] }, ['## A']);
    assert.equal(summary, 'agreed with none of 1 findings of review; the run moves on to the end');
  } finally {
    await rm(d);
  }
});

test('applying twice after a crash writes the same file and applies once', async () => {
  const d = await tmp();
  try {
    const items = ['Which DB?', 'Keep v1?'];
    const before = askingState({ kind: 'questions', stepId: 'plan.0', attempt: 1, items });
    await saveState(d, before);
    const answer = { kind: 'questions' as const, answers: ['Postgres', null] };
    await applyAnswer(d, structuredClone(before), graph, answer, items);
    const file = path.join(d, 'steps', 'plan.0', '1', 'answers.md');
    const first = await fs.readFile(file, 'utf8');
    // the crash: the file was written but state.json still holds the asking state
    await saveState(d, before);
    await applyAnswer(d, await loadState(d), graph, answer, items);
    assert.equal(await fs.readFile(file, 'utf8'), first);
    assert.deepEqual((await loadState(d)).answered, { 'plan.0': { answers: 'steps/plan.0/1/answers.md' } });
  } finally {
    await rm(d);
  }
});

test('askedItems: the questions, the split findings file, or none', async () => {
  const d = await tmp();
  try {
    assert.deepEqual(await askedItems(d, askingState(questions)), ['a?', 'b?', 'c?']);
    assert.deepEqual(await askedItems(d, askingState(findings)), []);
    await fs.mkdir(path.join(d, 'steps', 'review', '3', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(d, 'steps', 'review', '3', 'outputs', 'findings.md'), '## A\nx\n## B\n');
    assert.deepEqual(await askedItems(d, askingState(findings)), ['## A\n\nx', '## B']);
    assert.deepEqual(await askedItems(d, askingState({ ...findings, items: ['kept'] })), ['kept']);
    const { findings: _, ...noFile } = findings;
    assert.deepEqual(await askedItems(d, askingState(noFile)), []);
    assert.deepEqual(await askedItems(d, newState(init)), []);
  } finally {
    await rm(d);
  }
});

test('numberFindings keeps the items, and their steps when several steps failed; leaves numbered or question states alone', async () => {
  const d = await tmp();
  try {
    await writeFindings(d, 'review.0', '## A0\n');
    await writeFindings(d, 'review.1', '## A1\n');
    const two = askingState(twoFailing);
    assert.equal(await numberFindings(d, two), true);
    assert.deepEqual(two.asking, { ...twoFailing, items: ['## A0', '## A1'], itemSteps: ['review.0', 'review.1'] });
    const one = askingState({ ...twoFailing, also: undefined });
    delete (one.asking as { also?: unknown }).also;
    assert.equal(await numberFindings(d, one), true);
    assert.ok(one.asking?.kind === 'findings' && !('itemSteps' in one.asking));
    assert.deepEqual(one.asking.items, ['## A1']);
    assert.equal(await numberFindings(d, one), false);
    assert.equal(await numberFindings(d, askingState(questions)), false);
  } finally {
    await rm(d);
  }
});
