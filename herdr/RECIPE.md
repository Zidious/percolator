# Percolator

Herdr's own layout (a copy of its shipped `main`, 0.1.16) plus a Percolator panel and a status-bar cup. The cup, at the right end of the status bar, says how many Percolator runs need you ("2 need you", "1 running", or "Percolator") and shows or hides the panel. The panel lists every run as a row with a mini train of the six stages, and for the run you pick shows a big train, what it waits for, the file to review, and the buttons to answer (Approve, Reject, Resume, and so on). It reads `perc status --json` and answers by running `perc`.

![Percolator](preview.png)

## What you see

The layout is Herdr's `main` (sidebar with spaces and agents, tabs, work area, status bar) with two additions.

**The cup.** A 150px block at the right end of the 28px status row, next to the status text. It shows a 14px mark in the text colour (a cup under five drops, the middle drop a ring) and a 11.8px label: "N need(s) you", else "N running", else "Percolator". The ring is the "blocked" colour and pulses while something needs you, the "working" colour while something runs, muted otherwise. The label is "blocked" coloured when something needs you. While the panel or its window is open the button has the "raised" background. Tooltip: "Show Percolator" or "Hide Percolator"; the connection error when there is one; "Run perc herdr link once to connect" before linking.

**The panel.** A 380px block at the right of the work area (min 280, max 900), hidden until shown. Top to bottom:

1. Title bar: the mark (ring coloured needs-you, else working, else accent), "Percolator", the chips "N need you" and "N running" (the second only when 720px or wider), the tabs Active and All, a pop-out button (⧉) and a close button (✕). The word "fixtures" appears when the panel reads a sample file.
2. Board: one row per run, needing-you first, then running, then newest. A row has a status icon (pulsing dot for something that needs you, ✕ failed, spinner running, ✓ done), `#n` and the title, a mini train of six equal columns (one per core stage: intake, groom, plan, implement, review, deliver) with one segment per step coloured by status, a state line ("your turn · approve-groom", "paused · review at cap", "failed · implement", "stalled · driver stopped", "review · round 2/3", "delivered · PR #7") and the age. Narrow: two lines per row, stage names cut to four letters. Empty: the greyed mark and "No runs yet" (All) or "Nothing running, nothing waiting on you" (Active), then `perc run <owner/repo#issue>`.
3. Run header: `#n title`; links "issue ↗", "PR ↗" (if any), "driver pane ↗" (if its terminal is live); then branch, started ago, short id.
4. Train: six equal zones. Inside a zone, the stage's steps in execution order (`before:<stage>` hooks, the stage's own steps, `after:<stage>` hooks; `before-all` hooks first in intake, `after-all` hooks last in deliver). Core steps are 18px round stops, hook steps ("nodes") 10px round, gates square. One marker (a ring with a train glyph; square at a gate) sits at the current step. The stage name is under each zone, coloured when current; under a core stop its duration, under a node its id. Loop arcs above the track run from the step the loop returns to, labelled "↺ review → implement · round 2 of 3"; red and "· cap" at the cap. Narrow: nodes fold into "+n" under their stop.
5. Lower half, by state:
   - Needs you: a tag (GATE, PAUSED, FAILED or STALLED), the message, the age, an optional detail line; the first review file rendered as markdown; the action buttons; a line with the equivalent `perc` commands.
   - Running: "RUNNING · <step> is running for 3m. Nothing for you yet." with a "watch agent ↗" link and the agent's last 8 lines.
   - Delivered: "DELIVERED · Opened <pr>" and the history.
   - History (newest first): status mark, step id, kind, status, attempts, time taken.
6. Key hint row (wide only): "↑↓ runs, ←→ stops, a approve, r reject, g grant / resume, esc close".

**The window.** The panel can pop out into a floating 860x680 window (key `percolator`, remembers its place), the same view at the wider width: the full layout from 720px up.

Only theme colours are used (`theme()`), so it follows light and dark.

## How it behaves

**Statuses.** Each run is one of: needs you (a gate, a paused run, a failed run, a stalled run whose driver stopped, or an agent that is blocked), running, done. Needs-you is the red-orange "blocked" colour with a pulsing dot; running is the "working" colour with a spinner; done is a check.

