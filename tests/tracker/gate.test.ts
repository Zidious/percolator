import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Step } from '../../src/graph/build.ts';
import { deciderLogin, githubGate, readWaiting, writeDecision } from '../../src/tracker/gate.ts';
import { parseGateComment, renderGateComment } from '../../src/tracker/gate-comment.ts';
import { FakeGh } from '../helpers/fake-gh.ts';

const REPO = 'github.com/o/r';
const OWNER = 'owner';
const rm = (d: string) => fsp.rm(d, { recursive: true, force: true, maxRetries: 5 });

type Env = {
  runDir: string;
  gh: FakeGh;
  io: { stepDir: string; outputsDir: string };
  step: Step;
  ctx: RunContext;
  clock: { t: number };
  /** runs before each sleep resolves, with the 1-based sleep number */
  onSleep: { fn: (n: number) => Promise<void> | void };
  opts: { sleep: (ms: number) => Promise<void>; now: () => number };
};

async function setup(): Promise<Env> {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perc-gate-'));
  await fsp.writeFile(
    path.join(runDir, 'issue.json'),
    JSON.stringify({ repo: REPO, number: 7, title: 'T', url: `https://${REPO}/issues/7` }),
  );
  const stepDir = path.join(runDir, 'steps', 'approve-groom', '1');
  const outputsDir = path.join(stepDir, 'outputs');
  await fsp.mkdir(outputsDir, { recursive: true });
  const groomOut = path.join(runDir, 'steps', 'groom', '1', 'outputs');
  await fsp.mkdir(groomOut, { recursive: true });
  await fsp.writeFile(path.join(groomOut, 'spec.md'), 'The spec.\n');
  await fsp.writeFile(path.join(groomOut, 'notes.md'), 'Some notes.');
  await fsp.writeFile(path.join(groomOut, 'data.json'), '{}');
  const gh = new FakeGh({ user: OWNER, readFile: (f) => fs.readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 7);
  const groomStep = { id: 'groom' } as Step;
  const step = { id: 'approve-groom' } as Step;
  const ctx = {
    state: { history: [] },
    graph: { steps: [{ id: 'intake' }, groomStep, step] },
    previousOutputs: {
      intake: {},
      groom: {
        spec: 'steps/groom/1/outputs/spec.md',
        notes: 'steps/groom/1/outputs/notes.md',
        data: 'steps/groom/1/outputs/data.json',
      },
    },
  } as unknown as RunContext;
  const clock = { t: 0 };
  const onSleep = { fn: (_n: number): Promise<void> | void => {} };
  let n = 0;
  return {
    runDir,
    gh,
    io: { stepDir, outputsDir },
    step,
    ctx,
    clock,
    onSleep,
    opts: {
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.t += ms;
        await onSleep.fn(++n);
      },
    },
  };
}

const MARKER = '<!-- percolator:gate run=r1 step=approve-groom -->';
/** a round-1 gate comment as an earlier attempt posted it */
const OLD = renderGateComment({ runId: 'r1', stepId: 'approve-groom', round: 1, outputs: 'old', rejected: [] });
const OUTPUTS = '### notes\n\nSome notes.\n\n### spec\n\nThe spec.';
const readGate = async (stepDir: string) => JSON.parse(await fsp.readFile(path.join(stepDir, 'gate.json'), 'utf8'));
const count = (e: Env, method: string) => e.gh.calls.filter((c) => c.method === method).length;

const EXPECTED_BODY = `${MARKER}
**Percolator** needs approval to continue run \`r1\` (step \`approve-groom\`, round 1).

### notes

Some notes.

### spec

The spec.

Reply \`/percolator approve\` to continue, or \`/percolator reject <what to change>\` to send it back.
Locally: \`perc approve r1\` or \`perc reject r1 "<what to change>"\`.
`;

