# Percolator — Design

*2026-11-20 · status: approved*

Percolator is a "software factory" that takes a ticket written by a PO and carries it,
stage by stage, to a reviewed pull request — the way a coffee percolator pushes water
through stages. One deterministic orchestrator walks a configurable graph; every node in
the graph is its own agent session, visible as its own terminal in the Herdr desktop app.

## 1. Intent and the why

- **Why:** the owner wants to hand a groomed ticket to agents and only be pulled in where
  a human genuinely matters — preferably at the start (is the ticket right?) and at the end
  (PR review) — instead of shepherding every step.
- **Who:** built for the owner first, for personal projects *and* for work. At work there is
  a company SDLC with mandatory skills, plus team-level policies, skills and SDLCs layered on
  top. It may be open-sourced later, so nothing about the owner or their employer is
  hardcoded.
- **Success:** `perc run <ticket>` in a Herdr terminal produces a groomed-ticket comment,
  waits for approval, then plans, implements, self-reviews (at most 3 rounds) and opens a PR,
  with each stage watchable and steerable in its own Herdr pane — and the exact same engine
  runs a stricter work pipeline purely by pointing at different grounds.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**
- Deterministic graph engine: stages, edges, gates, loop caps enforced in code.
- Required core stages with contracts; every one must be bound by config.
- Fully configurable graph: profiles and grounds add nodes and attach them via hook points.
- Layered config (core → company/team grounds → user profile → repo), with locked policies.
- Model/agent agnostic: each node chooses its agent CLI and model.
- One git worktree per ticket so several tickets in one repo run independently.
- Runs on the Herdr desktop app stack (`hc` + `herdr-app`), on the owner's plan login — no API key.
- Durable run state on disk; a run survives the orchestrator being stopped and can resume.

**Non-goals (v1, but the design must leave room for them)**
- Picking up human PR review comments as further review rounds.
- Run lifetime extending to PR merge (v1 run ends when the PR is opened).
- Retrospective node (reads the whole run's transcripts, opens improvement PRs against the
  repo and against ground repos).
- A Herdr-app mod as UI (pipeline panel, Approve button).
- Trackers other than GitHub Issues (Jira etc. via adapter later).
- Multi-user / team rollout concerns (onboarding, shared install).

**Anti-goals (would make it a failure even if it "works")**
- An orchestrator that can drift: caps, required stages or locked company policies that are
  merely *asked for* in a prompt rather than enforced.
- Superpowers (or any skill set) baked in as a default — every stage binding is explicit.
- Editing the owner's skills or grounds in place without review.
- Endless review loops chasing diminishing returns.
- Requiring an Anthropic API key or anything outside the owner's existing plan.

## 3. Constraints and environment facts

- **Platform: agnostic — Windows, Linux and macOS are all first-class** (owner's requirement).
  The owner develops on Windows 11, so Windows must never be an afterthought. Implications:
  no shell-specific scripts in the engine (spawn processes with argv arrays, never through a
  shell string); paths via Node's `path`, with `~` expanded per OS; config/cache under the
  OS-appropriate home (`~/.percolator` on all three); line endings and quoting handled when
  passing task text to `hc` (prefer writing task text to a file and passing a short instruction
  that points at it); CI runs the engine's tests on all three OSes. Herdr desktop (`hc`,
  `herdr-app`) and the agent CLIs ship for all three.
