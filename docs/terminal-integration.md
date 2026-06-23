# Host-terminal integration (`--attach-in`, cmux + Herdr status)

How `agentbox claude|codex|opencode` (and `shell`) place the attached session in
the user's host terminal, and how a box's agent state is surfaced in the cmux
sidebar / Herdr pane. Source lives in `apps/cli/src/terminal/` and the attach
wrapper `apps/cli/src/wrapped-pty/run.ts`.

## Host-terminal detection

`detectHostTerminal()` (`apps/cli/src/terminal/host.ts`) classifies the host
terminal from env vars, in priority order:

1. `TMUX` set → `tmux` (wins even when nested inside cmux/Herdr — its CLI is the
   right primitive and is portable across macOS/Linux).
2. `CMUX_SOCKET_PATH` set → `cmux` (a Ghostty-based multiplexer with its own
   control CLI; it shares `TERM_PROGRAM=ghostty` with standalone Ghostty, so we
   key on `CMUX_*` env vars, not `TERM_PROGRAM`).
3. `HERDR_SOCKET_PATH` set → `herdr` (https://herdr.dev — a multiplexer with a
   newline-delimited JSON-RPC socket API). **Checked before iTerm2 on purpose:**
   Herdr runs *inside* a host emulator, so `TERM_PROGRAM` reflects the outer one
   (e.g. iTerm2). Keying on `TERM_PROGRAM` would mis-route attach into iTerm2
   windows instead of Herdr panes.
4. `TERM_PROGRAM=iTerm.app` → `iterm2` (macOS-only; driven via AppleScript).
5. else → `unknown` (caller falls back to inline attach).

The cmux control binary is resolved by `cmuxBinary()`: `CMUX_BUNDLED_CLI_PATH`
(cmux exports this) → bare `cmux` on PATH. Herdr needs no binary — we talk to its
socket directly (`apps/cli/src/terminal/herdr-socket.ts`), so there's no PATH /
`HERDR_BIN_PATH` dependency.

## `--attach-in` / `attach.openIn`

`AttachOpenIn = 'split' | 'window' | 'tab' | 'same'` (config key
`attach.openIn`, default `split`; CLI `--attach-in`, `--inline` = `same`).
`spawnInNewTerminal()` (`host.ts`) maps each mode per terminal:

| mode     | tmux                       | cmux                         | Herdr               | iTerm2                  |
| -------- | -------------------------- | ---------------------------- | ------------------- | ----------------------- |
| `split`  | `split-window -h`          | `new-split right`            | `pane.split`        | `split vertically`      |
| `tab`    | `new-window`               | `new-surface` (tab in pane)  | `tab.create`        | `create tab`            |
| `window` | `new-window`               | `new-workspace`              | `workspace.create`  | `create window`         |
| `same`   | inline attach in current terminal (no spawn)                                                  |

Mechanics:
- The new pane re-invokes `agentbox <agent> attach <box> --attach-in same` so the
  fresh pane runs the **full wrapper** (footer + prompt channel) against the
  already-prepared session; the original host process then exits 0.
- tmux/iTerm2 carry `cwd` so project-scoped refs resolve in the new pane. cmux
  `new-workspace` carries `--cwd`/`--command` atomically; `new-split`/
  `new-surface` print a surface ref (`surface:N`, parsed by `parseCmuxRef`) that
  we then `cmux send "cd <cwd> && exec <cmd>\n"` into.
- Herdr (`spawnInHerdr`, `host.ts`): the create method returns a new pane id
  (`extractHerdrPaneId`), then we `pane.send_text "cd <cwd> && exec <cmd>\n"` into
  it — same `cd && exec` shape as cmux/iTerm2. All over the socket via
  `herdrRequest` (request/response, since we need the pane id back).
- Anything that fails (unknown host, shell mode, spawn non-zero / no pane id)
  falls through to inline attach.

