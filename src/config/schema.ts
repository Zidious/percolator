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
export const GroundsSchema = z.record(z.string(), GroundSpecSchema).superRefine((grounds, ctx) => {
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

export const RulesSchema = z.strictObject({
  require_skills: z
    .array(z.strictObject({ stage: z.union([StageSchema, z.literal('*')]), skills: z.array(z.string()) }))
    .optional(),
  allowed_agents: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  max_rounds_ceiling: z.number().int().min(1).optional(),
  required_nodes: z.array(z.string()).optional(),
});
export type Rules = z.infer<typeof RulesSchema>;

const graphFragmentShape = {
  bindings: z.partialRecord(StageSchema, BindingSchema).optional(),
  nodes: z.record(z.string(), NodeDefSchema).optional(),
  rules: RulesSchema.optional(),
};

export const GraphFragmentSchema = z.strictObject(graphFragmentShape);
export type GraphFragment = z.infer<typeof GraphFragmentSchema>;

const stringOrList = z.union([z.string(), z.array(z.string())]);

export const ProfileSchema = z.strictObject({
  ...graphFragmentShape,
  match: z.strictObject({ remote: stringOrList.optional(), path: stringOrList.optional() }).optional(),
  use: z.array(MappingSchema).optional(),
  tracker: z.strictObject({ kind: z.literal('github') }).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  grounds: GroundsSchema.optional(),
  profiles: z.record(z.string(), ProfileSchema),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