- **Herdr desktop app**, installed: `herdr-app.exe` (window) and `hc.exe` (herdr-core).
  Verified from `herdr-app --skill` and `hc --skill` on the owner's machine:
  - `hc run --bg --name <n> --cwd <dir> [--label k=v] [--outlive-parent] <argv | template task>`
    starts a persistent terminal; the first task goes in `run` (a send to a booting agent can be dropped; check `first_message.sent`).
  - `hc wait <t>` / `hc wait --children any|all`, `hc read --lines N <t>`, `hc send <t> "…"`,
    `hc get <t>`, `hc interrupt`, `hc kill`, `hc rm`. Piped output is JSON except run/exec/read.
  - Agent status comes from OSC 7501: `idle | working | done | blocked | error`.
    `blocked` = a person is needed. `send` refuses on blocked unless `--force` — never force.
  - Children end with their parent unless `--outlive-parent`.
  - Templates: `~/.config/herdr-core/templates/<name>.md`, frontmatter `name`, `description`,
    `command` (incl. model), body = instructions. Currently none are installed.
  - Codex must run with `--no-daemon`.
  - `herdr-app do space.new --name <n> --folder <dir>`, `herdr-app do tab.new …`, `herdr-app ls/status`.
    hc terminals labelled `herdr.space=<id>` (and optionally `herdr.tab=<id>`) appear in that space;
    unlabelled terminals stay hidden.
  - No worktree commands in hc/herdr-app (the older `herdr` TUI had them) → Percolator runs `git worktree` itself.
  - Mods: trusted JS (gpui-kit) in `~/.config/herdr-app/mods/<name>/`, can call `hc`, list agents,
    notify, open overlays — the v2 UI path.
- **Claude Code CLI** supports `--model`, `--plugin-dir <path>` (repeatable, session-only),
  `--append-system-prompt[-file]`, `--settings` — so a node can load a ground's plugins/skills
  without installing anything globally.
