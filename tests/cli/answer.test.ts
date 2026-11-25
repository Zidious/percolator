import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.ts';
import { loadState, saveState } from '../../src/engine/state.ts';
import type { Asking, RunState } from '../../src/engine/state.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import { ENTRY, NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';
const BINDINGS = [
  '      intake: { builtin: github.intake }',
  "      groom: { command: [groom-script, '{outputs_dir}'] }",
  "      plan: { command: [plan-script, '{outputs_dir}'] }",
  "      implement: { command: [implement-script, '{outputs_dir}'] }",
  "      review: { command: [review-script, '{outputs_dir}'] }",
  '      deliver: { builtin: github.open_pr }',
];
const TRACKER = '    tracker: { kind: github, approvers: [alice] }';
const STEPS = ['intake', 'groom', 'approve-groom', 'plan', 'implement', 'review', 'deliver'];

type Env = RunEnv & {
  dir(id: string): string;
  perc(argv: string[], deps?: Partial<DriverDeps>): Promise<{ code: number; out: string; err: string }>;
  /** a prepared run paused on `asking` */
  asking(asking: Asking, ticket?: string): Promise<RunMeta>;
};

async function setup(): Promise<Env> {
  const hc = new FakeHc();
  const gh = new FakeGh({ readFile: (f) => fsSync.readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 5, { title: 'Fix the thing', body: 'It is broken.' });
  gh.addIssue(REPO, 6, { title: 'Fix the other thing', body: 'Also broken.' });
  const base = await setupRunEnv({ hc, gh, bindings: BINDINGS, extra: TRACKER });
  Object.assign(base.deps, { now: () => new Date(NOW.getTime()) });
  const dir = (id: string) => path.join(base.home, '.percolator', 'runs', id);
  const perc: Env['perc'] = async (argv, deps = base.deps) => {
    let out = '';
    let err = '';
    const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, deps);
    return { code, out, err };
  };
  return {
    ...base,
    dir,
    perc,
    asking: async (asking, ticket = '#5') => {
      const meta = await prepareRun({ ticket, repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps);
      const s = await loadState(dir(meta.runId));
      s.status = 'paused';
      s.cursor = STEPS.indexOf(asking.stepId);
      s.currentStep = asking.stepId;
      if (asking.kind === 'findings') s.rounds = { review: 3 };
      s.asking = asking;
      await saveState(dir(meta.runId), s);
      return meta;
    },
  };
}

const runCalls = (hc: FakeHc) => hc.calls.filter((c) => c[0] === 'run');
const QUESTIONS: Asking = { kind: 'questions', stepId: 'plan', attempt: 1, items: ['Which DB?', 'Keep v1?'] };
const FINDINGS: Asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', items: ['## Missing test\n\nwhy', '## Typo'] };

test('perc answer records the answers and relaunches the driver', async () => {
  const e = await setup();
  try {
    const meta = await e.asking(QUESTIONS);
    const r = await e.perc(['answer', meta.runId, '--answer', '1=Postgres', '--na', '2']);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    assert.equal(
      r.out,
      [
        'answered 2 questions of plan',
        `run ${meta.runId} resumed`,
        `  terminal ${meta.driver}`,
        `  follow with: perc status ${meta.runId}`,
        '',
      ].join('\n'),
    );
    assert.match(await fs.readFile(path.join(e.dir(meta.runId), 'steps', 'plan', '1', 'answers.md'), 'utf8'), /\*\*Answer:\*\* Postgres/);
    const calls = runCalls(e.deps.hc);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0]![1] as { argv: string[] }).argv, [process.execPath, ENTRY, 'drive', meta.runId]);
    const s = await loadState(e.dir(meta.runId));
    assert.ok(!('asking' in s));
    assert.deepEqual(s.answered, { plan: { answers: 'steps/plan/1/answers.md' } });
  } finally {
    await e.cleanup();
  }
});

