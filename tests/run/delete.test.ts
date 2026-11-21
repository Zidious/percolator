import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../../src/engine/state.ts';
import type { RunState } from '../../src/engine/state.ts';
import { deleteRun, isFinished, planDelete } from '../../src/run/delete.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { statusJson } from '../../src/run/status.ts';
import { removeWorktree } from '../../src/workspace/worktree.ts';
import { git } from '../helpers/git-repo.ts';
import { NOW, setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

type Env = RunEnv & {
  dir(m: RunMeta): string;
  prepare(): Promise<RunMeta>;
  edit(m: RunMeta, f: (s: RunState) => void): Promise<void>;
  liveDriver(m: RunMeta): void;
  waitAtGate(m: RunMeta): Promise<void>;
  stepTerminal(m: RunMeta, name?: string): void;
};

async function setup(): Promise<Env> {
  const base = await setupRunEnv();
  const dir = (m: RunMeta) => path.join(base.home, '.percolator', 'runs', m.runId);
  const edit = async (m: RunMeta, f: (s: RunState) => void) => {
    const s = await loadState(dir(m));
    f(s);
    await saveState(dir(m), s);
  };
  return {
    ...base,
    dir,
    prepare: () => prepareRun({ ticket: '#5', repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps),
    edit,
    liveDriver: (m) => {
      base.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } });
    },
    waitAtGate: async (m) => {
      await edit(m, (s) => {
        s.currentStep = 'approve-groom';
      });
      await fs.writeFile(
        path.join(dir(m), 'waiting.json'),
        JSON.stringify({
          stepId: 'approve-groom',
          stepDir: path.join(dir(m), 'steps', 'approve-groom', '1'),
          since: NOW.toISOString(),
          commentUrl: 'https://github.com/o/r/issues/5#issuecomment-7',
        }),
      );
    },
    stepTerminal: (m, name = `${m.runId}-plan`) => {
      base.deps.hc.add({ name, state: 'finished', labels: { 'percolator.run': m.runId, 'percolator.step': 'plan' } });
    },
  };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

const line = (m: RunMeta, n: number) => `deleted run ${m.runId}: ${n} terminal(s), worktree ${m.worktree}; kept branch ${m.branch}`;
const goneLine = (m: RunMeta, n: number) => `deleted run ${m.runId}: ${n} terminal(s), worktree already removed; kept branch ${m.branch}`;

/** The worktree and run dir are gone, the branch is kept, and `perc status --json` no longer lists the run. */
async function assertDeleted(e: Env, m: RunMeta): Promise<void> {
  assert.equal(await exists(m.worktree), false);
  assert.equal(await exists(e.dir(m)), false);
  assert.match(await git(e.root, 'rev-parse', '--verify', m.branch), /^[0-9a-f]{40}$/);
  assert.equal((await statusJson(e.deps)).runs.some((r) => r.id === m.runId), false);
}

async function del(e: Env, m: RunMeta, o?: Parameters<typeof deleteRun>[2]): Promise<string> {
  return deleteRun(await planDelete(m.runId, e.deps), e.deps, o);
}

test('deleteRun removes a completed run', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.status = 'completed'));
    e.deps.hc.add({ name: m.driver, state: 'finished', labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } });
    e.stepTerminal(m);
    e.deps.hc.add({ name: 'foreign', labels: {} });
    assert.equal(await del(e, m), line(m, 2));
    assert.deepEqual([...e.deps.hc.terminals.keys()], ['foreign']);
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

for (const status of ['failed', 'paused'] as const) {
  test(`deleteRun removes a ${status} run`, async () => {
    const e = await setup();
    try {
      const m = await e.prepare();
      await e.edit(m, (s) => (s.status = status));
      e.stepTerminal(m);
      assert.equal(await del(e, m), line(m, 1));
      await assertDeleted(e, m);
    } finally {
      await e.cleanup();
    }
  });
}

