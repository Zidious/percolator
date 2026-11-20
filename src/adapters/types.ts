export type LaunchSpec = {
  model?: string;
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
  argv(s: LaunchSpec): string[];
};
