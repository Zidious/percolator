import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_PAGES = ['how-it-works', 'configuration', 'pipelines', 'steering', 'integrations', 'development'];

/** README.md and every docs/*.md (not recursive, so docs/superpowers/ is never read). */
async function pages(): Promise<string[]> {
  const docs = path.join(ROOT, 'docs');
  const names = await fs.readdir(docs).catch(() => [] as string[]);
  return [path.join(ROOT, 'README.md'), ...names.filter((n) => n.endsWith('.md')).sort().map((n) => path.join(docs, n))];
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

/** The text with fenced code blocks (from an opening ``` up to and including its closing fence) removed. */
function stripFences(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(md: string): string[] {
  return [...stripFences(md).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!.trim()));
}

function links(md: string): string[] {
  const text = stripFences(md).replace(/`[^`\n]*`/g, '');
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!),
    ...[...text.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]!),
  ];
  return targets.filter((t) => !/^(?:https?|mailto):/.test(t));
}

test('slug follows GitHub', () => {
  assert.equal(slug('Grounds: shared policy from git'), 'grounds-shared-policy-from-git');
  assert.equal(slug('A run, stop by stop'), 'a-run-stop-by-stop');
  assert.equal(slug('Triggers and `perc watch`'), 'triggers-and-perc-watch');
});

test('fenced code is neither a heading nor a link', () => {
  const md = '# Title\n\n```yaml\n# not a heading\n[x](missing.md)\n```\n';
  assert.deepEqual(anchors(md), ['title']);
  assert.deepEqual(links(md), []);
});

test('every relative link and image in README.md and docs/*.md resolves', async () => {
  for (const page of await pages()) {
    const md = await fs.readFile(page, 'utf8');
    for (const target of links(md)) {
      const [file = '', anchor] = target.split('#');
      const targetPage = file === '' ? page : path.resolve(path.dirname(page), decodeURI(file));
      const exists = await fs.stat(targetPage).then(() => true, () => false);
      assert.ok(exists, `${rel(page)}: ${target} points to a missing file`);
      if (anchor !== undefined && anchor !== '') {
        const targetMd = targetPage === page ? md : await fs.readFile(targetPage, 'utf8');
        assert.ok(anchors(targetMd).includes(anchor), `${rel(page)}: ${target} points to a missing anchor`);
      }
    }
  }
});

test('the README is the newcomer path', async () => {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const h2 = [...stripFences(readme).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(h2, ['What you need', 'Quick start', 'A run, stop by stop', 'Where next']);
  const opening = readme.split('\n').find((l) => l.startsWith('Percolator is'));
  assert.ok(opening !== undefined, 'README.md has an opening paragraph starting "Percolator is"');
  assert.doesNotMatch(opening, /router|triage|trigger|perc watch|fan[- ]out|slice|inputs/i);
});

test('the README links every docs page', async () => {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  for (const page of DOCS_PAGES)
    assert.ok(links(readme).some((l) => l.split('#')[0] === `docs/${page}.md`), `README.md links docs/${page}.md`);
});
