<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mark-on-dark.svg">
    <img alt="Percolator" src="assets/mark-on-light.svg" width="96">
  </picture>
</p>

<h1 align="center">Percolator</h1>

<p align="center"><b>Tickets in. Pull requests out.</b></p>

Percolator is a deterministic software factory. Point `perc` at a GitHub issue and it walks the ticket through fixed stages, running the agent you choose at each one, and ends with a pull request. It stops once for your approval, and it saves every step, so a run can stop and pick up where it left off. The [docs](#where-next) cover the rest.

## What you need

**Required**

- **Node 24** or later, and **git**. Windows, Linux and macOS all work.
- **[`gh`](https://cli.github.com)**, logged in (`gh auth login`). Intake reads the issue, the gate posts to it and the exit acts through it: it opens the PR, or posts the comment, opens the issues, publishes the release, posts the review or opens the PR in an advisory's private fork (see [Exits](docs/pipelines.md#exits)). `perc watch` polls issues, pull requests and workflow runs through it.
- **`hc`**, Herdr's terminal CLI. Every step runs in a terminal it starts.
- **The agent CLIs your config names:** `claude` for the [example config](docs/configuration.md#example-config), `codex`, or any command.

**Optional**

- **The [Herdr](https://herdr.dev) app**, for a Herdr space per run and the Percolator panel. Runs create a space by default, so without the app, set `runtime: { space: false }` in your profile. See [Integrations](docs/integrations.md).

Percolator isn't on npm yet: install it from a checkout as in [Local development](docs/development.md), and use `node <checkout>/src/cli.ts` wherever these docs say `perc`.

## Quick start

| | Command | What it does |
|---|---|---|
| 1 | `perc init` | Writes an example config to `~/.percolator/config.yaml`. Edit it freely. |
| 2 | `perc validate` | Loads the config, resolves and pins grounds, and prints the graph each pipeline's run would walk. |
| 3 | `perc run owner/repo#42` | Starts a run of the default pipeline, `feature`. It stops once, after groom, for you to approve the ticket. |

`perc run` starts the run's driver in a terminal of its own. With Herdr, the driver stays out of the run's space, and the panel's **Driver pane ↗** peeks at it; closing the peek leaves the run going. Add `--foreground` to drive it in yours. `perc status` lists runs and `perc status <id>` shows one. `perc delete <id>…` removes the runs you name, and `perc delete --finished` every completed or failed one; both keep the branch. Delete also ends any terminal still open in the run's worktree, such as the shell its Herdr space starts, since that would hold the folder, and removes the run's gate comment still waiting for approval on its ticket. Run `perc --help` for every command and its options.

> [!IMPORTANT]
> **Before your first run with `claude` agents,** trust the repo and `~/.percolator` once in Claude Code. Each agent starts with `--add-dir ~/.percolator/runs/<run-id>` to read its task and write its outputs. If that folder is not trusted, Claude Code asks whether to trust it, and answering no ends the agent and pauses the run.

## A run, stop by stop

A run walks the stages of its pipeline in order. You choose what runs at each stage, but a run cannot skip or reorder them. This section follows the `feature` pipeline, the one `perc init` sets up; [Pipelines](docs/pipelines.md) shows how to add others. One gate is built into `feature`: after groom, the run waits for you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-run-dark.svg">
  <img alt="The feature pipeline's run train (other pipelines run their own stages, from intake to an exit): intake, groom, the approve-groom gate, plan, implement, an optional hook, review looping back to implement up to three times, the pr-description hook, then deliver opens a pull request." src="assets/diagram-run-light.svg" width="100%">
</picture>

The diagram shows the [example config](docs/configuration.md#example-config) mid-run: intake and groom are done, and the run waits at the `approve-groom` gate. Rejecting with feedback re-runs groom. Review can send work back to implement for up to 3 rounds; after the third, the run pauses and lists the findings left; you tick the ones to fix, and it goes back for one more round with only those, or delivers when you tick none. Hooks, like the one after implement, are optional nodes you add `before` or `after` any stage, or `all`. The `pr-description` hook before deliver writes the pull request text.

| Stop | What can run there | Done when |
|---|---|---|
| **intake** | builtin `github.intake` | The issue is read and the run has a ticket. |
| **groom … review** | an `agent`, `script` or `builtin` node, or a list of them | The step wrote `done.json` and its `outputs/<key>.md`. |
| **approve-groom** | `gate`, built in and locked, after groom (in `feature` only; a `feature` whose own `stages` leave out groom has none) | You approve, locally or with a `/percolator approve` comment on the issue. The gate keeps one comment on the issue and edits it each round; rejected rounds stay in a collapsed history, and approval adds "Approved by @you". A rejection re-runs groom, 3 times at most. |
| **deliver** | builtin `github.open_pr` | The branch is pushed and the PR is open. Its body is `Closes #N`, followed by the `pr_body` output if a step wrote one. |

## Where next

- [How it works](docs/how-it-works.md): the engine, its run graph, worktrees, and why runs are deterministic and bounded.
- [Configuration](docs/configuration.md): the config file, the example config, profiles, node fields, hooks, gates and loops, grounds, rules and locks.
- [Pipelines](docs/pipelines.md): your own pipelines, exits, starting a run, triage, triggers and `perc watch`, fan-out.
- [Steering a run](docs/steering.md): what each status means and how to answer it, step dirs, clean and delete.
- [Integrations](docs/integrations.md): the `perc status --json` and `perc pipelines --json` contract, and the Herdr panel.
- [Local development](docs/development.md): running perc from a checkout, and contributing.
