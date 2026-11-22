// Manual scenarios for the percolator-config skill. Not part of `pnpm test`.
//   node tests/smoke/skill.smoke.ts [--from <config>] [--only A,C]   build sandboxes and print the agent prompts
//   node tests/smoke/skill.smoke.ts --verify <root>                    check the real config and lock were not touched
// Each scenario gets its own home with a copy of the config (default ~/.percolator/config.yaml, or none for a
// fresh setup), its lock and the grounds cache, and a perc.mjs that runs this checkout's perc with HOME and
// USERPROFILE pointed at that home, so `~` never reaches the real ~/.percolator. Give each prompt.md to a fresh
// agent, then compare its report: did it ask what it should, edit only what was asked, and need no source code?
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMap, isScalar, parseDocument } from 'yaml';
import { expandHome } from '../../src/util/paths.ts';

type Scenario = { id: string; request: string; fresh?: boolean; files?: Record<string, string> };

const SCENARIOS: Scenario[] = [
  { id: 'A', request: 'Can you make plan use sonnet instead of opus, and let alice-dev and me approve runs?' },
  { id: 'B', request: 'After implement, run `pnpm test`. If the tests fail, send it back to implement, but give up after 2 tries.' },
  {
    id: 'C',
    request:
      'I also work on repos under github.com/acme/*. For those, use codex with model gpt-5.5 for implement, and only bob-acme can approve. Keep everything else the same as my normal setup.',
  },
  {
    id: 'D',
    request: 'I keep my security rules in ~/src/policies/security.md. Make implement and review follow them, and make sure nobody can quietly drop that.',
    files: { 'src/policies/security.md': '# Security\n- Never log secrets.\n- Validate all external input.\n' },
  },
  { id: 'E', fresh: true, request: "Set me up with Percolator. I want reviews to be cheaper, and I'd rather the groom step not use opus." },
  { id: 'F', request: "I'm sick of approving every single groom, just turn the approval off. Also let review go up to 5 rounds." },
  { id: 'G', request: "Let's try codex for the review step for a while, effort high." },
  {
    id: 'H',
    request:
      'Before review runs, lint with `pnpm lint`; if lint fails, just let implement fix it, once. And I want to sign off on the plan myself before any code gets written.',
  },
  {
    id: 'I',
    request: 'My teammate carol-dev should be able to approve runs too. And before the PR opens I want one last look myself; if I reject it, send it back to implement, max 2 times.',
  },
  {
    id: 'J',
    request:
      "For my side projects in ~/src/ (any repo there, whatever the remote), use the same setup as usual but put every agent step on sonnet to save money, and don't create a Herdr space for those runs.",
    files: { 'src/.keep': '' },
  },
];

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const realDir = path.join(os.homedir(), '.percolator');
const { values } = parseArgs({ options: { from: { type: 'string' }, only: { type: 'string' }, verify: { type: 'string' } } });

const sha = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await fs.readFile(file).catch(() => Buffer.from('absent')))
    .digest('hex');
const watched = [path.join(realDir, 'config.yaml'), path.join(realDir, 'percolator.lock')];

if (values.verify !== undefined) {
  const before = JSON.parse(await fs.readFile(path.join(values.verify, 'real-hashes.json'), 'utf8')) as Record<string, string>;
  let changed = false;
  for (const f of watched) {
    if ((await sha(f)) !== before[f]) {
      changed = true;
      console.error(`changed: ${f}`);
    }
  }
  console.log(changed ? 'the real config was touched' : 'real config and lock unchanged');
  process.exit(changed ? 1 : 0);
}

const from = path.resolve(values.from ?? path.join(realDir, 'config.yaml'));
const only = values.only?.split(',').map((s) => s.trim().toUpperCase());
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-skill-'));
await fs.writeFile(path.join(root, 'real-hashes.json'), JSON.stringify(Object.fromEntries(await Promise.all(watched.map(async (f) => [f, await sha(f)])))));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

