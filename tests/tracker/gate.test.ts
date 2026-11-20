import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunContext } from '../../src/engine/runtime.ts';
import type { Step } from '../../src/graph/build.ts';
import { githubGate, readWaiting, writeDecision } from '../../src/tracker/gate.ts';
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

const MARKER = '<!-- percolator:gate run=r1 step=approve-groom attempt=1 -->';

const EXPECTED_BODY = `${MARKER}
**Percolator** needs approval to continue run \`r1\` (step \`approve-groom\`).

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

test('a crash after posting reuses the existing comment', async () => {
  const e = await setup();
  try {
    const existing = e.gh.addComment(REPO, 7, OWNER, `${MARKER}\nold body`);
    e.onSleep.fn = () => {
      e.gh.addComment(REPO, 7, OWNER, '/percolator approve');
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    assert.equal(e.gh.calls.filter((c) => c.method === 'comment').length, 0);
    const g = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'gate.json'), 'utf8'));
    assert.deepEqual(g, { commentUrl: existing.url, postedAt: existing.createdAt });
  } finally {
    await rm(e.runDir);
  }
});

test('a local decision wins without the tracker', async () => {
  const e = await setup();
  try {
    e.onSleep.fn = async (n) => {
      if (n === 1) {
        const w = await writeDecision(e.runDir, { decision: 'approve' });
        assert.equal(w.stepId, 'approve-groom');
      }
    };
    const gate = githubGate({ gh: e.gh, runDir: e.runDir, runId: 'r1', ...e.opts });
    const out = await gate(e.step, e.ctx, e.io);
    assert.equal(out.status, 'pass');
    const d = JSON.parse(await fsp.readFile(path.join(e.io.stepDir, 'decision.json'), 'utf8'));
    assert.deepEqual(d, { decision: 'approve', by: os.userInfo().username, via: 'local' });
    assert.equal(
      await fsp.readFile(path.join(e.io.outputsDir, 'approval.md'), 'utf8'),
      `Approved by @${os.userInfo().username} via perc approve.\n`,
    );
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
    await assert.rejects(writeDecision(e.runDir, { decision: 'approve' }), {
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
