// Manual screenshots of the Percolator panel over the fixtures, in the REAL Herdr app. Not part of `pnpm test`.
//   node tests/smoke/panel.shots.ts [--out <dir>] [--light <theme>] [--dark <theme>] [--runs <id,...>] [--zooms <z,...>]
//   --out    where the PNGs go (default <tmpdir>/perc-panel-shots-<timestamp>)
//   --light, --dark   themes to shoot in (`app.theme` names: a preset or themes/<name>.json); neither: the current theme
//   --runs   run ids to shoot (default every run in herdr/fixtures/status.json)
//   --zooms  extra zooms (e.g. 1,0.8) to shoot t2 at, docked at 380 and 720 and in the window, stepping app.zoom_in /
//            app.zoom_out (0.1 a step); the zoom goes back after
// Needs Herdr open. It takes over the panel while it runs: it backs up the installed percolator and percolator-cup
// mods (perc.json included) and settings.json, mirrors herdr/mods/* into the app home with perc.json pointing at the
// fixtures, and drives the panel with `herdr-app do`: layout.switch, layout.resize, percolator-cup.open/<id>,
// percolator.key/<key>, percolator.place, app.theme, app.zoom_in/out. In `finally` it puts back the mods, settings.json, the
// zoom, the panel's width and shown/hidden state and the layout, and prints whether every backed-up file hashes equal.
// herdr-app: $HERDR_APP, else %LOCALAPPDATA%/Programs/herdr-app/herdr-app.exe on Windows, else `herdr-app` on PATH.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { herdrAppHome } from '../../src/herdr/link.ts';
import { nodeExec } from '../../src/util/exec.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    light: { type: 'string' },
    dark: { type: 'string' },
    runs: { type: 'string' },
    zooms: { type: 'string' },
  },
});

const repo = path.resolve(import.meta.dirname, '..', '..');
const fixtures = path.join(repo, 'herdr', 'fixtures');
const out = path.resolve(values.out ?? path.join(os.tmpdir(), `perc-panel-shots-${Date.now()}`));
const appHome = herdrAppHome(process.env, os.homedir());
const mods = ['percolator', 'percolator-cup'];
const BLOCK = 'percolator-panel';
const WIDTHS = [280, 380, 720];
const app =
  process.env['HERDR_APP'] ??
  (process.platform === 'win32'
    ? path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'herdr-app', 'herdr-app.exe')
    : 'herdr-app');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function herdr(args: string[]): Promise<string> {
  const res = await nodeExec(app, args);
  if (res.code !== 0 || /"error"/.test(res.stdout)) {
    throw new Error(`herdr-app ${args.join(' ')} failed: ${(res.stdout + res.stderr).trim()}`);
  }
  return res.stdout;
}
const run = (name: string, args?: object): Promise<string> =>
  herdr(args === undefined ? ['do', name] : ['do', name, JSON.stringify(args)]);
const status = async (): Promise<{ zoom: number; layout: string; overlays: string[] }> => JSON.parse(await herdr(['status']));

let shots = 0;
async function shot(name: string, wait = 600): Promise<void> {
  await sleep(wait);
  await herdr(['shot', path.join(out, `${name}.png`)]);
  shots += 1;
  console.log(`shot ${name}.png`);
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Every file under `dir`, relative, with its sha256. */
async function hashes(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    map.set(path.relative(dir, file), sha(await fs.readFile(file)));
  }
  return map;
}

/** Makes `to` hold exactly the files of `from`: removes the others (a stale train.js), copies the rest over. */
async function mirror(from: string, to: string, keep: string[] = []): Promise<void> {
  const want = await hashes(from);
  const have = await hashes(to).catch(() => new Map<string, string>());
  for (const rel of have.keys()) if (!want.has(rel) && !keep.includes(rel)) await fs.rm(path.join(to, rel));
  await fs.cp(from, to, { recursive: true });
}

const percJson = path.join(appHome, 'mods', 'percolator', 'perc.json');
const useFixture = (file: string): Promise<void> =>
  fs.writeFile(percJson, `${JSON.stringify({ fixtures: path.join(fixtures, file) })}\n`);
async function sync(): Promise<void> {
  for (const m of mods) await mirror(path.join(repo, 'herdr', 'mods', m), path.join(appHome, 'mods', m), m === 'percolator' ? ['perc.json'] : []);
}
const resize = (px: number): Promise<string> => run('layout.resize', { id: BLOCK, px });
const open = (id: string): Promise<string> => run(`percolator-cup.open/${id}`);
const key = (k: string): Promise<string> => run(`percolator.key/${k}`);

async function zoomTo(target: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const z = (await status()).zoom;
    if (Math.abs(z - target) < 0.01) return;
    await run(z < target ? 'app.zoom_in' : 'app.zoom_out');
  }
  throw new Error(`could not get the zoom back to ${target}; set it in Herdr's settings`);
}

const shortId = (id: string): string => id.split('-')[0] ?? id;

