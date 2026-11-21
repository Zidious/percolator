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

To install it:

1. Ask Herdr's agent to add the layout from this folder, or follow Herdr's procedure for shared layouts: copy `herdr/layouts/percolator.json` to Herdr's `layouts/` and `herdr/mods/percolator` and `herdr/mods/percolator-cup` to `mods/`, without overwriting anything, then run `layout.switch {name: "percolator"}`. The mod runs `node` with perc's CLI and reads `~/.percolator`.
2. Run `perc herdr link` (from a checkout: `node src/cli.ts herdr link`). It tells the panel how to run perc.
3. Reload the mods (save a file in each mod folder, or restart Herdr).

`herdr/` and `assets/` live in the repo only; they are not in the npm package.
