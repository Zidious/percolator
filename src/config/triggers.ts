import type { Trigger } from './schema.ts';

/** The trigger kinds `perc watch` polls, as a trigger's config key names them. */
export const TRIGGER_KINDS = ['schedule', 'label', 'pr_opened', 'dependabot', 'check_failed'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The trigger config of one kind. */
export type TriggerOf<K extends TriggerKind> = Extract<Trigger, Record<K, unknown>>;

/** A handler for every trigger kind, each given its own kind's config. */
export type TriggerHandlers<R> = { [K in TriggerKind]: (t: TriggerOf<K>) => R };

/** Which kind a trigger is: the config key it sets. */
export function triggerKind(t: Trigger): TriggerKind {
  if ('schedule' in t) return 'schedule';
  if ('label' in t) return 'label';
  if ('pr_opened' in t) return 'pr_opened';
  if ('dependabot' in t) return 'dependabot';
  if ('check_failed' in t) return 'check_failed';
  const none: never = t;
  throw new Error(`unknown trigger ${JSON.stringify(none)}`);
}

/**
 * Runs the handler of `t`'s kind. Everything that treats trigger kinds differently goes through here, so a new
 * kind (added to the schema and TRIGGER_KINDS) is a typecheck error wherever it has no handler yet.
 */
export function onTrigger<R>(t: Trigger, handlers: TriggerHandlers<R>): R {
  return (handlers[triggerKind(t)] as (t: Trigger) => R)(t);
}
