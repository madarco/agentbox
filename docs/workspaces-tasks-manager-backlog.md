# Workspaces / tasks / manager — backlog

Open work after Phase 9 (timeline). Design and history live in
[`workspaces-tasks-manager-plan.md`](./workspaces-tasks-manager-plan.md). Repo: **hub** = this repo
(`apps/hub`, `packages/relay`, `apps/cli`), **tray** = `../agentbox-tray`. Size: S < half a day,
M ≈ a day, L = several.

Suggested order: Phase 10a → 10b → 10c → 10d. Each phase is one session (branch, implement, smoke,
review, merge), as before.

## Phase 10a — Plan view fixes and dashboard (tray)

| # | Item | Size | Notes |
|---|------|------|-------|
| 1 | **"Start box with N selected" padding** | done | `BacklogHeaderView`: `horizontalPadding = 9`. |
| 2 | **Show every workspace box in Plan, even with no tasks** | done | `TaskListView.buildModel` appends a card for every other box of the workspace after the busy ones (failed creates skipped, project filter respected), with an `emptyBox` body row "No tasks · drop tasks here". Header without count/bar. Drop onto it assigns (verified with a real drag in the demo; fixture box `perf-audit`). |
| 3 | **New Box from the Manager window preselects the project** | done | Title bar New Box → sidebar project, else the project whose folder name is the workspace root's (the hub sends only `repo` = basename, same rule as the breadcrumb), else the panel's default. |
| 4 | **Last 2 timeline items on top of Plan** | done (caveat) | `TimelineStripView` above the Tasks header: two condensed `TimelineRowView`s (one line; title-only under 560pt) + View all. Plan reads `GET …/timeline?limit=2` (no `since`) on the window's normal refresh, never its own timer. **Caveat:** the route kicks the 60 s GitHub check on every read and has no param to skip it, so an open window in Plan keeps that check running too. If that matters, the hub needs e.g. `github=0`; the tray would then send it. **Hub (done):** `?sync=0` reports the last `github` status (`syncing` before any) without kicking the sync (`GithubPrSync.status`); OpenAPI + api.mdx. |
| 5   | **Manager terminal in the Timeline view too** | done | Only the inner split's top pane swaps (plan container ⇄ `TimelineView`); the split is never hidden. Verified live on a hub-run claude manager: the tmux window stays 136x15 across Plan → Timeline. |

## Phase 10b — Manager terminal (hub + tray)

The manager runs in a hub-owned tmux session (`startManagerSession`,
`packages/relay/src/workspaces/manager.ts`); the tray embeds `tmux attach` in Ghostty.

