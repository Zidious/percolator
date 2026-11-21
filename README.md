<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mark-on-dark.svg">
    <img alt="Percolator" src="assets/mark-on-light.svg" width="96">
  </picture>
</p>

# Percolator

A deterministic "software factory" engine. The `perc` CLI loads layered YAML config, builds a run graph (six core stages: intake, groom, plan, implement, review, deliver, plus hooks and bounded back-edges), walks it through pluggable runtimes and saves run state so a run can resume.

Run `perc init` to write the recommended config, `perc validate` to check it, and `perc run <owner/repo#issue>` to start a run. See `AGENTS.md` for the commands and the layout of the code.

## Herdr panel

The `herdr/` folder is a [Herdr](https://herdr.dev) layout: Herdr's own layout plus a Percolator panel (every run on a board, the stage train for the one you pick, and Approve / Reject / Resume buttons) and a status-bar cup that says how many runs need you and posts a notice when one does. See `herdr/RECIPE.md` and `herdr/preview.png`.

To install it, follow "Install" in `herdr/RECIPE.md`: copy `herdr/layouts/percolator.json` and the two folders under `herdr/mods/` into Herdr's home (`~/.config/herdr-app`) without overwriting, run `herdr-app check` on each mod, switch with `herdr-app do layout.switch --name percolator`, then run `node src/cli.ts herdr link` in a checkout (`perc herdr link` if perc is on PATH) and reload the mods. The mod runs `node` with perc's CLI and reads `~/.percolator`.

`herdr/` and `assets/` live in the repo only; they are not in the npm package.
