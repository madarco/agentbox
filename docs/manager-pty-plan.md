# Manager sessions on an AgentBox-owned PTY

Replaces tmux as the carrier of **hub-run** manager sessions with a detached pty-host per manager,
so a client terminal receives the agent's raw bytes.

## Why

A hub-run manager runs in the user's **own** tmux server, so
`managerSessionOptionsArgv` (`packages/relay/src/workspaces/manager.ts`) may only set
*session*-scoped options — every option that would fix the ergonomics (`extended-keys`,
`terminal-features ,*:extkeys`, `set-clipboard on`, `allow-passthrough`, the 2-line wheel rebind,
`history-limit`) is a **server** option, and setting one would silently change every unrelated tmux
session the user has open. The box image can set all of them in `/etc/tmux.conf` precisely because
that server belongs to the box.

The measured consequences are in
[`workspaces-tasks-manager-backlog.md`](./workspaces-tasks-manager-backlog.md) items #6–#8: the
modified Enter never reaches the agent (the tray rewrites Ctrl/Shift+Enter to Ctrl+J to compensate),
the wheel drops the pane into tmux copy mode instead of the terminal's own scrollback, selection and
clipboard go through tmux, and a status row is spent on a footer.

Running managers on a private tmux server (`-L agentbox -f …`) would recover the keys and the
clipboard, but scrollback and selection would still belong to tmux. Owning the pty removes the
terminal emulator from the middle entirely: ghostty (or any client terminal) is the only emulator in
the path, which is what makes scrollback, selection, mouse and key encodings simply work.

## Shape

```
hub (apps/hub — never requires node-pty)
  └─ spawn detached ─► pty-host  (apps/cli/dist/pty-host.js, owns node-pty)
       ~/.agentbox/pty/<id>.sock  0600  ◄── node:net ── hub (inject/stop/status/configure)
                                        ◄── raw proxy ─ agentbox manager attach <id>
                                        ◄── raw proxy ─ ghostty (tray), same command
       ~/.agentbox/pty/<id>.json  0600  meta + token + pid
       ~/.agentbox/logs/pty-<id>.log
       ~/.agentbox/workspaces/<ws>/managers/<id>.exit   (unchanged: `managerExitFile`)
```

Only the carrier line changes: `tmux new-session -d -s … -- <loginShell> -lc <script>` becomes
`ptySpawn(loginShell, ['-lc', script])`. `buildManagerShellScript`, `scrubAgentSessionEnv`, the exit
file and the registration flow are reused as they are.

The host is a **separate detached process**, not part of the hub: the hub restarts on every update
and a manager must not die with it, and the hub's standalone bundle ships no `node_modules`, so it
can never `require` node-pty. Discovery after a hub restart is a directory scan of
`~/.agentbox/pty`, not an in-memory registry.

tmux stays for detected/external managers (a session the user started in their own terminal, driven
by `send-keys` through `$TMUX_PANE`), for the claude `--bg` attach session, and as the fallback
carrier when node-pty is unavailable.

## Wire protocol

Length-prefixed binary (`packages/core/src/pty-protocol.ts`), not JSON lines: pty output is
arbitrary bytes — a chunk can split a UTF-8 character, and mouse reports or a paste contain any byte
— and byte-exactness is the whole point of the change. It also keeps a future WebSocket bridge a
pure relay (DATA/INPUT → binary frames, CTRL → text frames, nothing re-encodes).

```
frame := u8 type | u32be len | payload[len]      MAX 1 MiB
0x01 DATA   host→client  raw pty output
0x02 INPUT  client→host  raw bytes for the pty
0x03 CTRL   both         UTF-8 JSON
0x04 EXIT   host→client  u32be exit code
```

Handshake: client sends `hello {v, token, client:{id,kind,cols,rows}, lease?, replay}`, host answers
`welcome`. A socket alone is not authorization — every client presents the token from the meta file,
compared in constant time. Other CTRL verbs: `resize`, `inject`, `lease`, `release`, `stop`,
`signal`, `status`, `configure`, `bye`; host-side `size`, `lease-ack`, `status-report`, `error`,
`replay-begin`/`replay-end`.

`inject` replaces `tmux send-keys`: newlines are flattened (each would submit a fragment) and Enter
follows after `submitDelayMs` — the same rule the tmux carrier needed, because an agent TUI reads a
burst ending in Enter as a paste. Bracketed paste is the better fix and is a follow-up, not part of
this work.

## Replay

