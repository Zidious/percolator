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
// Ctrl-C (SIGINT, SIGTERM, SIGBREAK) or closing the terminal (SIGHUP) after the backup stops the shots and runs the same
// restore; a second one during the restore is ignored. Closing the console on Windows leaves about 10s before Windows ends
// the process, so that restore is best effort: check the summary, or restore by hand from the backup if the window
// closed first. Every herdr-app call times out after 30s (60s for shot), naming the command, and the restore follows.
// Themes: with --light/--dark the theme goes back to settings.json's "theme"; when settings.json names none (Herdr's
// default) the original is unknown to app.theme, so the summary says NOT restored and asks you to check the theme.
// herdr-app: $HERDR_APP (a path, or a JSON argv such as ["node","stub.js"]), else
// %LOCALAPPDATA%/Programs/herdr-app/herdr-app.exe on Windows, else `herdr-app` on PATH.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { herdrAppHome } from '../../src/herdr/link.ts';
import { setTimeout as wait } from 'node:timers/promises';

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
const appEnv = process.env['HERDR_APP'];
const [appFile, ...appArgs]: string[] = appEnv?.startsWith('[')
  ? (JSON.parse(appEnv) as string[])
  : [
      appEnv ??
        (process.platform === 'win32'
          ? path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'herdr-app', 'herdr-app.exe')
          : 'herdr-app'),
    ];
const TIMEOUT = 30_000;
const SHOT_TIMEOUT = 60_000;

// Ctrl-C and friends abort the shots: the call in flight is killed, the next sleep or call throws, and `finally` restores.
const stop = new AbortController();
let restoring = false;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : [])];
function onSignal(sig: NodeJS.Signals): void {
  if (restoring) {
    console.log(`${sig}: the restore is in progress; wait for it to finish`);
    return;
  }
  console.log(`${sig}: stopping the shots, then restoring`);
  stop.abort(new Error(`interrupted (${sig})`));
}
const sleep = (ms: number): Promise<void> => wait(ms, undefined, { signal: stop.signal }).catch(() => {
  throw stop.signal.reason as Error;
});

/** One herdr-app call, argv only, with a timeout; while shooting, an interrupt kills it. Never a shell. */
function herdr(args: string[]): Promise<string> {
  const what = `herdr-app ${args.slice(0, 2).join(' ')}`;
  if (!restoring && stop.signal.aborted) return Promise.reject(stop.signal.reason as Error);
  const timeout = args[0] === 'shot' ? SHOT_TIMEOUT : TIMEOUT;
  return new Promise((resolve, reject) => {
    execFile(
      appFile!,
      [...appArgs, ...args],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, ...(restoring ? {} : { signal: stop.signal }) },
      (err, stdout, stderr) => {
        if (err && !restoring && stop.signal.aborted) return reject(stop.signal.reason as Error);
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (e?.killed) return reject(new Error(`${what} timed out after ${timeout / 1000}s; is Herdr open and responding?`));
        if (e?.code === 'ENOENT') return reject(new Error(`${appFile} not found; set HERDR_APP`));
        if (err || /"error"/.test(stdout)) return reject(new Error(`${what} failed: ${(stdout + stderr).trim() || err?.message}`));
        resolve(stdout);
      },
    );
  });
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

// t23-epic-20261121-090000-7c2a-s1 → t23-epic-s1: unique per run (the slices and the triage pair share a ticket)
const shortId = (id: string): string => id.replace(/-\d{8}-\d{6}-[0-9a-f]{4}/, '');

