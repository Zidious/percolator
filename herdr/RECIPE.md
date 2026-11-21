# Percolator

Herdr's own layout (a copy of its shipped `main`, 0.1.16) plus a Percolator panel and a status-bar cup. The cup, at the right end of the status bar, says how many Percolator runs need you ("2 need you", "1 running", or "Percolator") and shows or hides the panel. The panel lists every run as a row with a mini train of the six stages, and for the run you pick shows a big train, what it waits for, the file to review, and the buttons to answer (Approve, Reject, Resume, and so on). It reads `perc status --json` and answers by running `perc`.

![Percolator](preview.png)

The screenshot shows the panel popped out into its window, with sample data from `fixtures/status.json`.

## What you see

The layout is Herdr's `main` (sidebar with spaces and agents, tabs, work area, status bar) with two additions.

**The cup.** A 150px block at the right end of the 28px status row, next to the status text. It shows a 14px mark in the text colour (a cup under five drops, the middle drop a ring) and an 11.8px label: "N need(s) you", else "N running", else "Percolator". The ring is the "blocked" colour and pulses while something needs you, the "working" colour while something runs, muted otherwise. The label is "blocked" coloured when something needs you. While the panel or its window is open the button has the "raised" background. Tooltip: "Show Percolator" or "Hide Percolator"; the connection error when there is one; "Run perc herdr link once to connect" before linking.

**The panel.** A 380px block at the right of the work area (min 280, max 900), hidden until shown. Top to bottom:

