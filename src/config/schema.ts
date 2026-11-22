import { z } from 'zod';
import { BUILTIN_NAMES, EXIT_KINDS } from '../tracker/index.ts';

/** The stages of the built-in feature pipeline, in order. */
export const STAGES = ['intake', 'groom', 'plan', 'implement', 'review', 'deliver'] as const;
export const StageSchema = z.enum(STAGES);
export type FeatureStage = z.infer<typeof StageSchema>;
/** A stage of some pipeline: the feature stages, or any stage a pipeline lists. */
export type Stage = string;

// Node and stage names become step ids (`stage.i` uses "."), so they are plain identifiers; a leading
// letter also keeps integer-like keys from reordering in JS objects.
const NODE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const STAGE_NAME = NODE_NAME;
export const PIPELINE_NAME = /^[a-z][a-z0-9-]{0,23}$/;
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/;

const StageNameSchema = z
  .string()
  .regex(STAGE_NAME, { message: `stage names start with a letter and contain only letters, digits, "_" and "-" (like ${STAGES.join(', ')})` });

export const GroundSpecSchema = z.union([
  z.strictObject({
    git: z.string().describe('URL of the git repo the ground is cloned from.'),
    ref: z.string().describe('Branch, tag or commit to use; perc validate pins it to a commit in percolator.lock.'),
  }),
  z.strictObject({ path: z.string().describe('Local directory used as the ground; ~ is expanded.') }),
]);
export type GroundSpec = z.infer<typeof GroundSpecSchema>;

// Ground names become cache directory names, so they must be safe path components.
// Checked with superRefine rather than a key schema, so the message names the offending key.
const GROUND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Record of anything keyed by ground name (config grounds, lock entries). */
export function groundRecord<T extends z.ZodType>(value: T) {
  return z.record(z.string(), value).superRefine((grounds, ctx) => {
    for (const name of Object.keys(grounds)) {
      if (!GROUND_NAME.test(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'ground names must start with a letter or digit and contain only letters, digits, ".", "_" and "-"',
        });
      }
    }
  });
}
export const GroundsSchema = groundRecord(
  GroundSpecSchema.describe('One ground: a git repo at a ref ({ git, ref }) or a local path ({ path }).'),
);

export const MappingKindSchema = z.enum(['policy', 'context', 'skills', 'plugins', 'prompt', 'graph']);
export type MappingKind = z.infer<typeof MappingKindSchema>;

export const MappingSchema = z
  .strictObject({
    from: z.string().describe('Name of the ground (under grounds) the file or dir comes from.'),
    file: z.string().optional().describe('File inside the ground to map; exactly one of file or dir.'),
    dir: z.string().optional().describe('Directory inside the ground to map; exactly one of file or dir.'),
    as: MappingKindSchema.describe(
      'What the mapping is: policy (binding rules), context (reference), skills, plugins, prompt (accepted but not used yet; has no effect), or graph (a config fragment layer).',
    ),
    applies_to: z
      .array(z.string())
      .default(['*'])
      .describe('Stages or node names the mapping applies to; default all stages (["*"]).'),
    required: z
      .boolean()
      .default(false)
      .describe('Locks the mapping: later layers may only restate it unchanged; default false.'),
  })
  .refine((m) => (m.file === undefined) !== (m.dir === undefined), {
    message: 'exactly one of "file" or "dir" is required',
  });
export type Mapping = z.infer<typeof MappingSchema>;

const StageOrAllSchema = z.string().refine((v) => v === 'all' || STAGE_NAME.test(v), {
  message: `expected a stage of the pipeline (like ${STAGES.join(', ')}) or all`,
});

const AGENT_ONLY = ['agent', 'model', 'skill', 'skills', 'effort'] as const;