**Clicks.** Cup: toggles the panel (or the window, whichever you last used). ✕ and Esc hide it. ⧉ pops the panel out into the window and hides the docked one; ⧉ in the window docks it back and closes the window. A row, or ↑/↓, selects a run. A train stop, or ←/→, opens a strip with its kind, stage, status, attempts, time taken and its output files as links that open in the reader. The links in the run header open the issue, the PR, or focus the driver pane (`pane.focus`).

**Buttons** come from the `actions` of the run in the JSON: Approve, Reject…, Grant a round & resume, Resume, Clean up, Go to agent pane, plus GitHub ↗ for gates. Each runs `perc` with an argv array (`approve <id>`, `reject <id> <feedback>`, ...). While it runs the button shows a spinner and the others are disabled; on exit 0 the panel refreshes; on failure the first stderr line shows under the buttons. Reject… opens a feedback box under the reader (Ctrl+Enter sends, Esc cancels); empty feedback is refused with "Say what to change". Clean up asks once through Herdr's `confirm`. Approve and Reject do not confirm.

**Keys** (panel focused, not typing): ↑/↓ runs, ←/→ stops, `a` approve, `r` reject, `g` grant or resume, Esc closes the stop strip, then the reject box, then hides the panel.

**Data.** On start, on each change under `~/.percolator/runs` (about 300ms after a burst) and every 10s, the panel and the cup each run `perc status --json`. If a call fails, the last good board stays and a one-line error bar says what failed and what to do (`perc status --json failed: <first stderr line>; check perc is installed and run perc herdr link`). Until `perc herdr link` has run, the panel shows only "Run perc herdr link once to connect".

**Notices.** When a run newly needs you (compared with the previous refresh, never on the first load), the cup posts a warning toast "#<n> needs you" with the message; clicking it shows the panel where you last had it (docked or window) and selects that run. For an agent that is blocked, Herdr may also post its own "agent needs you" notification, so you may see two toasts.

**Where it is.** The place (docked or window) is remembered in shared state `percolator.place`. Only the copy that matches it acts on `percolator.*` commands and keys, so a docked panel and a window never both answer.

**Light and dark.** Colours come from `theme()` only; nothing is hard-coded.

## Built from

Files (all in this folder, copied as they are):

- `layouts/percolator.json`: Herdr's shipped `main` 0.1.16 (`cloned_from` records it) with two additions.
  - In `work-body` (the row after `main` and the Files/Changes `panel` column), a block `percolator-panel`: `hidden: true`, `size: {px: 380}`, `min: 280`, `max: 900`, `content: {mod: "percolator"}`. It is its own block, not a child of `panel-body`: Herdr's tabs mod hides stack children that are not in the space's `workspace.panels`, which would close the Percolator panel on every space switch.
  - In `status-row` (a row, 28px), after `status` (weight 1), a block `percolator-cup`: `size: {px: 150}`, `content: {mod: "percolator-cup"}`.
- `mods/percolator/`: the panel. Plain JS, no build. `mod.json` is `{"place": "none", "title": "Percolator", "overlay": {"kind": "window", "width": 860, "height": 680, "key": "percolator"}}`. `main.js` (view), `board.js`, `train.js`, `turn.js`, `ui.js`, `model.js` (pure logic, typed by `model.d.ts`), `source.js` (runs `perc status --json`, watches `~/.percolator/runs`), `mark.js`, and the art `glyph-base.svg`, `glyph-live.svg`, `train.svg`.
- `mods/percolator-cup/`: the cup. `mod.json` is `{"place": "none", "title": "Percolator cup"}`. `main.js` plus copies of the panel's `model.js`, `mark.js` and `source.js`.
- `fixtures/status.json` and `fixtures/samples/`: a sample `perc status --json` for trying the panel without Percolator. If `mods/percolator/perc.json` is `{"fixtures": "<path to status.json>"}` the panel and the cup read that file and the buttons only say what they would run.

Shipped mods used: `workspace-chrome`, `spaces`, `agents`, `tabs`, `files`, `changes`, `pane`, `workspace-status` (all from `main`).