**Herdr default override.** The global `attach.openIn` default is `split`, but a
split pane is cramped for an attached agent under Herdr, so `hostAwareOpenIn`
(`host.ts`) maps it to `tab` **only when the value is the built-in default**
(`cfg.sources['attach.openIn'] === 'default'`) and the host is Herdr. An explicit
`--attach-in` / configured value (any non-default source) is honored as-is. It's
applied at each command's `cfg.effective.attach.openIn` read site (claude / codex
/ opencode / attach), so both the docker and cloud foreground paths get it.

## `queue.openIn` — open a background `-i` box when it is ready

`QueueOpenIn = 'none' | 'split' | 'window' | 'tab'` (config key `queue.openIn`,
default `none`; config-only — no CLI flag). The foreground `attach.openIn` above
runs in the submitting process; the background `-i` path can't, because the box
doesn't exist yet (it's created later by the relay's queue worker, and its name
isn't even known until then). So the open happens **from the worker, on the
host, the moment the box is ready** — not from a waiting pane at submit time.

Flow:
- At submit (`captureOpenTerminalContext`, `terminal/queue-open.ts`): if
  `queue.openIn !== 'none'` and the submitting shell is a known host terminal,
  capture the targeting (`host`, `mode`, `cwd`, tmux `$TMUX`/`$TMUX_PANE`, cmux
  `$CMUX_SOCKET_PATH`/CLI, Herdr `$HERDR_SOCKET_PATH`/`$HERDR_PANE_ID`/
  `$HERDR_WORKSPACE_ID`) onto the queue job (`QueueJob.openTerminal`). The live
  submit env is the source of truth — the long-lived relay/worker inherit a
  **stale** terminal env from whenever the relay first started.
- When the box is ready (`_run-queued-job.ts` → `maybeOpenQueuedTerminal`): the
  worker calls `spawnQueuedOpenTerminal`, which re-invokes
  `agentbox <agent> attach <box> --attach-in same` in a fresh terminal via
  `spawnInNewTerminal`, passing the captured env so tmux/cmux talk to the
  submitting shell's server. Best-effort: any failure is logged, never fails the
  job.

Per-host targeting differs from the foreground path because the worker is
detached (no "current" pane):

| mode     | tmux                          | cmux                                    | Herdr                          | iTerm2            |
| -------- | ----------------------------- | --------------------------------------- | ------------------------------ | ----------------- |
| `split`  | `split-window -h -t <pane>`   | `new-split --surface`→`--workspace`→`new-workspace` | `pane.split` (target pane)     | `split vertically` |
| `tab`    | `new-window -t <pane>`        | `new-surface --workspace`→`new-workspace` | `tab.create` (target workspace) | `create tab`       |
| `window` | `new-window -t <pane>`        | `new-workspace`                         | `workspace.create`             | `create window`    |

- tmux targets the captured `$TMUX_PANE` so the split/window lands in the
  submitting pane's session and shows up live in the attached client.
- cmux targets the captured `$CMUX_SURFACE_ID` / `$CMUX_WORKSPACE_ID` instead of
  the focused surface (a detached worker has none): `split` tries
  `new-split right --surface <id>` (the original pane), then
  `new-split right --workspace <id>` (the parent workspace); `tab` targets
  `new-surface --workspace <id>` (cmux's `new-surface` has no `--surface` flag).
  When every targeted attempt fails or no id was captured, it degrades to
  `new-workspace`. The created surface ref is then driven via `cmux send` exactly
  as before. **Caveat:** cmux's default
  `socketControlMode: cmuxOnly` only trusts cmux-initiated processes, so it
  rejects the worker's socket connection (the failure surfaces as a broken-pipe
  in the queue log). cmux opens require `socketControlMode: automation` (or
  `password`) in `~/.config/cmux/cmux.json` + `cmux reload-config`. `config set
  queue.openIn` prints this caveat. tmux/iTerm2 are unaffected.
- Herdr targets the captured `$HERDR_PANE_ID` (`split`) / `$HERDR_WORKSPACE_ID`
  (`tab`) so the new pane/tab lands relative to the submitting pane; `window`
  opens a fresh `workspace.create`. No socket-trust caveat like cmux's — Herdr's
  socket accepts the worker connection.