test('posts the groomed ticket once and passes on an approver comment', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = (n) => {
      if (n === 1) {
        assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 1);
        e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
      }
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    // waiting.json is visible while the gate loops
    let waiting: unknown;
    const inner = e.onSleep.fn;
    e.onSleep.fn = async (n) => {
      if (n === 1) waiting = await readWaiting(e.runDir);
      await inner(n);
    };
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 1);
    assert.equal(e.gh.bodies[0], EXPECTED_BODY);
    const posted = (await e.gh.issue(REPO, 7)).comments[0]!;
    assert.deepEqual(waiting, {
      stepId: 'approve-groom',
      stepDir: e.io.stepDir,
      since: (waiting as { since: string }).since,
      commentUrl: posted.url,
    });
    assert.equal(await readWaiting(e.runDir), undefined);
    const approval = await fsp.readFile(path.join(e.io.outputsDir, 'approval.md'), 'utf8');
    const reply = (await e.gh.issue(REPO, 7)).comments[1]!;
    assert.equal(approval, `Approved by @${OWNER} via comment ${reply.url}.\n`);
    assert.deepEqual(out.outputs, { approval: 'steps/approve-groom/1/outputs/approval.md' });
  } finally {
    await rm(e.runDir);
  }
});

test('reject carries the feedback to findings', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator reject  split it up \nand add tests\n');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'fail');
    assert.equal(
      await fsp.readFile(path.join(e.io.outputsDir, 'findings.md'), 'utf8'),
      `Rejected by @${OWNER}: split it up\nand add tests\n`,
    );
    assert.deepEqual(out.outputs, { findings: 'steps/approve-groom/1/outputs/findings.md' });
  } finally {
    await rm(e.runDir);
  }
});

test('ignores non-approvers, earlier comments and quoted commands', async () => {
  const e = await setup();
  try {
    // an earlier round's approval by the owner, before this gate's comment
    e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    e.onSleep.fn = (n) => {
      if (n === 1) {
        e.gh.addComment(REPO, 7, 'mallory', '/percolator approve');
        e.gh.addComment(REPO, 7, OWNER, 'please do not /percolator approve yet');
      }
      if (n === 2) e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    const comments = (await e.gh.issue(REPO, 7)).comments;
    const last = comments[comments.length - 1]!;
    assert.equal(
      await fsp.readFile(path.join(e.io.outputsDir, 'approval.md'), 'utf8'),
      `Approved by @${OWNER} via comment ${last.url}.\n`,
    );
  } finally {
    await rm(e.runDir);
  }
});

test('a crash after posting edits the found comment instead of posting again', async () => {
  const e = await setup();
  try {
    const existing = e.gh.addComment(REPO, 7, OWNER, OLD);
    let editedAt: string | undefined;
    const realEdit = e.gh.editComment.bind(e.gh);
    e.gh.editComment = async (repo, id, bodyFile) => {
      const at = await realEdit(repo, id, bodyFile);
      editedAt ??= at; // the first edit is the round's; a later one records the decision
      return at;
    };
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(count(e, 'comment'), 0);
    // the round edit, then the approval
    assert.equal(count(e, 'editComment'), 2);
    assert.equal(e.gh.bodies[0], EXPECTED_BODY);
    assert.deepEqual(await readGate(e.io.stepDir), { commentUrl: existing.url, commentId: existing.id, round: 1, postedAt: editedAt });
  } finally {
    await rm(e.runDir);
  }
});

test('an error from sleep aborts the gate (a killed driver), keeping gate.json for the resume', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = () => {
      throw new Error('driver killed');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    await assert.rejects(gate(e.step, e.ctx, e.io), { message: 'driver killed' });
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 1);
    const g = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'gate.json'), 'utf8'));
    assert.equal(g.commentUrl, (await e.gh.issue(REPO, 7)).comments[0]!.url);
  } finally {
    await rm(e.runDir);
  }
});

test('a local decision wins without the tracker', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = async (n) => {
      if (n === 1) {
        const w = await writeDecision(e.runDir, { decision: 'approve', by: 'alice' });
        assert.equal(w.stepId, 'approve-groom');
      }
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    const d = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'decision.json'), 'utf8'));
    assert.deepEqual(d, { decision: 'approve', by: 'alice', via: 'local' });
    assert.equal(
      await fsp.readFile(path.join(e.io.outputsDir, 'approval.md'), 'utf8'),
      'Approved by @alice via perc approve.\n',
    );
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 1);
  } finally {
    await rm(e.runDir);
  }
});