`herdr` functions used: `exec` (runs `perc`), `readTextFile`, `watchFolder`, `appHome`, `home`, `layout`, `run` (`layout.show`, `layout.hide`, `pane.focus`), `hc` and `terminals` (the agent's last lines and whether a terminal is live), `openOverlay` and `closeOverlay`, `props`, `shared` and `setShared`, `nextCommand`, `notify`, `checking`, `theme`; Clean up opens Herdr's shipped `confirm` mod as an overlay. Shared state keys: `percolator.place` (`"panel"` or `"window"`), `percolator.window` (the open window's overlay id), `percolator.focus` (`{run, at}`: the run to select). Commands: `percolator.*` (`key/<key>`, `clean/<id>`, `place`, `focus`) and `percolator-cup.*` (`open/<run-id>`, `toggle`). The window opens with `openOverlay({kind: "window", key: "percolator", keep: true, mod: "percolator", width: 860, height: 680})`.

Programs it runs: `node <cli> status --json` and, for the buttons, `node <cli> approve|reject|resume|clean|...`, where `node` and `<cli>` come from `mods/percolator/perc.json`: `{"node": "<absolute path of node>", "cli": "<absolute path of perc's cli>"}`. `perc herdr link` writes this file. It runs `node` directly, with no shell, so it works on Windows (no `.cmd` shim) and does not depend on PATH.

The data contract is the output of `perc status --json` (schema field `schema`); `model.js` is its only reader.

## Watch out

- **This is a copy of Herdr's `main` 0.1.16.** It does not follow later changes to `main`. To pick those up, re-add the listing afresh, or copy the two additions (the `percolator-panel` and `percolator-cup` blocks) into your own layout.
- **The mod runs programs and reads your files.** It runs `node` with perc's CLI and reads `~/.percolator/runs`, the review files and outputs perc points to, and `mods/percolator/perc.json`. It makes no network calls. Tell the person before adding it.
- **`perc herdr link` is required.** Install Percolator, add the layout and mods, then run `perc herdr link` (from a Percolator checkout: `node src/cli.ts herdr link`). It writes `perc.json` into the installed `mods/percolator/` folder, so it fails if the mod is not installed yet. Without it the panel and cup show "Run perc herdr link once to connect".
- **`perc.json` is read when the mods start.** After linking, reload both mods: save any file in `mods/percolator/` and in `mods/percolator-cup/` (Herdr reloads a mod when a file in its folder is saved; `touch main.js` does it), or restart Herdr.
- **Herdr refuses imports across mod folders.** That is why `mods/percolator-cup/` has its own copies of the panel's `model.js`, `mark.js` and `source.js`. They must stay byte-identical: edit the panel's file, then copy it over the cup's.
- **Mods-only install** (no layout copy, so no cup and no docked panel): copy `mods/percolator/` only. Its `mod.json` has a window overlay; open it with the command palette or a key you bind in `keys.json` (`"percolator.place"` pops the panel out). Without the cup there are no notices.
- **The window uses key `percolator` with `keep: true`**, so it remembers its place; the docked block is `percolator-panel`.
- **Take every colour from `theme()`;** hard-coded colours break light or dark.
- **One copy acts.** The docked panel and the window can both exist; only the one matching `percolator.place` handles `percolator.*` commands and keys.
- **Two toasts.** For a blocked agent Herdr may also post its own "agent needs you" notification next to the cup's.

## Done when

- `herdr-app check` on `mods/percolator/` and on `mods/percolator-cup/` reports nothing wrong.
- `layout.switch {name: "percolator"}` shows Herdr's normal layout with the cup at the right end of the status bar, labelled "Percolator".
- With `mods/percolator/perc.json` set to the fixture (`{"fixtures": "<path to herdr/fixtures/status.json>"}`), the cup reads "N need you" with a pulsing ring, and a click shows the 380px panel with the board; the title bar says "fixtures".
- The panel stays open after you switch to another space.
- Selecting the gate run shows a GATE tag, the groomed ticket rendered as markdown, and Approve, Reject… and GitHub ↗ buttons; Approve says what it would run (fixtures mode).
- ⧉ closes the docked panel and opens the 860x680 window with the same content; ⧉ in the window closes it and docks the panel again.
- Cup click, ✕ and Esc each hide a shown panel; a click on a "needs you" toast shows the panel on that run.
- After `perc herdr link` and a mod reload, the panel and cup show your real runs (`perc status --json` output), and "Run perc herdr link once to connect" is gone.
- A light and a dark appearance both read well, with no colour outside `theme()`.
