import path from 'node:path';
import type { PipelineSpec } from '../config/pipelines.ts';
import { validateEach } from '../validate.ts';
import { toRunGraph } from './graph-file.ts';
import type { RunGraphLoop, RunGraphStep } from './graph-file.ts';

export type PipelineEntry = {
  name: string;
  default: boolean;
  router: boolean;
  ticket: PipelineSpec['ticket'];
  inputs: { name: string; required: boolean; description?: string }[];
  exit: string;
  description?: string;
  steps: RunGraphStep[];
  loops: RunGraphLoop[];
};

/** `perc pipelines --json`: the contract the panel's `readPipelines` reads. */
export type PipelinesJson = {
  schema: 1;
  repo: string;
  profile: string;
  pipelines: (PipelineEntry | { name: string; error: string })[];
};

/**
 * The repo's pipelines, the default first and then in config order. A pipeline that fails validation is
 * listed with its (first-line) error; a config-level error throws.
 */
export async function pipelinesJson(o: { repoDir: string; configFile: string; profile?: string; home: string }): Promise<PipelinesJson> {
  const repo = path.resolve(o.repoDir);
  const { profile, pipelines, results } = await validateEach({
    configFile: path.resolve(o.configFile),
    cwd: repo,
    home: o.home,
    ...(o.profile !== undefined ? { profile: o.profile } : {}),
  });
  const specs = Object.values(pipelines);
  const ordered = [...specs.filter((s) => s.default), ...specs.filter((s) => !s.default)];
  return {
    schema: 1,
    repo,
    profile,
    pipelines: ordered.map((spec) => {
      const r = results[spec.name]!;
      if (r instanceof Error) return { name: spec.name, error: r.message.split('\n')[0]! };
      const { steps, loops } = toRunGraph(r.graph);
      return {
        name: spec.name,
        default: spec.default,
        // another change adds `router:`; read it without depending on its type
        router: (spec as { router?: unknown }).router === true,
        ticket: spec.ticket,
        inputs: Object.entries(spec.inputs).map(([name, i]) => ({
          name,
          required: i.required,
          ...(i.description !== undefined ? { description: i.description } : {}),
        })),
        exit: r.graph.exit,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        steps,
        loops,
      };
    }),
  };
}

/** One line per pipeline: `<name>[ (default)]  ticket <mode>  exit <exit>  inputs <a, b|->`, or its error. */
export function pipelinesText(j: PipelinesJson): string {
  return j.pipelines
    .map((p) => {
      if ('error' in p) return `${p.name}  error ${p.error}\n`;
      const inputs = p.inputs.length > 0 ? p.inputs.map((i) => i.name).join(', ') : '-';
      return `${p.name}${p.default ? ' (default)' : ''}  ticket ${p.ticket}  exit ${p.exit}  inputs ${inputs}\n`;
    })
    .join('');
}
