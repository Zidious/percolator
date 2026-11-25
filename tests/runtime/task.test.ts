import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Step } from '../../src/graph/build.ts';
import { buildTask, renderTemplate, STAGE_BRIEFS, TemplateError, type TaskInput } from '../../src/runtime/task.ts';
import type { MaterializedMapping } from '../../src/workspace/run-dir.ts';

function step(over: Partial<Step> = {}): Step {
  return {
    id: 'review',
    name: 'review',
    stage: 'review',
    role: 'slot',
    def: { kind: 'agent', agent: 'claude' } as Step['def'],
    slotLast: true,
    source: 'core',
    locked: false,
    ...over,
  };
}

function ctx(over: Partial<RunContext> = {}): RunContext {
  return {
    state: {} as RunContext['state'],
    graph: {
      pipeline: 'feature',
      contracts: { intake: ['ticket'], groom: ['groomed_ticket'], plan: ['plan'], implement: ['summary'], review: ['findings'], deliver: ['pr_url'] },
      steps: [step({ id: 'plan', stage: 'plan' }), step({ id: 'implement', stage: 'implement' }), step()],
    } as unknown as RunContext['graph'],
    round: 2,
    maxRounds: 3,
    previousOutputs: {
      implement: { summary: 'steps/implement/1/outputs/summary.md' },
      plan: { plan: 'steps/plan/1/outputs/plan.md' },
    },
    ...over,
  };
}

const worktree = 'C:\\Users\\a b\\wt';
const runDir = 'C:\\Users\\a b\\.percolator\\runs\\r1';

function input(over: Partial<TaskInput> = {}): TaskInput {
  return {
    step: step(),
    ctx: ctx(),
    runId: 'r1',
    ticket: 'o/r#7',
    worktree,
    branch: 'perc/7',
    base: 'main',
    runDir,
    outputsDir: `${runDir}\\steps\\review\\2\\outputs`,
    doneFile: `${runDir}\\steps\\review\\2\\done.json`,
    mappings: [
      { as: 'policy', runPath: '/run/grounds/g/policy.md' } as MaterializedMapping,
      { as: 'context', runPath: '/run/grounds/g/ctx.md' } as MaterializedMapping,
    ],
    skills: { native: ['a', 'b'] },
    parentTerminal: 'herdr-1',
    pipeline: 'feature',
    inputs: {},
    ...over,
  };
}

test('renderTemplate substitutes vars and rejects unknown ones', () => {
  assert.equal(renderTemplate('a {{ x }} b {{y}}', { x: '1', y: '2' }), 'a 1 b 2');
  assert.throws(
    () => renderTemplate('{{ a }} {{b}}', {}),
    (e: unknown) => {
      assert.ok(e instanceof TemplateError);
      assert.equal((e as Error).message, 'unknown template variable(s): a, b');
      return true;
    },
  );
  assert.match(STAGE_BRIEFS.intake, /\{\{ticket\}\}/);
});