// ── back up ──
const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-panel-shots-backup-'));
const settingsFile = path.join(appHome, 'settings.json');
const layoutFile = path.join(appHome, 'layouts', 'percolator.json');
for (const m of mods) await fs.cp(path.join(appHome, 'mods', m), path.join(backup, 'mods', m), { recursive: true });
await fs.copyFile(settingsFile, path.join(backup, 'settings.json'));
const before = await hashes(backup);
const was = await status();
const layoutText = await fs.readFile(layoutFile, 'utf8').catch(() => null);
const block = layoutText ? findBlock(JSON.parse(layoutText)) : null;
const wasWidth: number = block?.size?.px ?? 380;
const wasHidden = Boolean(block?.hidden);
console.log(`backed up to ${backup}`);

function findBlock(node: { id?: string; children?: unknown[]; size?: { px?: number }; hidden?: boolean }): typeof node | null {
  if (node.id === BLOCK) return node;
  for (const c of (node.children ?? []) as (typeof node)[]) {
    const f = findBlock(c);
    if (f) return f;
  }
  return null;
}

await fs.mkdir(out, { recursive: true });
try {
  const status0 = JSON.parse(await fs.readFile(path.join(fixtures, 'status.json'), 'utf8')) as { runs: { id: string }[] };
  const runs = values.runs ? values.runs.split(',') : status0.runs.map((r) => r.id);
  const themes = [values.light, values.dark].filter((x): x is string => x !== undefined);

  await useFixture('status.json');
  await sync();
  await sleep(1500); // the mods reload
  await run('layout.switch', { name: 'percolator' });

  for (const theme of themes.length ? themes : ['current']) {
    if (theme !== 'current') await run('app.theme', { name: theme });
    for (const id of runs) {
      for (const w of WIDTHS) {
        await resize(w);
        await open(id);
        await shot(`${theme}-${w}-${shortId(id)}`);
      }
    }
    // t8 with a finished stop open
    await resize(380);
    await open('t8-20261121-091502-a41c');
    await sleep(300);
    await key('left');
    await key('left');
    await shot(`${theme}-380-t8-picked`);
    await key('escape');
    // t2 in the window; with a stop picked; the worst case (reject open, a stop picked) docked 720 and in the window
    await open('t2-20261121-005347-f0ab');
    await run('percolator.place');
    await shot(`${theme}-window-t2`, 1200);
    await key('left');
    await shot(`${theme}-window-t2-picked`);
    await key('r');
    await shot(`${theme}-window-t2-reject-picked`);
    await key('escape');
    await key('escape');
    await run('percolator.place');
    await resize(720);
    await open('t2-20261121-005347-f0ab');
    await key('left');
    await key('r');
    await shot(`${theme}-720-t2-reject-picked`);
    await key('escape');
    await key('escape');
  }

  for (const z of (values.zooms ?? '').split(',').filter(Boolean).map(Number)) {
    await zoomTo(z);
    await resize(380);
    await open('t2-20261121-005347-f0ab');
    await shot(`zoom${z}-380-t2`, 1000);
    await resize(720);
    await shot(`zoom${z}-720-t2`);
    await run('percolator.place');
    await shot(`zoom${z}-window-t2`, 1200);
    await run('percolator.place');
  }
  await zoomTo(was.zoom);

  // the empty state, on the Active tab: a fresh panel (re-synced) reading empty.json; no command picks the All tab
  await useFixture('empty.json');
  await sync();
  await sleep(1500);
  await resize(380);
  await run('layout.show', { id: BLOCK });
  await shot('empty-active', 1500);
} finally {
  // ── restore ──
  const problems: string[] = [];
  const step = async (what: string, f: () => Promise<unknown>): Promise<void> => {
    try {
      await f();
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
    }
  };
  await step('dock the panel', async () => {
    if ((await status()).overlays.includes('percolator')) await run('percolator.place');
  });
  await step('zoom', () => zoomTo(was.zoom));
  await step('panel width', () => resize(wasWidth));
  await step('panel shown', () => run(wasHidden ? 'layout.hide' : 'layout.show', { id: BLOCK }));
  await step('layout', () => run('layout.switch', { name: was.layout }));
  for (const m of mods) {
    await step(`mods/${m}`, async () => {
      await mirror(path.join(backup, 'mods', m), path.join(appHome, 'mods', m));
    });
  }
  await step('settings.json', () => fs.copyFile(path.join(backup, 'settings.json'), settingsFile));
  const now = new Map<string, string>();
  for (const m of mods) for (const [k, v] of await hashes(path.join(appHome, 'mods', m))) now.set(path.join('mods', m, k), v);
  now.set('settings.json', sha(await fs.readFile(settingsFile)));
  const differ = [...before].filter(([k, v]) => now.get(k) !== v).map(([k]) => k);
  const extra = [...now.keys()].filter((k) => !before.has(k));
  const ok = differ.length === 0 && extra.length === 0 && problems.length === 0;
  console.log(
    ok
      ? `restored: ${before.size} files hash equal (backup ${backup})`
      : `NOT restored: differ ${differ.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}; ${problems.join('; ') || ''} (backup ${backup})`,
  );
  const layoutNow = await fs.readFile(layoutFile, 'utf8').catch(() => null);
  console.log(`layouts/percolator.json ${layoutNow === layoutText ? 'unchanged' : 'differs from before (Herdr rewrote it)'}`);
  console.log(`${shots} shots in ${out}`);
  if (!ok) process.exitCode = 1;
}