| # | Item | Size | Notes |
|---|------|------|-------|
| 6 | **Scroll wheel scrolls the screen, not up/down keys** | done | `startManagerSession` sets `mouse on` on the session only (`set-option -t =<session>: mouse on`; a bare `=<session>` target is rejected, and nothing is `-g`). Verified on tmux 3.6a through a PTY: an SGR wheel-up `\e[<64;10;10M` puts the pane in copy mode (`pane_in_mode=1`, `scroll_position=10` after three notches); with mouse off nothing happens. A pane on the alternate screen gets the wheel forwarded as a mouse event (`WheelUpPane` sends `-M`), which it ignores unless it asked for mouse — either way no more arrow keys. Live on a hub-run claude manager: claude draws on the main screen (`alternate_on=0`), and two wheel notches put the pane in copy mode. **Tray:** check click-to-focus in the Ghostty embed; with mouse on tmux takes clicks and drags (text selection needs the terminal's bypass modifier). |
| 7 | **Ctrl+Enter inserts a newline in the claude prompt** | hub: won't fix · tray: done | **Hub cannot do (a).** tmux 3.6a: `extended-keys`, `extended-keys-format` and `terminal-features` are server options, and `set-option -t <session> extended-keys on` exits 0 while setting the SERVER option. The manager runs on the user's default tmux server, so the hub leaves them alone (comment in `managerSessionOptionsArgv`). Bytes the pane read (private socket, raw read) when the client sent `\e[13;5u`: extended-keys off → `\r`; `on`, app did not ask → `\r`; `on` and the app sent `\e[>4;1m` or `\e[>4;2m` → `\e[27;5;13~` (with `extended-keys-format csi-u`: `\e[13;5u`); `always` → `\r`; off and the app asked → `\r`. Ctrl+J (`\n`) arrives as `\n` and ESC CR as `\e\r` under every setting. **claude 2.1.270** default bindings: `enter: chat:submit`, `ctrl+j: chat:newline` (the hint says `shift+enter` only on a terminal it detected); it requests `\e[>4;2m` / kitty `\e[>1u` only after probing, and has no Ctrl+Enter newline binding in the prompt, so even extended keys would not help. **Decision for the tray: (b)** — map Ctrl+Enter (and Shift+Enter) to `\n` in the manager embed. codex 0.142.3 has a configurable `insert_newline` keymap; its Ctrl+J default was not verified. **Tray (done):** `ManagerTerminalView` (TerminalView subclass) rewrites Ctrl+Return / Shift+Return (and keypad Enter) into a Ctrl+J key event in both `keyDown` and `performKeyEquivalent` (the package intercepts Ctrl+Return there). Verified live on claude 2.1.270 through the embed: `line one` Ctrl+Enter `line two` Shift+Enter `line three` gave three prompt lines, nothing submitted. |
| 8 | **Custom footer instead of the stock tmux status bar** | done | `managerSessionOptionsArgv` sets `status on`, `status-position bottom`, `status-style bg=#303030,fg=colour250` and `status-format[0]` on the session only, in the attach footer's colours (`statusLine`): blue ` agentbox ▸ manager claude · 5edc0ee0 ` block (session id head, else the manager id), the workspace name on the dark bar, and `C-b d: detach │ wheel: scroll` right-aligned (`#{prefix}`, so the user's real prefix). Static text and format variables only, no `#()`. Live smoke: `tmux show-options` lists the five options on the manager session only (another manager session and the server's `extended-keys off` untouched), and an attached client draws ` agentbox ▸ manager claude · 08e794c9  AgentBox … C-b d: detach │ wheel: scroll`. Not included: a live "boxes working" count — it needs the hub to rewrite the option on change. **Review fix:** `tmuxFormatText` also escapes `%` as `%%` (the status format goes through strftime, so a workspace named `q3-%d-review` drew a date). |
| 16 | **Warm manager terminals** | done | Switching manager or workspace felt ~1 s slow: the pane freed the Ghostty surface, waited on two hub reads, then cold-attached. **Tray:** `TerminalHostView` is now a pool keyed by tmux session. Switching parks the shown terminal instead of freeing it: `setSurfaceVisible(false)` occludes it, so Ghostty renders no frames but still parses the `tmux attach` output. A parked view is unpinned at its frame, so folding the pane doesn't squeeze its client to 0 rows; the fold parks too, it frees nothing. It keeps the last 5 hidden terminals and frees one hidden 10 min (`WarmTerminalPolicy`, unit-tested; a one-shot timer armed only while something is parked). Window close frees them all. Before a switched-to workspace's managers fetch lands, only a warm session is attached (a last-known one may have ended). A hidden terminal whose attach exits drops silently. After a fresh managers fetch, parked sessions the hub no longer names are freed. The controller keeps the last-known managers, tasks and timeline per workspace (up to 8), so a switch shows the warm terminal before the hub answers. Debug log: `manager terminal shown: warm\|cold in N ms` (subsystem `com.madarco.agentbox-tray`, category `manager`). **Pending:** a live smoke on a real hub (timings, `tmux list-clients` sizes, RSS per warm terminal). |

## Phase 10c — Compact, pinnable Manager window (tray)

| # | Item | Size | Notes |
|---|------|------|-------|
| 9 | **Responsive layout: works as a narrow side panel** | done | Under 720pt: sidebar hidden through the divider (restored on widening unless the user collapsed it), title bar dropdown (workspaces + current projects, managers, Add Workspace…), icon-only Open Hub/New Box, `N working` pill. Tasks header (< 600pt): Clear completed and Add task icon-only, summary without the box count; manager bar (< 600pt): path and status words hidden, session picker shows the agent only, Restart icon-only; box card (< 470pt): no branch/bar, Web icon-only; narrow timeline rows drop Web (the box menu has it). Min width 400pt. Checked at 1180 and 440pt in the demo. A single scripted resize from wide to 440 stops at ~564 (wide constraints clamp before compact kicks in); a second resize or a drag goes all the way. |
| 10 | **Pin on top** | done | Title bar pin: `.floating` + `.canJoinAllSpaces`/`.fullScreenAuxiliary`, `ManagerPinned`. While pinned, our other windows that become key (New Box card, details) are raised to floating so they don't open behind it; unpin restores them. Verified window layer 3. |

## Phase 10d — Timeline data and the host skill (hub)

| # | Item | Size | Notes |
|---|------|------|-------|
| 11 | **+/− lines on push rows** | done | `git.push` events carry `additions`/`deletions` (`pushLineStat`, `packages/relay/src/workspaces/push-stat.ts`): the pushed ref's tip is read in the host repo BEFORE the push (`refs/remotes/<remote>/<branch>`, or `refs/heads/<dest>` for push-host), then `git diff --shortstat old..new`; with no old tip, from the merge base with `origin/HEAD` → `origin/main\|master` → `main\|master`. One 2 s budget, undefined on any failure or an empty diff. Wired in the docker `git.push` RPC (`server.ts`), the cloud executor (`runGitRpc`; skipped for a scratch repo) and the hub's `push` / `push-host` routes (`recordAround`). OpenAPI + api.mdx updated. **Review fixes:** a rebase + force-push no longer counts the upstream it moved onto (`before` must pass `merge-base --is-ancestor`, else the default-branch merge base, same 2 s budget); the hub's push routes re-read the box fact after the op, so a box hydrated from its Store registration during the push still gets a row (without a diff). **Tray:** the event's `additions`/`deletions` are top-level; `TimelineItem` folds them only into a `pr`, so a push row needs to keep them. **Tray (done):** `TimelineItem` decodes top-level `additions`/`deletions`; a `Pushed` row shows the branch link then `+N −N` (no base arrow); fixture push `feat/charge-backoff +97 −18`. |
| 12 | **Host skill: use tasks when parallelizing** | done | New "Workspaces: tasks, and the timeline when you manage" section: make tasks first (`tasks add`), then `agentbox claude -i --tasks T-1,T-2` or `tasks assign T-3 --box <box>`. Plugin copy synced. |
| 13 | **Timeline notes via CLI/REST** | done | Shipped in Phase 9; the skill's manager wording was tightened with #12 (same examples, fewer lines). |

## Phase 11 — Timeline as a branch graph (hub + tray)

Design in [`workspaces-tasks-manager-plan.md`](./workspaces-tasks-manager-plan.md#phase-11--the-timeline-as-a-branch-graph).

| # | Item | Size | Notes |
|---|------|------|-------|
| 14 | **Hub: lanes on the timeline API** | done | `lane: {id, kind, from?, into?, branch?, open?}` on every item and live row, assigned at read time before paging (`timeline-lanes.ts`). `base` on `box.created`/`box.ready`, `box.branch` after checkout/new branch. OpenAPI + api.mdx. |
| 15 | **Tray: draw the graph** | in progress | Column packing (`TimelineGraph.layout`), lane colours, curves at forks and merges, an inline type glyph before the title. |
| 16 | **Filter a workspace to one manager session** | done | `?managerId=` on the timeline API narrows items, live rows and the summary to one session: what it stamped, plus what happened on a box it owns (`rowBelongsToManager`). Applied after `assignLanes` and before paging, so lane ids and forks are unchanged. In the tray a "This session" toggle in `WorkspacePaneHeader` drives it and revives `managerTaskFilter`, so one control narrows both the task list and the Timeline. |

## Parked (decided to look at later)

- **Realtime box activity / in-box pushes and PRs**: the relay status store and the relay timeline hooks don't fire the hub change signal, so those arrive on the 30 s poll. Fix: notify from both, debounced.
- **Menu PR state goes stale**: the GitHub PR check only runs while a Timeline is open. Option: a 5-minute background check for workspaces with boxes on a branch.
- **Cost trims**: read only the tail of `timeline.jsonl`; refresh cloud-box diff counts less often.
- **Tray menu with many boxes**: native menu scroll arrows, header/footer scroll away. Options: "N more…" per group, or a panel with a real scrollbar.
- **"Since you left" resets on a quick Plan ⇄ Timeline flip**: add a minimum-away threshold or tie it to window visibility.
- **Merged rows repeat the PR number** (title and link): drop it from the title if it reads noisy.
- **Pre-existing CLI bugs found along the way**: `agentbox create -y` still prompts for carry on the local-hub path; `agentbox destroy a b -y` destroys only the first box; `agentbox tasks rm` without `-y` outside a TTY reports "Can't reach the hub".