- iTerm2 opens relative to the **frontmost** window (no stable submit-time handle
  is captured in v1).
- Unknown host terminal at submit → nothing is captured and nothing opens.

## Terminal title

`apps/cli/src/terminal/title.ts`: `setTerminalTitle` emits OSC 0
(`ESC ]0;<title> BEL`); the wrapper seeds the box name then re-emits the agent's
`status.json` `sessionTitle` on each poll (tmux swallows the inner OSC title via
`set-titles off`). `pushTerminalTitle`/`popTerminalTitle` use XTPUSHTITLE /
XTPOPTITLE (`CSI 22;2 t` / `CSI 23;2 t`) to save/restore the user's title across
the attach.

## Wrapper footer status slot

The attach footer renders ` agentbox ▸ <box> (<state>) — <title>   <hints>`
(`apps/cli/src/wrapped-pty/footer.ts` → dashboard `statusLine`). The `(<state>)`
slot shows the box's **aggregate `agentbox.yaml` service status** when the box
declares services — `starting N/M…` while they boot, `service error` if one
crashed / went unhealthy / a setup task failed, `ready` once all are up. When
attached you can already see the agent; what you can't see is whether the
background services have come up, so service status wins the slot. It's derived
by `serviceStatusLabel` (`apps/cli/src/wrapped-pty/service-status.ts`) from the
same `status.json` the footer polls every 3s. Boxes with **no** services fall
back to the agent activity (`idle`/`working`/…) for claude, or the
`(shell)`/`(codex)`/`(opencode)` mode label otherwise.

## cmux sidebar: box agent status (`attach.cmuxStatus`)

`apps/cli/src/terminal/cmux-status.ts`. When attached **inside cmux**, the
wrapper reflects the box agent's live activity on the box's cmux **workspace** so
the sidebar shows what each box is doing. Config key `attach.cmuxStatus` (bool,
default true); no-op outside cmux.

- Driven from the existing 3s `status.json` poll loop in `run.ts` (`pollStatus`),
  on each `claude`/`codex`/`opencode` activity transition.
- State → workspace colour + description (`mapActivityToWorkspace`):
  working/compacting → Blue "working"; question/waiting → Amber "needs input";
  end-plan → Amber "plan ready"; error → Red; idle → tint cleared; unknown →
  left as-is.
- The workspace's prior colour + description are captured on attach
  (`captureCmuxWorkspace` via `cmux list-workspaces --json --id-format both`) and
  restored on detach (`restoreCmuxWorkspace`). Restore is best-effort — a hard
  `SIGKILL` of the wrapper can leave a stale colour/description until the next
  attach.
- All cmux calls are fire-and-forget (`runCmux`); a missing/erroring `cmux` never
  breaks the attach.

### Per-tab highlight for needs-input (multi-box-per-workspace)

Boxes opened with `--attach-in tab` are **tabs (surfaces) in one workspace**, so
the per-workspace colour/description can't say *which* tab needs input — it just
reflects whichever box changed state last. To disambiguate, when an agent first
crosses into a needs-input state (`isAttentionState`: question / waiting /
end-plan / error) the wrapper runs `cmux notify --surface $CMUX_SURFACE_ID`
(`markCmuxTabAttention`, title = box name, body = e.g. `claude · needs input`),
which flags **the box's own tab**. Fired once per entry into needs-input (guarded
by `isAttentionState(next) && !isAttentionState(prev)`), not every poll. cmux
clears the flag automatically when the user focuses the tab to answer. Same
`attach.cmuxStatus` gate.

**Why `notify`, not `tab-action mark-unread`:** `mark-unread` only badges a
**non-selected** tab — marking the workspace's currently-selected tab is a no-op
(treated as read). Since the box that needs input is frequently the selected tab
in its (possibly background) workspace, `mark-unread` silently did nothing in
exactly the case that matters. `notify` is cmux's native needs-input path: it
badges any tab (selected or not), reorders it up, and shows a desktop
notification. The desktop popup is the accepted trade-off for a reliable flag
(verified live — `mark-unread` on a selected tab: no badge; `notify` on the same
tab: badge). `notify` requires the **surface UUID** (refs like `surface:3` are
rejected); the attach process has it as `$CMUX_SURFACE_ID`.

