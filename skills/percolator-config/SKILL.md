---
name: percolator-config
description: Use when the user wants to create or modify a Percolator config (perc): agents, models and effort per stage, prompts, which repos a profile matches, approvers, extra steps or commands before/after a stage, test or audit loops, gates, grounds and policies, rules, or the review round cap; also when they ask to make runs cheaper or to turn off the approval.
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
    bindings: { intake: …, groom: …, plan: …, implement: …, review: …, deliver: … }
    nodes: { <name>: { …, before|after: <stage>|all } }
    rules: { allowed_agents: […], allowed_models: […], max_rounds_ceiling: n, require_skills: […], required_nodes: […] }
```

Everything except `version` and `grounds` belongs to one profile. A profile inherits nothing unless it sets `extends`. Grounds are shared: every profile's `perc validate` and runs fetch all of them.

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

The command runs in the run's worktree; a non-zero exit is a fail. `max_rounds` counts failed rounds, the first run included: `2` means one retry, then the run pauses and escalates to the owner. (The review loop is different: at its cap it delivers anyway.) Each time review sends the work back to implement, the command runs again and its round count starts fresh; add `once: true` if it should not re-run at all after it has passed.

**A human sign-off after a stage**:

```yaml
nodes:
  sign-off: { kind: gate, after: plan }
```

The run waits there until the user answers, the same way as `approve-groom`; a rejection fails the run unless the gate has an `on_fail` (for the gate above, `{ back_to: plan, max_rounds: 3 }` sends a rejected plan back to be redone; `back_to` must be the gate's stage or an earlier one). Nodes on the same hook point run in the order they appear in the YAML.

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

## Agents, models and skills

- `agent` is `claude`, `codex` or `command`. `effort` (low, medium, high, xhigh, max) is for `claude` only.
- `model` goes to the agent's CLI as is: Percolator does not check it, so a typo only fails when the run starts. For claude, use what `claude --model` takes (`opus`, `sonnet`, `haiku` or a full model id). Tell the user when you set a model name you could not confirm.
- `claude` loads skills as installed plugins (`superpowers:brainstorming`). `codex` and `command` load skills only from files: a skill `ns:name` must come from a `skills` mapping out of a ground named `ns`, and a bare `name` is taken from the first mapped skills dir that has a folder of that name (ground checkouts are in `~/.percolator/grounds/<ground>@<commit12>/`, so you can look for a skill there), which may be a different skill than the claude one. Limit such a mapping with `applies_to` to the stages that need it.
- When switching a stage away from claude: remove `effort` (validation rejects it), replace or remove a claude `model` such as `opus`, and for each skill either map it from a ground or drop it. If no ground the user already has contains the skill, ask the user which repo (and ref) to add; do not pick one yourself, since every run trusts what a ground provides. Offer dropping the skill as the alternative. Tell the user which skills you dropped and which you mapped from where.

## What the config cannot do

- **Turn off the groom approval.** Every run pauses at `approve-groom` after `groom`; a rejection re-runs `groom` (at most 3 times, then escalates). It is built in, which is why `perc validate` lists it although the config never mentions it. Offer instead: `tracker.approvers` to let others approve, or answering faster with `perc approve <run-id>` or a `/percolator approve` comment on the issue. Extra gates can be added as nodes with `kind: gate`.
- **Remove or change a locked target** (`required: true` in a ground). Validation reports the lock and the file that set it; tell the user to change the ground or ask its owner.
- **Set `effort` on codex or command.** Offer to keep the stage on claude with that effort, or to switch without it.
- **Give one gate its own approvers.** `tracker.approvers` applies to all gates of the profile.
- **Bind fewer than six stages.** `intake`, `groom`, `plan`, `implement`, `review`, `deliver` must all be bound.

## 3. Edit the YAML

- Make the smallest edit that does what the user asked.
- Keep the existing comments.
- Check each key not shown in this skill against the JSON schema rather than guessing its name.

## 4. Validate

Run `perc validate --config <file> --profile <name>` once for each profile you touched.

If it reports errors in the config, fix the config and run it again until it is clean. If it fails for another reason (a ground cannot be cloned or fetched, git or the network fails), stop and show the user the error: do not change git settings or work around it. If the ground is one you just added, take it out again first (grounds are shared, so it breaks every profile), and say what it was for.

`perc validate` prints the approvers, the runtime settings the profile sets, the grounds, each mapping (with the stages it applies to, when limited), and each step with what runs it (`claude, model opus, effort high, skills …`, `command pnpm test`, `gate`, `builtin …`). Check there that every change the user asked for shows up, for each profile you touched. Then tell the user:

1. what changed, as the diff of the config;
2. anything you assumed or could not check (model names, skills you dropped, things the config cannot do);
3. the validate result.
