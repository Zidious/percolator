import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DriverDeps } from '../../src/run/prepare.ts';
import { FakeHerdrApp } from './fake-app.ts';
import { FakeGh } from './fake-gh.ts';
import { FakeHc } from './fake-hc.ts';
import { git, makeRepo } from './git-repo.ts';

export const NOW = new Date('2026-03-04T05:06:07Z');
export const ENTRY = path.resolve('/opt/perc/dist/cli.js');

/** Every stage bound to a script (`echo <stage>`) plus the github builtins. */
export const SCRIPT_BINDINGS = [
  '      intake: { builtin: github.intake }',
  '      groom: { command: [echo, groom] }',
  '      plan: { command: [echo, plan] }',
  '      implement: { command: [echo, implement] }',
  '      review: { command: [echo, review] }',
  '      deliver: { builtin: github.open_pr }',
];

export type RunEnv = {
  root: string;
  home: string;
  /** absolute path of the bare repo behind `origin` */
  bare: string;
  configFile: string;
  deps: DriverDeps & { hc: FakeHc; app: FakeHerdrApp; gh: FakeGh };
  /** rewrite the config: profile `work` with `bindings` (lines under `bindings:`) and `extra` profile lines */
  writeConfig(extra?: string, bindings?: string[]): Promise<void>;
  cleanup(): Promise<void>;
};

/**
 * A repo whose origin url is `github.com/o/r.git`: a relative path to a bare repo inside the clone,
 * so `normalizeRemote` gives `github.com/o/r` and `git fetch origin` still works offline from the clone.
 * A `pushInsteadOf` maps that url to the bare repo's absolute path, so a push from a worktree (another cwd)
 * reaches it too; `git remote get-url origin` is unaffected.
 */
export async function setupRunEnv(o: { hc?: FakeHc; gh?: FakeGh; bindings?: string[]; extra?: string } = {}): Promise<RunEnv> {
  const repo = await makeRepo();
  const bare = path.join(repo.root, 'github.com', 'o', 'r.git');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await fs.rename(repo.origin, bare);
  await git(repo.root, 'remote', 'set-url', 'origin', 'github.com/o/r.git');
  await git(repo.root, 'config', `url.${bare}.pushInsteadOf`, 'github.com/o/r.git');
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perc-home-')));
  const cfgDir = path.join(home, 'cfg');
  await fs.mkdir(path.join(cfgDir, 'team', 'policies'), { recursive: true });
  await fs.writeFile(path.join(cfgDir, 'team', 'policies', 'sdlc.md'), 'be careful\n');
  const configFile = path.join(cfgDir, 'config.yaml');
  const writeConfig = (extra = o.extra ?? '', bindings = o.bindings ?? SCRIPT_BINDINGS) =>
    fs.writeFile(
      configFile,
      [
        'version: 1',
        'grounds:',
        '  team: { path: ./team }',
        'profiles:',
        '  work:',
        '    use:',
        '      - { from: team, file: policies/sdlc.md, as: policy }',
        '    bindings:',
        ...bindings,
        extra,
        '',
      ].join('\n'),
    );
  await writeConfig();
  const deps = {
    hc: o.hc ?? new FakeHc(),
    app: new FakeHerdrApp(),
    gh: o.gh ?? new FakeGh(),
    home,
    now: () => NOW,
    out: () => {},
    entry: ENTRY,
  };
  return {
    root: repo.root,
    home,
    bare,
    configFile,
    deps,
    writeConfig,
    cleanup: async () => {
      await repo.cleanup();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