### Why colour/description and **not** `cmux set-status` pills

This is the load-bearing gotcha. cmux *does* have a per-workspace status pill
(`cmux set-status <key> <value>`), and using its native `claude_code`/`codex`/
`opencode` keys was the obvious "make it look like a local agent" approach. It
**does not work for boxes**:

- cmux only **renders** a status pill for workspaces it recognizes as running an
  agent — its own claude/codex/opencode integrations register the agent (hooks +
  a tracked PID, swept every 30s). A box runs the agent **inside the container**,
  so cmux sees a generic `docker exec`/`ssh` process, never associates an agent
  with the workspace, and never draws the pill row.
- `cmux set-status` still returns exit 0 and `cmux list-status` shows the value
  **stored** — it is simply never displayed. (Verified live: a box workspace had
  the pill stored but invisible, while a workspace running a cmux-launched claude
  showed the identical pill.)
- What cmux **always** renders for any workspace is its **colour**,
  **description**, and **title** — so we drive those instead.

## cmux custom dock (`agentbox install cmux`)

cmux can pin a **custom dock** to the right sidebar: a list of "controls", each a
shell command rendered in its own Ghostty-backed terminal section, declared in
JSON at `~/.config/cmux/dock.json` (personal, honoring `$XDG_CONFIG_HOME`) — see
https://cmux.com/docs/dock. `agentbox install cmux` upserts one control with
`id: agentbox` that runs `agentbox list --cmux --watch`, so the live box list
sits in the sidebar. Implementation: `apps/cli/src/commands/install-cmux.ts`
(`cmuxDockPath`, `upsertAgentboxControl`).

- **`--cmux` is the compact sidebar format.** A ~22-col Ghostty section can't fit
  the wide `list` table, so `--cmux` (in `list.ts`) groups boxes by project under
  a dashed `── name ──` header and renders 2 short lines per box — `<index>
  <name>` then an indented coloured glyph + agent + activity. The glyph/colour
  map mirrors `mapActivityToWorkspace` (blue=working, amber=needs-input,
  red=error, dim=idle); colour is dropped on `NO_COLOR` / a non-TTY. Renderer
  helpers are pure and unit-tested in `test/list-cmux.test.ts`.
- **Flicker-free refresh.** `--cmux` passes `hideStatusLine: true` to
  `watchRender`, which drops the `watching every …` chrome *and* switches to an
  in-place redraw (cursor-home + per-line clear-to-EOL + clear-to-end) instead of
  the full-screen `2J`/`3J` wipe. cmux re-runs a dock control whenever the active
  project changes (its config precedence is re-resolved per project — the dock
  guidance says controls must be "safe to start repeatedly"), so the relaunch is
  unavoidable; the in-place redraw keeps both that relaunch and the periodic
  refresh from blank-flashing. Other watch callers keep the `2J`/`3J` path.

- **The panel is always global (all boxes).** A dock control runs from the config
  base — home for the global `~/.config/cmux/dock.json` — not the focused cmux
  workspace, so `findProjectRoot(cwd)` can't follow the active project. Rather
  than show an empty/wrong project scope, `--cmux` lists every box. (cmux *does*
  expose the focused workspace's dir via `cmux rpc workspace.current`, but the
  dock restarts on project switch and that path added complexity for little gain
  — we chose the simple all-boxes view.)

- **Dock is a cmux *beta* feature, off by default.** Writing `dock.json` is
  necessary but not sufficient: the user must enable it under cmux Settings ->
  Beta features -> Dock, then switch the right sidebar to the Dock tab
  (`cmux right-sidebar dock` reports `mode 'dock' is not available` until the
  beta toggle is on). The CLI can't flip that toggle, so the command's success
  note tells the user to. Schema/location were verified against `cmux docs dock`
  (`~/.config/cmux/dock.json`, top-level `controls[]`).