test('a local approval closes the gate comment', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = async (n) => {
      if (n === 1) await writeDecision(e.runDir, { decision: 'approve', by: OWNER });
    };
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(count(e, 'comment'), 1);
    assert.equal(count(e, 'editComment'), 1);
    const posted = parseGateComment(e.gh.bodies[0]!)!;
    assert.equal(e.gh.bodies[1], renderGateComment({ ...posted, approvedBy: OWNER }));
    assert.ok(e.gh.bodies[1]!.endsWith('\n\nApproved by @owner\n'));
    assert.equal((await e.gh.issue(REPO, 7)).comments.length, 1);
  } finally {
    await rm(e.runDir);
  }
});

test("a comment rejection is kept in the comment's history", async () => {
  const e = await setup();
  try {
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator reject  split it up \nand add tests\n');
    };
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'fail');
    assert.equal(count(e, 'editComment'), 1);
    const edited = parseGateComment(e.gh.bodies.at(-1)!)!;
    assert.deepEqual(edited.rejected, [{ round: 1, by: OWNER, feedback: 'split it up\nand add tests' }]);
    assert.equal('approvedBy' in edited, false);
  } finally {
    await rm(e.runDir);
  }
});

test('a decision already in the comment is not written again', async () => {
  const e = await setup();
  try {
    const c = e.gh.addComment(
      REPO, 7, OWNER,
      renderGateComment({ runId: 'r1', stepId: 'approve-groom', round: 1, outputs: 'old', rejected: [], approvedBy: OWNER }),
    );
    await fsp.writeFile(
      path.join(e.io.stepDir, 'gate.json'),
      JSON.stringify({ commentUrl: c.url, commentId: c.id, round: 1, postedAt: c.createdAt }),
    );
    await fsp.writeFile(path.join(e.io.stepDir, 'decision.json'), JSON.stringify({ decision: 'approve', by: OWNER, via: 'local' }));
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(count(e, 'editComment'), 0);
  } finally {
    await rm(e.runDir);
  }
});

test('a failure to record the decision does not stop the gate', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = async (n) => {
      if (n === 1) {
        await writeDecision(e.runDir, { decision: 'approve', by: OWNER });
        e.gh.fail('editComment', 'HTTP 502');
      }
    };
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
  } finally {
    await rm(e.runDir);
  }
});

test('an invalid decision.json escalates', async () => {
  const e = await setup();
  try {
    await fsp.writeFile(path.join(e.io.stepDir, 'decision.json'), '{"decision":"maybe"}');
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'escalate');
    assert.match(out.reason ?? '', /decision\.json is invalid: /);
  } finally {
    await rm(e.runDir);
  }
});

test('writeDecision when nothing waits', async () => {
  const e = await setup();
  try {
    await assert.rejects(writeDecision(e.runDir, { decision: 'approve', by: OWNER }), {
      message: 'run is not waiting at a gate',
    });
  } finally {
    await rm(e.runDir);
  }
});

test('gh failure while polling keeps waiting', async () => {
  const e = await setup();
  try {
    let issueCalls = 0;
    let failed = false;
    const realIssue = e.gh.issue.bind(e.gh);
    e.gh.issue = async (repo, n) => {
      // the first poll after the gate comment was recorded fails
      if (!failed && fs.existsSync(path.join(e.io.stepDir, 'gate.json'))) {
        failed = true;
        throw new Error('network down');
      }
      if (failed) issueCalls++;
      return realIssue(repo, n);
    };
    e.onSleep.fn = (n) => {
      if (n === 2) e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.ok(failed && issueCalls >= 1);
  } finally {
    await rm(e.runDir);
  }
});

test('a posting error escalates with the step id', async () => {
  const e = await setup();
  try {
    e.gh.fail('comment', 'boom');
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'escalate');
    assert.equal(out.reason, 'gate approve-groom: gh comment failed: boom');
  } finally {
    await rm(e.runDir);
  }
});

