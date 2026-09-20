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
| 2 | CLI attach client (`agentbox manager attach`, `--raw`, detach chord) | todo |
| 3 | Hub/relay integration (`kind: 'pty'`, start/stop/resume/message, status) | todo |
| 4 | Lease/grace wiring, `pinned`, config keys, hub janitor, tmux fallback | todo |
| 5 | Tray (`ptyAttach` argv, delete the Ctrl+J rewrite, `isAttachable`) | todo |
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
