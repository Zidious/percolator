---
name: percolator-config
description: Use when the user wants to create or modify a Percolator config (perc): agents, models and effort per stage, prompts, pipelines and their inputs and exits, triage routers, triggers that start runs (perc watch), fan-out of a stage over slices, which repos a profile matches, approvers, extra steps or commands before/after a stage, test or audit loops, gates, grounds and policies, rules, or the review round cap; also when they ask to make runs cheaper or to turn off the approval.
---

# Configuring Percolator

You help the user create or change a Percolator config file. Your only actions are running `perc` commands and editing the YAML config.

References: the Percolator package's `schema/percolator.schema.json` describes every key; the shape and recipes below cover the common changes, so read the schema only for a key they do not mention.

## Local development

If the user is working in a checkout of the Percolator repository rather than an installed package, `perc` may not be on the PATH. Run every `perc` command in this skill from the checkout root as `node src/cli.ts …` (Node 24 runs the TypeScript directly), or run `pnpm build` once and use `node dist/cli.js …`. Use `perc` only when `perc --help` works.

## 1. Find the config

The config is `~/.percolator/config.yaml`, unless the user names another file.

- If it does not exist, run `perc init` (or `perc init --config <file>` for a named file). It writes the recommended config, with one profile named `default`. Never write the recommended config by hand or copy it from anywhere else.
- If it exists, read it. Do not use `perc init --force` unless the user explicitly asks to replace the file.

## 2. Ask what to change

Ask one question at a time and wait for the answer; skip what the request already answers. Topics:

- the agent, model and effort for each stage
- the prompt for each stage
- which repositories the profile matches
- who may approve at the gate
- extra steps before or after a stage: an agent, a command, or a gate
- grounds and the `use:` mappings that draw policies, skills or prompts from them
- the review loop cap (`max_rounds`)
- another pipeline: a run with its own stages, inputs and exit (see "Pipelines")
- a triage router that hands each ticket to the pipeline that fits (see "Routers")
- triggers that start runs on a schedule, a label, a pull request or a failed check (see "Triggers")
- running a stage once per slice of a plan, each slice in its own PR (see "Fan-out")

Stop asking when the user has nothing more to change.

If the request asks for something the config cannot do (see "What the config cannot do"), say so in your first reply, before editing anything, and offer the nearest thing it can do.

## Where keys go

```yaml
version: 1
grounds:                        # top level, shared by all profiles
  <name>: { git: <url>, ref: <branch|tag|commit> }   # or { path: <dir> }
profiles:                       # checked in order: the FIRST whose match fits wins
  <profile>:
    extends: <other profile>                         # optional: start from that profile
    match: { remote: "github.com/<owner>/*" }        # or { path: "~/src/**" }
    tracker: { kind: github, approvers: [<login>, …] }
    runtime: { base: main, worktree_root: …, keep_terminals: false, space: true }
    trust_repo_config: false
    use: [ { from: <ground>, file|dir: …, as: policy|context|skills|plugins|prompt|graph, applies_to: [<stage>…], required: true } ]
    pipelines:
      feature:                                       # the ticket → PR pipeline; the recommended config binds it here
        default: true                                # what perc run uses without --pipeline
        bindings: { intake: …, groom: …, plan: …, implement: …, review: …, deliver: … }
        nodes: { <name>: { …, before|after: <stage>|all } }
      <other>: { stages: [intake, …, <exit stage>], ticket: …, inputs: …, outputs: …, exit: …, next: …, triggers: […], fan_out: { stage: …, slices: { from: …, output: … }, max_parallel: 3 }, bindings: …, nodes: …, rules: … }
      <router>: { router: true, stages: [intake, route], routes: […], choose: { … }, fallback: …, triggers: […] }
    bindings: { … }                                  # top-level bindings and nodes also belong to feature
    nodes: { … }
    rules: { allowed_agents: […], allowed_models: […], max_rounds_ceiling: n, require_skills: […], required_nodes: […] }   # every pipeline; max_rounds_ceiling caps every loop (review, any stage with max_rounds, on_fail.max_rounds)
```

