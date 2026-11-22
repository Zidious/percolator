import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepHandler } from '../../runtime/herdr-runtime.ts';
import { collectOutputs } from '../../runtime/outcome.ts';
import { writeFileAtomic } from '../../util/fs.ts';
import { splitSections } from '../../util/sections.ts';
import type { Gh } from '../gh.ts';
import { formatTicket, parseTicket } from '../ticket.ts';
import { escalate, latestOutput } from './latest.ts';

/** The issues a run opened, from its `issue_urls` output; `ref` is the `formatTicket` form, lines that are not issue URLs are skipped. */
export function openedIssues(text: string): { ref: string; url: string }[] {
  const out: { ref: string; url: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    try {
      out.push({ ref: formatTicket(parseTicket(url)), url });
    } catch {
      // not an issue URL
    }
  }
  return out;
}

type Created = Record<string, string>;

/** Every `created.json` of this step's attempts, earliest first, merged. */
async function readCreated(stepRoot: string): Promise<Created> {
  let names: string[];
  try {
    names = await fs.readdir(stepRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const merged: Created = {};
  for (const a of names.filter((n) => /^\d+$/.test(n)).sort((x, y) => Number(x) - Number(y))) {
    try {
      Object.assign(merged, JSON.parse(await fs.readFile(path.join(stepRoot, a, 'created.json'), 'utf8')) as Created);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return merged;
}

/**
 * The `issue` exit: opens one issue per `## ` section of the latest `issues` output; with no drafts it passes
 * and opens nothing. Each issue carries a marker and is recorded in `created.json`, so a resume reuses it.
 */
export function githubOpenIssues(o: { gh: Gh; runDir: string; runId: string; repo: string }): StepHandler {
  return async (_step, ctx, io) => {
    try {
      const text = await latestOutput(ctx, o.runDir, 'issues');
      const items = text === undefined ? [] : splitSections(text);
      if (items.length === 0) return { status: 'pass', outputs: {} };

      await fs.mkdir(io.outputsDir, { recursive: true });
      const createdFile = path.join(io.stepDir, 'created.json');
      const created = await readCreated(path.dirname(io.stepDir));
      const urls: string[] = [];
      for (const [k, item] of items.entries()) {
        const n = String(k + 1);
        let url: string | undefined = created[n];
        if (!url) {
          // a crash between create and record leaves the issue unrecorded: find it by its marker first
          const search = `percolator:issue run=${o.runId} n=${n}`;
          const marker = `<!-- ${search} -->`;
          url = (await o.gh.findIssues(o.repo, search)).find((i) => i.body.includes(marker))?.url;
          if (!url) {
            const bodyFile = path.join(io.stepDir, `issue-${n}.md`);
            await writeFileAtomic(bodyFile, `${item.body}\n\n${marker}\n`);
            url = await o.gh.createIssue(o.repo, { title: item.title, bodyFile });
          }
        }
        created[n] = url;
        await writeFileAtomic(createdFile, `${JSON.stringify(created, null, 2)}\n`);
        urls.push(url);
      }
      await writeFileAtomic(path.join(io.outputsDir, 'issue_urls.md'), `${urls.join('\n')}\n`);
      const collected = await collectOutputs(io.outputsDir, o.runDir);
      if ('error' in collected) return escalate(`github.open_issues: ${collected.error}`);
      return { status: 'pass', outputs: collected.outputs };
    } catch (err) {
      return escalate(`github.open_issues: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
