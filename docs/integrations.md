# Integrations

`perc` is complete on its own: it starts runs, waits at gates and takes your answers on the command line. An integration adds a view on top. It reads `perc status --json`, a stable and versioned contract (and `perc pipelines --json` to offer the pipelines a run can start on), and answers by running `perc` commands, as you would by hand. It never talks to the engine directly.

`perc status --json` is at `schema: 2`. Each run carries its `pipeline` and `inputs`; `ticket` is `null` on a ticketless run; `parent` is the run that started it (a router's, an `issue` exit's with `next`, or a fan-out's), or `null`; `children` lists the runs it started, with their pipeline and status (a fan-out's slices first, by index, each with `slice: { index, title }`, and `status: pending` for a slice whose run has not started yet); and `opened` lists the issues its exit opened. A run's `attention` says what it needs from you: a `message`, and the `actions` an integration may offer; at a `pick-pipeline` gate those are `pick` and `reject`, with the pipelines to pick from in `choices`. Beside `runs`, `watcher` says whether `perc watch` is running: `alive`, `since` (when it started, only while alive) and the `repos` it watches. An integration that reads schema 1 must be updated.

| Integration | Adds | Lives in |
|---|---|---|
| [Herdr](#herdr) | A space per run, a live board of runs and the runs they started (fan-out slices included), Approve / Reject / Resume / Delete and Run `<pipeline>` buttons, **+ New run** and **▸ Run next…** to start runs (the pipelines come from `perc pipelines --json`), the watcher's state with Start watcher / Stop, notices | [`herdr/`](../herdr/) |

## Herdr

The Herdr app adds a space per run, and the Percolator panel adds a live board of every run and buttons for the same commands. Agents run in terminals started by `hc` either way.

- **Start a run.** **+ New run** in the title bar opens the start picker, and a finished run offers **▸ Run next…** on its ticket (see [Starting a run](pipelines.md#starting-a-run)).
- **Pipelines.** A run on a pipeline other than `feature` shows a chip with the pipeline's name after its title, and its spine draws that pipeline's own stages.
- **Linked runs.** A run that another one started shows `↳ from #42` under its title (the parent's ticket, or the parent's pipeline when the ticket is the run's own or there is none); a fan-out's slice shows `↳ slice 2 of #42: <title>` instead (`↳ slice 2 of <pipeline>: <title>` when the parent has no ticket). A run that started others shows `→ 3 runs`; a fan-out parent shows `→ 4 slices · 2 started` while some slices have not started, then `→ 4 slices`. Clicking the line selects that run (the parent, or the first run it started that is listed). On the board, a router's completed run has the state line `Routed → <pipeline>`, and a completed ticketless run with no PR and no opened issues (whatever its exit) the line `Done`. Selected, such a run's outcome box says `ROUTED → <pipeline>` or `DONE`.
- **Slices.** Under a fan-out parent's fan-out stage, each slice has a row: its status dot, `<i>.`, its title, the step it is at (`Done`, `Not started`, the current step, or its status) and a `PR ↗` link once it has one. Clicking a row selects that slice's run; a slice that has not started has no run to select yet.
- **Pick a pipeline.** At a router's `pick-pipeline` gate, the message names the agent's suggestion when it made one, and the panel shows one **Run `<name>`** button per pipeline the router may pick; each runs `perc approve <id> --pipeline <name>`. **Reject** has the agent pick again.
- **The watcher.** The title bar shows whether `perc watch` runs: `Watching 2 repos`; `Starting…` after **Start watcher** until its first heartbeat (at most 60 s; no button meanwhile); `Watcher not responding` when its heartbeat is stale but the `percolator-watch` terminal is still live (with **Stop**); else `Not watching`. **Stop** runs `perc watch stop`; **Start watcher** runs `perc watch` with a `--repo` for every repo earlier runs used, so it is not offered before the first run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagram-modes-dark.svg">
  <img alt="Two setups side by side. On its own you drive perc from a terminal: run, status, approve (with --pipeline at a pick-pipeline gate) or reject, resume, delete, pipelines and watch. With Herdr, the panel and cup read perc status --json and perc pipelines --json, and run perc run (from + New run or Run next…), approve (with --pipeline from a Run pipeline button), reject, resume and watch for you. In both, perc starts runs from perc run, from a router or a fan-out as linked runs, and from triggers while perc watch runs; hc and the agents are the same in both." src="../assets/diagram-modes-light.svg" width="100%">
</picture>

To set it up:

1. Copy `herdr/layouts/percolator.json` and the two folders in `herdr/mods/` into `~/.config/herdr-app`.
2. Run `perc herdr link` once, so the panel knows which `node` and CLI to run.

For the full steps, keys and checks, see [`herdr/RECIPE.md`](../herdr/RECIPE.md).