Everything except `version` and `grounds` belongs to one profile. Edit the feature pipeline where the config already has it: the recommended config keeps its bindings and nodes under `pipelines.feature`; an existing config may keep them at the top of the profile instead, and then you edit them where they already are (do not move them under `pipelines.feature`). To add another pipeline to such a profile, a new `pipelines:` block can sit beside them. If one profile sets the same stage or node in both places, `pipelines.feature` wins. Top-level `rules` apply to every pipeline; `pipelines.<p>.rules` to that one only. A profile inherits nothing unless it sets `extends`. Grounds are shared: every profile's `perc validate` and runs fetch all of them.

`tracker.kind: github` is required whenever `tracker` is set. Setting `approvers` replaces the default (the gh user running `perc`): ask for the user's own GitHub login and add it too if they should still approve. Approvers are GitHub logins (not display names, case does not matter) and count at every gate of the profile.

## Recipes

**Run a command after a stage, and loop back if it fails** (tests, lint, audit):

```yaml
nodes:
  tests:
    command: [pnpm, test]          # argv array, never a shell string; {worktree}, {run_dir}, {outputs_dir} are filled in
    after: implement
    on_fail: { back_to: implement, max_rounds: 2 }
```

The command runs in the run's worktree; a non-zero exit is a fail. `max_rounds` counts failed rounds, the first run included: `2` means one retry, then the run pauses and escalates to the owner. (The review loop is different: at its cap it asks the owner which findings to fix.) Each time review sends the work back to implement, the command runs again and its round count starts fresh; add `once: true` if it should not re-run at all after it has passed. A hook sits on a stage's edge: `after: implement` and `before: review` both place a node between implement and review, so pick the one that reads best (several nodes on one hook point run in YAML order).

**A human sign-off after a stage**:

```yaml
nodes:
  sign-off: { kind: gate, after: plan }
```

