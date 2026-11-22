// Where the runs come from, for the panel and the cup (which carries a copy; tests/herdr/cup.test.ts keeps them equal):
// perc.json in this mod's folder (`perc herdr link` writes it) says how to run `perc status --json`;
// `{ "fixtures": "<file>" }` reads a file instead. Refreshes on changes under ~/.percolator/runs, with a 10s fallback.

import { appHome, exec, home, readTextFile, watchFolder } from 'herdr';
import { pipelinesFixture, readPipelines, readStatus, resolvePath } from './model.js';

export const firstLine = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? '';

/** The panel mod's folder, where perc.json lives. */
export const modDir = () => `${appHome()}/mods/percolator`;

/** Reads perc.json: `{ conn: 'perc', perc }`, `{ conn: 'fixtures', fixture }` or `{ conn: 'missing' }`. */
export async function connectSource() {
  const dir = modDir();
  const text = await readTextFile(`${dir}/perc.json`).catch(() => null);
  let cfg = null;
  try {
    cfg = text ? JSON.parse(text) : null;
  } catch {
    cfg = null;
  }
  if (cfg && typeof cfg.fixtures === 'string') return { conn: 'fixtures', fixture: resolvePath(dir, cfg.fixtures) };
  if (cfg && typeof cfg.node === 'string' && typeof cfg.cli === 'string') return { conn: 'perc', perc: cfg };
  return { conn: 'missing' };
}

/** One `perc status --json` (or the fixture file): readStatus's `{ ok, data }` or `{ ok: false, error }`. */
export async function fetchStatus(src) {
  if (src.conn === 'fixtures') {
    const text = await readTextFile(src.fixture).catch(() => null);
    if (text === null) return { ok: false, error: `${src.fixture} not found; fix "fixtures" in perc.json` };
    return readStatus(text);
  }
  const res = await exec(src.perc.node, [src.perc.cli, 'status', '--json'], { timeout: 30000 }).catch((e) => ({
    code: -1,
    stdout: '',
    stderr: String(e?.message ?? e),
  }));
  if (res.code !== 0) {
    const why = firstLine(res.stderr) || `exit ${res.code}`;
    return { ok: false, error: `perc status --json failed: ${why}; check perc is installed and run perc herdr link` };
  }
  return readStatus(res.stdout);
}

/** One `perc pipelines --repo <repo> --json` (or pipelines.json beside the fixture): readPipelines's result. */
export async function fetchPipelines(src, repo) {
  if (src.conn === 'fixtures') {
    const file = pipelinesFixture(src.fixture);
    const text = await readTextFile(file).catch(() => null);
    if (text === null) return { ok: false, error: `${file} not found; put pipelines.json beside the status fixture` };
    return readPipelines(text);
  }
  const argv = [src.perc.cli, 'pipelines', '--repo', repo, '--json'];
  const res = await exec(src.perc.node, argv, { timeout: 30000 }).catch((e) => ({ code: -1, stdout: '', stderr: String(e?.message ?? e) }));
  if (res.code !== 0) {
    const why = firstLine(res.stderr) || `exit ${res.code}`;
    return { ok: false, error: `perc pipelines --json failed for ${repo}: ${why}; check the repo's Percolator config` };
  }
  return readPipelines(res.stdout);
}

/** Calls `refresh(cx)` every 10s and ~300ms after a burst of changes under ~/.percolator/runs. */
export function watchRuns(cx, refresh) {
  let pending = null;
  cx.timer.every(10000, refresh);
  cx.spawn(async (cx) => {
    for (;;) {
      try {
        await watchFolder(`${home()}/.percolator/runs`);
      } catch {
        await cx.sleep(10000); // no runs folder yet: the 10s timer covers it
        continue;
      }
      pending?.cancel();
      pending = cx.timer.after(300, refresh);
    }
  });
}