test('perc answer with a question left unanswered is a usage error and changes nothing', async () => {
  const e = await setup();
  try {
    const meta = await e.asking(QUESTIONS);
    const before = await fs.readFile(path.join(e.dir(meta.runId), 'state.json'), 'utf8');
    const r = await e.perc(['answer', meta.runId, '--answer', '1=x']);
    assert.equal(r.code, 2);
    assert.ok(
      r.err.startsWith(`run ${meta.runId}: answer every question or mark it N/A; unanswered: 2 (--answer <n>=<text>, --na <n>)\n\nusage:`),
      r.err,
    );
    assert.equal(await fs.readFile(path.join(e.dir(meta.runId), 'state.json'), 'utf8'), before);
    await assert.rejects(fs.access(path.join(e.dir(meta.runId), 'steps', 'plan', '1', 'answers.md')));
    assert.deepEqual(runCalls(e.deps.hc), []);
  } finally {
    await e.cleanup();
  }
});

test('perc answer on a run that is not asking is refused, also after it was answered', async () => {
  const e = await setup();
  try {
    const meta = await e.asking(QUESTIONS);
    const ok = await e.perc(['answer', meta.runId, '--answer', '1=a', '--answer', '2=b']);
    assert.equal(ok.code, 0, ok.err);
    // the relaunched driver is still live: the refusal comes first
    const again = await e.perc(['answer', meta.runId, '--answer', '1=a', '--answer', '2=b']);
    assert.equal(again.code, 1);
    assert.equal(again.err, `run ${meta.runId} is not waiting for answers; see where it is with perc status ${meta.runId}\n`);
    assert.equal(runCalls(e.deps.hc).length, 1);
  } finally {
    await e.cleanup();
  }
});

test('perc answer on findings: ticked ones go back to implement, none moves on', async () => {
  const e = await setup();
  try {
    const some = await e.asking(FINDINGS);
    const r = await e.perc(['answer', some.runId, '--agree', '2']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], 'agreed with 1 of 2 findings of review; the run goes back to implement');
    assert.equal(await fs.readFile(path.join(e.dir(some.runId), 'steps', 'review', '3', 'agreed-findings.md'), 'utf8'), '## Typo\n');
    assert.equal((await loadState(e.dir(some.runId))).grantedRound, 'review');
    const none = await e.asking(FINDINGS, '#6');
    const r2 = await e.perc(['answer', none.runId]);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(r2.out.split('\n')[0], 'agreed with none of 2 findings of review; the run moves on to deliver');
  } finally {
    await e.cleanup();
  }
});

test('perc answer --foreground drives in this process', async () => {
  const e = await setup();
  try {
    const meta = await e.asking(FINDINGS);
    const r = await e.perc(['answer', meta.runId, '--foreground']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], 'agreed with none of 2 findings of review; the run moves on to deliver');
    const s: RunState = await loadState(e.dir(meta.runId));
    assert.equal(s.status, 'completed');
    assert.deepEqual(s.history.map((h) => h.stepId), ['deliver']);
  } finally {
    await e.cleanup();
  }
});

test('perc resume on a run that is asking is refused', async () => {
  const e = await setup();
  try {
    const meta = await e.asking(QUESTIONS);
    const r = await e.perc(['resume', meta.runId]);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      `run ${meta.runId} is waiting for answers to questions from plan; answer with perc answer ${meta.runId} (perc status ${meta.runId} lists them)\n`,
    );
    assert.deepEqual(runCalls(e.deps.hc), []);
  } finally {
    await e.cleanup();
  }
});

