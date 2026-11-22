// `pnpm herdr:sync`: mirrors herdr/mods/* into the Herdr app's mods folder (HERDR_APP_HOME, else ~/.config/herdr-app),
// so the running app reloads them. Files an older version left there are removed; each mod's perc.json is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = new Set(['perc.json']); // written by `perc herdr link` or by hand, never in the source

/** Removes what `to` holds and `from` does not (`rel` names it in `removed`), descending into folders both hold. */
function prune(from: string, to: string, rel: string, removed: string[]): void {
  for (const e of fs.readdirSync(to, { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && KEEP.has(e.name)) continue;
    const source = path.join(from, e.name);
    const target = path.join(to, e.name);
    const there = fs.existsSync(source) ? fs.statSync(source) : null;
    if (there && there.isDirectory() === e.isDirectory()) {
      if (e.isDirectory()) prune(source, target, name, removed);
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
}

/** Mirrors every mod folder under `src` into `<home>/mods/`; returns one line per mod saying what it did. */
export function syncMods(src: string, home: string): string[] {
  const mods = fs
    .readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return mods.map((mod) => {
    const from = path.join(src, mod);
    const to = path.join(home, 'mods', mod);
    const removed: string[] = [];
    if (fs.existsSync(to)) prune(from, to, '', removed);
    fs.cpSync(from, to, { recursive: true });
    return `synced ${mod} -> ${to}${removed.length > 0 ? ` (removed ${removed.sort().join(', ')})` : ''}`;
  });
}

if (import.meta.main) {
  const home = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
  for (const line of syncMods(path.resolve(import.meta.dirname, '..', 'herdr', 'mods'), home)) console.log(line);
}