The run waits there until the user answers, the same way as `approve-groom`. A rejection sends the run back, with the feedback, to the stage the gate follows: `after: X` to X, `before: X` to the stage before X, and a gate in a stage's binding to that stage after another node of it, else to the stage before. Back to intake, the feedback goes to the first stage with an agent (groom). That is 3 rounds at most (clamped by `max_rounds_ceiling`), then the run escalates. A gate after a looping stage's work (`after: review`, or after a node in the binding of `review` or a stage with `max_rounds`) counts its reject as a round of that loop; one before it (`before: review`) goes back at once, before the stage runs. Give the gate an `on_fail` to send it elsewhere (`{ back_to: implement, max_rounds: 2 }`; `back_to` must be the gate's stage or an earlier one). A gate without `on_fail` that has nowhere to go back to is refused by `perc validate`: `before: all`, `after: all` (give it an `on_fail`), `before: intake`, and a gate after the exit stage (`after: deliver`, `after: route` in a router), since a reject would deliver again: attach it before the exit stage or give it an `on_fail`. Nodes on the same hook point run in the order they appear in the YAML.

**Make a stage follow a file** (policy, coding standards): the file must come from a ground. For a local file, add its directory as a ground:

```yaml
grounds:
  policies: { path: "~/src/policies" }
profiles:
  default:
    use:
      - { from: policies, file: security.md, as: policy, applies_to: [implement, review], required: true }
```

`as: policy` is a rule the agent must follow; `as: context` is background reading. `required: true` stops later layers (team grounds, the repo's own config) from changing or dropping it; it does not stop anyone editing this file.

**A second set of repos with different settings** ("same as my normal setup, except…"): add a profile that extends the normal one, with its own `match`, and only the keys that differ. Place it above any profile whose `match` would also fit those repos (for example above `default` with `github.com/*/*`):

```yaml
profiles:
  acme:
    extends: default
    match: { remote: "github.com/acme/*" }
    tracker: { kind: github, approvers: [bob] }
    bindings:
      implement:                     # replaces default's implement binding whole: restate what should stay
        agent: codex
        skills: [superpowers:executing-plans]
  default: …
```

What `extends` takes from the other profile: its bindings, nodes, rules and `use` (this profile replaces a binding or node by name, as a whole: a binding written here must restate every key it should keep, such as skills and prompt; mappings are added; the other profile's `required: true` still locks), and its `tracker` and `runtime` unless this profile sets them, each as a whole block. It never takes `match` or `trust_repo_config`. One level only: the profile you extend must not itself extend another.

**Make runs cheaper**: per stage, a smaller `model`, a lower `effort` (claude only), and for review a lower `max_rounds`. Each makes the stage less thorough; ask which one the user wants. Then list every other stage and node still on the expensive model (with the recommended config: `plan`, `implement` and `pr-description`) so the user can decide about them too.

## Pipelines

A profile can run more than one kind of work. Each entry under `pipelines:` is a pipeline: its own stages, inputs, outputs and exit. `feature` (intake, groom, plan, implement, review, deliver, ending in a PR) is the built-in one. Names start with a lower-case letter, then lower-case letters, digits and `-`, at most 24 characters.

```yaml
pipelines:
  dd-alert:
    description: Diagnose a Datadog alert and write a report      # shown by perc pipelines
    ticket: none                     # required (default), optional or none: this one runs without an issue
    inputs:
      alert_url: { required: true, description: Link to the alert }
    stages: [intake, gather, diagnose, report]   # intake first; the last stage is the exit stage
    outputs:
      gather: [evidence]             # the stage must write outputs/evidence.md
      diagnose: [diagnosis]
    exit: none                       # how the run ends: pr, comment, issue, none, release, pr_review, private_fork_pr (see "Exits")
    bindings:
      gather: { agent: claude, model: sonnet, prompt: "Collect what {{input_alert_url}} points at into evidence.md." }
      diagnose: { agent: claude, model: opus }
```

- `stages` is required for every pipeline but `feature`. `intake` must come first; when it is unbound it runs `github.intake`, which reads the issue into `ticket.md`. Every other stage needs a binding under `pipelines.<p>.bindings`, except the last one when `exit:` is set (Percolator binds the exit's builtin there). `all`, `before-all` and `after-all` are reserved: they cannot be stage names.
- `outputs` lists the keys each stage must write; a stage left out needs none, except groom, plan, implement and review, which keep their feature outputs unless listed. The `feature` stages keep their fixed outputs (groomed_ticket, plan, summary, findings, pr_url).
- `inputs` are named values a run gets with `perc run --input <name>=<value>` (repeat `--input` for each); `required: true` refuses a run without it, and an unknown name is refused too. Input names start with a lower-case letter, then lower-case letters, digits and `_`, at most 32 characters. Prompts read them as `{{input_<name>}}`.
- `ticket: none` means the pipeline takes no issue: `perc run` with a ticket is refused, and the run starts with `perc run --pipeline <name> --input …` alone. Its intake writes the inputs as the ticket (`ticket.md`), its PR (if any) has no `Closes #N`, and its gates are answered with `perc approve`/`perc reject` or the panel, since there is no issue to comment on. A ticketless run needs the repo to have an `origin` remote. `ticket: optional` takes a ticket or not.
- `default: true` marks the pipeline `perc run` uses without `--pipeline`; at most one per profile. Without one, `feature` is the default.
- A stage named `review` loops back to the stage before it (3 rounds unless its binding sets `max_rounds`); any other stage loops the same way when its binding sets `max_rounds`.
- Hooks (`before`/`after`) must name a stage of their own pipeline, or `all`.
- The `approve-groom` gate is built into `feature` only, after its `groom` stage. Another pipeline gets no gate unless you add one as a node with `kind: gate`.

Start one with `perc run [<ticket>] --pipeline <name> [--input key=value]…`. Without `--pipeline`, `perc run <ticket>` uses a `pipeline:<name>` label on the issue, else the latest `/percolator run <name>` comment by an approver, else the profile default. `perc pipelines` lists the pipelines a repo can use, with their ticket mode, exit and inputs. Validate each pipeline you touched: `perc validate --config <file> --profile <name> --pipeline <pipeline>` (without `--pipeline` it checks all of them).

## Exits

The last stage of every pipeline is its exit: a builtin Percolator runs itself, never an agent. Set `exit:` and leave the stage unbound (Percolator binds the builtin), or bind the stage to the builtin; if you do both, they must agree. Each exit reads an output an earlier stage writes, so put that key under `outputs:` of the stage before it, and tell that stage's agent to write it.

| `exit` | Builtin | Reads | Needs | Writes |
|---|---|---|---|---|
| `pr` | `github.open_pr` | `pr_body` (optional) | | `pr_url` |
| `comment` | `github.comment` | `comment` (required) | a ticket on every run: not with `ticket: none` or `optional` | `comment_url` |
| `issue` | `github.open_issues` | `issues`: one `## <title>` section per issue; none means no issues | every section titled: a bare `## ` heading escalates with `github.open_issues: draft <n> in issues.md has no title (a bare "## " heading); give it a title and resume` | `issue_urls` |
| `none` | `percolator.report` | | | nothing; outputs stay in the run dir |
| `release` | `github.release` | `tag`, `release_notes` | input `tag`, or `tag` under `outputs` of an earlier stage; a tag that already has another release escalates | `release_url` |
| `pr_review` | `github.pr_review` | `review` (required) | input `pr` | `review_url` |
| `private_fork_pr` | `github.private_fork_pr` | `pr_body` (optional) | input `advisory` (a GHSA id) | `pr_url` |

`perc validate` refuses an exit whose needs are missing and says what to declare; an input an exit needs (`pr`, `advisory`) must be declared with `required: true`. `pr_review` posts a comment review only; it never approves or requests changes. `private_fork_pr` opens the PR in the advisory's temporary private fork, without `Closes #N`.

**Approve drafted issues before they are opened** (`approve-issue`): a gate node before the exit stage, with `when_output`, so it stops only when the stage before wrote drafts:

```yaml
pipelines:
  dd-alert:
    stages: [intake, gather, diagnose, open]
    outputs: { gather: [evidence] }    # issues stays unlisted: diagnose may write no issues.md
    bindings:
      gather: { … }
      diagnose: { agent: claude, prompt: "… For each issue to open, a \"## <title>\" section in issues.md; none to open: no issues.md." }
    exit: issue
    nodes:
      approve-issue:
        kind: gate
        before: open
        when_output: issues                # no issues output: the gate passes at once and nothing is opened
        on_fail: { back_to: diagnose, max_rounds: 3 }   # a rejection redrafts
```

`when_output` is for gate nodes only. Do not list that key under `outputs:`: a listed output is required, so the gate would always stop. Without `on_fail`, a rejection goes back to the stage before `open` (here diagnose).

## Routers

A router is a pipeline that only reads the ticket and hands it to another pipeline, as a new linked run (the router's own run ends there; a run's stages never change once it starts).

```yaml
pipelines:
  triage:
    description: Hand each ticket to the pipeline that fits
    router: true
    stages: [intake, route]          # must end with route; route is built in: do not bind it, and set no exit
    routes:
      - { label: bug, to: hotfix }   # label rules, first match wins
    choose:                          # optional: an agent picks when no rule matched
      agent: claude
      model: sonnet                  # or agent: command with command: [program, ...args], as on a node (no tokens)
      from: [feature, hotfix]        # the pipelines it may pick
      confirm: unsure                # unsure (default): stop at the pick-pipeline gate only when the agent is unsure; always: every time
    fallback: feature                # optional; default the profile default (feature if the default is itself a router)
```

The route is decided in this order: a pipeline the issue names (a `pipeline:<name>` label or an approver's `/percolator run <name>` comment; the router ignores a `pipeline:<name>` label or `/percolator run <name>` comment that names a `ticket: none` pipeline or one with required inputs), then the first `routes:` rule whose label the issue has, then the `choose` agent's pick, then `fallback:`. The decision is saved in the run dir as `route.json` before the linked run starts. A matching `routes:` rule skips the pick-pipeline gate (as does a pipeline the issue names): `confirm` only covers the agent's pick, so a ticket a rule routes never waits for a human. To have every ticket confirmed, leave `routes:` out and set `confirm: always`.

- A router needs a ticket (`ticket: required`, the default), and every target (`routes[].to`, `choose.from`, `fallback`) must be a pipeline of the same profile that takes a ticket, is not a router and has no required inputs (a route passes none): validate refuses one with `… takes required inputs a <router|next> cannot pass; make them optional or route elsewhere`.
- When the run stops at the `pick-pipeline` gate, the user answers with `perc approve <run-id>` (take the agent's pick, or the fallback when it made none), `perc approve <run-id> --pipeline <name>` (a pipeline from `choose.from` instead), or `perc reject <run-id> <feedback>` (the agent picks again with the feedback, at most 3 rounds).
- To make triage the default, set `default: true` on it (and remove it from `feature`).

**Send the issues a pipeline opens through another pipeline**: on a pipeline with `exit: issue`, `next: <pipeline>` starts a linked run of that pipeline for each issue it opened, for example `next: triage`. `next:` is refused on any other exit, and its target must take a ticket and have no required inputs. `next` may not lead back to the pipeline itself, directly or through other pipelines' `next`.

## Triggers

`triggers:` on a pipeline start runs of it automatically, but only while `perc watch` runs: nothing fires while it is stopped, and missed firings are not made up later (a schedule fires once for its latest missed time, only within the last 7 days).

```yaml
pipelines:                # only the keys triggers need; stages, bindings and exit as usual
  nightly:
    ticket: none
    inputs: { area: { required: true } }
    triggers:
      - { schedule: "0 6 * * 1-5", timezone: Europe/London, inputs: { area: deps } }   # cron: minute hour day-of-month month day-of-week
  triage:
    triggers:
      - { label: triage }                          # each open issue with this label
  review-pr:
    ticket: none
    inputs: { pr: { required: true } }
    triggers:
      - { pr_opened: { not_author: [alice] } }     # or pr_opened: true; each open PR (here: not alice's), as input pr
      - { dependabot: true }                       # each open Dependabot PR, as input pr
  fix-ci:
    ticket: none
    inputs: { branch: { required: true }, run_url: { required: true } }
    triggers:
      - { check_failed: { branch: main, workflow: ci.yml } }   # each failed workflow run on the branch, and each failed re-run
```

What `perc validate` requires: `schedule` needs `ticket: none` or `optional`, a cron of five numeric fields (no names) and a known IANA `timezone` (default: the watching machine's), and its `inputs` must cover the pipeline's required inputs. `label` needs a pipeline that takes a ticket. `pr_opened`, `dependabot` and `check_failed` start runs without a ticket, so they need `ticket: none` or `optional`; validate refuses one on a pipeline that requires a ticket with `a <kind> trigger starts runs without a ticket; set ticket: none or ticket: optional`. `pr_opened` and `dependabot` pass input `pr`, and `check_failed` passes inputs `branch` and `run_url`, so the pipeline must declare them.

Then tell the user to start the watcher: `perc watch --repo <dir>` (repeat `--repo` per repo; default the current directory; `--interval <s>`, default 60, at least 15) starts it in its own terminal, and `perc watch stop` ends it. Each firing starts exactly one run, even across watcher restarts. A watcher does not backfill: each time it starts, its first poll of a `pr_opened`, `dependabot` or `check_failed` trigger records what is already open or failed (including what appeared while it was stopped) without starting runs (a `label` trigger does fire for issues already labelled). A `label` trigger fires once per issue; removing the label and adding it again (while the watcher runs) asks for another run. A run you deleted is not started again by a restarted watcher. Reordering triggers changes nothing; editing one makes it a new trigger, whose first poll only records what is there.

## Fan-out

`fan_out:` runs one stage, and every stage after it, once per slice of an earlier stage's output, each slice in its own linked run with its own branch and exit (for `exit: pr`, one PR per slice).

```yaml
pipelines:
  epic:
    stages: [intake, plan, implement, review, deliver]
    exit: pr
    outputs: { plan: [plan] }
    fan_out:
      stage: implement                       # neither intake nor the exit stage
      slices: { from: plan, output: slices } # from: a stage before stage; output: the key it writes (slices.md)
      max_parallel: 3                        # optional: slices running at once, default 3
    bindings:
      plan: { agent: claude, model: opus, prompt: "… Split the work into slices.md, one \"## <title>\" section per slice." }
      implement: { … }
      review: { … }
```

- Put `fan_out:` on a pipeline of its own (here `epic`), not on `feature`, so small tickets keep their single PR. To send big tickets there, point a router at it: a `routes:` rule (`{ label: epic, to: epic }`) or `epic` in the router's `choose.from` (see "Routers").
- Each `## ` section of the slices output is one slice; tell the `from` stage's prompt to write them. The slices key need not be listed under `outputs:`: fan-out makes it a required output of the `from` stage.
- The run (the parent) stops at the fanned stage and starts slice runs `<parent>-s<i>` (1, 2, …), each on branch `percolator/<parent>-s<i>` from the parent's base. A slice run starts with a seed step (the parent's outputs plus `slice.md`, its own section), then runs the fanned stage through the exit. The parent waits for every slice, then completes with `slices_done`, one line per slice with its PR.
- The split is saved in the parent's run dir as `fanout.json`; a resume reuses it and never splits again.
- A loop (`on_fail.back_to`, `max_rounds`) in a slice may only go back to the fanned stage or later; `perc validate` refuses one that goes back before it (`<node> loops back to <stage>, which runs before the fan-out at <fanned stage>; loop back to <fanned stage> or later`). So the fanned stage cannot be one that loops (`review`, or a stage whose binding sets `max_rounds`), since it goes back to the stage before it every round: `review loops back to implement every round, so it cannot start a fan-out slice; set fan_out.stage to implement or an earlier stage`.
- A failed slice pauses the parent once every slice has finished, with `percolator.fan_out: slice(s) <slice-ids> failed; perc delete each (its branch stays), then perc resume <parent-id> to run it again`. A failed run cannot be resumed, so the user runs `perc delete <slice-id>` and then `perc resume <parent-id>`, which starts that slice again on its branch. If the `from` stage wrote no `## ` sections, the parent pauses at the fan-out step; fix the output, then `perc resume <parent-id>`. A section with a bare `## ` heading pauses it with `percolator.fan_out: slice <n> in <output>.md has no title (a bare "## " heading); give it a title and resume`. A slice run deleted while running pauses it with `percolator.fan_out: slice(s) <slice-ids> deleted while running; perc resume <parent-id> to start it again`, and that resume starts the slice again. A paused slice, once no other slice is running, pauses it with `percolator.fan_out: slice(s) <slice-ids> paused; answer each (perc status <id>), then perc resume <parent-id>`.
- `perc delete <parent-id>` leaves the slice runs alone.

`perc validate --pipeline epic` prints the parent's steps (ending in the fan-out step, `builtin percolator.fan_out`), then a second block with what each slice run walks; check the slice steps and loops there:

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

## Agents, models and skills

- `agent` is `claude`, `codex` or `command`. `effort` (low, medium, high, xhigh, max) is for `claude` only.
- `model` goes to the agent's CLI as is: Percolator does not check it, so a typo only fails when the run starts. For claude, use what `claude --model` takes (`opus`, `sonnet`, `haiku` or a full model id). Tell the user when you set a model name you could not confirm.
- `claude` loads skills as installed plugins (`superpowers:brainstorming`). `codex` and `command` load skills only from files: a skill `ns:name` must come from a `skills` mapping out of a ground named `ns`, and a bare `name` is taken from the first mapped skills dir that has a folder of that name (ground checkouts are in `~/.percolator/grounds/<ground>@<commit12>/`, so you can look for a skill there), which may be a different skill than the claude one. Limit such a mapping with `applies_to` to the stages that need it.
- When switching a stage away from claude: remove `effort` (validation rejects it), replace or remove a claude `model` such as `opus`, and for each skill either map it from a ground or drop it. If no ground the user already has contains the skill, ask the user which repo (and ref) to add; do not pick one yourself, since every run trusts what a ground provides. Offer dropping the skill as the alternative. Tell the user which skills you dropped and which you mapped from where.

## What the config cannot do

- **Turn off the groom approval and keep groom.** Every run of the `feature` pipeline pauses at `approve-groom` after `groom`; a rejection re-runs `groom` (at most 3 times, then escalates). It is built in, which is why `perc validate` lists it although the config never mentions it, and no key removes it while `groom` is a stage. The gate belongs to groom: a `feature` whose own `stages` leave out `groom` has no `approve-groom` gate, and neither does a pipeline without groom (like `hotfix`). Offer instead: `tracker.approvers` to let others approve, answering faster with `perc approve <run-id>` or a `/percolator approve` comment on the issue, or a pipeline without groom for the tickets that need no grooming. Extra gates can be added as nodes with `kind: gate`.
- **Remove or change a locked target** (`required: true` in a ground). Validation reports the lock and the file that set it; tell the user to change the ground or ask its owner.
- **Set `effort` on codex or command.** Offer to keep the stage on claude with that effort, or to switch without it.
- **Give one gate its own approvers.** `tracker.approvers` applies to all gates of the profile.
- **Bind fewer stages than the pipeline lists.** `feature`'s `intake`, `groom`, `plan`, `implement`, `review`, `deliver` must all be bound, and so must every stage of a `feature` given its own `stages`: a `feature` with its own `stages` gets no default intake or exit binding. Another pipeline must bind every stage it lists (intake and the exit stage can come from defaults, see "Pipelines"). To run different stages, add a pipeline instead.
- **Run an agent in the exit stage.** The last stage of a pipeline is a builtin that Percolator runs itself (opening the PR, for `feature`); put agents in earlier stages or in a hook before it.

## 3. Edit the YAML

- Make the smallest edit that does what the user asked.
- Keep the existing comments.
- Check each key not shown in this skill against the JSON schema rather than guessing its name.

## 4. Validate

Run `perc validate --config <file> --profile <name>` once for each profile you touched. It checks every pipeline of the profile and prints one block per pipeline; add `--pipeline <pipeline>` to check just one.

If it reports errors in the config, fix the config and run it again until it is clean. If it fails for another reason (a ground cannot be cloned or fetched, git or the network fails), stop and show the user the error: do not change git settings or work around it. If the ground is one you just added, take it out again first (grounds are shared, so it breaks every profile), and say what it was for.

`perc validate` prints the approvers, the runtime settings the profile sets, the grounds, each mapping (with the stages it applies to, when limited), and each step with what runs it (`claude, model opus, effort high, skills …`, `command pnpm test`, `gate`, `builtin …`). Check there that every change the user asked for shows up, for each profile you touched. Then tell the user:

1. what changed, as the diff of the config;
2. anything you assumed or could not check (model names, skills you dropped, things the config cannot do);
3. the validate result.