test('perc status and perc answer number a numbered-list findings file the same way, with clean labels', async () => {
  const e = await setup();
  try {
    const asking: Asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', findings: 'steps/review/3/outputs/findings.md' };
    const m = await e.asking(asking);
    const text = await fs.readFile(path.join(import.meta.dirname, '..', 'fixtures', 'findings', 't25-review-3.md'), 'utf8');
    await fs.mkdir(path.join(e.dir(m.runId), 'steps', 'review', '3', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(e.dir(m.runId), 'steps', 'review', '3', 'outputs', 'findings.md'), text);
    const out = (await e.perc(['status', m.runId])).out.split('\n');
    const j = out.findIndex((l) => l.startsWith('  1. '));
    assert.equal(out[j], "  1. A missing earlier answers file fails perc answer with Node's raw ENOENT text (src/run/answer.ts applyAnswer, the fs.readFile(path.join(dir, earlierRel)) added in aca9d4b).");
    assert.ok(out[j + 1]!.startsWith('  2. Follow-up questions are numbered from any ## Question N line'), out[j + 1]);
    // the space before ) is the file's own, inside the `` … `` around the code
    assert.equal(out[j + 2], '  3. The summary says "answered 1 questions" (src/run/answer.ts applyAnswer, summary = answered ${items.length} questions of ${asking.stepId} ).');
    assert.equal(out[j + 3], `  next: perc answer ${m.runId} --agree <n>[,<n>…]`);
    const r = await e.perc(['answer', m.runId, '--agree', '2']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], 'agreed with 1 of 3 findings of review; the run goes back to implement');
    const agreed = await fs.readFile(path.join(e.dir(m.runId), 'steps', 'review', '3', 'agreed-findings.md'), 'utf8');
    assert.ok(agreed.startsWith('2. **Follow-up questions are numbered from any `## Question N` line'), agreed);
    assert.ok(!agreed.includes('1. **A missing') && !agreed.includes('3. **The summary'));
  } finally {
    await e.cleanup();
  }
});

test('perc status lists what the run asks and how to answer', async () => {
  const e = await setup();
  try {
    // a question is printed in full, its options under it; a finding by its first line only
    const q = await e.asking({ ...QUESTIONS, items: ['Which DB?\n\n- Postgres\n- SQLite', 'Keep v1?'] });
    const out = (await e.perc(['status', q.runId])).out.split('\n');
    const i = out.indexOf('your turn: plan has questions for you');
    assert.deepEqual(out.slice(i, i + 8), [
      'your turn: plan has questions for you',
      '  Answer each one or mark it N/A; plan then runs again with your answers.',
      '  1. Which DB?',
      '',
      '     - Postgres',
      '     - SQLite',
      '  2. Keep v1?',
      `  next: perc answer ${q.runId} --answer <n>="<text>" --na <n> …`,
    ]);
    const f = await e.asking(FINDINGS, '#6');
    const fout = (await e.perc(['status', f.runId])).out.split('\n');
    const j = fout.indexOf('your turn: review hit its cap with findings left');
    assert.deepEqual(fout.slice(j + 2, j + 6), [
      '  1. Missing test',
      '  2. Typo',
      `  next: perc answer ${f.runId} --agree <n>[,<n>…]`,
      `  next: perc answer ${f.runId}`,
    ]);
  } finally {
    await e.cleanup();
  }
});

test('perc status labels keep __dirname and a leading year in a ## title', async () => {
  const e = await setup();
  try {
    const asking: Asking = { kind: 'findings', stepId: 'review', attempt: 3, edgeId: 'review', findings: 'steps/review/3/outputs/findings.md' };
    const m = await e.asking(asking);
    const out = path.join(e.dir(m.runId), 'steps', 'review', '3', 'outputs');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'findings.md'), '## `__dirname` is undefined\n\nwhy\n\n## 2024. retrospective\n\nwhy\n');
    const lines = (await e.perc(['status', m.runId])).out.split('\n');
    const j = lines.findIndex((l) => l.startsWith('  1. '));
    assert.deepEqual(lines.slice(j, j + 2), ['  1. __dirname is undefined', '  2. 2024. retrospective']);
  } finally {
    await e.cleanup();
  }
});