test('the 60000-char cap bounds the total output text of the comment', async () => {
  const e = await setup();
  try {
    const dir = path.join(e.runDir, 'steps', 'groom', '1', 'outputs');
    await fsp.writeFile(path.join(dir, 'a.md'), 'x'.repeat(40000));
    await fsp.writeFile(path.join(dir, 'b.md'), 'y'.repeat(40000));
    await fsp.writeFile(path.join(dir, 'c.md'), 'z');
    e.ctx.previousOutputs.groom = {
      a: 'steps/groom/1/outputs/a.md',
      b: 'steps/groom/1/outputs/b.md',
      c: 'steps/groom/1/outputs/c.md',
    };
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    await gate(e.step, e.ctx, e.io);
    const body = e.gh.bodies[0]!;
    const expected =
      `### a\n\n${'x'.repeat(40000)}\n\n### b\n\n${'y'.repeat(20000)}\n` +
      '… (truncated; full text in steps/groom/1/outputs/b.md of run r1)\n\nReply';
    assert.ok(body.includes(expected), 'body holds the capped sections');
    assert.equal(body.includes(e.runDir), false);
    assert.ok(!body.includes('### c'));
    assert.ok(body.length < 65536);
  } finally {
    await rm(e.runDir);
  }
});

const record = (status: 'pass' | 'fail' | 'escalate' | 'contract_error', attempt: number) => ({
  stepId: 'approve-groom',
  attempt,
  startedAt: '',
  endedAt: '',
  status,
  outputs: {},
});
/** The runtime creates each attempt's step dir before calling the gate. */
const attemptIo = async (e: Env, n: number) => {
  const stepDir = path.join(e.runDir, 'steps', 'approve-groom', String(n));
  await fsp.mkdir(path.join(stepDir, 'outputs'), { recursive: true });
  return { stepDir, outputsDir: path.join(stepDir, 'outputs') };
};

test('an escalation after posting, then a new attempt, edits nothing and reuses postedAt', async () => {
  const e = await setup();
  try {
    await fsp.writeFile(path.join(e.io.stepDir, 'decision.json'), '{"decision":"maybe"}');
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const first = await gate(e.step, e.ctx, e.io);
    assert.equal(first.status, 'escalate');
    const g1 = await readGate(e.io.stepDir);
    e.ctx.state.history.push(record('escalate', 1));
    // after attempt 1 posted, before attempt 2 starts: it answers this round
    e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    const writes = count(e, 'comment') + count(e, 'editComment');
    const io2 = await attemptIo(e, 2);
    const out = await gate(e.step, e.ctx, io2);
    assert.equal(out.status, 'pass');
    // only the approval is written
    assert.equal(count(e, 'comment') + count(e, 'editComment'), writes + 1);
    assert.deepEqual(await readGate(io2.stepDir), g1);
  } finally {
    await rm(e.runDir);
  }
});