export const NodeDefSchema = z
  .strictObject({
    kind: z
      .enum(['agent', 'builtin', 'script', 'gate'])
      .optional()
      .describe('agent, builtin, script or gate; inferred from agent, builtin or command when left out.'),
    agent: z.string().optional().describe('Which agent runs the step (agent nodes only).'),
    model: z.string().optional().describe("Model the agent uses (agent nodes only); default the agent's own."),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe("Reasoning effort for the agent (agent nodes only, claude only); default the agent's own."),
    skill: z.string().optional().describe('One skill the agent loads (agent nodes only).'),
    skills: z.array(z.string()).optional().describe('Skills the agent loads (agent nodes only).'),
    prompt: z
      .union([
        z.string(),
        z.strictObject({
          from: z.string().describe('Name of the ground the prompt file comes from.'),
          file: z.string().describe('Prompt file inside the ground.'),
        }),
      ])
      .optional()
      .describe(
        "Task prompt for an agent node: inline text, or { from: <ground>, file: … }; {{run_id}}, {{worktree}} and the other task variables are filled in; default: carry out the stage contract (bindings) or the node's purpose (hooks).",
      ),
    builtin: z.string().optional().describe(`Builtin to run: ${BUILTIN_NAMES.join(' or ')} (builtin nodes).`),
    command: z
      .array(z.string())
      .optional()
      .describe(
        'Argv array, never a shell string: the script for a script node ({run_dir}, {outputs_dir}, {worktree} filled in), or the program for agent: command.',
      ),
    before: StageOrAllSchema.optional().describe(
      'Hook point: run this node before a stage, or before all; at most one of before/after.',
    ),
    after: StageOrAllSchema.optional().describe(
      'Hook point: run this node after a stage, or after all; at most one of before/after.',
    ),
    once: z
      .boolean()
      .optional()
      .describe('Skip the hook once it has passed in this run, so a loop does not re-run it; default false.'),
    on_fail: z
      .strictObject({
        back_to: StageNameSchema.describe('Earlier stage the run loops back to when this node fails.'),
        max_rounds: z
          .number()
          .int()
          .min(1)
          .describe('Failed rounds allowed before escalating to you, the first run counts; 1 escalates on the first fail; required.'),
      })
      .optional()
      .describe('Bounded back-edge: on fail, loop back to an earlier stage until max_rounds rounds have failed (the first run counts).'),
    max_rounds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Round cap for the review loop, read from the last node bound to review; default 3.'),
    timeout_s: z
      .number()
      .positive()
      .optional()
      .describe('Escalate to you if the step is not done after this many seconds (agent and script nodes only); default no timeout.'),
    when_output: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'expected an output key like issues')
      .optional()
      .describe('Gate nodes only: stop only when an earlier step wrote this output (like issues); otherwise pass at once. Default always stop.'),
    escalation: z.boolean().optional().describe('Accepted but not used yet; has no effect.'),
    required: z
      .boolean()
      .optional()
      .describe(
        'Locks the node (in bindings, the whole stage binding): later layers may only restate it unchanged; default false.',
      ),
  })
  .superRefine((n, ctx) => {
    if (n.before !== undefined && n.after !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'at most one of "before" or "after" may be set' });
    }
    if (n.kind === undefined && n.agent === undefined && n.builtin === undefined && n.command === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'node needs "kind", or one of "agent", "builtin" or "command" to infer it',
      });
      return;
    }
    // Agent-only fields on another kind would satisfy allowed_*/require_skills without ever running an agent.
    const kind = effectiveKind(n);
    if (n.when_output !== undefined && kind !== 'gate') {
      ctx.addIssue({
        code: 'custom',
        path: ['when_output'],
        message: `"when_output" only applies to gate nodes (this node is kind "${kind}")`,
      });
    }
    if (kind === 'agent') {
      if (n.agent === undefined) {
        ctx.addIssue({ code: 'custom', message: 'agent nodes need "agent" (which agent runs this node)' });
      }
      return;
    }
    for (const field of AGENT_ONLY) {
      if (n[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `"${field}" only applies to agent nodes (this node is kind "${kind}")`,
        });
      }
    }
  });
export type NodeDef = z.infer<typeof NodeDefSchema>;

export function effectiveKind(n: NodeDef): 'agent' | 'builtin' | 'script' | 'gate' {
  if (n.kind !== undefined) return n.kind;
  if (n.agent !== undefined) return 'agent';
  if (n.builtin !== undefined) return 'builtin';
  if (n.command !== undefined) return 'script';
  throw new Error('node has no kind and none can be inferred');
}

export const BindingSchema = z.union([NodeDefSchema, z.array(NodeDefSchema)]);
export type Binding = z.infer<typeof BindingSchema>;