test('deleteRun stops a live driver terminal of a run waiting at a gate', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    e.liveDriver(m);
    await e.waitAtGate(m);
    const plan = await planDelete(m.runId, e.deps);
    assert.equal(plan.status, 'waiting');
    e.deps.hc.calls = [];
    assert.equal(await deleteRun(plan, e.deps), line(m, 1));
    assert.deepEqual(e.deps.hc.calls.find((c) => c[0] === 'kill'), ['kill', m.driver]);
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

async function writeLock(e: Env, m: RunMeta, host: string): Promise<void> {
  await fs.writeFile(
    path.join(e.dir(m), 'driver.json'),
    JSON.stringify({ pid: 4242, host, terminal: null, startedAt: NOW.toISOString() }),
  );
  e.deps.pidAlive = () => true;
}

test('deleteRun refuses a foreground driver on this host', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await writeLock(e, m, os.hostname());
    await assert.rejects(del(e, m), {
      message: `run ${m.runId} is being driven by process 4242; stop it (Ctrl-C) and run perc delete ${m.runId} again`,
    });
    assert.equal(await exists(m.worktree), true);
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun refuses a driver on another host', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await writeLock(e, m, 'elsewhere');
    await assert.rejects(del(e, m), {
      message: `run ${m.runId} is being driven by process 4242 on elsewhere; stop it there and run perc delete ${m.runId} again`,
    });
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun finishes after the worktree was already removed', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await e.edit(m, (s) => (s.status = 'completed'));
    await removeWorktree({ repoRoot: m.repoRoot, dir: m.worktree, force: true });
    assert.equal(await del(e, m), goneLine(m, 0));
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun keeps the record when it fails before removing the run dir, and a re-run finishes', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await assert.rejects(
      del(e, m, {
        removeWorktree: async () => {
          throw new Error('boom');
        },
      }),
      { message: `run ${m.runId}: boom` },
    );
    assert.equal(await exists(e.dir(m)), true);
    assert.equal(await del(e, m), line(m, 0));
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun retries a held worktree and then gives up', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    let calls = 0;
    await assert.rejects(
      del(e, m, {
        retryDelaysMs: [1, 1],
        removeWorktree: async () => {
          calls++;
          throw new Error(`git worktree remove failed: error: failed to delete '${m.worktree}': Permission denied`);
        },
      }),
      { message: `run ${m.runId}: worktree ${m.worktree} is still in use; close what holds it and run perc delete ${m.runId} again` },
    );
    assert.equal(calls, 3);
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun retries a held worktree and succeeds when it is released', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    let calls = 0;
    const got = await del(e, m, {
      retryDelaysMs: [1, 1],
      removeWorktree: async (o) => {
        if (++calls === 1) throw new Error('EBUSY: resource busy or locked');
        return removeWorktree(o);
      },
    });
    assert.equal(got, line(m, 0));
    assert.equal(calls, 2);
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun finishes a run whose run.json is gone', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(path.join(e.dir(m), 'run.json'));
    e.stepTerminal(m);
    const plan = await planDelete(m.runId, e.deps);
    assert.equal(plan.status, 'unreadable');
    assert.equal(
      await deleteRun(plan, e.deps),
      `deleted run ${m.runId}: 1 terminal(s); its worktree is unknown, check <repo>/.worktrees/${m.runId}; kept branch percolator/${m.runId}`,
    );
    assert.equal(await exists(e.dir(m)), false);
    assert.equal(e.deps.hc.terminals.size, 0);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun deletes a run whose state.json is corrupt', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.writeFile(path.join(e.dir(m), 'state.json'), 'garbage');
    const plan = await planDelete(m.runId, e.deps);
    assert.equal(plan.status, 'unreadable');
    assert.equal(await deleteRun(plan, e.deps), line(m, 0));
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun prunes a worktree removed by hand', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.rm(m.worktree, { recursive: true, force: true, maxRetries: 5 });
    assert.equal(await del(e, m), goneLine(m, 0));
    assert.equal((await git(e.root, 'worktree', 'list')).includes(m.runId), false);
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun with a missing repo removes the record and says so', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const missing = path.join(e.home, 'moved-away');
    await fs.writeFile(path.join(e.dir(m), 'run.json'), JSON.stringify({ ...m, repoRoot: missing }));
    e.stepTerminal(m);
    assert.equal(
      await del(e, m),
      `deleted run ${m.runId}: 1 terminal(s); repo ${missing} not found, worktree ${m.worktree} left as is; kept branch ${m.branch}`,
    );
    assert.equal(await exists(e.dir(m)), false);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun never touches a terminal named like the driver without the run label', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    e.deps.hc.add({ name: m.driver, labels: {} });
    assert.equal(await del(e, m), line(m, 0));
    assert.equal(e.deps.hc.terminals.get(m.driver)?.state, 'live');
    assert.equal(e.deps.hc.calls.some((c) => c[0] === 'kill'), false);
  } finally {
    await e.cleanup();
  }
});