- **Idempotent + sibling-safe.** The `agentbox` control is updated in place on
  re-run; any other controls (lazygit, logs, …) are preserved. `--dry-run`
  prints the resulting JSON without writing; `--force` backs up an unparseable
  `dock.json` to `dock.json.bak` and writes fresh.
- **No per-project scope (see the always-global note above).** An earlier
  version had an in-panel `g` toggle; it was dropped because a global dock can't
  scope to the focused project anyway, so the panel just lists all boxes. The
  non-cmux `agentbox list --watch` (wide terminal) keeps its `g` scope toggle —
  that path still uses `watchRender`'s `onKey` raw-mode capture.

## Herdr: box agent status (`attach.herdrStatus`)

`apps/cli/src/terminal/herdr-status.ts` + `herdr-socket.ts`. When attached
**inside Herdr**, the wrapper reports the box agent's live activity to its Herdr
**pane** so the box looks like a *normal* agent pane in Herdr's UI. Config key
`attach.herdrStatus` (bool, default true); no-op outside Herdr.

Unlike cmux (where we had to drive the workspace colour because cmux won't draw
its agent pill for a `docker exec`), Herdr has a first-class agent model. So the
design is the inverse: we **proxy state transparently** and let Herdr do the rest.

- **Transparent state proxy.** Driven from the same 3s `status.json` poll loop in
  `run.ts`, on each activity transition we send `pane.report_agent` with
  `agent: "claude"|"codex"|"opencode"` (`reportHerdrAgentState`). Mapping
  (`mapActivityToAgentState`): working/compacting → `working`;
  question/waiting/end-plan/error → `blocked`; idle → `idle`; unknown → left
  as-is. Because Herdr treats it as a normal agent, **Herdr surfaces needs-input
  itself** from the `blocked` state — so, unlike the cmux path, we do **not**
  fire our own needs-input toast.
- **Special highlight for AgentBox's own prompts.** The one thing Herdr can't
  know about is AgentBox's **host-relay approval prompts** (git push / PR / merge
  / cp / download / checkpoint) — they're not the box agent. When one arrives
  (the `onPrompt` SSE callback in `run.ts`) we fire `notification.show` with sound
  `request` (`notifyHerdrApprovalPrompt`, title = box name, body =
  `agentbox · <prompt message>`) so it stands out from the normal agent flow.
- **No capture/restore.** The `pane.report_agent` association is ours (it didn't
  exist before the attach), so detach just reports `idle` (`clearHerdrAgentState`)
  — there's nothing prior to restore.
- **Transport.** All calls go over Herdr's newline-delimited JSON-RPC UNIX socket
  (`herdr-socket.ts`): `herdrSend` (fire-and-forget, for state reports +
  notifications) and `herdrRequest` (request/response, for spawn). Everything is
  best-effort — a missing/erroring socket never breaks the attach. Keyed on
  `HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` (`herdrStatusActive`), so
  it works even when a tmux is nested inside Herdr.

## Herdr plugin (`agentbox install herdr` + repo-root `herdr-plugin.toml`)