// ── back up ──
const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'perc-panel-shots-backup-'));
const settingsFile = path.join(appHome, 'settings.json');
const layoutFile = path.join(appHome, 'layouts', 'percolator.json');
for (const m of mods) await fs.cp(path.join(appHome, 'mods', m), path.join(backup, 'mods', m), { recursive: true });
await fs.copyFile(settingsFile, path.join(backup, 'settings.json'));
const before = await hashes(backup);
const wasTheme: unknown = JSON.parse(await fs.readFile(settingsFile, 'utf8')).theme;
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
for (const sig of SIGNALS) process.on(sig, onSignal);
let themeChanged = false;
let failure: Error | null = null;
try {
  const status0 = JSON.parse(await fs.readFile(path.join(fixtures, 'status.json'), 'utf8')) as { runs: { id: string }[] };
  const runs = values.runs ? values.runs.split(',') : status0.runs.map((r) => r.id);
  const themes = [values.light, values.dark].filter((x): x is string => x !== undefined);

  await useFixture('status.json');
  await sync();
  await sleep(1500); // the mods reload
  await run('layout.switch', { name: 'percolator' });

  for (const theme of themes.length ? themes : ['current']) {
    if (theme !== 'current') {
      themeChanged = true;
      await run('app.theme', { name: theme });
    }
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
    // the start picker: + New run per pipeline, Start in fixtures mode (spike: nothing required), ▸ Run next… on a
    // finished run (t3: its ticket; audit: the issues it opened, a select); docked at each width, then in the window
    for (const place of [...WIDTHS.map(String), 'window']) {
      if (place === 'window') await run('percolator.place');
      else await resize(Number(place));
      for (const p of ['feature', 'hotfix', 'dd-alert', 'spike']) {
        await run(`percolator.new/${p}`);
        await shot(`${theme}-${place}-new-${p}`, place === 'window' && p === 'feature' ? 1200 : 600);
      }
      await run('percolator.start');
      await shot(`${theme}-${place}-new-spike-started`);
      await key('escape');
      for (const id of ['t3-20261120-142211-e012', 'audit-20261120-180000-2d7c']) {
        await open(id);
        await sleep(300); // the panel selects the run on its next frame
        await run('percolator.next');
        await shot(`${theme}-${place}-next-${shortId(id)}`);
        await key('escape');
      }
      if (place === 'window') await run('percolator.place');
    }
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
} catch (e) {
  failure = e as Error;
} finally {
  // ── restore ── (each step on its own, so one failure neither stops the others nor hides the first error)
  restoring = true;
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
  await step('theme', async () => {
    if (!themeChanged) return;
    if (typeof wasTheme !== 'string') throw new Error('settings.json named no theme before, so app.theme cannot put it back; check the theme in Herdr');
    await run('app.theme', { name: wasTheme });
  });
  for (const m of mods) {
    await step(`mods/${m}`, async () => {
      await mirror(path.join(backup, 'mods', m), path.join(appHome, 'mods', m));
    });
  }
  await step('settings.json', () => fs.copyFile(path.join(backup, 'settings.json'), settingsFile));
  let differ: string[] = [];
  let extra: string[] = [];
  await step('hash check', async () => {
    const now = new Map<string, string>();
    for (const m of mods) for (const [k, v] of await hashes(path.join(appHome, 'mods', m))) now.set(path.join('mods', m, k), v);
    now.set('settings.json', sha(await fs.readFile(settingsFile)));
    differ = [...before].filter(([k, v]) => now.get(k) !== v).map(([k]) => k);
    extra = [...now.keys()].filter((k) => !before.has(k));
  });
  const ok = differ.length === 0 && extra.length === 0 && problems.length === 0;
  console.log(
    ok
      ? `restored: ${before.size} files hash equal (backup ${backup})`
      : `NOT restored: differ ${differ.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}; ${problems.join('; ') || ''} (backup ${backup})`,
  );
  const layoutNow = await fs.readFile(layoutFile, 'utf8').catch(() => null);
  console.log(`layouts/percolator.json ${layoutNow === layoutText ? 'unchanged' : 'differs from before (Herdr rewrote it)'}`);
  console.log(`${shots} shots in ${out}`);
  if (failure) console.log(`stopped: ${failure.message}`);
  if (!ok || failure) process.exitCode = 1;
}
