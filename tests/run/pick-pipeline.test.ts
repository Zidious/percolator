import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineSpec } from '../../src/config/pipelines.ts';
import { pipelineFor } from '../../src/run/pick-pipeline.ts';
import type { Issue, IssueComment } from '../../src/tracker/gh.ts';

const spec = (name: string): PipelineSpec => ({ name, ticket: 'required', inputs: {}, default: name === 'feature' });
const specs = { feature: spec('feature'), hotfix: spec('hotfix'), docs: spec('docs') };

let id = 0;
const comment = (author: string, body: string): IssueComment => {
  id++;
  return { id, author, body, createdAt: `2026-01-01T00:00:${String(id).padStart(2, '0')}Z`, url: `https://github.com/o/r/issues/5#issuecomment-${id}` };
};
const issue = (o: Partial<Issue> = {}): Issue => ({
  number: 5,
  title: 'T',
  body: '',
  url: 'https://github.com/o/r/issues/5',
  state: 'OPEN',
  author: 'someone',
  comments: [],
  labels: [],
  ...o,
});
const base = { approvers: ['Alice'], specs, defaultName: 'feature', profile: 'work', ref: 'github.com/o/r#5' };

test('the flag wins over a label', () => {
  assert.deepEqual(pipelineFor({ ...base, flag: 'docs', issue: issue({ labels: ['pipeline:hotfix'] }) }), { name: 'docs', by: 'flag' });
});

test('a pipeline: label names the pipeline', () => {
  assert.deepEqual(pipelineFor({ ...base, issue: issue({ labels: ['bug', 'pipeline:hotfix'] }) }), { name: 'hotfix', by: 'label' });
});

test("an approver's /percolator run comment names it", () => {
  const comments = [comment('alice', '/percolator run docs'), comment('ALICE', 'thinking\n/percolator run hotfix  ')];
  assert.deepEqual(pipelineFor({ ...base, issue: issue({ comments }) }), { name: 'hotfix', by: 'comment' });
});

test("a non-approver's comment is ignored", () => {
  const comments = [comment('mallory', '/percolator run hotfix')];
  assert.deepEqual(pipelineFor({ ...base, issue: issue({ comments }) }), { name: 'feature', by: 'default' });
});

test('an unknown named pipeline is refused', () => {
  assert.throws(() => pipelineFor({ ...base, issue: issue({ labels: ['pipeline:nope'] }) }), {
    message:
      'issue github.com/o/r#5 asks for pipeline "nope" (label pipeline:nope), which profile "work" does not define (pipelines: feature, hotfix, docs); fix it or pass --pipeline',
  });
  const c = comment('alice', '/percolator run nope');
  assert.throws(() => pipelineFor({ ...base, issue: issue({ comments: [c] }) }), {
    message: `issue github.com/o/r#5 asks for pipeline "nope" (comment ${c.url}), which profile "work" does not define (pipelines: feature, hotfix, docs); fix it or pass --pipeline`,
  });
});

test('default otherwise', () => {
  assert.deepEqual(pipelineFor({ ...base }), { name: 'feature', by: 'default' });
  assert.deepEqual(pipelineFor({ ...base, defaultName: 'docs', issue: issue() }), { name: 'docs', by: 'default' });
});
