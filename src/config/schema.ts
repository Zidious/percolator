import { z } from 'zod';

export const STAGES = ['intake', 'groom', 'plan', 'implement', 'review', 'deliver'] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const GroundSpecSchema = z.union([
  z.strictObject({ git: z.string(), ref: z.string() }),
  z.strictObject({ path: z.string() }),
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
export const GroundsSchema = groundRecord(GroundSpecSchema);

export const MappingKindSchema = z.enum(['policy', 'context', 'skills', 'plugins', 'prompt', 'graph']);
export type MappingKind = z.infer<typeof MappingKindSchema>;

export const MappingSchema = z
  .strictObject({
    from: z.string(),
    file: z.string().optional(),
    dir: z.string().optional(),
    as: MappingKindSchema,
    applies_to: z.array(z.string()).default(['*']),
    required: z.boolean().default(false),
  })
  .refine((m) => (m.file === undefined) !== (m.dir === undefined), {
    message: 'exactly one of "file" or "dir" is required',
  });
export type Mapping = z.infer<typeof MappingSchema>;

const StageOrAllSchema = z.enum([...STAGES, 'all']);

const AGENT_ONLY = ['agent', 'model', 'skill', 'skills'] as const;

export const NodeDefSchema = z
  .strictObject({
    kind: z.enum(['agent', 'builtin', 'script', 'gate']).optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    skill: z.string().optional(),
    skills: z.array(z.string()).optional(),
    prompt: z.union([z.string(), z.strictObject({ from: z.string(), file: z.string() })]).optional(),
    builtin: z.string().optional(),
    command: z.array(z.string()).optional(),
    before: StageOrAllSchema.optional(),
    after: StageOrAllSchema.optional(),
    once: z.boolean().optional(),
    on_fail: z.strictObject({ back_to: StageSchema, max_rounds: z.number().int().min(1) }).optional(),
    max_rounds: z.number().int().min(1).optional(),
    timeout_s: z.number().positive().optional(),
    escalation: z.boolean().optional(),
    required: z.boolean().optional(),
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
  .strictObject({ name: z.string(), before: StageOrAllSchema.optional(), after: StageOrAllSchema.optional() })
  .refine((r) => (r.before === undefined) !== (r.after === undefined), {
    message: 'exactly one of "before" or "after" is required',
  });

export const RulesSchema = z.strictObject({
  require_skills: z
    .array(z.strictObject({ stage: z.union([StageSchema, z.literal('*')]), skills: z.array(z.string()) }))
    .optional(),
  allowed_agents: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  max_rounds_ceiling: z.number().int().min(1).optional(),
  required_nodes: z.array(z.union([z.string(), RequiredNodeSchema])).optional(),
});
export type Rules = z.infer<typeof RulesSchema>;

// Node names become step ids (`stage.i` uses "."), so they are plain identifiers; a leading letter
// also keeps integer-like keys from reordering in JS objects.
const NODE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const NodesSchema = z.record(z.string(), NodeDefSchema).superRefine((nodes, ctx) => {
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
  bindings: z.partialRecord(StageSchema, BindingSchema).optional(),
  nodes: NodesSchema.optional(),
  rules: RulesSchema.optional(),
  use: z.array(MappingSchema).optional(),
};

export const GraphFragmentSchema = z.strictObject(graphFragmentShape);
export type GraphFragment = z.infer<typeof GraphFragmentSchema>;

const stringOrList = z.union([z.string(), z.array(z.string())]);

export const ProfileSchema = z.strictObject({
  ...graphFragmentShape,
  match: z.strictObject({ remote: stringOrList.optional(), path: stringOrList.optional() }).optional(),
  tracker: z.strictObject({ kind: z.literal('github'), approvers: z.array(z.string()).optional() }).optional(),
  runtime: z
    .strictObject({
      worktree_root: z.string().optional(),
      base: z.string().optional(),
      keep_terminals: z.boolean().optional(),
      space: z.boolean().optional(),
    })
    .optional(),
  trust_repo_config: z.boolean().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  grounds: GroundsSchema.optional(),
  profiles: z.record(z.string(), ProfileSchema),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
