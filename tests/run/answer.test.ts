import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runGraph } from '../../src/engine/engine.ts';
import { loadState, newState, saveState } from '../../src/engine/state.ts';
import type { Asking, RunState } from '../../src/engine/state.ts';
import { buildGraph } from '../../src/graph/build.ts';
import { mergeLayers } from '../../src/graph/merge.ts';
import { AnswerError, applyAnswer, askedItems, checkAnswer, findingItems, numberFindings } from '../../src/run/answer.ts';
import type { AnswerFlags } from '../../src/run/answer.ts';
import { ask, FakeRuntime } from '../helpers/fake-runtime.ts';

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

test('findingItems: one item per ## section, one item per numbered item without any, none when blank', () => {
  assert.deepEqual(findingItems('## A\n\nwhy\n\n## B\nmore'), ['## A\n\nwhy', '## B\n\nmore']);
  assert.deepEqual(findingItems('  \n## A\nx'), ['## A\n\nx']);
  assert.deepEqual(findingItems('1. bug A\n2. bug B\n\n## Policy compliance\nok'), ['1. bug A\n2. bug B', '## Policy compliance\n\nok']);
  assert.deepEqual(findingItems('1. one\n2. two'), ['1. one', '2. two']);
  assert.deepEqual(findingItems('  \n'), []);
  assert.deepEqual(findingItems('## Policy compliance\n\nok\n## Bug\n'), ['## Policy compliance\n\nok', '## Bug']);
});

test('findingItems: an h1 title before the first ## section is not a finding; text after it still is', () => {
  assert.deepEqual(findingItems('# Review findings\n\n## Missing test\nwhy\n## Typo\nhere'), ['## Missing test\n\nwhy', '## Typo\n\nhere']);
  assert.deepEqual(findingItems('# Review findings\n\n1. bug A\n\n## Typo\nhere'), ['1. bug A', '## Typo\n\nhere']);
  assert.deepEqual(findingItems('# Review findings\n'), []);
});

const fixture = (name: string) => fs.readFile(path.join(import.meta.dirname, '..', 'fixtures', 'findings', name), 'utf8');

test("findingItems: t25's numbered-list reviews give one item per finding (9, 4, 3)", async () => {
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map((n) => fixture(`t25-review-${n}.md`)));
  assert.equal(findingItems(r1!).length, 9);
  assert.equal(findingItems(r2!).length, 4);
  assert.equal(findingItems(r3!).length, 3);
  const first = findingItems(r1!)[0]!;
  assert.ok(first.startsWith("1. **The owner's answers are lost when the re-run step does not finish cleanly** (`src/engine/engine.ts:75`)."));
  assert.ok(first.includes('   - Contract case:'));
  assert.ok(first.includes('   - Timeout case:'));
  assert.ok(first.includes('   Change: drop the entry only when the attempt passes'));
  assert.ok(!first.includes('2. **Pressing Enter'));
  assert.ok(findingItems(r1!)[8]!.startsWith('9. **Small wording and coverage gaps**'));
  assert.ok(findingItems(r1!)[8]!.includes('   - The groomed ticket requires screenshots'));
  assert.ok(findingItems(r3!)[2]!.startsWith('3. **The summary says "answered 1 questions"**'));
});

test('findingItems: a numbered list before ## sections stays one preamble item; each section is one item', async () => {
  assert.deepEqual(findingItems(await fixture('list-then-sections.md')), [
    '1. **Bug A** (`a.ts:1`).\n   Detail A.\n\n2. **Bug B**.',
    '## Policy compliance\n\nOne breach.',
    '## Typo\n\nREADME.md: "teh".',
  ]);
});

test('findingItems: a CRLF numbered list splits as LF does', () => {
  assert.deepEqual(findingItems('# Findings\r\n\r\n1. A\r\n   more\r\n2. B\r\n'), ['1. A\n   more', '2. B']);
});

test('findingItems: a numbered list inside a ## section stays in that section', () => {
  assert.deepEqual(findingItems('## Bugs\n\n1. A\n2. B\n## Typo\nx'), ['## Bugs\n\n1. A\n2. B', '## Typo\n\nx']);
});

