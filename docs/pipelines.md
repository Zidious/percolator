# Pipelines

A pipeline is a named list of stages, what runs each one, the inputs a run takes and how it ends. `feature` is built in; every other pipeline lists its own stages under `pipelines:`.

```yaml
profiles:
  default:
    pipelines:
      feature: { default: true, bindings: { … }, nodes: { … } }    # as in the example config
      hotfix:
        description: Small fix, no grooming                       # shown by perc pipelines
        inputs:
          severity: { required: true, description: sev1 … sev3 }
        stages: [intake, implement, review, deliver]
        exit: pr
        bindings:
          implement: { agent: claude, model: opus, prompt: "Fix the issue. Severity: {{input_severity}}." }
          review: { agent: claude, model: sonnet, max_rounds: 2 }
```

| Key | What it does |
|---|---|
| `stages` | The stages in order. `intake` comes first and the last one is the exit stage. Required for every pipeline but `feature`, which runs its six stages unless it lists its own; a `feature` whose `stages` leave out groom has no `approve-groom` gate. |
| `bindings` / `nodes` | What runs each stage, and the pipeline's hooks and gates, as for `feature`. On every pipeline but `feature`, `intake` left unbound runs `github.intake` and the exit stage left unbound runs the builtin of `exit`; `feature` binds every stage itself, even with its own `stages`. The exit stage is never an agent. |
| `outputs` | Per stage, the output keys it must write (`outputs/<key>.md`). A stage left out needs none, except groom, plan, implement and review, which keep their feature outputs unless listed; `feature`'s stages keep their fixed outputs, and the exit stage writes its exit's output. |
| `exit` | How the run ends: `pr`, `comment`, `issue`, `none`, `release`, `pr_review` or `private_fork_pr` (see [Exits](#exits)). Optional when the last stage is bound to an exit builtin; when both are set they must agree. |
| `inputs` | Named values a run takes with `--input <name>=<value>`; `required: true` refuses a run without it, `description` is the hint. Prompts read them as `{{input_<name>}}`. |
| `ticket` | `required` (default), `optional` or `none`. |
| `router` `routes` `choose` `fallback` | Make the pipeline a triage router, which hands the ticket to another pipeline (see [Triage](#triage)). |
| `next` | On a pipeline with `exit: issue`: each issue it opens starts a linked run of this pipeline (see [Exits](#exits)). |
| `triggers` | What starts runs of the pipeline while `perc watch` runs (see [Triggers and perc watch](#triggers-and-perc-watch)). |
| `fan_out` | `{ stage, slices: { from, output }, max_parallel }`: run `stage` and every stage after it once per `## ` section of the `output` that the earlier stage `from` writes, each slice in its own linked run, at most `max_parallel` (default 3) at a time (see [Fan-out](#fan-out)). |
| `default` | `true` on the pipeline `perc run` uses without `--pipeline`; at most one per profile. Without one, `feature` is the default. |
| `description` | One line on what the pipeline is for. |
| `rules` / `use` | Rules and mappings for this pipeline only. |
| `required` | Locks the pipeline's own keys (all but `bindings`, `nodes`, `rules` and `use`): later layers may only restate them. |

Pipeline names start with a lower-case letter, then lower-case letters, digits and `-` (at most 24 characters); input names start with a lower-case letter, then lower-case letters, digits and `_` (at most 32 characters). `all`, `before-all` and `after-all` are reserved and cannot be stage names.

- **Loops.** A stage named `review` loops back to the stage before it, 3 rounds unless its binding sets `max_rounds`; any other stage loops the same way when its binding sets `max_rounds`.
- **Gates.** `approve-groom` belongs to `feature`, after its groom stage. Another pipeline has no built-in gate; add one as a node with `kind: gate` where you want to decide. Rejecting a gate without `on_fail` sends the run back, with your feedback, to the stage it follows (`after: X` to X, `before: X` to the stage before X), or to the nearest earlier stage with an agent when that stage has none (intake, a script-only stage), 3 rounds at most; give it `on_fail` to send it elsewhere.
- **Outputs.** Each step's outputs reach the steps after it as inputs, so a stage reads what the stages before it wrote.
- **Tickets.** A pipeline with `ticket: none` refuses a ticket and runs on its inputs alone: its intake writes them as the ticket (`ticket.md`, an `## Inputs` list), so later stages read them as they would read an issue. The run id, branch and Herdr space take the pipeline's name where a ticket run has the issue number (`dd-alert-20261122-…`), a PR it opens has no `Closes #N`, and its gates are answered with `perc approve`/`perc reject` or the panel, since there is no issue to comment on. It names its repository from the clone's `origin`; an SSH origin that uses a host alias from your SSH config (`git@gh-work:o/r`) names the host the alias connects to, as `ssh -G` reports it (the watcher and a bare `#123` ticket do the same). With `ticket: optional`, a ticket is fetched when one is given.

`perc validate` checks every pipeline of the profile and prints one block per pipeline; `perc validate --pipeline hotfix` checks just one. `perc pipelines [--repo <dir>] [--profile <name>]` lists the pipelines a repo can use, the default first, one line each:

```text
feature (default)  ticket required  exit pr  inputs -
hotfix  ticket required  exit pr  inputs severity
```

With `--json` it is the contract the Herdr panel's start picker reads (`schema: 1`): the `repo` and `profile` it read, then each pipeline's `name`, `default`, `router`, `ticket`, `inputs` (name, required, description), `exit` (one of the kinds under [Exits](#exits), or `route` for a router), `description`, and the `steps` and `loops` its preview draws; a pipeline that fails validation is listed with its `error` instead.

## Exits

The last stage of a pipeline is its exit: a builtin that Percolator runs itself, never an agent. It reads what earlier stages wrote, acts on GitHub through `gh`, and writes one output. Each one marks what it creates, so a resume after a crash finds it instead of creating it twice.

| `exit` | Builtin | What it does | What it needs | Writes | Found again on resume by |
|---|---|---|---|---|---|
| `pr` | `github.open_pr` | Pushes the run branch and opens a PR against the base: `Closes #N`, then the `pr_body` output if a step wrote one. Its title is the `pr_title` output if a step wrote one, else the issue's title (`<pipeline>: <run id>` without a ticket). | Nothing | `pr_url` | The open PR for the run branch |
| `comment` | `github.comment` | Posts the `comment` output on the run's issue. | A ticket on every run (`ticket: none` or `optional` is refused); a stage before it writes `comment.md`, else the step escalates | `comment_url` | `<!-- percolator:exit run=<id> step=<step> -->` in the comment, which it then edits |
| `issue` | `github.open_issues` | Opens one issue per `## <title>` section of the `issues` output, in the run's repo. With no `issues` output, or no sections, it opens nothing and the run ends done. A section with a bare `## ` heading escalates with `github.open_issues: draft <n> in issues.md has no title (a bare "## " heading); give it a title and resume`. | Nothing | `issue_urls` (one URL per line) | `<!-- percolator:issue run=<id> n=<i> -->` in each issue, and `created.json` in the step dir |
| `none` | `percolator.report` | Nothing: the run ends, and its outputs stay in the run dir until `perc delete` removes them. | Nothing | Nothing | Nothing to find |
| `release` | `github.release` | Pushes the run branch and publishes a GitHub release of its head commit. The tag is the `tag` output, else input `tag`; the notes are the `release_notes` output. | Input `tag`, or `tag` under `outputs` of an earlier stage | `release_url` | `<!-- percolator:release run=<id> -->` in the release notes of the release with that tag; a tag that another release already has escalates with `github.release: tag "<t>" already has a release (<url>); pick another tag and resume` |
| `pr_review` | `github.pr_review` | Posts the `review` output on the pull request in input `pr`, as a comment review: never approve or request changes. | Input `pr` (`#123`, `owner/repo#123` or a pull request URL); a stage before it writes `review.md` | `review_url` | `<!-- percolator:review run=<id> -->` in the review |
| `private_fork_pr` | `github.private_fork_pr` | Creates the temporary private fork of the security advisory in input `advisory`, pushes the run branch there and opens the PR in it, with the `pr_body` output and no `Closes #N`, so the fix stays private until the advisory is published. Its title is the `pr_title` output if a step wrote one (write one when the issue's title says too much), else the issue's title, else `Fix for <GHSA id>`. | Input `advisory`, a GHSA id (`GHSA-xxxx-xxxx-xxxx`) | `pr_url` | `fork.json` in the step dir, then the open PR for the run branch in the fork |

`perc validate` refuses an exit whose needs the pipeline does not declare, or declares without `required: true`, for example:

```text
exit pr_review needs input "pr" (the pull request to review); declare it under pipelines.<name>.inputs
```

A gate before the exit is the pipeline's choice. For example, to read the drafted issues before they are opened, add an `approve-issue` gate with `when_output`, so it stops only when there are drafts:

```yaml
pipelines:
  dd-alert:
    ticket: none
    inputs: { alert_url: { required: true } }
    stages: [intake, gather, diagnose, open]
    outputs: { gather: [evidence] }    # issues stays unlisted: diagnose may write no issues.md
    exit: issue
    next: triage                         # optional: each opened issue starts a linked triage run
    bindings:
      gather: { … }
      diagnose: { agent: claude, prompt: "… For each issue to open, a \"## <title>\" section in issues.md; none to open: no issues.md." }
    nodes:
      approve-issue:
        kind: gate
        before: open
        when_output: issues              # no drafts: the gate passes at once and the run ends done
        on_fail: { back_to: diagnose, max_rounds: 3 }   # a rejection redrafts
```

Leave `issues` out of `outputs`: an output listed there is required, so the gate would always stop. `next` is only for an `issue` exit, and it must name a pipeline that takes a ticket and has no required inputs (a `next` run gets none); a `next` that leads back to its own pipeline, directly or through other pipelines' `next`, is refused. Each new issue gets its own linked run, recorded in the exit's `created.json` before it starts, so a resume starts only the ones still missing.

## Starting a run

```sh
perc run owner/repo#42                                        # the default pipeline
perc run owner/repo#42 --pipeline hotfix --input severity=sev2
perc run --pipeline dd-alert --input alert_url=https://app.datadoghq.com/…   # ticket: none, run from the repo's clone
```

`--pipeline <name>` picks the pipeline. Without it, a run on a ticket uses the pipeline the issue asks for: a `pipeline:<name>` label, else the latest `/percolator run <name>` comment by an approver, else the profile's default. Without a ticket or a flag, the default is used, and if that one needs a ticket, the run is a usage error. `--input key=value` gives one input; repeat it for each. The value is everything after the first `=`, so it may hold `=`, spaces or a path. Before creating anything, `perc run` refuses an input the pipeline does not declare, a missing required input, and a ticket on a `ticket: none` pipeline (usage errors, exit code 2), and a pipeline the profile does not have. Inputs reach prompts as `{{input_<name>}}`, and intake lists them under `## Inputs` in the ticket. `--repo <dir>` runs in that repo's clone instead of the current directory.

**From the Herdr panel.** The panel starts the same `perc run`, never through `perc watch`:

- **+ New run** in the title bar (a `+` under 800px wide, the words from 800px) opens the start picker. Pick the repo first, since the pipelines come from it: the git repos of the spaces open in Herdr on this machine (spaces on another machine are left out), in space order and tagged `Open` (a space in a run worktree, `<repo>/.worktrees/<run-id>`, lists `<repo>`), then the repos earlier runs used, then **Choose folder…**. Each repo is listed once. The shown space's repo is preselected; when that space isn't in a git repo, the first open space's repo is, else the latest run's. A folder found not to be a repo is asked again each time the picker opens. While a space's repo is still being looked up, the preselection may move when it is found, until you pick, type anything or press Start in the picker (never when a key binding opened it on a named pipeline). Then pick the pipeline: the default is preselected, and each one shows its tags (`Default`, `No ticket`, `Ticket optional`) and its description. Last come the fields that pipeline asks for: a ticket field when it takes a ticket (a URL or `owner/repo#n`), and one field per input, its description as the placeholder. A typed ticket preselects the repo of the latest run on that GitHub repo.
- **▸ Run next…** in the header of a finished run, while no run on its ticket is live, opens the same picker on that run. It lists only the pipelines that take a ticket, and the ticket and repo are fixed (the repo shown at the top): the run's own ticket, or a choice among it and the issues its `issue` exit opened.
- The picker shows the exact `perc run …` line it will run. **Start** stays disabled until the pipeline's needs are met, and says why: `Pick a repo`, `Enter a ticket`, `A ticket cannot start with -` or `Enter <input>`. Enter in a field starts and Esc cancels; once started, the new run is selected.
- The picked pipeline's preview (its stages, gates, hooks, loops and exit) sits below the picker, and to its right in a window from 720px wide.
- The Herdr commands `percolator.new` (or `percolator.new/<pipeline>`, with that pipeline picked), `percolator.next` and `percolator.start` do the same from a key binding. With the panel's fixtures, Start only says `Fixture: would run perc run …`.

A ticket has at most one live run (`running` or `paused`): starting another pipeline on it is refused until that run finishes or is deleted. The run a router starts on its ticket is linked to the router's run, so it is not refused while that one is still live; neither are a fan-out's slice runs, beside their parent and each other. A run on `feature` has the id `t<n>-<date>-<time>-<rand>`, on another pipeline `t<n>-<pipeline>-…`, without a ticket `<pipeline>-…`, and a fan-out's slice `<parent>-s<i>`.

## Triage

A router is a pipeline that reads the ticket and hands it to another pipeline. Set `router: true` and end its `stages` with `route`, as the `triage` example in the [example config](configuration.md#example-config) does. The `route` stage is built in: it is never bound, and a router sets no `exit`. Mark the router `default: true` to send every `perc run <ticket>` without `--pipeline` through it.

| Key | What it does |
|---|---|
| `routes` | Label rules, `{ label, to }`, tried in order. |
| `choose` | The agent that picks when no rule matched: `agent`, `model`, `effort`, `skill(s)`, `prompt`, `command` (for `agent: command`) as on a node, `from` (the pipelines it may pick) and `confirm`: `unsure` (default) stops at the `pick-pipeline` gate only when the agent says it is unsure, `always` stops every time. |
| `fallback` | The pipeline used when nothing picked one. Default: the profile's default, or `feature` when the default is the router. |

The route step decides in this order and stops at the first answer:

1. **Named.** The issue names a pipeline: a `pipeline:<name>` label, or an approver's `/percolator run <name>` comment. A name the router cannot hand the ticket to (a `ticket: none` pipeline, or one with required inputs) is ignored, and the next step decides. (Naming one with `perc run --pipeline` skips the router altogether.)
2. **Rule.** The first `routes` rule whose label the issue has.
3. **Agent.** The `choose` agent writes `pick.md`: `pipeline: <name>`, `unsure: true|false`, then its reasons. A pick outside `from` counts as unsure. A sure pick goes ahead on its own; an unsure one (or every one, with `confirm: always`) waits at the `pick-pipeline` gate.
4. **Fallback.** `fallback`, when the agent made no valid pick and you approved without naming one, or when the router has no `choose`.

The decision goes to `route.json` in the run dir (`pipeline`, `by`: named, rule, agent, gate or fallback, and why), with the id of the child run, **before** that run starts, so a resume finds the child instead of starting a second one. The child is a new run of the chosen pipeline on the same ticket, linked to the router's run: the router's `route` output says `Routed to <pipeline> (<by>: <why>) → run <child>`, and `perc status --json` lists it under the router's `children` and gives the child's `parent`. The router's run completes once the child has started; the work goes on in the child. `perc delete` of the router's run leaves the child alone.

At the `pick-pipeline` gate:

| Answer | What happens |
|---|---|
| `perc approve <id>` | The agent's pick goes ahead, or the fallback when it made no valid pick. `perc status` names the pick: "pick the pipeline for this ticket (the agent suggests hotfix)". |
| `perc approve <id> --pipeline <name>` | `<name>` instead; it must be one of `choose.from`. `--pipeline` answers only a `pick-pipeline` gate. The panel's **Run `<name>`** buttons run this. |
| `perc reject <id> "<feedback>"` | The agent picks again with your feedback, 3 rounds at most. |

`perc validate` checks the routes across the profile: every `to`, `choose.from` entry and `fallback` must be a pipeline of the profile that takes a ticket, is not itself a router and has no required inputs (a route passes none: `… takes required inputs a <router|next> cannot pass; make them optional or route elsewhere`), and the router needs a ticket:

```text
router "triage" routes tickets, but pipeline "dd-alert" has ticket: none; route to a pipeline that takes a ticket
```

## Triggers and perc watch

`triggers` on a pipeline start runs of it without you. They fire only while `perc watch` runs: it polls each repo through `gh` and starts one run per firing, exactly as `perc run` would. Nothing fires while it is stopped, and nothing it missed is made up later, except that a schedule fires once for its latest missed time within the last 7 days.

```yaml
pipelines:                # only the keys triggers need; stages, bindings and exit as usual
  nightly:
    ticket: none
    inputs: { area: { required: true } }
    triggers:
      - { schedule: "0 6 * * 1-5", timezone: Europe/London, inputs: { area: deps } }
  triage:
    triggers:
      - { label: triage }
  review-pr:
    ticket: none
    inputs: { pr: { required: true } }
    triggers:
      - { pr_opened: { not_author: [alice] } }
      - { dependabot: true }
  fix-ci:
    ticket: none
    inputs: { branch: { required: true }, run_url: { required: true } }
    triggers:
      - { check_failed: { branch: main, workflow: ci.yml } }
```

| Trigger | Starts a run | The run gets | The pipeline needs |
|---|---|---|---|
| `schedule: "<cron>"` | On each matching minute: five fields (minute, hour, day of month, month, day of week; `*`, numbers, ranges, lists, `/steps`; 0 or 7 is Sunday), in `timezone` (an IANA name; default the machine's). | No ticket; the trigger's `inputs`. | `ticket: none` or `optional`; the `inputs` cover its required inputs. |
| `label: <name>` | Once for each open issue with the label, unless the issue already has a live run. | The issue as its ticket. | A ticket (`required` or `optional`). |
| `pr_opened: true` or `{ not_author: [<login>…] }` | On each open pull request (skipping those authors). | Input `pr`: the PR's URL. | `ticket: none` or `optional`, and input `pr`. |
| `dependabot: true` | On each open Dependabot pull request. | Input `pr`. | `ticket: none` or `optional`, and input `pr`. |
| `check_failed: { branch, workflow? }` | On each failed workflow run on the branch (of that workflow file only, when set), and again when a re-run of it fails. | Inputs `branch` and `run_url`. | `ticket: none` or `optional`, and inputs `branch` and `run_url`. |

`perc validate` refuses a pull request or check trigger on a pipeline that needs a ticket, for example:

```text
~/.percolator/config.yaml:31: profiles.default.pipelines.review-pr.triggers.0: a pr_opened trigger starts runs without a ticket; set ticket: none or ticket: optional
```

```sh
perc watch --repo ~/src/app --repo ~/src/api   # default: the current directory; --interval <s>, default 60, at least 15
perc watch stop
```

`perc watch` starts the watcher in its own hc terminal, `percolator-watch` (labelled `percolator.role=watcher`), and returns; `--foreground` runs it in yours. Each poll validates each repo's config (a broken one is logged and skipped until it is fixed). The watcher writes a heartbeat to `~/.percolator/watch/watch.json` when it starts and after each repo it polls. `perc watch stop` asks the watcher to stop: it finishes the repo it is polling, including starting any run it fired, then exits; if it has not exited after 30 s, its terminal is ended. It asks even when the heartbeat is stale, as long as the watcher's process still runs on this machine and the `percolator-watch` terminal is live; a stale heartbeat with no live watcher terminal is only forgotten (`no watcher running`), since its pid may now belong to another process. A watcher that starts ignores a leftover request for its own pid. A watcher started with `--foreground` has no terminal and is only asked to stop: if it has not exited after 30 s, `perc watch stop` exits 1 with `the watcher (pid <pid>) did not stop within 30s; end pid <pid>`, and the request stays, so the watcher still stops at its next repo unless you end it first. A second `perc watch` while one runs is refused, and so is `perc watch --foreground` while the `percolator-watch` terminal is live or `watch.json` shows another watcher alive: `perc watch is already running as pid <pid>; stop it first (perc watch stop, or end pid <pid>)`. `perc status --json` reports the watcher under `watcher`: alive while its process runs on this machine and its heartbeat is fresh. The Herdr panel shows it, with a Start watcher / Stop button (see [Herdr](integrations.md#herdr)).

Every firing has a key (the issue, PR, workflow run or schedule time it is for) and goes in the firing ledger, `~/.percolator/watch/fired.json`, with its run id **before** the run starts. So each firing starts exactly one run, even when the watcher is restarted; one that crashed before its run started is retried with the same id. The first time a schedule is polled, it only records the time, so a new watcher does not start runs for times before it began; likewise each time the watcher starts, its first poll of a `pr_opened`, `dependabot` or `check_failed` trigger records the pull requests and failed runs already there (including those that appeared while it was stopped) without starting runs (a `label` trigger does start runs for issues labelled before the watcher began). Both happen per repo: a repo whose first poll fails (say its config does not validate) gets them, and the retry of firings that crashed before their run started, on its first poll that gets through. A PR or failed run that a trigger polls for the first time while another trigger of the pipeline fires it still starts its run. A firing whose run you deleted with `perc delete` is not started again. The key of a PR or failed run is dropped from the ledger once its run was prepared (or it was only recorded as seen), it is more than a week old, and the PR is closed or the failure is no longer in gh's list of recent failed runs. A `label` trigger fires once per issue; to ask for another run, remove the label and add it again while the watcher runs (a closed issue re-arms the same way, so reopening one that still has the label starts a run). An issue that already has a live run when it is labelled starts nothing, now or when that run finishes. `perc run` never goes through the watcher. A schedule fires once per watched repo whose config has it. The watcher knows a trigger by its settings, not its place in the list: reordering triggers changes nothing, while editing one makes it a new trigger, whose first poll only records what is there (a `label` trigger still fires for labelled issues).

## Fan-out

`fan_out` runs one stage, and every stage after it, once per slice, each slice in its own linked run. Use it when an earlier stage (say `plan`) splits the work into parts that can be built, reviewed and delivered on their own: the `epic` example in the [example config](configuration.md#example-config) opens one PR per slice.

```yaml
pipelines:
  epic:
    stages: [intake, plan, implement, review, deliver]
    exit: pr
    fan_out:
      stage: implement                       # neither intake nor the exit stage
      slices: { from: plan, output: slices } # a stage before it, and the output key it writes
      max_parallel: 3                        # default 3
    bindings: { … }
```

- **Slices.** Each `## <title>` section of the `slices` output (`slices.md`) is one slice, in order. The output becomes a required output of the `from` stage, so it need not be listed under `outputs`.
- **The parent.** The run walks the stages before `stage`, then a fan-out step. That step writes the split to `fanout.json` in the run dir (each slice's index, run id and title) and starts the slice runs, keeping at most `max_parallel` unfinished at a time. It waits until every slice has finished, then completes with the `slices_done` output, one line per slice: `<i>. <title> → <PR url or status>`. The parent runs no exit of its own.
- **The slices.** Slice `i` is the run `<parent>-s<i>`, in its own worktree on branch `percolator/<parent>-s<i>`, from the parent's base. Its intake is a seed step: it copies the parent's latest outputs and its issue and writes `slice.md`, the slice's title and section. Then it runs from `stage` through the exit. A slice's PR says `Part of #N`, not `Closes #N`, so merging one leaves the issue open for the other slices, and is titled `<issue title>: <slice title>` (`<pipeline>: <slice title>` without a ticket) unless a step wrote `pr_title`. A loop in it may go back only to `stage` or later; `perc validate` refuses one that goes back further (`profiles.default.pipelines.epic.nodes.test.on_fail.back_to: test loops back to plan, which runs before the fan-out at implement; loop back to implement or later`). So `stage` cannot be a stage that loops, such as `review`, which goes back to the stage before it every round: `review loops back to implement every round, so it cannot start a fan-out slice; set fan_out.stage to implement or an earlier stage`.
- **Resume.** A resume of the parent reuses `fanout.json` and never splits again. It leaves finished slices alone and restarts the driver of an unfinished slice whose driver is gone.
- **Escalations.** If `from` wrote no `## ` sections, the parent pauses with `percolator.fan_out: plan wrote no slices (## <title> sections in slices.md); fix the output and resume`; if a section has no title, with `percolator.fan_out: slice 2 in slices.md has no title (a bare "## " heading); give it a title and resume`. If a slice run is deleted while the parent waits on it, the parent pauses with `percolator.fan_out: slice(s) <parent>-s2 deleted while running; perc resume <parent> to start it again`. If a slice pauses (an escalation or a gate) and no other slice is running, the parent pauses too, since nothing moves until the slice is answered: `percolator.fan_out: slice(s) <parent>-s2 paused; answer each (perc status <id>), then perc resume <parent>`. If a slice fails, the parent pauses once every slice has finished, naming the failed ones: `percolator.fan_out: slice(s) <parent>-s2 failed; perc delete each (its branch stays), then perc resume <parent> to run it again`. A failed run cannot be resumed, so run `perc delete <parent>-s<i>`, then `perc resume <parent>`: the parent starts that slice again, on its branch.
- **Status.** `perc status --json` lists the slices first among the parent's `children`, with their `slice` index and title (see [Integrations](integrations.md)); the Herdr panel shows one row per slice under the fan-out stage (see [Herdr](integrations.md#herdr)).
- **Delete.** `perc delete` of the parent leaves its slice runs; delete them by id.

`perc validate` prints the parent's block, whose steps end in the fan-out step (`implement: builtin percolator.fan_out`), then what each slice run walks, so you can check the slice steps and loops:

```text
slice runs (fan-out of implement, at most 3 at a time):
steps:
1. intake: builtin percolator.seed
2. implement: claude, model opus, skills superpowers:executing-plans, superpowers:test-driven-development
3. review: claude, model opus, skills deep-dive-review
4. deliver: builtin github.open_pr

back-edges:
review → implement (max 3, continue)
```

To send only big tickets through fan-out, keep it on its own pipeline and point a [router](#triage) at it, with a `routes` rule such as `{ label: epic, to: epic }` or `epic` in `choose.from`.