`apps/cli/src/commands/install-herdr.ts` is the source of truth for a Herdr
plugin (https://herdr.dev/docs/plugins) reachable two ways, both producing the
same files:
- **discovery:** `herdr plugin install madarco/agentbox` → the committed
  repo-root `herdr-plugin.toml` (+ `build.sh`); its `[[build]]` runs `build.sh` →
  `agentbox install herdr --plugin-keys`. The manifest lives at the repo root (not
  a subdir) so the Herdr marketplace, which indexes `herdr-plugin.toml` from each
  tagged repo's root, can discover it.
- **local:** `agentbox install herdr` → the same files under
  `~/.agentbox/herdr/plugin/`, then `herdr plugin unlink agentbox` (best-effort) →
  `herdr plugin link` → `herdr server reload-config`.

**Static manifest + a shim.** Herdr runs plugin commands as a bare argv with no
shell expansion and an unreliable PATH (e.g. nvm). Rather than bake machine paths
into the manifest, agentbox commands route through `agentbox-shim.sh`
(`herdrShimContent` → `exec <node> <cliEntry> "$@"`), written at install time.
That keeps `buildHerdrManifest()` **pure + parameterless** so the committed
repo-root `herdr-plugin.toml` is byte-identical to what the local install
writes — a test (`committed plugin stays in sync`) asserts it, as does
`build.sh` vs `herdrBuildScript()`. The plugin carries its own
`version` (constant), independent of the CLI version, so the committed file is
stable across releases.

Manifest contents:
- `[[build]]` → `["sh", "build.sh"]` (run only by `herdr plugin install`, not by
  `herdr plugin link`).
- `[[panes]]` `boxes` (placement `overlay`) → `sh agentbox-shim.sh list --herdr --watch`.
- `[[actions]]` `boxes` (opens the pane via bare `herdr plugin pane open`), `new`
  (`sh agentbox-shim.sh herdr new`), `link` (`sh agentbox-shim.sh herdr link`).
- `[[link_handlers]]` `^agentbox://` → action `link`.

`build.sh` (committed): if `command -v agentbox` resolves, run
`agentbox install herdr --plugin-keys` (writes the shim into the plugin root +
keybindings + reload, no relink); else print the `npm i -g` hint and `exit 0` —
the plugin installs but stays inert until the CLI arrives (never aborts the
install).

**Keybindings live in the user's `config.toml`, not the manifest.** Verified
against Herdr 0.7: manifest `[[keys.command]]` entries are ignored (they don't
appear in `herdr plugin list` and never fire). So `install herdr` splices a
managed `[[keys.command]]` block into `~/.config/herdr/config.toml`
(`herdrConfigPath`) — idempotently, between `# >>> agentbox … >>>` sentinels via
`upsertHerdrKeybindings` — binding `prefix+a` → `agentbox.boxes` and
`prefix+shift+a` → `agentbox.new` with `type = "plugin_action"`, then runs
`herdr server reload-config`. (`prefix+b` is Herdr's own `toggle_sidebar`, so
it's avoided.) `herdr config reset-keys` (or re-running) removes the block.

The plugin's runtime entry points live in `apps/cli/src/commands/herdr.ts`
(hidden command group `agentbox herdr`):
- `herdr new` reads `HERDR_PLUGIN_CONTEXT_JSON` for the cwd and reuses the phase-1
  `spawnInNewTerminal({host:'herdr', mode:'tab'})` to open a box session in a tab.
- `herdr link` parses `HERDR_PLUGIN_CLICKED_URL` (`agentbox://web/<box>`, via the
  pure `parseHerdrLink`), finds the box's exposed web endpoint
  (`ListedBox.endpoints`), and opens it with `hostOpenCommand()` — or, when no web
  app is exposed, fires a `notification.show` and does nothing.

`agentbox list --herdr` is the `--cmux` compact renderer with box names wrapped in
**OSC 8 hyperlinks** to `agentbox://web/<name>` (forced on — the Herdr overlay
always supports OSC 8 and the link is what drives Ctrl+click). 

**Native sidebar vs the overlay.** Herdr's sidebar agent panel
(`agent_panel_scope = "all"`) already lists *attached* boxes globally (phase-1
reporting feeds it) — that's the always-visible view of active boxes. Plugins
**cannot** add to the sidebar (v1 panes are only overlay/split/tab/zoomed) and the
sidebar only shows boxes with a live pane, so the full roster (incl. paused) is
the keyboard-toggled overlay instead.

## Gotchas

- **`set-status` is stored-but-hidden for box workspaces** — see above. Don't
  "fix" the cmux integration by switching back to `set-status`; it will look
  correct in `list-status` and never appear in the sidebar.
- **cmux gates its socket by session lineage.** A process spawned inside a fresh
  pty session that cmux didn't create (e.g. the `pnpm drive` PTY harness, which
  forkpty/setsids) is disowned, and `cmux …` fails with
  `Failed to write to socket (Broken pipe, errno 32)`. The **real** attach (a
  direct child of the cmux surface shell) is authorized. **Consequence: the drive
  harness cannot validate the cmux status feature — only a real cmux surface
  can.** Verify by attaching in an actual cmux tab and watching the workspace
  colour/description, not via `pnpm drive`. The same limit applies to the custom
  dock: the harness can verify the live `agentbox list --watch` view + `g` toggle
  in a plain PTY, but cmux dock *rendering* and keystroke routing into a focused
  dock panel can only be confirmed in a real cmux surface.
- **Exit 0 ≠ visible.** `cmux set-status`/`workspace-action` return 0 even when
  the result isn't rendered (hidden pill) or targets a stale workspace id. Use
  `cmux list-status` / `cmux list-workspaces --json` to check ground truth, and a
  real surface to check rendering.
- **`CMUX_WORKSPACE_ID` is a UUID; `list-workspaces` reports refs/indexes.**
  `set-status`/`workspace-action` accept the UUID (default `$CMUX_WORKSPACE_ID`),
  but `list-workspaces --json` only exposes `workspace:N` refs unless you pass
  `--id-format both`. `captureCmuxWorkspace` uses `--id-format both` and matches
  the UUID loosely.
- **tmux wins over cmux/Herdr when nested**, but both cmux status and Herdr
  status key on their socket env var directly (not `detectHostTerminal`), so the
  status still updates when a tmux runs inside a cmux surface / Herdr pane.
- **Herdr is checked before iTerm2** in `detectHostTerminal` — Herdr runs inside
  an emulator, so `TERM_PROGRAM` is the outer one (iTerm2). Don't reorder these,
  or attach spawns iTerm2 windows instead of Herdr panes.
- **Herdr handles needs-input; don't double-notify.** The whole point of the
  transparent `pane.report_agent` proxy is that Herdr does its own needs-input
  surfacing from `blocked`. Reserve `notification.show` for AgentBox-specific
  relay prompts. (If a future Herdr version stops surfacing needs-input from
  reported state, the fallback is to add a `notification.show` in the poll
  transition, mirroring cmux's `markCmuxTabAttention`.)
- **Non-TTY / missing node-pty → fallback.** `runWrappedAttach` runs the plain
  `runFallback` (no footer, no poll loop, no cmux status) when stdin/stdout
  aren't TTYs or the node-pty backend is unavailable. The cmux status only fires
  on the wrapped interactive path.

## Verify

In a **real cmux tab** (not the drive harness): `agentbox claude --attach-in
window` (or `--inline`) against an `examples/` box; give the agent a task and
watch its workspace turn Blue/"working" then Amber/"needs input", and revert on
detach. For the per-tab flag, open two boxes as tabs in one workspace
(`agentbox claude --attach-in tab` twice); make one ask a question and confirm
its tab gets cmux's badge + a desktop notification (and reorders up), which
clears when you focus it — including when that box is the selected tab in its
workspace. `agentbox config set attach.cmuxStatus false` disables it.
Outside cmux (tmux/iTerm2/plain shell) there must be zero `cmux` calls.

In a **real Herdr pane**: `agentbox claude` against an `examples/` box; confirm
the pane shows a claude agent (Herdr's native treatment) and transitions
working↔blocked↔idle as the agent runs — and that Herdr raises its **own**
needs-input signal when the agent asks a question (we don't). Probe the socket
with e.g. `printf '{"id":"x","method":"agent.list","params":{}}\n' | nc -U
"$HERDR_SOCKET_PATH"`. Trigger a host-relay approval (e.g. an in-box `git push`)
and confirm an AgentBox `notification.show` toast fires. `agentbox config set
attach.herdrStatus false` disables it; outside Herdr there must be zero socket
calls.

Unit tests: `apps/cli/test/cmux-status.test.ts` and
`apps/cli/test/herdr-status.test.ts` (pure state map + `*StatusActive`),
`apps/cli/test/terminal-host.test.ts` (detection incl. Herdr-before-iTerm2 +
`--attach-in` parsing).