const RequiredNodeSchema = z
  .strictObject({
    name: z.string().describe('Name of the node that must exist.'),
    before: StageOrAllSchema.optional().describe(
      'The node must be attached before this stage (or all); exactly one of before/after.',
    ),
    after: StageOrAllSchema.optional().describe(
      'The node must be attached after this stage (or all); exactly one of before/after.',
    ),
  })
  .refine((r) => (r.before === undefined) !== (r.after === undefined), {
    message: 'exactly one of "before" or "after" is required',
  });

export const RulesSchema = z.strictObject({
  require_skills: z
    .array(
      z.strictObject({
        stage: z
          .union([z.literal('*'), StageNameSchema])
          .describe(
            'Stage whose agent nodes must load the skills, or * for every stage; a named stage must be bound to an agent node.',
          ),
        skills: z.array(z.string()).describe('Skills each agent node in that stage must load.'),
      }),
    )
    .optional()
    .describe('Skills that agent nodes in a stage must load.'),
  allowed_agents: z.array(z.string()).optional().describe('Agents that agent nodes may use; default any agent.'),
  allowed_models: z.array(z.string()).optional().describe(
    'Models agent nodes may use; when set, every agent node must name one of them; default any model.',
  ),
  max_rounds_ceiling: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Highest round cap allowed for the review loop and on_fail back-edges; default no ceiling.'),
  required_nodes: z
    .array(z.union([z.string(), RequiredNodeSchema]))
    .optional()
    .describe('Nodes that must be defined: a name, or { name, before | after } to also fix where it attaches.'),
});
export type Rules = z.infer<typeof RulesSchema>;

export const NodesSchema = z
  .record(
    z.string(),
    NodeDefSchema.describe('One named node: a hook (with before/after), a gate or a node rules require.'),
  )
  .superRefine((nodes, ctx) => {
    for (const name of Object.keys(nodes)) {
      if (!NODE_NAME.test(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'node names must start with a letter and contain only letters, digits, "_" and "-"',
        });
      }
    }
  });

function namedRecord<T extends z.ZodType>(value: T, name: RegExp, message: string) {
  return z.record(z.string(), value).superRefine((rec, ctx) => {
    for (const key of Object.keys(rec)) if (!name.test(key)) ctx.addIssue({ code: 'custom', path: [key], message });
  });
}

export const PipelineInputSchema = z.strictObject({
  required: z.boolean().default(false).describe('The run cannot start without this input; default false.'),
  description: z.string().optional().describe('What the input is; shown as the field hint when starting a run.'),
});

