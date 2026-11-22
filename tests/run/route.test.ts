import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { drive } from '../../src/run/drive.ts';
import { readRunMeta } from '../../src/run/meta.ts';
import type { RunMeta } from '../../src/run/meta.ts';
import { prepareRun } from '../../src/run/prepare.ts';
import { parsePick } from '../../src/run/route.ts';
import { readWaiting, writeDecision } from '../../src/tracker/gate.ts';
import type { HcRunOptions } from '../../src/herdr/hc.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { FakeHc } from '../helpers/fake-hc.ts';
import { setupRunEnv } from '../helpers/run-env.ts';
import type { RunEnv } from '../helpers/run-env.ts';

const REPO = 'github.com/o/r';

/** Profile `work`: feature (the default), a hotfix pipeline and the router triage. */
function routerConfig(o: { choose?: boolean; confirm?: 'always' } = {}): string {
  return [
    '    tracker: { kind: github, approvers: [alice] }',
    '    pipelines:',
    '      hotfix:',
    '        stages: [intake, implement, deliver]',
    '        exit: pr',
    '        bindings:',
    '          implement: { command: [echo, implement] }',
    '      triage:',
    '        router: true',
    '        stages: [intake, route]',
    '        routes:',
    '          - { label: bug, to: hotfix }',
    '          - { label: urgent, to: feature }',
    ...(o.choose === false
      ? []
      : [`        choose: { agent: claude, from: [hotfix, feature]${o.confirm !== undefined ? `, confirm: ${o.confirm}` : ''} }`]),
  ].join('\n');
}

type Env = RunEnv & {
  /** pick.md the choose agent writes; undefined = the agent never runs */
  pick: { text?: string };
  /** each gate the run waited at, in order */
  waited: string[];
  /** the decision written at the pick-pipeline gate */
  answer: { decision: 'approve' | 'reject'; pipeline?: string };
  meta: RunMeta;
  dir(id: string): string;
  routeJson(): Promise<Record<string, unknown>>;
  /** hc run calls for a step id (`@driver` → drivers) */
  runsOf(step: string): HcRunOptions[];
};