test('checkAnswer refuses incomplete or malformed answers to questions', () => {
  const items = questions.kind === 'questions' ? questions.items : [];
  refuses(() => checkAnswer('r1', questions, items, flags()), 'run r1: answer every question or mark it N/A; unanswered: 1, 2, 3 (--answer <n>=<text>, --na <n>)');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['4=x'] })), 'run r1: there is no question 4 (it asks 1–3); number them as perc status r1 lists them');
  refuses(() => checkAnswer('r1', questions, items, flags({ na: ['0'] })), 'run r1: there is no question 0 (it asks 1–3); number them as perc status r1 lists them');
  refuses(() => checkAnswer('r1', questions, items, flags({ answer: ['1=a'], na: ['1'] })), 'run r1: question 1 is answered twice; give each question once, with --answer or --na');
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
  refuses(() => checkAnswer('r1', findings, items, flags({ agree: ['5'] })), 'run r1: there is no finding 5 (it lists 1–4); tick them by the numbers perc status r1 lists');
  refuses(() => checkAnswer('r1', findings, items, flags({ agree: ['a'] })), 'run r1: --agree needs finding numbers like 1,3, got "a"');
  refuses(
    () => checkAnswer('r1', findings, items, flags({ na: ['1'] })),
    'run r1 is asking about findings; tick them with --agree <n>[,<n>…]',
  );
  refuses(() => checkAnswer('r1', findings, [], flags({ agree: ['1'] })), 'run r1: review wrote no findings to tick; answer without --agree to move on past it');
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

test('a step that asks again re-runs with the answers to its earlier questions as well as the new ones', async () => {
  const d = await tmp();
  const save = async () => {};
  try {
    const answerAll = async (s: RunState, answers: string[]) => {
      assert.ok(s.asking?.kind === 'questions');
      await applyAnswer(d, s, graph, { kind: 'questions', answers }, s.asking.items);
      s.status = 'running';
    };
    const s1 = await runGraph(graph, newState(init), { runtime: new FakeRuntime({ groom: [ask('Q1?', 'Q2?')] }), save });
    await answerAll(s1, ['one', 'two']);
    const s2 = await runGraph(graph, s1, { runtime: new FakeRuntime({ groom: [ask('Q3?')] }), save });
    await answerAll(s2, ['three']);
    const rt = new FakeRuntime();
    await runGraph(graph, s2, { runtime: rt, save });
    assert.equal(rt.calls[0], 'groom');
    const answers = await fs.readFile(path.join(d, rt.previous[0]!['groom']!['answers']!), 'utf8');
    assert.equal(
      answers,
      "# Answers to groom's questions\n\n## Question 1\n\nQ1?\n\n**Answer:** one\n\n## Question 2\n\nQ2?\n\n**Answer:** two\n\n" +
        '## Question 3\n\nQ3?\n\n**Answer:** three\n',
    );
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

test('applyAnswer: ticking 2 and 5 across a ## slot and a numbered-list slot writes each slot its own finding', async () => {
  const d = await tmp();
  try {
    await writeFindings(d, 'review.0', '# Review findings\n\n## A0\nx\n\n## B0\ny\n\n## C0\nz\n');
    await writeFindings(d, 'review.1', '1. **A1**\n   a\n\n2. **B1**\n   b\n\n3. **C1**\n');
    const s = askingState(twoFailing);
    assert.equal(await numberFindings(d, s), true);
    const items = s.asking!.kind === 'findings' ? s.asking!.items! : [];
    await applyAnswer(d, s, graph, { kind: 'findings', agree: [2, 5] }, items);
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.0', '3', 'agreed-findings.md'), 'utf8'), '## B0\n\ny\n');
    assert.equal(await fs.readFile(path.join(d, 'steps', 'review.1', '3', 'agreed-findings.md'), 'utf8'), '2. **B1**\n   b\n');
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
    await fs.mkdir(path.join(d, 'steps', 'review', '3', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(d, 'steps', 'review', '3', 'outputs', 'findings.md'), '');
    assert.deepEqual(await askedItems(d, askingState(findings)), []);
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

test('askedItems and numberFindings refuse a findings file that cannot be read, naming it and the run', async () => {
  const d = await tmp();
  try {
    const file = path.join(d, 'steps', 'review', '3', 'outputs', 'findings.md');
    const message = `run r1: cannot read review's findings ${file} (ENOENT); restore the file, then run perc status r1 again`;
    await assert.rejects(askedItems(d, askingState(findings)), { message });
    const state = askingState(findings);
    await assert.rejects(numberFindings(d, state), { message });
    assert.ok(state.asking?.kind === 'findings' && state.asking.items === undefined);
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