test('buildTask for review lists policies with the compliance instruction, inputs with absolute paths, and the done protocol', () => {
  const t = buildTask(input());
  assert.match(t, /^# Percolator task: review \(review, round 2\/3\)\n/);
  assert.match(t, /Do not push, open pull requests or comment on the tracker; Percolator does that\./);
  assert.match(t, /## Stage contract\n\nReview the branch diff \(git diff main\.\.\.HEAD\)/);
  assert.match(t, /## Task\n\nCarry out the stage contract above\./);
  assert.match(t, /Use these skills: a, b\./);
  assert.match(
    t,
    /## Policies \(binding\)\n\nFollow every policy below\. Check the change against each one: each breach is a finding, its own "## " section naming the policy; write nothing about the policies the change keeps\.\n\n- \/run\/grounds\/g\/policy\.md/,
  );
  assert.match(t, /## Context \(reference\)\n\n- \/run\/grounds\/g\/ctx\.md/);
  const planLine = `- plan (from plan): ${path.join(runDir, 'steps/plan/1/outputs/plan.md')}`;
  const summaryLine = `- summary (from implement): ${path.join(runDir, 'steps/implement/1/outputs/summary.md')}`;
  assert.ok(t.includes(planLine));
  assert.ok(t.indexOf(planLine) < t.indexOf(summaryLine));
  assert.ok(t.includes(`Worktree: ${worktree} (branch perc/7, base main).`));
  assert.ok(t.includes(`Write each output as a Markdown file in ${runDir}\\steps\\review\\2\\outputs, named <key>.md.`));
  assert.match(t, /Required: findings\.md/);
  assert.ok(
    t.includes(
      `Write ${runDir}\\steps\\review\\2\\done.json last, as one JSON object: {"status":"pass"}, {"status":"fail"} (review findings, or the step failed) or {"status":"escalate","reason":"…"} when a person is needed. If you have questions only the owner can answer, don't guess: escalate with them, {"status":"escalate","questions":["…","…"]}, and this step runs again with their answers as input answers.`,
    ),
  );
  assert.ok(t.includes('Then run: hc send herdr-1 "review done"'));
});

test('buildTask lists skill files for non-native adapters and omits empty sections', () => {
  const t = buildTask(
    input({
      step: step({ id: 'hook1', stage: 'implement', role: 'hook', slotLast: false }),
      skills: { files: ['/s/one/SKILL.md'] },
      mappings: [],
      ctx: ctx({ previousOutputs: {} }),
    }),
  );
  assert.match(t, /Read and follow these skill files before you start:\n\n- \/s\/one\/SKILL\.md/);
  assert.match(t, /Carry out the node's purpose\./);
  assert.doesNotMatch(t, /## Stage contract/);
  assert.doesNotMatch(t, /## Policies/);
  assert.doesNotMatch(t, /## Context/);
  assert.doesNotMatch(t, /Required:/);
  const none = buildTask(input({ skills: { native: [] }, mappings: [] }));
  assert.doesNotMatch(none, /## Skills/);
});

test('buildTask renders a prompt with template vars', () => {
  const t = buildTask(input({ prompt: 'Look at {{ticket}} on {{branch}}' }));
  assert.match(t, /## Task\n\nLook at o\/r#7 on perc\/7/);
});

test('buildTask omits the hc send line without a parent terminal', () => {
  const t = buildTask(input({ parentTerminal: undefined }));
  assert.doesNotMatch(t, /hc send/);
});

test('the groom brief tells the agent to address approval-gate findings', () => {
  const t = buildTask(input({ step: step({ id: 'groom', name: 'groom', stage: 'groom' }) }));
  assert.match(t, /If the inputs include findings from an approval gate, revise the groomed ticket to address them\./);
});

test('the groom brief tells the agent to refine a previous groomed ticket, not start over', () => {
  const t = buildTask(input({ step: step({ id: 'groom', name: 'groom', stage: 'groom' }) }));
  assert.match(
    t,
    /If the inputs include a previous groomed ticket \(previous_groom\), start from it: keep what still holds, change what the ticket, its comments or the feedback changed; don't start over\./,
  );
});

test('the groom brief tells the agent to record the owner\'s terminal decisions', () => {
  const t = buildTask(input({ step: step({ id: 'groom', name: 'groom', stage: 'groom' }) }));
  assert.ok(
    t.includes(
      'Record in groomed_ticket.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
    ),
  );
});

test('the plan brief tells the agent to record the owner\'s terminal decisions', () => {
  const t = buildTask(input({ step: step({ id: 'plan', name: 'plan', stage: 'plan' }) }));
  assert.ok(
    t.includes(
      'Record in plan.md every decision or clarification the owner gave you in the terminal: the next step sees only your outputs, not this conversation.',
    ),
  );
});

test('the review brief asks for one ## section per finding, even when a skill suggests another format', () => {
  const t = buildTask(input());
  assert.ok(
    t.includes(
      'Write your findings to findings.md, one "## <title>" section per finding, with its detail under it; keep this format even when a skill suggests another, so Percolator can number the findings.',
    ),
  );
  assert.ok(t.includes('If there are none, write "No findings." and finish with status pass; otherwise finish with status fail.'));
});

/** A run of pipeline hotfix whose reproduce stage must write failing_test and fix writes nothing. */
function hotfixInput(stage: string, over: Partial<TaskInput> = {}): TaskInput {
  const graph = { ...ctx().graph, pipeline: 'hotfix', contracts: { intake: ['ticket'], reproduce: ['failing_test'], fix: [] } };
  return input({ step: step({ id: stage, name: stage, stage }), ctx: ctx({ graph }), pipeline: 'hotfix', ...over });
}

test('task for a custom stage uses the generic brief', () => {
  const t = buildTask(hotfixInput('reproduce'));
  assert.ok(t.includes('## Stage contract\n\nCarry out the "reproduce" stage of pipeline hotfix. Write failing_test.md to the outputs directory.'));
  assert.ok(t.includes('Required: failing_test.md'));
});

test('a custom stage with no required outputs gets a short brief and no Required line', () => {
  const t = buildTask(hotfixInput('fix'));
  assert.ok(t.includes('## Stage contract\n\nCarry out the "fix" stage of pipeline hotfix.\n\n## Task'));
  assert.doesNotMatch(t, /Required:/);
});

test('a feature stage name in another pipeline uses the generic brief', () => {
  const t = buildTask(hotfixInput('intake'));
  assert.ok(t.includes('## Stage contract\n\nCarry out the "intake" stage of pipeline hotfix. Write ticket.md to the outputs directory.'));
});

test('{{input_alert_url}} and {{pipeline}} render', () => {
  const t = buildTask(
    input({ prompt: 'Look at {{input_alert_url}} for {{pipeline}}', inputs: { alert_url: 'https://x' }, pipeline: 'dd-alert' }),
  );
  assert.ok(t.includes('## Task\n\nLook at https://x for dd-alert'));
});

test('a declared input the run was not given renders empty; an undeclared one is still unknown', () => {
  const t = buildTask(input({ prompt: 'n={{input_note}} u={{input_url}}', inputs: { url: 'https://x' }, declaredInputs: ['note', 'url'] }));
  assert.ok(t.includes('## Task\n\nn= u=https://x\n'));
  assert.throws(() => buildTask(input({ prompt: '{{input_other}}', declaredInputs: ['note'] })), {
    message: 'unknown template variable(s): input_other',
  });
});
