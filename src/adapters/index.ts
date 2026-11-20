import type { AgentAdapter } from './types.ts';

export type { AgentAdapter, LaunchSpec } from './types.ts';

export const ADAPTERS: Readonly<Record<'claude' | 'codex' | 'command', AgentAdapter>> = Object.freeze({
  claude: {
    name: 'claude',
    nativeSkills: true,
    plugins: true,
    argv: (s) => [
      'claude',
      ...(s.model ? ['--model', s.model] : []),
      ...s.pluginDirs.flatMap((d) => ['--plugin-dir', d]),
      ...s.addDirs.flatMap((d) => ['--add-dir', d]),
      '--',
      s.message,
    ],
  },
  codex: {
    name: 'codex',
    nativeSkills: false,
    plugins: false,
    // Unverified, because codex is not installed on the dev machine (Task 22 `--codex` smoke, 2026-11-20):
    // whether `--add-dir` exists, and whether hc can launch the Windows `.cmd` shim. If hc reports
    // `spawn_failed ... not found on PATH`, codex is missing or hc cannot run its shim.
    argv: (s) => [
      'codex',
      '--no-daemon',
      ...(s.model ? ['--model', s.model] : []),
      ...s.addDirs.flatMap((d) => ['--add-dir', d]),
      '--',
      s.message,
    ],
  },
  command: {
    name: 'command',
    nativeSkills: false,
    plugins: false,
    // No `--`: the generic CLI's argument parsing is unknown.
    argv: (s) => [...(s.command ?? []), s.message],
  },
});