test('planDelete reports ticket, status and dirty worktree', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await fs.writeFile(path.join(e.dir(m), 'issue.json'), JSON.stringify({ title: 'Fix the thing' }));
    const clean = await planDelete(m.runId, e.deps);
    assert.deepEqual(clean.ticket, { ref: m.ticket, title: 'Fix the thing' });
    assert.equal(clean.status, 'running');
    assert.deepEqual(clean.worktree, { path: m.worktree, state: 'clean' });
    await fs.writeFile(path.join(m.worktree, 'x.txt'), 'x');
    assert.equal((await planDelete(m.runId, e.deps)).worktree?.state, 'dirty');
    await removeWorktree({ repoRoot: m.repoRoot, dir: m.worktree, force: true });
    assert.equal((await planDelete(m.runId, e.deps)).worktree?.state, 'gone');
  } finally {
    await e.cleanup();
  }
});

test('planDelete of an unknown id', async () => {
  const e = await setup();
  try {
    await assert.rejects(planDelete('nope', e.deps), { message: 'no run nope; perc status lists runs' });
  } finally {
    await e.cleanup();
  }
});

test('isFinished is true only for completed and failed', () => {
  for (const s of ['completed', 'failed'] as const) assert.equal(isFinished(s), true);
  for (const s of ['running', 'waiting', 'paused', 'unreadable'] as const) assert.equal(isFinished(s), false);
});

test('deleteRun removes a worktree dir that git no longer lists', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    await removeWorktree({ repoRoot: m.repoRoot, dir: m.worktree, force: true });
    await fs.mkdir(m.worktree, { recursive: true });
    await fs.writeFile(path.join(m.worktree, 'left.txt'), 'x');
    assert.equal(await del(e, m), line(m, 0));
    await assertDeleted(e, m);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun refuses a live foreground lock even when an unlabelled terminal has the driver name', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    e.deps.hc.add({ name: m.driver, labels: {} });
    await writeLock(e, m, os.hostname());
    await assert.rejects(del(e, m), {
      message: `run ${m.runId} is being driven by process 4242; stop it (Ctrl-C) and run perc delete ${m.runId} again`,
    });
    assert.equal(await exists(m.worktree), true);
    assert.equal(await exists(e.dir(m)), true);
    assert.equal(e.deps.hc.calls.some((c) => c[0] === 'kill'), false);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun names the run and what to do when hc fails', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const plan = await planDelete(m.runId, e.deps);
    const fail = async (): Promise<never> => {
      throw new Error('hc: cannot reach herdr');
    };
    e.deps.hc.get = fail;
    e.deps.hc.list = fail;
    await assert.rejects(deleteRun(plan, e.deps), {
      message: `run ${m.runId}: hc: cannot reach herdr; start herdr and run perc delete ${m.runId} again`,
    });
    assert.equal(await exists(e.dir(m)), true);
  } finally {
    await e.cleanup();
  }
});

test('deleteRun finishes when the repo is no longer a git repo and the worktree is gone', async () => {
  const e = await setup();
  try {
    const m = await e.prepare();
    const plain = path.join(e.home, 'plain');
    await fs.mkdir(plain);
    await fs.writeFile(path.join(e.dir(m), 'run.json'), JSON.stringify({ ...m, repoRoot: plain, worktree: path.join(plain, '.worktrees', m.runId) }));
    assert.equal(
      await del(e, m),
      `deleted run ${m.runId}: 0 terminal(s), worktree already removed; repo ${plain} is not a git repo, nothing to prune; kept branch ${m.branch}`,
    );
    assert.equal(await exists(e.dir(m)), false);
  } finally {
    await e.cleanup();
  }
});

for (const self of ['driver', 'step'] as const) {
  test(`deleteRun refuses to run from the run's own ${self} terminal`, async () => {
    const e = await setup();
    try {
      const m = await e.prepare();
      const t =
        self === 'driver'
          ? e.deps.hc.add({ name: m.driver, labels: { 'percolator.run': m.runId, 'percolator.role': 'driver' } })
          : e.deps.hc.add({ name: `${m.runId}-plan`, labels: { 'percolator.run': m.runId, 'percolator.step': 'plan' } });
      e.deps.selfTerminal = t.address;
      await assert.rejects(del(e, m), {
        message: `run ${m.runId}: this terminal belongs to the run; run perc delete ${m.runId} from another terminal`,
      });
      assert.equal(e.deps.hc.calls.some((c) => c[0] === 'kill'), false);
      assert.equal(await exists(e.dir(m)), true);
    } finally {
      await e.cleanup();
    }
  });
}