/** What starts a run of a pipeline from perc watch: one of five shapes, told apart by their key. */
export const TriggerSchema = z.union([
  z
    .strictObject({
      schedule: z.string().describe('Cron expression (minute hour day-of-month month day-of-week) of when a ticketless run starts.'),
      timezone: z.string().optional().describe('IANA time zone the schedule is read in, like Europe/London; default the time zone of the machine running perc watch.'),
      inputs: z.record(z.string(), z.string().describe('Value of the input.')).optional().describe('Inputs each scheduled run gets.'),
    })
    .describe('Start a ticketless run on a cron schedule.'),
  z
    .strictObject({ label: z.string().describe('Issue label that starts a run on the issue.') })
    .describe('Start a run on each issue that gets this label.'),
  z
    .strictObject({
      pr_opened: z
        .union([
          z.literal(true),
          z.strictObject({
            not_author: z.array(z.string()).optional().describe('GitHub logins whose pull requests are skipped.'),
          }),
        ])
        .describe('true, or { not_author } to skip some authors; the run gets the PR as input pr.'),
    })
    .describe('Start a run on each pull request opened.'),
  z
    .strictObject({ dependabot: z.literal(true).describe('true; the run gets the PR as input pr.') })
    .describe('Start a run on each Dependabot pull request.'),
  z
    .strictObject({
      check_failed: z
        .strictObject({
          branch: z.string().describe('Branch whose failed checks start a run.'),
          workflow: z.string().optional().describe('Only failures of this workflow (its file name); default any workflow.'),
        })
        .describe('Which failed check runs start a run; the run gets inputs branch and run_url.'),
    })
    .describe('Start a run when a check fails on a branch.'),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const PipelineSchema = z.strictObject({
  default: z
    .boolean()
    .optional()
    .describe("This is the profile's default pipeline; at most one per profile; default: feature."),
  description: z.string().optional().describe('What the pipeline is for; shown when picking a pipeline.'),
  stages: z
    .array(StageNameSchema)
    .min(1)
    .optional()
    .describe('Ordered stage names; the first must be intake and the last is the exit stage; only feature may leave it out.'),
  outputs: z
    .record(z.string(), z.array(z.string()).describe('Output keys the stage must write (<key>.md in its outputs directory).'))
    .optional()
    .describe('Output keys each stage must write (stage → keys); a stage left out requires none, unless it is a feature stage.'),
  exit: z
    .enum(EXIT_KINDS)
    .optional()
    .describe(`How the pipeline ends: ${EXIT_KINDS.join(', ')}; runs the matching builtin on the last stage when it is unbound.`),
  ticket: z
    .enum(['required', 'optional', 'none'])
    .optional()
    .describe('Whether a run needs a ticket (an issue): required, optional or none; default required.'),
  inputs: namedRecord(
    PipelineInputSchema.describe('One named input: perc run --input <name>=<value>.'),
    INPUT_NAME,
    'input names must start with a lower-case letter and contain only a-z, 0-9 and "_"',
  )
    .optional()
    .describe('Named values a run takes (perc run --input key=value), available to prompts as {{input_<name>}}.'),
  router: z
    .boolean()
    .optional()
    .describe('This pipeline is a triage router: its last stage, route, hands the ticket to another pipeline; default false.'),
  routes: z
    .array(
      z
        .strictObject({
          label: z.string().describe('Issue label that picks the pipeline.'),
          to: z.string().describe('Pipeline the ticket goes to when the issue has the label.'),
        })
        .describe('One rule: an issue with this label goes to this pipeline.'),
    )
    .optional()
    .describe('Router only: label rules tried in order before the choose agent; the first match wins.'),
  choose: z
    .strictObject({
      agent: z.string().describe('Which agent picks the pipeline.'),
      model: z.string().optional().describe("Model the agent uses; default the agent's own."),
      effort: z
        .enum(['low', 'medium', 'high', 'xhigh', 'max'])
        .optional()
        .describe("Reasoning effort for the agent (claude only); default the agent's own."),
      skill: z.string().optional().describe('One skill the agent loads.'),
      skills: z.array(z.string()).optional().describe('Skills the agent loads.'),
      prompt: z
        .union([
          z.string(),
          z.strictObject({
            from: z.string().describe('Name of the ground the prompt file comes from.'),
            file: z.string().describe('Prompt file inside the ground.'),
          }),
        ])
        .optional()
        .describe('Task prompt for the agent; default: pick one of from and write pick.md (pipeline and whether it is unsure).'),
      from: z.array(z.string()).min(1).describe('Pipelines the agent may pick from.'),
      confirm: z
        .enum(['unsure', 'always'])
        .optional()
        .describe('When the pick-pipeline gate asks you to confirm the pick: unsure (only when the agent is unsure) or always; default unsure.'),
    })
    .optional()
    .describe('Router only: the agent that picks a pipeline when no label rule matched; without it the fallback applies.'),
  fallback: z
    .string()
    .optional()
    .describe("Router only: the pipeline used when nothing else picked one; default the profile's default pipeline, or feature when that is a router."),
  triggers: z
    .array(TriggerSchema)
    .optional()
    .describe('What starts runs of this pipeline while perc watch runs: schedule, label, pr_opened, dependabot or check_failed.'),
  fan_out: z
    .strictObject({
      stage: StageNameSchema.describe('Stage run once per slice, each in its own linked run; neither intake nor the exit stage.'),
      slices: z
        .strictObject({
          from: StageNameSchema.describe('Earlier stage that writes the slices.'),
          output: z.string().describe('Output key of that stage holding the slices: one "## <title>" section per slice.'),
        })
        .describe('Where the slices come from.'),
      max_parallel: z.number().int().min(1).optional().describe('Most slices running at once; default 3.'),
    })
    .optional()
    .describe('Run one stage, and every stage after it, once per slice in parallel linked runs; the run waits for them all.'),
  next: z
    .string()
    .optional()
    .describe('Issue exit only: the pipeline each opened issue starts a linked run of; default none (the issues just stay open).'),
  bindings: z
    .record(z.string(), BindingSchema.describe('The node that runs this stage, or a list of nodes run in order.'))
    .optional()
    .describe("What runs each of the pipeline's stages; after all layers merge, every stage must be bound."),
  nodes: NodesSchema.optional().describe('Extra nodes of this pipeline by name: hooks, gates and nodes required by rules.'),
  rules: RulesSchema.optional().describe('Checks on this pipeline only; top-level rules apply to every pipeline.'),
  use: z
    .array(MappingSchema)
    .optional()
    .describe("Files or dirs from grounds mapped into this pipeline's runs."),
  required: z
    .boolean()
    .optional()
    .describe("Locks the pipeline's settings (every key but bindings, nodes, rules and use): later layers may only restate them; default false."),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const PipelinesSchema = namedRecord(
  PipelineSchema.describe('One pipeline: its stages, what runs them, its inputs and how it ends.'),
  PIPELINE_NAME,
  'pipeline names must start with a lower-case letter and contain only a-z, 0-9 and "-" (at most 24 characters)',
);

const graphFragmentShape = {
  bindings: z
    .partialRecord(
      StageSchema,
      BindingSchema.describe('The node that runs this stage, or a list of nodes run in order.'),
    )
    .optional()
    .describe(
      'What runs each core stage (intake, groom, plan, implement, review, deliver); after all layers merge, every stage must be bound.',
    ),
  nodes: NodesSchema.optional().describe('Extra nodes by name: hooks, gates and nodes required by rules.'),
  rules: RulesSchema.optional().describe('Checks on the merged graph; rules from every layer all apply, to every pipeline.'),
  pipelines: PipelinesSchema.optional().describe(
    'Named pipelines: each its own stages, bindings, nodes, inputs and exit; top-level bindings and nodes belong to feature.',
  ),
  use: z
    .array(MappingSchema)
    .optional()
    .describe('Files or dirs from grounds mapped into the run as policy, context, skills, plugins, prompt or graph.'),
};

export const GraphFragmentSchema = z.strictObject(graphFragmentShape);
export type GraphFragment = z.infer<typeof GraphFragmentSchema>;

const stringOrList = z.union([z.string(), z.array(z.string())]);

export const ProfileSchema = z.strictObject({
  extends: z
    .string()
    .optional()
    .describe(
      "Another profile this one starts from: its bindings, nodes, rules and use come first as their own layer, and its tracker and runtime apply unless this profile sets them; match and trust_repo_config are never inherited; one level only.",
    ),
  ...graphFragmentShape,
  match: z
    .strictObject({
      remote: stringOrList.optional().describe("Glob or globs matched against the repo's remote URL."),
      path: stringOrList.optional().describe("Glob or globs matched against the repo's path; ~ is expanded."),
    })
    .optional()
    .describe('Which repos use this profile; the first matching profile wins; without it, only --profile picks it.'),
  tracker: z
    .strictObject({
      kind: z.literal('github').describe('Tracker type; only github.'),
      approvers: z
        .array(z.string())
        .optional()
        .describe('GitHub logins whose approve/reject comments count at a gate; default the gh user running perc.'),
    })
    .optional()
    .describe('Issue tracker used for tickets, gates and pull requests.'),
  runtime: z
    .strictObject({
      worktree_root: z.string().optional().describe(
        'Put worktrees under <root>/<repo>/; relative to the config file, ~ expanded; default <repo>/.worktrees.',
      ),
      base: z
        .string()
        .optional()
        .describe('Branch the run starts from and opens its PR against; detected from the repo when left out.'),
      keep_terminals: z.boolean().optional().describe('Keep step terminals open after they finish; default false.'),
      space: z.boolean().optional().describe('Create a Herdr space per run; default true (false skips it).'),
    })
    .optional()
    .describe('How runs are set up: worktrees, base branch, terminals and the Herdr space.'),
  trust_repo_config: z
    .boolean()
    .optional()
    .describe("Load the repo's own config file as the last layer; default false (refused)."),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UserConfigSchema = z.strictObject({
  version: z.literal(1).describe('Config format version; must be 1.'),
  grounds: GroundsSchema.optional().describe(
    'Named sources of policies, skills, prompts and graph fragments: git repos or local paths.',
  ),
  profiles: z
    .record(
      z.string(),
      ProfileSchema.describe('One profile: the graph, tracker and runtime settings for the repos it matches.'),
    )
    .describe('Named profiles; the first whose match fits the repo wins, or pick one with --profile.'),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
