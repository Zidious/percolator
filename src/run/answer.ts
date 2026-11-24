import fs from 'node:fs/promises';
import path from 'node:path';
import { answerFindings, answerQuestions, saveState } from '../engine/state.ts';
import type { Asking, RunState } from '../engine/state.ts';
import type { Graph } from '../graph/build.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { splitSections } from '../util/sections.ts';
import { stepDir } from '../workspace/run-dir.ts';

/** The owner's answer to what a run asks: per question its text or null (N/A); or the 1-based findings they agree with. */
export type Answer = { kind: 'questions'; answers: (string | null)[] } | { kind: 'findings'; agree: number[] };

/** Raw values of `perc answer`'s repeatable flags. */
export type AnswerFlags = { answer: string[]; na: string[]; agree: string[] };

/** An answer that does not fit what the run asks: a usage error (exit 2). */
export class AnswerError extends Error {}

/** One item per `## ` section of a findings file (text before the first is dropped); the whole text when it has none. */
export function findingItems(md: string): string[] {
  const sections = splitSections(md);
  if (sections.length === 0) return md.trim() === '' ? [] : [md.trim()];
  return sections.map((s) => {
    const heading = s.title === '' ? '##' : `## ${s.title}`;
    return s.body === '' ? heading : `${heading}\n\n${s.body}`;
  });
}

/** What the run asks, item by item: its questions, or the findings file split into items. Empty when not asking. */
export async function askedItems(dir: string, state: RunState): Promise<string[]> {
  const asking = state.asking;
  if (asking === undefined) return [];
  if (asking.items !== undefined) return asking.items;
  if (asking.kind !== 'findings' || asking.findings === undefined) return [];
  return findingItems(await fs.readFile(path.join(dir, asking.findings), 'utf8').catch(() => ''));
}

/** Check `flags` against what run `runId` asks (`items`); throws AnswerError naming what is wrong. */
export function checkAnswer(runId: string, asking: Asking, items: readonly string[], flags: AnswerFlags): Answer {
  const refuse = (msg: string): never => {
    throw new AnswerError(msg);
  };
  if (asking.kind === 'questions') {
    if (flags.agree.length > 0) refuse(`run ${runId} is asking questions; answer them with --answer <n>=<text> or --na <n>`);
    const n = items.length;
    const inRange = (q: number) => {
      if (q < 1 || q > n) refuse(`run ${runId}: there is no question ${q} (it asks ${n === 1 ? '1' : `1–${n}`})`);
    };
    const answers: (string | null | undefined)[] = items.map(() => undefined);
    const give = (q: number, value: string | null) => {
      inRange(q);
      if (answers[q - 1] !== undefined) refuse(`run ${runId}: question ${q} is answered twice`);
      answers[q - 1] = value;
    };
    for (const raw of flags.answer) {
      const m = /^(\d+)=([\s\S]*)$/.exec(raw);
      if (!m) return refuse(`run ${runId}: --answer needs <n>=<text>, got "${raw}"`);
      const q = Number(m[1]);
      inRange(q);
      if (m[2]!.trim() === '') refuse(`run ${runId}: answer ${q} is empty; give text or use --na ${q}`);
      give(q, m[2]!);
    }
    for (const raw of flags.na) {
      if (!/^\d+$/.test(raw)) refuse(`run ${runId}: --na needs a question number, got "${raw}"`);
      give(Number(raw), null);
    }
    const missing = answers.flatMap((a, i) => (a === undefined ? [i + 1] : []));
    if (missing.length > 0) {
      refuse(`run ${runId}: answer every question or mark it N/A; unanswered: ${missing.join(', ')} (--answer <n>=<text>, --na <n>)`);
    }
    return { kind: 'questions', answers: answers as (string | null)[] };
  }
  if (flags.answer.length > 0 || flags.na.length > 0) {
    refuse(`run ${runId} is asking about findings; tick them with --agree <n>[,<n>…]`);
  }
  const agree = new Set<number>();
  for (const raw of flags.agree) {
    for (const part of raw.split(',')) {
      if (!/^\d+$/.test(part.trim())) refuse(`run ${runId}: --agree needs finding numbers like 1,3, got "${raw}"`);
      const f = Number(part.trim());
      if (f < 1 || f > items.length) {
        const range = items.length === 0 ? 'none' : items.length === 1 ? '1' : `1–${items.length}`;
        refuse(`run ${runId}: there is no finding ${f} (it lists ${range})`);
      }
      agree.add(f);
    }
  }
  return { kind: 'findings', agree: [...agree].sort((a, b) => a - b) };
}

/**
 * Apply the owner's answer to the run in `dir`: write the answer file in the asking attempt's step dir (deterministic,
 * so a retry after a crash rewrites the same file), record it in `state` and save it. Returns a one-line summary.
 */
export async function applyAnswer(dir: string, state: RunState, graph: Graph, a: Answer, items: readonly string[]): Promise<string> {
  const asking = state.asking;
  if (asking === undefined) throw new Error(`run ${state.runId} is not waiting for answers`);
  const attemptDir = stepDir(dir, asking.stepId, asking.attempt);
  const rel = (file: string) => path.relative(dir, file).split(path.sep).join('/');
  let summary: string;
  if (asking.kind === 'questions' && a.kind === 'questions') {
    const body = items.map((q, i) => `## Question ${i + 1}\n\n${q}\n\n**Answer:** ${a.answers[i] ?? 'N/A'}`).join('\n\n');
    const file = path.join(attemptDir, 'answers.md');
    await fs.mkdir(attemptDir, { recursive: true });
    await writeFileAtomic(file, `# Answers to ${asking.stepId}'s questions\n\n${body}\n`);
    answerQuestions(state, rel(file));
    summary = `answered ${items.length} questions of ${asking.stepId}`;
  } else if (asking.kind === 'findings' && a.kind === 'findings') {
    const edge = graph.backEdges[asking.edgeId];
    if (!edge) throw new Error(`run ${state.runId} asks about back-edge "${asking.edgeId}", which is not in this graph`);
    const of = `of ${items.length} findings of ${asking.stepId}`;
    if (a.agree.length > 0) {
      const file = path.join(attemptDir, 'agreed-findings.md');
      await fs.mkdir(attemptDir, { recursive: true });
      await writeFileAtomic(file, `${a.agree.map((n) => items[n - 1]).join('\n\n')}\n`);
      answerFindings(state, graph, rel(file));
      summary = `agreed with ${a.agree.length} ${of}; the run goes back to ${graph.steps[edge.toStepIndex]!.stage}`;
    } else {
      answerFindings(state, graph, undefined);
      summary = `agreed with none ${of}; the run moves on to ${graph.steps[edge.jumpAfterIndex + 1]?.stage ?? 'the end'}`;
    }
  } else {
    throw new Error(`run ${state.runId} is asking ${asking.kind === 'questions' ? 'questions' : 'about findings'}, not ${a.kind}`);
  }
  await saveState(dir, state);
  return summary;
}
