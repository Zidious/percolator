import type { NodeDef } from '../config/schema.ts';

export type LaunchSpec = {
  model?: string;
  effort?: string;
  pluginDirs: string[];
  addDirs: string[];
  /** The program for the generic `command` agent. */
  command?: string[];
  message: string;
};

export type AgentAdapter = {
  name: string;
  /** The agent loads skills itself (from plugins); otherwise they are read from SKILL.md files. */
  nativeSkills: boolean;
  /** The agent accepts plugin directories. */
  plugins: boolean;
  /** The agent accepts an effort level. */
  effort: boolean;
  argv(s: LaunchSpec): string[];
  /** Problems with an agent step's config only this agent has rules for; `key` is the offending key under the step. */
  check?(def: NodeDef): { message: string; key?: string }[];
};
