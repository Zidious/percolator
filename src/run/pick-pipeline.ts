import type { PipelineSpec } from '../config/pipelines.ts';
import type { Issue } from '../tracker/gh.ts';

const LABEL = 'pipeline:';
const COMMAND = /^\/percolator run ([a-z][a-z0-9-]*)\s*$/m;

/**
 * The pipeline a run starts on: `--pipeline`, else a `pipeline:<name>` label on the issue, else the
 * latest `/percolator run <name>` comment by an approver, else the profile's default. A name the issue
 * asks for must be one the profile defines; the flag is checked by validate.
 */
export function pipelineFor(o: {
  flag?: string;
  issue?: Issue;
  /** the ticket, as errors show it */
  ref?: string;
  approvers: string[];
  specs: Record<string, PipelineSpec>;
  defaultName: string;
  profile: string;
}): { name: string; by: 'flag' | 'label' | 'comment' | 'default' } {
  if (o.flag !== undefined) return { name: o.flag, by: 'flag' };
  const known = (name: string, why: string): string => {
    if (Object.hasOwn(o.specs, name)) return name;
    throw new Error(
      `issue ${o.ref ?? o.issue?.url} asks for pipeline "${name}" (${why}), which profile "${o.profile}" does not define (pipelines: ${Object.keys(o.specs).join(', ')}); fix it or pass --pipeline`,
    );
  };
  const label = o.issue?.labels.find((l) => l.startsWith(LABEL));
  if (label !== undefined) return { name: known(label.slice(LABEL.length), `label ${label}`), by: 'label' };
  const approvers = new Set(o.approvers.map((a) => a.toLowerCase()));
  const latestFirst = (o.issue?.comments ?? [])
    .filter((c) => approvers.has(c.author.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const c of latestFirst) {
    const m = COMMAND.exec(c.body.replace(/\r\n/g, '\n'));
    if (m) return { name: known(m[1]!, `comment ${c.url}`), by: 'comment' };
  }
  return { name: o.defaultName, by: 'default' };
}
