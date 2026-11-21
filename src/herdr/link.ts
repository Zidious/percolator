import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, writeFileAtomic } from '../util/fs.ts';

/** Herdr's app home: `HERDR_APP_HOME`, else `<home>/.config/herdr-app` (on every OS). */
export function herdrAppHome(env: NodeJS.ProcessEnv, home: string): string {
  const set = env['HERDR_APP_HOME'];
  return set !== undefined && set !== '' ? set : path.join(home, '.config', 'herdr-app');
}

/** Tell the Percolator panel how to run perc: writes `<appHome>/mods/percolator/perc.json`; returns its path. */
export async function linkHerdr(o: { appHome: string; node: string; cli: string }): Promise<string> {
  const appHome = path.resolve(o.appHome);
  if (!(await exists(appHome))) throw new Error(`perc herdr link: no Herdr config at ${appHome}; install Herdr first`);
  const modDir = path.join(appHome, 'mods', 'percolator');
  if (!(await exists(modDir))) {
    throw new Error(`perc herdr link: ${modDir} not found; add the Percolator layout to Herdr first (see herdr/RECIPE.md)`);
  }
  const file = path.join(modDir, 'perc.json');
  await writeFileAtomic(file, `${JSON.stringify({ node: o.node, cli: o.cli }, null, 2)}\n`);
  return file;
}