- **Auth:** agents run as their normal interactive CLIs inside hc terminals, using whatever login
  the CLI already has (the owner's Claude plan). Percolator itself never calls a model API.
- **Tracker:** GitHub Issues via the `gh` CLI for v1.

## 4. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | **Deterministic engine CLI** (`perc`, TypeScript/Node) running in a Herdr terminal, driving `hc` and `herdr-app` | More code up front; all judgement must live inside nodes. In exchange: caps, required stages and locked policies are guaranteed; orchestration costs no tokens; state is plain files so pause/resume and long-lived runs are cheap; predictable for open-source users. | **Chosen** |
| B | **Agent as orchestrator** — a lead agent session following a `percolator` skill, using the Herdr skills to spawn panes | Fastest to start and can improvise, but every guarantee becomes a request it may drift from (bad for SDLC compliance and the review cap), burns tokens on coordination, fragile to resume. | Rejected |
| — | Claude Agent SDK as the runtime | Plan-based auth for the SDK is murky; Anthropic's docs steer SDK products to API keys. Driving real CLIs in hc avoids the question and keeps it agent-agnostic. | Rejected |

Language: TypeScript on Node (**builder's call made by Claude, owner may override**) — strong
YAML/JSON-Schema tooling, agent CLIs are already npm-distributed, approachable for
contributors, runs on Windows via `npx`.

## 5. Decided design

### 5.1 Core stages (required slots with contracts)

The core defines a fixed set of **stages**. Each is a slot with an input/output contract. The
config **must** bind every slot; `perc` refuses to start if one is unbound. Percolator ships
**no default binding** — Superpowers is one example among many.

| Stage | Input | Must produce |
|---|---|---|
| `intake` | ticket reference | ticket content (title, body, existing comments) |
| `groom` | ticket content | groomed ticket — posted as a comment on the issue |
| `plan` | approved groomed ticket | an implementation plan document |
| `implement` | plan + worktree | commits on the run's branch |
| `review` | the branch diff + plan | findings, or an explicit pass |
| `deliver` | branch | an open PR |

A slot may be bound to a **single node or a small subgraph**. Example: a Superpowers-based profile binds
`plan` to two nodes — `superpowers:brainstorming` (spec) then `superpowers:writing-plans`
(implementation plan); another might use one planning skill.

The stage order above is the core spine. `review` loops back to `implement` when it returns
findings (see 5.4).

**Side effects are engine-owned** *(Claude's call)*: agents write artifacts to the run folder;
the engine (through the tracker adapter) posts the groom comment, pushes the branch and opens the
PR. So contract checks are checks on files, agents need no tracker write access, and the engine
can always add the unresolved-findings summary and pinned ground versions to the PR body. The
tracker adapter supplies built-in nodes for `intake` and `deliver`; these are integrations, not
skill defaults — agent stages (`groom`, `plan`, `implement`, `review`) still ship unbound.

### 5.2 Extension nodes and hook points

Profiles and `graph` fragments from grounds can add their own nodes and attach them at:

- `before-all`, `after-all`
- `before: <stage>`, `after: <stage>`

Examples: a security threat-model node `after: plan`; a QA-sign-off gate `before: deliver`;
later, a retrospective node `after-all`. Locked (company) nodes cannot be removed or routed
around; lower layers can only add.

- **Hooks on looping stages** *(Claude's call)*: nodes hooked `before:`/`after:` `implement` or
  `review` run every round unless marked `once: true`.
- **Outcomes and routing** *(owner decided)*: every node ends
  with `pass`, `fail` or `escalate`. A node may declare `on_fail: { back_to: <earlier stage>,
  max_rounds: N }` — a bounded loop back, enforced like the review cap. Arbitrary new edges are
  not allowed; the graph is the core spine plus hook insertions plus bounded back-edges. When a
  back-edge's cap is hit, the run escalates to the owner. (Rejected alternative: nodes may only
  pass, fail/stop or escalate.)
- **Slot subgraphs** are linear sequences in v1.

### 5.3 Node definition

Each node declares:

- `kind`: `agent` (an agent session in hc), `builtin` (deterministic engine code, e.g. tracker
  operations), `script` (a plain command run in hc), or `gate` (human approval)
- `agent`: for agent nodes, which CLI (e.g. `claude`, `codex`, `opencode`, `pi`, or a generic `command`)
- `model`
- `skills` / `plugins`: references into grounds, loaded for this session only
- `prompt`: the node's task text (template with access to run context)
- `inputs` / `outputs`: which run artifacts it reads and must write
- `escalation`: whether it may block for a human (default yes)
- limits: e.g. `max_rounds`, timeouts

Nodes of kind `gate` pause the run for human approval (see 5.5).

### 5.4 Review loop cap

`implement → review` repeats while review returns findings, up to `max_rounds` (default **3**,
configurable; a locked ground may set it). The count is enforced by the engine. When the cap is
hit with open findings, the engine does **not** loop again: it proceeds to `deliver` and the PR
body carries a summary of unresolved findings for the human.

### 5.5 Humans in the loop

- **Gate after `groom`** (core, always present): groomed ticket is posted as an issue comment
  and the run pauses until the owner approves. Approval channels: answering in the Herdr pane,
  or a `/percolator approve` comment on the issue (and/or 👍 reaction — builder may pick one for v1).
  Rejection with feedback re-runs `groom`.
- **Ad-hoc escalation anywhere:** when an agent's status goes `blocked`, the engine pauses
  *that ticket's* graph (other tickets continue), and the owner answers in the pane. The engine
  never `--force`-sends to a blocked agent.
- **Final gate:** the PR, reviewed by the owner.
- Profiles and grounds can add more gates (e.g. tech-lead sign-off on the plan).

### 5.6 Config: format, profiles, grounds

- **Format:** YAML, validated against a published JSON Schema (editor autocompletion; engine
  rejects broken config before any agent starts).

#### Grounds (where policies, skills and prompts come from)

A **ground** is any git repo (or local folder) that Percolator draws material from — like coffee
grounds the water passes through, flavouring every stage. A ground needs **no Percolator-specific
structure**: a company engineering handbook full of markdown works as-is. The owner's config
states **explicitly** which files or directories are used and what each one is.

```yaml
grounds:
  company-sdlc:
    git: git@github.com:acme/engineering-handbook.git
    ref: v2.3.1                  # exact commit pinned in percolator.lock
  team-payments:
    git: git@github.com:acme/payments-playbook.git
    ref: main
  superpowers-example:
    path: ~/dev/percolator-grounds-superpowers   # local folder, e.g. while developing it
```

- Fetched and cached by Percolator at `~/.percolator/grounds/<name>@<commit>` — not hand-managed
  clones. Exact commits pinned in `percolator.lock` beside the config that declares them. Pinned
  versions are recorded in the PR body as SDLC evidence ("built under company-sdlc@v2.3.1").
- Every referenced file/dir is checked to exist at the pinned commit **before any agent starts**;
  a renamed handbook file fails loudly rather than silently dropping a policy.

**What a mapping can be (`as:`):**

| `as:` | Meaning | How the engine uses it |
|---|---|---|
| `policy` | Binding rules (markdown) | Copied into the run record; nodes in `applies_to` are instructed to follow it; `review` explicitly checks the change against it and findings carry a **policy compliance** section |
| `context` | Non-binding reference (architecture, glossary) | Made available to nodes in `applies_to` |
| `skills` | A skill or a directory of skills | Loaded into agent sessions of nodes in `applies_to` |
| `plugins` | Agent plugins (Claude Code / Codex) | Loaded for the session only (e.g. `claude --plugin-dir`) |
| `prompt` | Markdown used as a node's task text | Referenced from a node definition |
| `graph` | Optional Percolator config fragment | For a ground that *wants* to ship nodes, hooks, bindings and locks |

`applies_to` takes stage names, node names or `"*"`.

#### Profiles

The user config `~/.percolator/config.yaml` holds named **profiles** *(Claude's call)*. A profile
is selected by matching the repo's git remote or path, overridable with `perc run --profile <name>`.
This is what switches a work repo onto company + team material without committing anything to it.

```yaml
profiles:
  personal:
    match: { remote: "github.com/<owner>/*" }
    use:
      - { from: superpowers-example, dir: skills/, as: skills, applies_to: ["*"] }
    bindings: { … }

  work:
    match: { remote: "github.com/acme/*" }
    use:
      - from: company-sdlc
        file: policies/software-development-processes.md
        as: policy
        applies_to: ["*"]
        required: true
      - from: company-sdlc
        file: policies/code-review-standards.md
        as: policy
        applies_to: [review]
      - from: team-payments
        dir: skills/
        as: skills
      - from: team-payments
        file: percolator.yaml     # only if that repo chooses to ship one
        as: graph
    bindings: { … }
    nodes: { … }
```

#### Layers, locking, policies

- **Merge order**, later overrides earlier for *unlocked* values *(Claude's call — grounds supply
  defaults, the owner has the last word on anything not locked)*:
  1. built-in core (stage contracts only, no agent bindings)
  2. `graph` fragments from grounds, in `use` order (e.g. company, then team); a fragment may
     reference other grounds; resolved depth-first, de-duplicated
  3. the selected profile
  4. optional repo config `.percolator/percolator.yaml` (never required)
  "Company" and "team" are not special to the engine — they are just grounds in order.
- **Locking:** a `graph` fragment, or the profile itself, can mark nodes, bindings, mappings or
  values `required: true`. Any later layer may add but not remove or weaken them; locks always win
  over merge order. Errors name the ground/file/line that locked a value.
- **Cross-cutting rules** *(Claude's call)*, declarable in a `graph` fragment or a profile, checked
  after merging:
  - `require_skills: { stage: <stage|*>, skills: [...] }`
  - `allowed_agents` / `allowed_models`
  - `max_rounds_ceiling`
  - `required_nodes: [...]` with their hook position
  Violations stop the run before any agent starts.

#### Agent adapters

Adapters translate a node into a launch: e.g. for Claude Code,
`claude --model <m> --plugin-dir <cached ground>/<plugin dir> … "<task>"`. Each adapter knows how
its agent loads skills/plugins and any quirks (Codex `--no-daemon`). v1 ships **three adapters**: Claude Code, Codex, and a generic
`command` adapter — a second real agent in v1 proves the engine has no Claude-only assumptions.
Agents are launched through their own CLI login (no API keys). Node completion never relies on hc
status alone: every node must write its outputs to the run folder and report via `hc send`,
which works for any agent; hc status (`blocked` etc.) is used where the agent reports it.

Illustrative bindings for a profile:

```yaml
tracker: { kind: github }
bindings:
  intake:    { builtin: github.intake }
  groom:     { agent: claude, model: haiku, prompt: { from: my-grounds, file: prompts/groom.md } }
  plan:      [ { agent: claude, skill: superpowers:brainstorming },
               { agent: claude, skill: superpowers:writing-plans } ]
  implement: { agent: claude, model: opus }
  review:    { agent: claude, skill: my:code-review, max_rounds: 3 }
  deliver:   { builtin: github.open_pr }
nodes:
  threat-model: { after: plan, agent: claude, skill: sec:threat-model }
```

### 5.7 Runtime on Herdr

Per run (`perc run <repo-or-cwd> #123`):

1. Load + merge + validate config; resolve/fetch grounds and check every mapped file exists; verify every slot bound.
2. Create a worktree + branch for the ticket (`git worktree add`), path configurable.
3. `herdr-app do space.new --name "<repo> #123" --folder <worktree>` → space id.
4. For each node: `hc run --bg --name <run>-<node> --cwd <worktree> --label herdr.space=<id> <adapter argv> "<task>"`;
   confirm `first_message.sent`; `hc wait` on it (and on messages). The task instructs the agent
   to write its outputs to the run folder and report with `hc send $HC_TERMINAL_ID` when done or stuck.
5. On `blocked`: mark the run paused-for-human; leave the terminal visible; resume waiting.
6. Check the node's outputs against its stage contract before advancing; contract failure is an
   error the node gets one retry on, then escalates.
7. Finished node terminals are killed/removed by the engine once outputs are recorded
   (configurable keep for debugging).

**Process model** *(Claude's call)*: one `perc run` process per ticket. `perc run` launches itself
in an hc terminal with `--outlive-parent` (labelled into the ticket's space) so it survives the
terminal it was typed in; node terminals are its children. Several tickets = several independent
processes, each with its own worktree, space and state file — no shared daemon, no cross-run locking.
`perc resume` re-attaches to a node terminal that is still live (found by its hc name), otherwise
relaunches that node from its recorded inputs.

**Sessions per round** *(Claude's call)*: every node execution, including each review round, is a
fresh agent session. `implement` round N gets the plan plus round N−1's findings file as input;
`review` gets the diff, the plan and prior findings. Fresh sessions keep context clean, keep the
reviewer unanchored, make each round a complete record for the retrospective, and make resume a
relaunch. Steering a live node (owner typing into its pane) is still possible.

### 5.8 Run state and record

- Run folder per run, e.g. `<worktree>/.percolator/runs/<run-id>/` or `~/.percolator/runs/<run-id>/`
  (builder picks; must not be committed to the PR): `state.json` (current node, round counters,
  gate status, ground versions), per-node `inputs/`, `outputs/`, and a saved transcript
  (`hc read` capture or the agent's own session log).
- `perc resume <run-id>` continues from the recorded node. `perc status` lists runs.
- This record is the future retrospective node's input, so it must be complete.

## 6. Later phases (designed for, not built in v1)

1. **Run until merge:** watch the PR; owner review comments become further review rounds; run
   closes at merge. Requires state to survive days (already file-based).
2. **Retrospective node** (`after-all`, post-merge): reads the whole run record, opens PRs against
   the working repo (CLAUDE.md, docs) and against ground repos (skill improvements). Never edits in place.
3. **Herdr-app mod UI:** a panel listing runs, each ticket's graph, current node, "review 2/3", and
   an Approve button for gates.
4. More tracker adapters (Jira), more agent adapters (OpenCode, Pi, Gemini…).
5. Example grounds published (e.g. `percolator-grounds-superpowers`).

## 7. Left to the builder

- CLI shape and command names beyond `run`, `resume`, `status`.
- Exact JSON Schema, merge semantics for lists vs maps (must honour locking).
- Where run folders and worktrees live by default.
- How a node signals completion beyond `hc` status (e.g. sentinel output file) — must be robust.
- Approval mechanism details for the groom gate in v1 (pane answer and/or issue comment).
- Test strategy (fake `hc`/`herdr-app`/`gh` for engine tests).
- Packaging (npm package, `npx percolator`).
