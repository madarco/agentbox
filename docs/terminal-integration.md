# Host-terminal integration (`--attach-in`, cmux sidebar status)

How `agentbox claude|codex|opencode` (and `shell`) place the attached session in
the user's host terminal, and how a box's agent state is surfaced in the cmux
sidebar. Source lives in `apps/cli/src/terminal/` and the attach wrapper
`apps/cli/src/wrapped-pty/run.ts`.

## Host-terminal detection

`detectHostTerminal()` (`apps/cli/src/terminal/host.ts`) classifies the host
terminal from env vars, in priority order:

1. `TMUX` set → `tmux` (wins even when nested inside cmux — its CLI is the right
   primitive and is portable across macOS/Linux).
2. `CMUX_SOCKET_PATH` set → `cmux` (a Ghostty-based multiplexer with its own
   control CLI; it shares `TERM_PROGRAM=ghostty` with standalone Ghostty, so we
   key on `CMUX_*` env vars, not `TERM_PROGRAM`).
3. `TERM_PROGRAM=iTerm.app` → `iterm2` (macOS-only; driven via AppleScript).
4. else → `unknown` (caller falls back to inline attach).

The cmux control binary is resolved by `cmuxBinary()`: `CMUX_BUNDLED_CLI_PATH`
(cmux exports this) → bare `cmux` on PATH.

## `--attach-in` / `attach.openIn`

`AttachOpenIn = 'split' | 'window' | 'tab' | 'same'` (config key
`attach.openIn`, default `split`; CLI `--attach-in`, `--inline` = `same`).
`spawnInNewTerminal()` (`host.ts`) maps each mode per terminal:

| mode     | tmux                       | cmux                         | iTerm2                  |
| -------- | -------------------------- | ---------------------------- | ----------------------- |
| `split`  | `split-window -h`          | `new-split right`            | `split vertically`      |
| `tab`    | `new-window`               | `new-surface` (tab in pane)  | `create tab`            |
| `window` | `new-window`               | `new-workspace`              | `create window`         |
| `same`   | inline attach in current terminal (no spawn)                            |

Mechanics:
- The new pane re-invokes `agentbox <agent> attach <box> --attach-in same` so the
  fresh pane runs the **full wrapper** (footer + prompt channel) against the
  already-prepared session; the original host process then exits 0.
- tmux/iTerm2 carry `cwd` so project-scoped refs resolve in the new pane. cmux
  `new-workspace` carries `--cwd`/`--command` atomically; `new-split`/
  `new-surface` print a surface ref (`surface:N`, parsed by `parseCmuxRef`) that
  we then `cmux send "cd <cwd> && exec <cmd>\n"` into.
- Anything that fails (unknown host, shell mode, spawn non-zero) falls through to
  inline attach.

## Terminal title

`apps/cli/src/terminal/title.ts`: `setTerminalTitle` emits OSC 0
(`ESC ]0;<title> BEL`); the wrapper seeds the box name then re-emits the agent's
`status.json` `sessionTitle` on each poll (tmux swallows the inner OSC title via
`set-titles off`). `pushTerminalTitle`/`popTerminalTitle` use XTPUSHTITLE /
XTPOPTITLE (`CSI 22;2 t` / `CSI 23;2 t`) to save/restore the user's title across
the attach.

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
  the wide `list` table, so `--cmux` (in `list.ts`) renders 2 short lines per box
  — `<index> <name>` then an indented coloured glyph + agent + activity — plus a
  one-line `[ ] all projects · g` toggle and short empty messages. It also passes
  `hideStatusLine: true` to `watchRender` to drop the `watching every …` chrome.
  The glyph/colour map mirrors `mapActivityToWorkspace` (blue=working,
  amber=needs-input, red=error, dim=idle); colour is dropped on `NO_COLOR` / a
  non-TTY. Renderer helpers are pure and unit-tested in `test/list-cmux.test.ts`.

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
- **Scope is an in-panel toggle, not a flag.** The dock schema has no checkbox
  widget, so the project-vs-all-projects scope lives inside the live view:
  `agentbox list --watch` renders a `[ ] all projects   ·   press g to toggle`
  header and the `g` key flips it (raw-mode key capture in `watchRender`, wired
  from `list.ts`). `q`/Ctrl-C exits. `agentbox install cmux -g` only bakes the
  panel's *initial* scope.
- **Project scope depends on the dock command's cwd.** cmux runs dock commands
  in the login shell; the non-`-g` view scopes by `findProjectRoot(cwd)`, so if
  that cwd isn't the focused project the all-projects view is the reliable one.

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
- **tmux wins over cmux when nested**, but cmux status keys on `CMUX_SOCKET_PATH`
  directly (not `detectHostTerminal`), so the workspace status still updates when
  a tmux runs inside a cmux surface.
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

Unit tests: `apps/cli/test/cmux-status.test.ts` (pure state→colour/description
map + `cmuxStatusActive`), `apps/cli/test/terminal-host.test.ts` (detection +
`--attach-in` parsing).