test('a later round edits the same comment and keeps its history', async () => {
  const e = await setup();
  try {
    const rejected = [{ round: 1, by: OWNER, feedback: 'x' }];
    const existing = e.gh.addComment(
      REPO, 7, OWNER, renderGateComment({ runId: 'r1', stepId: 'approve-groom', round: 1, outputs: 'old', rejected }),
    );
    e.gh.addComment(REPO, 7, OWNER, '/percolator reject x');
    e.ctx.state.history.push(record('fail', 1));
    e.onSleep.fn = (n) => {
      if (n === 1) e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const io2 = await attemptIo(e, 2);
    const out = await gate(e.step, e.ctx, io2);
    // round 1's reply came before the edit: only the approve added at sleep 1 counts
    assert.equal(out.status, 'pass');
    assert.equal(
      await fsp.readFile(path.join(io2.outputsDir, 'approval.md'), 'utf8'),
      `Approved by @${OWNER} via comment ${(await e.gh.issue(REPO, 7)).comments.at(-1)!.url}.\n`,
    );
    assert.equal(count(e, 'comment'), 0);
    assert.equal(
      e.gh.bodies[0],
      renderGateComment({ runId: 'r1', stepId: 'approve-groom', round: 2, outputs: OUTPUTS, rejected }),
    );
    const gates = (await e.gh.issue(REPO, 7)).comments.filter((c) => c.body.includes(MARKER));
    assert.deepEqual(gates.map((c) => c.url), [existing.url]);
    assert.equal((await readGate(io2.stepDir)).round, 2);
  } finally {
    await rm(e.runDir);
  }
});

test('a legacy gate.json from before the upgrade is still used', async () => {
  const e = await setup();
  try {
    const existing = e.gh.addComment(REPO, 7, OWNER, OLD);
    await fsp.writeFile(
      path.join(e.io.stepDir, 'gate.json'),
      JSON.stringify({ commentUrl: existing.url, postedAt: existing.createdAt }),
    );
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    let waitingUrl: string | undefined;
    const gate = githubGate({
      gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts, onWaiting: (_s, url) => (waitingUrl = url),
    });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    // only the approval is written
    assert.equal(count(e, 'comment'), 0);
    assert.equal(count(e, 'editComment'), 1);
    assert.equal(waitingUrl, existing.url);
  } finally {
    await rm(e.runDir);
  }
});

test('an edit error escalates with the step id', async () => {
  const e = await setup();
  try {
    e.gh.addComment(REPO, 7, OWNER, OLD);
    e.gh.fail('editComment', 'boom');
    e.onSleep.fn = () => {
      throw new Error('the gate waited instead of escalating');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'escalate');
    assert.equal(out.reason, 'gate approve-groom: gh editComment failed: boom');
  } finally {
    await rm(e.runDir);
  }
});

test('a failed lookup after posting falls back to the pre-post time', async () => {
  const e = await setup();
  try {
    e.clock.t = Date.UTC(2025, 0, 1);
    const realIssue = e.gh.issue.bind(e.gh);
    let issueCalls = 0;
    e.gh.issue = async (repo, n) => {
      issueCalls++;
      // call 1 searches for the marker, call 2 looks up the posted comment
      if (issueCalls === 2) throw new Error('network down');
      return realIssue(repo, n);
    };
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    const posted = (await realIssue(REPO, 7)).comments[0]!;
    assert.deepEqual(await readGate(e.io.stepDir), {
      commentUrl: posted.url,
      commentId: posted.id,
      round: 1,
      postedAt: '2025-01-01T00:00:00.000Z',
    });
  } finally {
    await rm(e.runDir);
  }
});

test('the marker search only trusts comments by the gh user', async () => {
  const e = await setup();
  try {
    const forged = e.gh.addComment(REPO, 7, 'mallory', OLD);
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER.toUpperCase(), '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', approvers: [OWNER], ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 1);
    const g = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'gate.json'), 'utf8'));
    assert.notEqual(g.commentUrl, forged.url);
  } finally {
    await rm(e.runDir);
  }
});

test('the marker search matches the gh user case-insensitively', async () => {
  const e = await setup();
  try {
    const existing = e.gh.addComment(REPO, 7, OWNER.toUpperCase(), OLD);
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    assert.equal((await gate(e.step, e.ctx, e.io)).status, 'pass');
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 0);
    const g = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'gate.json'), 'utf8'));
    assert.equal(g.commentUrl, existing.url);
  } finally {
    await rm(e.runDir);
  }
});

test('deciderLogin is the gh login', async () => {
  assert.equal(await deciderLogin(new FakeGh({ user: 'alice' }), () => 'os-user'), 'alice');
});

test('deciderLogin falls back to the OS user when gh fails or has no login, as one handle', async () => {
  const gh = new FakeGh();
  gh.fail('user', 'not logged in');
  assert.equal(await deciderLogin(gh, () => 'Gabe  Smith'), 'Gabe-Smith');
  assert.equal(await deciderLogin(new FakeGh({ user: '' }), () => 'gabe'), 'gabe');
});

test('a corrupt gate.json escalates naming the file and what to do', async () => {
  const e = await setup();
  try {
    const file = path.join(e.io.stepDir, 'gate.json');
    await fsp.writeFile(file, '{');
    let why = '';
    try {
      JSON.parse('{');
    } catch (err) {
      why = (err as Error).message;
    }
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'escalate');
    assert.equal(out.reason, `gate approve-groom: Gate file ${file} is invalid: ${why}; delete it and resume the run`);
  } finally {
    await rm(e.runDir);
  }
});