tmux could repaint a late attacher because it parsed every byte into a screen model. The host keeps
a raw ring (`packages/cli-kit/src/pty-ring.ts`) plus a streaming scanner that tracks two things: the
last **safe resume point** (an alt-screen switch or a full clear — replaying from there is a whole
frame, not half of one) and the **sticky mode set** currently in force (mouse reporting, bracketed
paste, DECCKM, `ESC[>4;Nm`, `ESC[>1u`). A TUI announces those modes once at startup and never
repeats them, so without re-asserting them a late client has dead mouse and dead paste.

On attach the host emits: `ESC[?1049l ESC[!p ESC[2J ESC[H` (soft reset — not RIS, which would also
discard the client surface's configured colors), then the recorded modes, then the ring trimmed to
the safe point, then a repaint nudge (a one-row resize toggle) so the agent redraws.

## Multi-client and sizing

Every DATA frame goes to every client and every client's INPUT reaches the pty, so the CLI, the tray
and a plain terminal drive the same agent. Size arbitration defaults to `latest`, matching the
`window-size latest` the tmux carrier set — but keyed on the last **attach or explicit resize**,
never on keystrokes: a client typing in a small window must not silently shrink a larger one the
next time some unrelated client attaches or leaves.

This retires two tray workarounds: "never two attaches to one session" (fan-out is now first-class)
and "a parked pane must not shrink the shared session" (a parked pane is simply not the latest
sizer).

## Lifetime: lease + grace

The lease lives in the **host**, not the hub — the host outlives the hub, so a hub-held lease would
be lost on every update, and an on-disk one would be a second source of truth for something the host
can observe directly.

The lease *is* the client connection: a client sets `lease:{hold,ttlMs}` in `hello`, keyed by a
stable client id it persists (`tray:<uuid>`). A connected holder is fresh by definition; a gone one
ages out. Once a session has ever had a holder and none is fresh past `leaseGraceMs` (default 60s),
an unpinned session is stopped (SIGHUP → SIGTERM → SIGKILL, each step short-circuiting on exit).

So quitting the tray kills the terminals it owned, while a tray relaunch or update inside the grace
window re-claims them. A session that never had a lease holder (started from a terminal, no tray) is
never reaped — exactly today's behavior. `pinned` overrides in both directions.

## Phases

| # | Phase | State |
|---|-------|-------|
| 1 | Protocol, replay ring and the host, standalone | done |
| 2 | CLI attach client (`agentbox manager attach`, `--raw`, detach chord) | done |
| 3 | Hub/relay integration (`kind: 'pty'`, start/stop/resume/message, status) | done |
| 4 | Lease/grace wiring, `pinned`, config keys, hub janitor, tmux fallback | done |
| 5 | Tray (`ptyAttach` argv, delete the Ctrl+J rewrite, `isAttachable`) | done |
| 6 | Cleanup, docs, groundwork for a web terminal | todo |

### Phase 1 (done)

- `packages/core/src/pty-protocol.ts` — frame codec, message types, `parsePtyCtrl` (unknown tags are
  refused, so a newer peer cannot steer an older host through a field it does not understand).
- `packages/sandbox-core/src/pty-session.ts` — `~/.agentbox/pty` paths (0700), the meta file
  (0600, temp+rename), `listPtySessions`, `removePtySession`. Flat and outside the workspace dir
  because a unix socket path must stay inside macOS's 104-byte `sun_path` limit; the host says so
  with a clear error rather than a bare `EINVAL` when it does not.
- `packages/cli-kit/src/pty-ring.ts` — the ring and the escape scanner.
- `packages/cli-kit/src/pty-host.ts` — the host: fan-out, sizing, replay, inject, lease reaper, stop
  ladder, stale-socket adoption (probe-connect first; a live socket is never unlinked, which would
  strand attached clients while the agent kept running unreachable).
- `apps/cli/src/manager/pty-host-entry.ts` → `dist/pty-host.js` (third tsup entry). The spec arrives
  on **fd 3**, not argv, because it carries the session token and the agent's launch script and argv
  is world-readable through `ps` — an improvement on the tmux carrier, which put the script in argv.

Signal: `packages/cli-kit/test/pty-host.test.ts` (real pty, skipped when the node-pty prebuild is
missing) covers fan-out, replay to a late client, size arbitration, `inject`, token and version
refusal, refusing to steal a live socket, adopting a stale one, lease reaping past the grace window,
and a pinned session surviving. `pty-ring.test.ts` and `packages/core/test/pty-protocol.test.ts` are
pure.

### Phase 2 (done)

- `apps/cli/src/manager/detach-chord.ts` — the only key sequence the client interprets. `C-] d`
  detaches, `C-] C-]` sends one literal leader, `C-] <anything else>` types both, so a mistyped
  chord swallows nothing. No timeout: a chord that expires is a chord you cannot trust. `none`
  turns it off for an embedding terminal whose window already is the detach.
- `apps/cli/src/manager/pty-attach.ts` — the raw proxy: stdin to the session, session to stdout,
  `resize` on SIGWINCH, SIGINT forwarded as `0x03` (the proxy never dies on it), the exit code
  mirrored. Nothing is parsed or rewritten.
- `apps/cli/src/commands/manager.ts` — `attachToSession` tries the pty carrier first when the
  manager runs on this machine and a local session meta exists (its socket and token are readable
  only here, which is also the only place an attach could work from). `--raw` and `--detach-key`
  added; `--attach-in` spawns `[execPath, argv[1], 'manager', 'attach', id]` rather than a bare
  `agentbox`, because a new pane's login shell may not have this install on PATH.

Found while testing: a deferred repaint nudge that fires after the agent exits makes node-pty throw
`ioctl(2) failed, ENOTTY` from a timer — an uncaught exception that would have killed the host, and
with it the session cleanup. Every pty write/resize/kill is now guarded by an `alive` flag and a
try/catch, and the nudge timer is cleared on exit.

### Phase 3 (done)

- `packages/relay/src/workspaces/pty-client.ts` — the hub's side: pure `node:net` plus the codec,
  never node-pty (the hub's bundle ships no `node_modules`). `ptyHostAlive` is the liveness probe
  `tmux has-session` used to be; `ptyInject` replaces `send-keys`; `ptyStop`, `ptyStatus`,
  `ptyConfigure` round out the control surface. The hub attaches with `replay: false` and a 0x0
  size, so it never takes the screen or the size from a real terminal.
- `packages/relay/src/workspaces/manager-pty.ts` — the carrier: spawn detached, wait for meta AND a
  listening socket (either alone is a half-started host), register `kind: 'pty'`.
  `resolvePtyHostEntry` walks `$AGENTBOX_CLI_ENTRY` → this repo's build → a hub-bundle sibling.
- `manager.ts` — `startManagerSession` is now a dispatcher (`auto` = pty, else tmux; a named carrier
  never silently falls back), the old body is `startManagerTmuxSession`. `registeredManager` takes
  the kind from the registration and clears the other carrier's fields; `managerStatus` probes the
  socket; `stopManagerSession` asks the host; `backgroundFor` no longer offers a running pty manager
  as a detached background session; `toManagerView` carries `ptyAttach`.
- Hub: `spawnPtyHost`/`managerCarrier` seams on `BackendDeps` (a test must never spawn an agent),
  `lastExit` for either hub-run kind, message routed to `ptyInject`, `ptyAttach` on the view and on
  the heartbeat, `kind: 'pty'` + `pty` + `runId` through the validators and OpenAPI.
- Detection got *stronger*: the host exports `AGENTBOX_MANAGER_RUN`, the CLI sends it, and
  `trustedHint` believes a pty manager's `managerId` only when the run id matches — where the tmux
  carrier could only ask tmux and `$AGENTBOX_MANAGER` alone is leaked by Claude's daemon.

Live end-to-end (an isolated `$HOME`, its own hub on 8799, a real claude manager):
`manager start` → `kind: pty`; `manager list` shows it running; `manager message` typed **and**
submitted into the live TUI; `hub restart` left it running and attachable (the host outlives the
hub by design); `manager stop` ended the agent, reaped socket + meta and dropped the attached
client. **The point of the whole change, measured:** `ESC[13;2u` (Shift+Enter) reached Claude Code
unchanged and inserted a newline — two lines in the prompt, nothing submitted, nothing rewriting it
anywhere. (`ESC[13;5u` submits, which is claude's own binding, not the carrier.)

Three bugs the live run found, all fixed with tests:

1. The spec rode a temp file on fd 3, and an inherited descriptor is already at EOF — the host read
   an empty spec and every start fell back to tmux. It is a pipe now, so the token never touches
   disk either.
2. `stopManagerSession` sent an empty token, so the host refused the stop and the session kept
   running. The token lives in the meta file (a record travels to a control box; a token must not),
   so stop reads it there, with a pid SIGTERM as the last resort.
3. The hub's 0x0 control client won the size arbitration and `pty.resize(0, 0)` **killed the host**,
   taking the agent with it. Only clients that are a terminal size the session now.

### Phase 4 (done)

- Seven `manager.*` config keys (`packages/config`): `carrier`, `lifetime`, `leaseGraceSeconds`,
  `scrollbackBytes`, `windowSize`, `submitDelayMs`, `detachKey`. The hub resolves them **at the
  folder the session will run in**, not its own cwd, and hands the numbers to the host in its spawn
  spec — a detached host does no config layering, and a live change reaches it as `configure`.
- `manager.lifetime: persistent` exempts every session from reaping; `agentbox manager pin <id>`
  exempts one. A pin is written to the record (what a restart reads) *and* pushed to the live host
  (what enforces it now), through `POST /api/v1/managers/{id}/pin`.
- `apps/hub/lib/pty-janitor.ts` — a host outlives the hub, so a crashed one's socket and meta are
  only ever cleaned up by someone looking. Conservative: it removes a session's files only when the
  socket refuses a connection AND the recorded pid is gone, because either alone can be a live host.
- The CLI's detach chord comes from `manager.detachKey`, so a terminal that already owns `C-]` can
  move it (or set `none`).

Live, against real claude managers on an isolated hub with `leaseGraceSeconds: 8`: the config
reached the host (`leaseGraceMs 8000`); a lease holder leaving left the session up at +4s and reaped
at +12s; **the same client id returning inside the window kept the session past its original
deadline** — the tray-update case, measured; a pinned session survived 12s past the grace, and
unpinning reaped it within one reaper tick, which is the live `configure` push working both ways.
`manager.carrier: tmux` started the same agent on the old carrier.

One bug: the pin route answered `{manager: …}` where every other manager route answers the manager
itself, so the CLI read an undefined payload — the session was pinned correctly, only the reply was
wrong.

### Phase 5 (done, in `../agentbox-tray`)

- The pane runs the argv the hub sends (`ptyAttach.command` + `--lease-id`), so nothing has to be on
  the app's PATH; `ManagerTerminalView` — the Ctrl/Shift+Enter → Ctrl+J rewrite — is deleted, which
  was the whole point.
- The warm pool keys on a neutral `terminalKey` (manager id for pty, tmux session name otherwise),
  because a pty session has no session name.
- `TrayClient.leaseId` is a UUID persisted in `UserDefaults`, so quitting reaps the app's sessions
  after the grace window while a relaunch inside it takes them back.
- `agentbox manager attach --lease-id <id>` is the CLI half: an ordinary attach holds no lease
  (closing a terminal you opened by hand must not end the agent's work).

Verified: `swift build` clean, `make test` 105 green (including a captured pty payload decoded by
the app's own types, the argv it builds, and the shell quoting an install path with a space needs).
The embedded terminal against a live pty manager is **not** verified yet: a manager start registers
through the record store, and this Mac's is the control box, which still runs the pre-`pty` build —
`ManagerRegistration` there refuses `kind: 'pty'`. Update the control box and the PC together.

### Review pass (`/review medium`)

Thirteen findings, all real, all fixed on the branch. The two that mattered most were edits from
Phase 3 that **silently did not apply** (a reformat had moved the anchors), which is exactly what a
review is for:

- `manager attach` with no id still filtered `kind === 'tmux'`, so the common case — one running
  manager in the workspace — answered "no tmux-run manager is running" and exited 2.
- `--lease-id` was declared and threaded but never put into the options object, so the flag was
  inert and the tray's sessions would never have been reaped.

Both re-verified live this time: a bare `manager attach` found the pty manager, and an attach with
`--lease-id` was reaped 8s after the client left (and not before).

The rest:

- Every start/resume/message path was gated on `tmuxAvailable` → 503 "tmux is not installed", which
  refused exactly the install the pty carrier exists for. One carrier-aware `carrierRefusal` now
  answers, with `MANAGER_CARRIER_MISSING` / `PTY_CARRIER_MISSING` beside `TMUX_MISSING` (still the
  refusal for the paths that are tmux by nature).
- `start --restart` only stopped a running `tmux` manager first, so a restart of a pty one always
  failed on the resume's own "already running" check.
- A resume ignored `manager.*` entirely: the probe now carries the carrier and the tunables, because
  a resume is a start.
- A pty record resumed by hand in a terminal stayed `kind: 'pty'` with a dead socket (reading as
  stopped while the agent ran); the demote-to-`external` rule is now "not external", not "tmux".
- A failure between spawning the agent and serving the socket left the agent orphaned — unreachable
  and invisible to the janitor. It is killed now.
- **The reaper could SIGHUP a session someone was typing into**: it consulted leases only, so a tray
  quit ended a terminal attached by hand. Any attached client with a real size now holds it open.
- An unparseable `manager.detachKey` was indistinguishable from `none`, silently leaving no way out
  of an attach; it warns and falls back. `--attach-in` dropped `--raw`/`--detach-key`/`--lease-id`
  from the pane it spawned. A pty manager on another host was described as "runs in a terminal of
  its own". The attach had no handshake timeout. `listManagers` paid an extra probe per manager.