/**
 * The config text for a sandbox: each path ground (relative to the config, or under the real ~) is copied
 * into `into/<name>` and its path rewritten to the copy, so it resolves in the sandbox and agents never
 * reach the real files. The result is also the diff baseline.
 */
async function sandboxConfig(file: string, into: string): Promise<string> {
  const original = await fs.readFile(file, 'utf8');
  const doc = parseDocument(original);
  let rewritten = false;
  const grounds = doc.get('grounds');
  if (isMap(grounds)) {
    for (const pair of grounds.items) {
      const spec = pair.value;
      const written = isMap(spec) ? spec.get('path') : undefined;
      if (!isMap(spec) || typeof written !== 'string') continue;
      const src = written.startsWith('~') ? expandHome(written) : path.resolve(path.dirname(file), written);
      const dst = path.join(into, String(isScalar(pair.key) ? pair.key.value : pair.key));
      await fs.cp(src, dst, { recursive: true });
      spec.set('path', dst.replaceAll('\\', '/'));
      rewritten = true;
    }
  }
  return rewritten ? doc.toString() : original; // toString would re-format an untouched config
}

for (const s of SCENARIOS.filter((x) => !only || only.includes(x.id))) {
  const dir = path.join(root, s.id);
  const home = path.join(dir, 'home');
  const perc = path.join(home, '.percolator');
  await fs.mkdir(perc, { recursive: true });
  if (!s.fresh) {
    const text = await sandboxConfig(from, path.join(home, 'local-grounds'));
    await fs.writeFile(path.join(perc, 'config.yaml'), text);
    await fs.writeFile(path.join(dir, 'original.yaml'), text);
    const lock = path.join(path.dirname(from), 'percolator.lock');
    if (await exists(lock)) await fs.copyFile(lock, path.join(perc, 'percolator.lock'));
  }
  if (await exists(path.join(realDir, 'grounds'))) await fs.cp(path.join(realDir, 'grounds'), path.join(perc, 'grounds'), { recursive: true });
  for (const [rel, text] of Object.entries(s.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true });
    await fs.writeFile(path.join(home, rel), text);
  }
  const wrapper = path.join(dir, 'perc.mjs');
  await fs.writeFile(
    wrapper,
    [
      "import { spawnSync } from 'node:child_process';",
      `const home = ${JSON.stringify(home)};`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'src', 'cli.ts'))}, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home } });`,
      'process.exit(r.status ?? 1);',
      '',
    ].join('\n'),
  );
  const fwd = (p: string) => p.replaceAll('\\', '/');
  const report = s.fresh
    ? '2) the final config file content'
    : `2) \`diff -u ${fwd(path.join(dir, 'original.yaml'))} ${fwd(path.join(perc, 'config.yaml'))}\``;
  await fs.writeFile(
    path.join(dir, 'prompt.md'),
    `You are helping a user with their Percolator config. First read ${fwd(path.join(ROOT, 'skills', 'percolator-config', 'SKILL.md'))} and follow it exactly.

Test environment (overrides paths only, not the skill's instructions):
- The user's home directory is ${fwd(home)} . Wherever the skill or docs say \`~\`, use that directory, always as an absolute path (never let a shell expand \`~\`). Never read or write ${fwd(realDir)}.
- Run perc as \`node ${fwd(wrapper)} <args>\` instead of \`perc\` or \`node src/cli.ts\`.
- The Percolator package checkout is ${fwd(ROOT)} (read-only: do not edit anything in it).
- The user is not available for follow-up. Where the skill tells you to ask, write down the question you would ask, then answer it yourself from the request with the most reasonable choice.

User's request: "${s.request}"

Final report (concise): 1) questions you would have asked; ${report}; 3) final perc validate output (or the error); 4) the message you would give the user at the end; 5) anything in the skill that was unclear, missing or wrong, and anything you had to look up elsewhere (say where and what).
`,
  );
  console.log(`${s.id}: ${path.join(dir, 'prompt.md')}`);
}
console.log(`\nsandboxes in ${root}\nafterwards: node tests/smoke/skill.smoke.ts --verify ${root}`);