async function setup(labels: string[], config = routerConfig()): Promise<Env> {
  const pick: { text?: string } = {};
  const hc = new FakeHc(async (t) => {
    if (t.labels['percolator.step'] !== 'route.1') throw new Error(`unexpected wait on ${t.name}`);
    const dir = path.dirname(hc.taskFileOf(t));
    await fs.mkdir(path.join(dir, 'outputs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'outputs', 'pick.md'), pick.text ?? '');
    await fs.writeFile(path.join(dir, 'done.json'), JSON.stringify({ status: 'pass' }));
  });
  const gh = new FakeGh({ readFile: (f) => fsSync.readFileSync(f, 'utf8') });
  gh.addIssue(REPO, 5, { title: 'Fix the thing', body: 'It is broken.', labels });
  const base = await setupRunEnv({ hc, gh, extra: config });
  const dir = (id: string) => path.join(base.home, '.percolator', 'runs', id);
  const waited: string[] = [];
  const answer: Env['answer'] = { decision: 'approve' };
  let meta: RunMeta | undefined;
  Object.assign(base.deps, {
    sleep: async () => {
      const w = await readWaiting(dir(meta!.runId));
      if (w === undefined) return;
      waited.push(w.stepId);
      await writeDecision(dir(meta!.runId), { ...answer, by: 'bob' });
    },
  });
  meta = await prepareRun({ ticket: '#5', pipeline: 'triage', repoDir: base.root, configFile: base.configFile, profile: 'work' }, base.deps);
  return {
    ...base,
    pick,
    waited,
    answer,
    meta,
    dir,
    routeJson: async () => JSON.parse(await fs.readFile(path.join(dir(meta!.runId), 'route.json'), 'utf8')),
    runsOf: (step) =>
      hc.calls
        .filter((c) => c[0] === 'run')
        .map((c) => c[1] as HcRunOptions)
        .filter((r) => (step === '@driver' ? r.labels?.['percolator.role'] === 'driver' : r.labels?.['percolator.step'] === step)),
  };
}

/** Drives the router to its end and returns the child it started. */
async function driveRouter(e: Env): Promise<RunMeta> {
  const state = await drive(e.meta.runId, e.deps);
  assert.equal(state.status, 'completed', JSON.stringify(state.history));
  const route = await e.routeJson();
  const child = await readRunMeta(e.dir(String(route['child'])));
  assert.equal(child.parent, e.meta.runId);
  assert.equal(child.ticket, `${REPO}#5`);
  assert.deepEqual(e.runsOf('@driver').map((r) => r.argv.at(-1)), [child.runId]);
  const routed = state.history.findLast((h) => h.stepId === 'route.3')!;
  assert.deepEqual(Object.keys(routed.outputs).sort(), ['child_run', 'route']);
  assert.equal(
    await fs.readFile(path.join(e.dir(e.meta.runId), routed.outputs['route']!), 'utf8'),
    `Routed to ${route['pipeline']} (${route['by']}: ${route['detail']}) → run ${child.runId}\n`,
  );
  assert.equal((await fs.readFile(path.join(e.dir(e.meta.runId), routed.outputs['child_run']!), 'utf8')).trim(), child.runId);
  return child;
}

test('a pipeline: label routes without the agent', async () => {
  const e = await setup(['pipeline:hotfix', 'bug']);
  try {
    const child = await driveRouter(e);
    assert.equal(child.pipeline, 'hotfix');
    assert.deepEqual(await e.routeJson(), { pipeline: 'hotfix', by: 'named', detail: 'label pipeline:hotfix', child: child.runId });
    assert.deepEqual(e.runsOf('route.1'), []);
    assert.deepEqual(e.waited, []);
  } finally {
    await e.cleanup();
  }
});

test('a /percolator run comment by an approver routes without the agent', async () => {
  const e = await setup([]);
  try {
    e.deps.gh.addComment(REPO, 5, 'alice', '/percolator run hotfix');
    const child = await driveRouter(e);
    assert.equal(child.pipeline, 'hotfix');
    assert.deepEqual(await e.routeJson(), { pipeline: 'hotfix', by: 'named', detail: 'comment /percolator run hotfix', child: child.runId });
    assert.deepEqual(e.runsOf('route.1'), []);
  } finally {
    await e.cleanup();
  }
});

test('the first matching routes rule wins', async () => {
  const e = await setup(['urgent', 'bug']);
  try {
    const child = await driveRouter(e);
    assert.equal(child.pipeline, 'hotfix');
    assert.deepEqual(await e.routeJson(), { pipeline: 'hotfix', by: 'rule', detail: 'label bug', child: child.runId });
    assert.deepEqual(e.runsOf('route.1'), []);
    assert.deepEqual(e.waited, []);
  } finally {
    await e.cleanup();
  }
});

test("the agent's sure pick goes ahead without the gate", async () => {
  const e = await setup([]);
  try {
    e.pick.text = 'pipeline: hotfix\nunsure: false\nIt is a small fix.\n';
    const child = await driveRouter(e);
    assert.equal(child.pipeline, 'hotfix');
    assert.deepEqual(await e.routeJson(), { pipeline: 'hotfix', by: 'agent', detail: 'picked, sure', child: child.runId });
    assert.equal(e.runsOf('route.1').length, 1);
    assert.deepEqual(e.waited, []);
  } finally {
    await e.cleanup();
  }
});

test('an unsure pick stops at pick-pipeline', async () => {
  const e = await setup([]);
  try {
    e.pick.text = 'pipeline: hotfix\nunsure: true\n';
    const child = await driveRouter(e);
    assert.deepEqual(e.waited, ['pick-pipeline']);
    assert.equal(child.pipeline, 'hotfix');
    assert.deepEqual(await e.routeJson(), { pipeline: 'hotfix', by: 'agent', detail: 'picked, approved by @bob', child: child.runId });
  } finally {
    await e.cleanup();
  }
});

test('confirm: always stops even for a sure pick', async () => {
  const e = await setup([], routerConfig({ confirm: 'always' }));
  try {
    e.pick.text = 'pipeline: hotfix\nunsure: false\n';
    const child = await driveRouter(e);
    assert.deepEqual(e.waited, ['pick-pipeline']);
    assert.equal(child.pipeline, 'hotfix');
  } finally {
    await e.cleanup();
  }
});

test('an approve with --pipeline overrides the pick', async () => {
  const e = await setup([]);
  try {
    e.pick.text = 'pipeline: hotfix\nunsure: true\n';
    e.answer.pipeline = 'feature';
    const child = await driveRouter(e);
    assert.deepEqual(e.waited, ['pick-pipeline']);
    assert.equal(child.pipeline, 'feature');
    assert.deepEqual(await e.routeJson(), { pipeline: 'feature', by: 'gate', detail: 'perc approve --pipeline by @bob', child: child.runId });
  } finally {
    await e.cleanup();
  }
});

test('fallback applies when the agent writes no valid pick and confirm is unsure', async () => {
  const e = await setup([]);
  try {
    e.pick.text = 'pipeline: nope\nunsure: false\n';
    const child = await driveRouter(e);
    // an invalid pick is unsure: the gate stops first, and the fallback applies after its approve
    assert.deepEqual(e.waited, ['pick-pipeline']);
    assert.equal(child.pipeline, 'feature');
    assert.deepEqual(await e.routeJson(), { pipeline: 'feature', by: 'fallback', detail: 'no pipeline picked', child: child.runId });
  } finally {
    await e.cleanup();
  }
});

test('a router without choose falls back when no rule matches', async () => {
  const e = await setup([], routerConfig({ choose: false }));
  try {
    const child = await driveRouter(e);
    assert.equal(child.pipeline, 'feature');
    assert.deepEqual(await e.routeJson(), { pipeline: 'feature', by: 'fallback', detail: 'no pipeline picked', child: child.runId });
  } finally {
    await e.cleanup();
  }
});

test('handoff writes route.json before starting the child', async () => {
  const e = await setup(['bug']);
  try {
    const seen: unknown[] = [];
    const run = e.deps.hc.run.bind(e.deps.hc);
    e.deps.hc.run = async (o) => {
      seen.push(JSON.parse(await fs.readFile(path.join(e.dir(e.meta.runId), 'route.json'), 'utf8')));
      return run(o);
    };
    const child = await driveRouter(e);
    assert.deepEqual(seen, [{ pipeline: 'hotfix', by: 'rule', detail: 'label bug', child: child.runId }]);
  } finally {
    await e.cleanup();
  }
});

test('handoff finds the child it started before a crash', async () => {
  const e = await setup(['bug']);
  try {
    // the child's driver starts, then the router's driver dies before it records the step
    const run = e.deps.hc.run.bind(e.deps.hc);
    let crash = true;
    e.deps.hc.run = async (o) => {
      const r = await run(o);
      if (crash) {
        crash = false;
        throw new Error('driver killed');
      }
      return r;
    };
    const first = await drive(e.meta.runId, e.deps);
    assert.equal(first.status, 'paused');
    const runs = await fs.readdir(path.join(e.home, '.percolator', 'runs'));
    const child = await driveRouter(e);
    assert.deepEqual(await fs.readdir(path.join(e.home, '.percolator', 'runs')), runs);
    assert.equal(e.runsOf('@driver').length, 1);
    assert.equal(child.pipeline, 'hotfix');
  } finally {
    await e.cleanup();
  }
});

test('parsePick reads the pipeline and whether the agent is unsure', () => {
  const from = ['hotfix', 'feature'];
  assert.deepEqual(parsePick('pipeline: hotfix\nunsure: false\nreasons', from), { pipeline: 'hotfix', unsure: false });
  assert.deepEqual(parsePick('pipeline: hotfix\r\nunsure: true\r\n', from), { pipeline: 'hotfix', unsure: true });
  assert.deepEqual(parsePick('pipeline: hotfix\n', from), { pipeline: 'hotfix', unsure: true });
  assert.deepEqual(parsePick('pipeline: nope\nunsure: false\n', from), { unsure: true });
  assert.deepEqual(parsePick('', from), { unsure: true });
});