test("a corrupt gate.json in an earlier attempt escalates naming that file", async () => {
  const e = await setup();
  try {
    const file = path.join(e.io.stepDir, 'gate.json');
    await fsp.writeFile(file, 'not json');
    let why = '';
    try {
      JSON.parse('not json');
    } catch (err) {
      why = (err as Error).message;
    }
    const io2 = await attemptIo(e, 2);
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, io2);
    assert.equal(out.status, 'escalate');
    assert.equal(out.reason, `gate approve-groom: Gate file ${file} is invalid: ${why}; delete it and resume the run`);
  } finally {
    await rm(e.runDir);
  }
});

test('a long rejection history shrinks the outputs so the whole comment fits GitHub', async () => {
  const e = await setup();
  try {
    const dir = path.join(e.runDir, 'steps', 'groom', '1', 'outputs');
    await fsp.writeFile(path.join(dir, 'a.md'), 'x'.repeat(60000));
    e.ctx.previousOutputs.groom = { a: 'steps/groom/1/outputs/a.md' };
    const rejected = [1, 2].map((round) => ({ round, by: OWNER, feedback: 'f'.repeat(5000) }));
    e.gh.addComment(REPO, 7, OWNER, renderGateComment({ runId: 'r1', stepId: 'approve-groom', round: 2, outputs: 'old', rejected }));
    e.ctx.state.history.push(record('fail', 1), record('fail', 2));
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const io3 = await attemptIo(e, 3);
    await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, io3);
    const body = e.gh.bodies[0]!;
    assert.ok(body.includes('\n… (truncated; full text in steps/groom/1/outputs/a.md of run r1)\n'), 'outputs are truncated');
    assert.ok(body.length <= 65536, `body is ${body.length} chars`);
    assert.equal(parseGateComment(body)?.rejected.length, 2);
  } finally {
    await rm(e.runDir);
  }
});

test('a legacy comment url without an id records no decision in any comment', async () => {
  const e = await setup();
  try {
    // another run's gate comment that happens to have id 0
    const other = e.gh.addComment(REPO, 7, OWNER, renderGateComment({ runId: 'r0', stepId: 'approve-groom', round: 1, outputs: 'o', rejected: [] }));
    other.id = 0;
    await fsp.writeFile(
      path.join(e.io.stepDir, 'gate.json'),
      JSON.stringify({ commentUrl: `https://${REPO}/issues/7`, postedAt: other.createdAt }),
    );
    await fsp.writeFile(path.join(e.io.stepDir, 'decision.json'), JSON.stringify({ decision: 'approve', by: OWNER, via: 'local' }));
    const out = await githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts })(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(count(e, 'editComment'), 0);
    assert.equal(parseGateComment((await e.gh.issue(REPO, 7)).comments[0]!.body)?.approvedBy, undefined);
  } finally {
    await rm(e.runDir);
  }
});

test('a gate without an issue waits locally and posts nothing', async () => {
  const e = await setup();
  try {
    await fsp.rm(path.join(e.runDir, 'issue.json'));
    const waited: [string, string | undefined][] = [];
    e.onSleep.fn = async (n) => {
      if (n !== 1) return;
      const w = await readWaiting(e.runDir);
      assert.deepEqual(Object.keys(w!).sort(), ['since', 'stepDir', 'stepId']);
      await writeDecision(e.runDir, { decision: 'approve', by: 'bob' });
    };
    const h = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts, onWaiting: (s, u) => void waited.push([s, u]) });
    const out = await h(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.deepEqual(waited, [['approve-groom', undefined]]);
    assert.deepEqual(e.gh.calls.filter((c) => c.method !== 'user'), []);
    assert.equal(await fsp.readFile(path.join(e.io.outputsDir, 'approval.md'), 'utf8'), 'Approved by @bob via perc approve.\n');
    assert.equal(await readWaiting(e.runDir), undefined);
  } finally {
    await rm(e.runDir);
  }
});