1. Title bar: the mark (ring coloured needs-you, else working, else accent), "Percolator", the chips "N need you" and "N running" (the second only when 720px or wider), the tabs Active and All, a pop-out button (⧉) and a close button (✕), always at the right. When the panel is narrow, "Percolator" truncates first, then the chip shortens to "N" (under 370px), then the tabs move to a second row (under 320px; under 300px with no chip). The word "fixtures" appears when the panel reads a sample file.
2. Board: one row per run, needing-you first, then running, then newest. A row has a status icon (pulsing dot for something that needs you, ✕ failed, spinner running, ✓ done), `#n` and the title, a mini train of six equal columns (one per core stage: intake, groom, plan, implement, review, deliver) with one segment per step coloured by status, a state line ("your turn · approve-groom", "paused · review at cap", "failed · implement", "stalled · driver stopped", "review · round 2/3", "delivered · PR #7") and the age. Narrow: two lines per row, stage names cut to four letters. Empty: the greyed mark and "No runs yet" (All) or "Nothing running, nothing waiting on you" (Active), then `perc run <owner/repo#issue>`. The board scrolls when the runs don't fit; below it a 7px divider (a 1px border line, accent while dragged, row-resize cursor) sets its height.
3. Run header: `#n title` (the ticket ref until intake has read the issue); links "issue ↗" (once its URL is known), "PR ↗" (if any), "driver pane ↗" / "hide driver pane" (when the run has a space and its driver terminal is live); then branch, started ago, short id.
4. Train: six equal zones. Inside a zone, the stage's steps in execution order (`before:<stage>` hooks, the stage's own steps, `after:<stage>` hooks; `before-all` hooks first in intake, `after-all` hooks last in deliver). Core steps are 18px round stops, hook steps ("nodes") 10px round, gates square. One marker (a ring with a train glyph; square at a gate) sits at the current step. The stage name is under each zone, coloured when current; under a core stop its duration, under a node its id. Loop arcs above the track run from the step the loop returns to, labelled "↺ review → implement · round 2 of 3"; red and "· cap" at the cap. Narrow: nodes fold into "+n" under their stop.
5. Lower half, by state:
   - Needs you: a tag (GATE, PAUSED, FAILED or STALLED), the message, the age, an optional detail line; the first review file rendered as markdown; the action buttons; a "Terminal commands" row (click to open, closed by default, the choice kept while the panel lives) listing the equivalent `perc` commands, each with a Copy button.
   - Running: "RUNNING · <step> is running for 3m. Nothing for you yet." with a "watch agent ↗" link and the agent's last 8 lines.
   - Delivered: "DELIVERED · Opened <pr>" and the history.
   - History (newest first): status mark, step id, kind, status, attempts, time taken.
   Items 3 to 5 scroll together as one region. The review file (or the history, or the agent's last lines) fills what that region has left, at least 120px, and scrolls on its own past its height; with less room the region scrolls instead.
6. Key hint row (wide only): "↑↓ runs, ←→ stops, a approve, r reject, g grant / resume, esc close".

**The window.** The panel can pop out into a floating 860x680 window (key `percolator`, remembers its place), the same view at the wider width: the full layout from 720px up.

Every colour comes from `theme()`; nothing is hard-coded, so it follows light and dark.

## How it behaves

**Statuses.** Each run is one of: needs you (a gate, a paused run, a failed run until `perc clean` removes its worktree, a stalled run whose driver stopped, or an agent that is blocked), running, done. Needs-you is the red-orange "blocked" colour with a pulsing dot; running is the "working" colour with a spinner; done is a check.

**Clicks.** Cup: toggles the panel (or the window, whichever you last used). ✕ and Esc hide it. ⧉ pops the panel out into the window and hides the docked one; ⧉ in the window docks it back and closes the window. A row, or ↑/↓, selects a run. A train stop, or ←/→, opens a strip with its kind, stage, status, attempts, time taken and its output files as links that open in the reader. The links in the run header open the issue, the PR, or toggle the driver: it starts hidden from the run's space; **driver pane ↗** labels it into the space (`hc label -- <driver> herdr.space=<space>`) and focuses it, **hide driver pane** removes the label (`herdr.space=`). Only a terminal labelled with this run and role driver is touched.

**Buttons** come from the `actions` of the run in the JSON: Approve, Reject…, Grant a round & resume, Resume, Clean up, Go to agent pane, plus GitHub ↗ for gates. Each runs `perc` with an argv array (`approve <id>`, `reject <id> <feedback>`, ...). While it runs the button shows a spinner and the others are disabled; on exit 0 the panel refreshes; on failure the first stderr line shows under the buttons. Reject… opens a feedback box under the reader (Ctrl+Enter sends, Esc cancels); empty feedback is refused with "Say what to change". Clean up asks once through Herdr's `confirm`. Approve and Reject do not confirm.

**Board height.** Drag the divider between the board and the run below: the board keeps at least two rows (or all its rows if fewer) and at most 70% of the area below the title bar; double-click resets it to 30%. The height is kept as a ratio of that area in shared state (`percolator.boardRatio`, saved by Herdr), so the docked panel and the window show the same proportion and it survives a restart; before the first drag, the older per-copy `localStorage` value `board.ratio` is used if there is one. ↑/↓ scroll the board to the selected row.

**Keys** (panel focused, not typing): ↑/↓ runs, ←/→ stops, `a` approve, `r` reject, `g` grant or resume, Esc closes the reject box, then the stop strip, then hides the panel.

**Data.** On start, on each change under `~/.percolator/runs` (about 300ms after a burst) and every 10s, the cup runs `perc status --json`, and so does the panel copy where the panel lives (docked or window) while it is shown; a copy that comes back into view refreshes at once. If a call fails, the last good board stays and a one-line error bar says what failed and what to do (`perc status --json failed: <first stderr line>; check perc is installed and run perc herdr link`). Until `perc herdr link` has run, the panel shows only "Run perc herdr link once to connect".

**Notices.** When a run newly needs you (compared with the previous refresh, never on the first load), the cup posts a warning toast "#<n> needs you" with the message; clicking it shows the panel where you last had it (docked or window) and selects that run. For an agent that is blocked, Herdr may also post its own "agent needs you" notification, so you may see two toasts.

**Where it is.** The place (docked or window) is remembered in shared state `percolator.place`. Only the copy that matches it acts on `percolator.*` commands and keys, so a docked panel and a window never both answer.

## Built from

**Where the files come from.** The `herdr/` folder of the Percolator repository, https://github.com/Zidious/percolator (private for now: you need access until it is public), next to this recipe. Copy these files as they are; build from the recipe only if they do not load on your Herdr version:

- `layouts/percolator.json`: Herdr's shipped `main` 0.1.16 (`cloned_from` records it) with two additions.
  - In `work-body` (the row after `main` and the Files/Changes `panel` column), a block `percolator-panel`: `hidden: true`, `size: {px: 380}`, `min: 280`, `max: 900`, `content: {mod: "percolator"}`. It is its own block, not a child of `panel-body`: Herdr's tabs mod hides stack children that are not in the space's `workspace.panels`, which would close the Percolator panel on every space switch.
  - In `status-row` (a row, 28px), after `status` (weight 1), a block `percolator-cup`: `size: {px: 150}`, `content: {mod: "percolator-cup"}`.
- `mods/percolator/` (the panel; plain JS, no build): `mod.json`, `main.js` (the view), `board.js`, `train.js`, `turn.js`, `ui.js`, `model.js` (pure logic, the only reader of the JSON contract), `model.d.ts` (its types), `source.js` (runs `perc status --json`, watches `~/.percolator/runs`), `mark.js`, and the art `glyph-base.svg`, `glyph-live.svg`, `train.svg`. `mod.json` is `{"place": "none", "title": "Percolator", "overlay": {"kind": "window", "width": 860, "height": 680, "key": "percolator"}}`.
- `mods/percolator-cup/` (the cup): `mod.json` (`{"place": "none", "title": "Percolator cup"}`), `main.js`, and copies of the panel's `model.js`, `mark.js` and `source.js`.
- `fixtures/status.json` and `fixtures/samples/` (`findings.md`, `groomed_ticket.md`, `implement-log.md`, the review files that `status.json` points to by relative path): a sample `perc status --json`, for trying the panel without Percolator (see Install, step 5).
- `preview.png` and this recipe are for the listing; do not copy them into Herdr.

`"place": "none"` means Herdr does not dock the mod anywhere by itself; it shows only where a layout block (`percolator-panel`, `percolator-cup`) or an overlay (the window) puts it.

**Install.** Check the Herdr version first: `herdr-app --version` (this layout was cloned from 0.1.16; on another version, check the mods and layout as below and build from this recipe if they fail). If `herdr-app` is not on PATH, run it from where Herdr installed it (on Windows `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`).

1. Herdr's app home is `~/.config/herdr-app` on every OS (on Windows, `C:\Users\<you>\.config\herdr-app`), or the folder in `HERDR_APP_HOME` if set (`perc herdr link` respects it too). Layouts live in `<home>/layouts/<name>.json`, mods in `<home>/mods/<name>/`.
2. Copy `layouts/percolator.json` to `<home>/layouts/` and the two mod folders to `<home>/mods/`. Never overwrite. The names are fixed in the code (mods `percolator` and `percolator-cup`, layout block `percolator-panel`, the `percolator.*` and `percolator-cup.*` commands and shared-state keys), so renaming is not supported: if `layouts/percolator.json` or either mod folder already exists, stop and tell the person. Herdr loads new files live.
3. Check each mod: `herdr-app check <home>/mods/percolator` and `herdr-app check <home>/mods/percolator-cup`. Each prints `check passed: <folder>` and exits 0; on failure it prints the error and exits nonzero. (The check may add `gpui-kit.d.ts` and `jsconfig.json` to the mod folder; they are Herdr's and harmless.)
4. Switch to the layout: `herdr-app do layout.switch --name percolator` (or `ctrl-shift-l` until it shows; the same key cycles back to the person's layout). It returns with no error and the window redraws. Confirm with `herdr-app status`: its JSON has `"layout": "percolator"` and `"errors": []`.
5. Connect to perc. Both mods read only `<home>/mods/percolator/perc.json` (the cup carries the panel's `source.js`, which always looks in that folder). Either:
   - (a) Fixtures, written by hand: `{"fixtures": "<path to herdr/fixtures/status.json>"}`, for example `{"fixtures": "C:/Users/you/percolator/herdr/fixtures/status.json"}` (forward slashes, or doubled backslashes, in JSON). Keep `fixtures/samples/` beside `status.json`: the review and output paths inside it are relative to that file's folder. A relative `fixtures` path works too, resolved against `<home>/mods/percolator/`; use an absolute one.
   - (b) Real runs. You need Node 24 or later (it runs the `.ts` sources directly), pnpm 12 or later (https://pnpm.io/installation) and a checkout of the Percolator repository: `git clone https://github.com/Zidious/percolator`, then in it `pnpm install --frozen-lockfile`. After step 2, run `node src/cli.ts herdr link` in the checkout (`perc herdr link` only if `perc` is installed on PATH). It writes `perc.json` as `{"node": "<absolute path of node>", "cli": "<absolute path of perc's cli>"}`. It fails with `perc herdr link: no Herdr config at <home>; install Herdr first` if the home does not exist, and with `perc herdr link: <home>/mods/percolator not found; add the Percolator layout to Herdr first (see herdr/RECIPE.md)` if the panel mod is not copied yet. Linking replaces fixtures mode; moving or reinstalling the checkout means linking again.
6. Reload the mods, because `perc.json` is read when they start: save a file in `<home>/mods/percolator/` and in `<home>/mods/percolator-cup/` (Herdr reloads every copy of a mod when any file in its folder is saved; rewrite `main.js` with its own content), or restart Herdr. Confirm the reload: `herdr-app status` shows `"errors": []`, and the cup's tooltip no longer says "Run perc herdr link once to connect".

Shipped mods used: `workspace-chrome`, `spaces`, `agents`, `tabs`, `files`, `changes`, `pane`, `workspace-status` (all from `main`).

`herdr` functions used: `exec` (runs `perc`), `readTextFile`, `watchFolder`, `appHome`, `home`, `layout`, `run` (`layout.show`, `layout.hide`, `pane.focus`), `hc` and `terminals` (the agent's last lines and whether a terminal is live; perc gives hc terminal names, matched against `terminals()` names or addresses, and `hc read` and `pane.focus` get the address), `openOverlay` and `closeOverlay`, `props`, `shared` and `setShared`, `nextCommand`, `notify`, `checking`, `theme`; Clean up opens Herdr's shipped `confirm` mod as an overlay. Shared state keys: `percolator.place` (`"panel"` or `"window"`), `percolator.window` (the open window's overlay id), `percolator.focus` (`{run, at}`: the run to select). Commands: `percolator.*` (`key/<key>`, `clean/<id>`, `place`, `focus`) and `percolator-cup.*` (`open/<run-id>`, `toggle`). The window opens with `openOverlay({kind: "window", key: "percolator", keep: true, mod: "percolator", width: 860, height: 680})`.

Programs it runs: `node <cli> status --json` and, for the buttons, `node <cli> approve|reject|resume|clean|...`, where `node` and `<cli>` come from `mods/percolator/perc.json`: `{"node": "<absolute path of node>", "cli": "<absolute path of perc's cli>"}`. `perc herdr link` writes this file. It runs `node` directly, with no shell, so it works on Windows (no `.cmd` shim) and does not depend on PATH.

The data contract is the output of `perc status --json` (schema field `schema`); `model.js` is its only reader.

## Watch out

- **This is a copy of Herdr's `main` 0.1.16.** It does not follow later changes to `main`. To pick those up, re-add the listing afresh, or copy the two additions (the `percolator-panel` and `percolator-cup` blocks) into your own layout.
- **The mod runs programs and reads your files.** It runs `node` with perc's CLI and reads `~/.percolator/runs`, the review files and outputs perc points to, and `mods/percolator/perc.json`. It makes no network calls. Tell the person before adding it.
- **`perc herdr link` is required for real runs** (Install, step 5). Until `perc.json` exists the panel and cup show "Run perc herdr link once to connect" (the panel shows nothing else; the cup's label stays "Percolator"); an unreadable `perc.json` counts as missing.
- **Herdr refuses imports across mod folders.** That is why `mods/percolator-cup/` has its own copies of the panel's `model.js`, `mark.js` and `source.js`. They must stay byte-identical: edit the panel's file, then copy it over the cup's. In a repo checkout only: `node --test tests/herdr/cup.test.ts` checks they are equal.
- **Mods-only install** (no layout copy, so no cup, no docked panel and no notices): copy `mods/percolator/` only, then connect as in Install, step 5. Open the window with the command `mod.open` and the name `percolator`. To bind a key, add this to `<home>/keys.json` (merge into the person's file; ask before replacing a key they use): `{"global": {"ctrl-alt-p": "mod.open:percolator"}}`. With the cup installed, `"ctrl-alt-p": "percolator-cup.toggle"` toggles the panel instead.
- **The window uses key `percolator` with `keep: true`**, so it remembers its place; the docked block is `percolator-panel`.
- **One copy acts.** The docked panel and the window can both exist; only the one matching `percolator.place` handles `percolator.*` commands and keys.
- **Two toasts.** For a blocked agent Herdr may also post its own "agent needs you" notification next to the cup's.

## Done when

Items marked (eyes) need the person to look at the window; the rest an agent can check.

- `herdr-app check` on `mods/percolator/` and on `mods/percolator-cup/` prints `check passed`.
- After the switch (Install, step 4), `herdr-app status` shows `"layout": "percolator"`; (eyes) Herdr's normal layout appears with the cup at the right end of the status bar, labelled "Percolator" (its tooltip, before any `perc.json` exists, reads "Run perc herdr link once to connect").
- With `perc.json` set to the fixture and the mods reloaded: (eyes) the cup reads "N need you" with a pulsing ring; a click shows the 380px panel with the board, and the title bar says "fixtures".
- (eyes) The panel stays open after you switch to another space.
- (eyes) Selecting the gate run shows a GATE tag, the groomed ticket rendered as markdown, and Approve, Reject… and GitHub ↗ buttons; Approve says what it would run (fixtures mode).
- (eyes) ⧉ closes the docked panel and opens the 860x680 window with the same content; ⧉ in the window closes it and docks the panel again.
- (eyes) Cup click, ✕ and Esc each hide a shown panel; a click on a "needs you" toast shows the panel on that run.
- After `perc herdr link` and a mod reload: (eyes) the panel and cup show your real runs, the same as `perc status --json`, and the "Run perc herdr link once to connect" tooltip is gone.
- (eyes) A light and a dark appearance both read well.
