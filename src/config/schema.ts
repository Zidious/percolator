import { z } from 'zod';
import { BUILTIN_NAMES } from '../tracker/index.ts';

export const STAGES = ['intake', 'groom', 'plan', 'implement', 'review', 'deliver'] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

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

const StageOrAllSchema = z.enum([...STAGES, 'all']);

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
      .describe("Reasoning effort for the agent (agent nodes only); default the agent's own."),
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
        "Task prompt for an agent node: inline text, or { from: <ground>, file: … }; {run_id}, {worktree} and the other task variables are filled in; default: carry out the stage contract (bindings) or the node's purpose (hooks).",
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
        back_to: StageSchema.describe('Earlier stage the run loops back to when this node fails.'),
        max_rounds: z.number().int().min(1).describe('Most rounds the loop may run before escalating to you; required.'),
      })
      .optional()
      .describe('Bounded back-edge: on fail, loop back to an earlier stage, up to max_rounds times.'),
    max_rounds: z.number().int().min(1).optional().describe(
      'Round cap for the review loop, read from the last node bound to review; default 3.',
    ),
    timeout_s: z
      .number()
      .positive()
      .optional()
      .describe('Escalate to you if the step is not done after this many seconds; default no timeout.'),
    escalation: z.boolean().optional().describe('Accepted but not used yet; has no effect.'),
    required: z
      .boolean()
      .optional()
      .describe('Locks the node (in bindings, the whole stage binding): later layers may only restate it unchanged; default false.'),
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
          .union([StageSchema, z.literal('*')])
          .describe('Stage whose agent nodes must load the skills, or * for every stage; a named stage must be bound to an agent node.'),
        skills: z.array(z.string()).describe('Skills each agent node in that stage must load.'),
      }),
    )
    .optional()
    .describe('Skills that agent nodes in a stage must load.'),
  allowed_agents: z.array(z.string()).optional().describe('Agents nodes may use; default any agent.'),
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

// Node names become step ids (`stage.i` uses "."), so they are plain identifiers; a leading letter
// also keeps integer-like keys from reordering in JS objects.
const NODE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const NodesSchema = z
  .record(z.string(), NodeDefSchema.describe('One named node: a hook (with before/after), a gate or a node rules require.'))
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

const graphFragmentShape = {
  bindings: z
    .partialRecord(StageSchema, BindingSchema.describe('The node that runs this stage, or a list of nodes run in order.'))
    .optional()
    .describe('What runs each core stage (intake, groom, plan, implement, review, deliver); all six must be bound.'),
  nodes: NodesSchema.optional().describe('Extra nodes by name: hooks, gates and nodes required by rules.'),
  rules: RulesSchema.optional().describe('Checks on the merged graph; rules from every layer all apply.'),
  use: z
    .array(MappingSchema)
    .optional()
    .describe('Files or dirs from grounds mapped into the run as policy, context, skills, plugins, prompt or graph.'),
};

export const GraphFragmentSchema = z.strictObject(graphFragmentShape);
export type GraphFragment = z.infer<typeof GraphFragmentSchema>;

const stringOrList = z.union([z.string(), z.array(z.string())]);

export const ProfileSchema = z.strictObject({
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
    .record(z.string(), ProfileSchema.describe('One profile: the graph, tracker and runtime settings for the repos it matches.'))
    .describe('Named profiles; the first whose match fits the repo wins, or pick one with --profile.'),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
