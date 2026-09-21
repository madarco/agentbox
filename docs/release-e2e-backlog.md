# Release e2e — backlog

> Live list for [`release-e2e-plan.md`](./release-e2e-plan.md). Product bugs the suite found, harness gaps, and the checklist IDs not yet in a scenario.

## Product bugs found by the suite

Found while building and first running the suite on nightly `0.33.0-nightly.202609211038` (2026-09-21). Not fixed in the suite's branch; each needs its own change.

- **`agentbox opencode -i "<prompt>"` never starts a turn.** The shared `positionalSeedLauncher` (`packages/core`, `resolveAgentLauncher`) passes the seed prompt as the first positional, but opencode's positional is the project directory: opencode 1.18 fails with "Failed to change directory to /workspace/<prompt>", exits, and the tmux session disappears. It needs `--prompt "<msg>"`. The queue job still reports `done` (see the next-but-one item), so the user sees a ready box with no agent.
- **Cloud host-action approvals never reach the hub.** On daytona, hetzner, vercel and e2b an in-box `agentbox-ctl tool request` is denied at once with "no attached wrapper to confirm … or set AGENTBOX_GH_NO_SUB=allow" (exit 10) instead of appearing in `GET /api/v1/approvals`, so the web UI and the tray can't answer it. On docker the same request waits in `/api/v1/approvals` and works after approval. The message also names an unrelated gh variable.
- **Vercel: starting the claude session fails** with "Sandbox API request failed … status code: 200 OK" on `GET /api/v2/sandboxes/<name>?…&resume=false`: the SDK rejects a 200 response, most likely an API/SDK shape drift (`@vercel/sandbox ^2.0.1`).
- **E2B: the sandbox drops mid-scenario.** After claude committed, `agentbox shell` failed with "the connection to sandbox … ended before the stream completed: This error is likely due to sandbox timeout". The sandbox timeout isn't being extended while the box is in use.
- **Hetzner: a restored openclaw bot is not ready within 180s** (`openclaw --restore`); the suite now allows 600s. If it still fails, the restore path is at fault, not the VPS speed.
- **A box from an LFS repo fails to create when the host has no `git-lfs`.** On the Linux VM the in-container worktree tried to smudge `sample.bin` with the host's credential helper path (`/usr/bin/gh: not found` inside the box). On the Mac, git-lfs prefetches on the host first, so it works.
- **`agentbox dashboard` is unavailable on Node ≥ 25 for npm installs.** Its terminal backend, the optional `@homebridge/node-pty-prebuilt-multiarch@0.13`, declares `engines: node <25`, so npm silently skips it and the dashboard prints "native terminal backend failed to load". Seen on Node 26.8 with the packed nightly.
- **A codex box fails to create while the Codex desktop app is running.** Seeding the codex config volume rsyncs `~/.codex`, and the app's `ipc/ipc.sock` vanishes mid-copy: rsync exits 24 ("some files vanished") and `ensureCodexVolume` treats it as fatal. Exclude sockets, or accept exit 24.
- **Every plain `agentbox create` box runs a broken openclaw service, so `agentbox wait` never returns ready.** A box created without an agent registers no `agent`, `registrationAgents` (`packages/relay/src/registration-to-record.ts`) returns undefined, and `agents.list` falls back to shipping every agent's units, openclaw's included. In the box, `openclaw-onboard` exits 127 (not installed), the `openclaw` service waits forever on `openclaw-render`, and `agentbox wait <box>` times out. S4's "a plain `wait`" step tracks it; the rest of S4 waits on `--units postgres web`.
- **`openclaw --restore <bot>` names the new box `restored-<id>`**, not after the bot it restores, unless `-n` is given.
- **A scratch `HOME` kills the user's hub.** `applyRelayPortAtStartup` (`apps/cli/src/relay-port-override.ts`) always pins the port to the effective `relay.port`, whose default is 8787, so the documented `AGENTBOX_RELAY_PORT` override is dead at CLI startup. A hub started from any other `HOME` then reclaims 8787 and kills the running hub. Seen when `agentbox install` ran in a scratch home with only the env var set. The suite works around it by writing `relay.port` into every scratch config.
- **opencode boxes don't inherit the host's model.** Only the login is synced, not `~/.local/state/opencode/model.json`, so the box falls back to a provider the login doesn't cover (here Google, with no key). The suite pins `--model` from the host's last-used model.
- **A queued docker create reports `done` although the agent session died.** The opencode job above logged `starting opencode session … done` with no tmux session left in the box. The cloud path verifies the detached session came up; the docker path doesn't.
- **The agent-state probe lags.** `agent state` read `working` well after claude had committed and stopped; `agent wait-for input-needed` can also match `idle` before the turn starts. The suite waits on the git result instead.
- **Nested `--help` prints the root help.** `agentbox workspace add --help`, `tasks add --help`, `manager start --help`, `checkpoint create --help` all print the top-level help instead of their own options.
- **`doctor` says "docker not prepared" right after a bake.** The summary token maps any warning in a provider group to "not prepared"; the only docker warning was "portless not installed". The same happens for hetzner/digitalocean.
- **`doctor` in one `HOME` reports another `HOME`'s boxes** ("box relay port: agentbox-e2e-… still dial a relay port this host no longer serves"), because it reads the engine-wide container list.
- **"local hub restarted" without restarting.** With a stale hub on the port whose home had been wiped, the install wizard printed "local hub restarted on :8798", then "The local hub reports no API token"; the stale process kept the port.
- **Bare `agentbox` exits 1.** It prints the short help; the old checklist (BOOT-002) expected exit 0.
- **Tray: the menu rebuilt 3–10 times a second against a quiet hub.** The tray branch `feat/e2e-testability` adds a fingerprint that skips unchanged rebuilds; why a quiet hub triggers that many refreshes is still open.

## Harness gaps

- **remote-docker needs the VM in the user's real `~/.ssh/config`** (OpenSSH reads the passwd home, not `$HOME`). Done on Marco's Mac: a `Host e2e-linux` block pointing at the test VM with its key. The VM also has `git-lfs` now, so `docker@linux` gets past the LFS test repo.
- **Cloud `stop` reports `paused`** (E2B implements stop as its pause); the suite accepts either.

- **Environment, not product:** the first docker run failed opencode because this Mac's own opencode login had expired (`Token refresh failed: 401` in the box; the host `auth.json` was last refreshed in May). Re-login with `opencode auth login`. The harness now stops as soon as the agent reports `error` instead of waiting out the timeout.
- **A host `claude` under the e2e HOME reads as logged out** (the macOS login is keyed to the home). The harness passes the access token from `~/.agentbox/claude-credentials.json` as `CLAUDE_CODE_OAUTH_TOKEN`; the hub doesn't scrub it and boxes don't receive it.

- **Old e2e bakes are never deleted.** Every forced bake leaves a base snapshot/template per cloud in the account. Delete the previous e2e bake after a new one succeeds (never one the real `~/.agentbox/*-prepared.json` points at).
- **Tray on-screen steps need an idle Mac.** The AX reads and presses work with the menu closed; opening the menu and screenshots wait for a minute of user idle time and an unlocked screen. A Tart VM (or Daytona's use.computer Macs) would remove the constraint; needs a one-hour proof of concept each.
- **No judge on the Linux worker** (no `claude` on the VM); its steps are all scripted.
- **S2's tray check** (the box row with its PR label) is only in S8's generic row check; a PR label assertion needs a box with a merged PR while the tray runs.

## Next scenarios

- **S9 — remote hub via `hub expose`.** On the Linux test VM run `agentbox hub expose`, point the Mac's e2e CLI at it (`relay.controlPlaneUrl` + API key), replay a slim S2 through it (cloud box via `cloud.viaHub`, agent turn, push, merged PR; a docker box on the VM with the local relay off), and point the e2e tray at the same URL. Every run.
- **S10 — control box deployed to Hetzner.** `hub setup --deploy hetzner` non-interactively (pre-seeded `control-plane.env`), then: HTTPS on the sslip.io host, `hub status` version = local CLI, auth gates, the `docker:hub` flip (`box.provider` = `remote-docker`, host `hub`), a box built on the VPS, a push with the relay off, `hub update` in place, `hub destroy` leaving no `agentbox.role=control-plane` server or firewall. Release runs only (`--targets all` or `--with-deploy`). Open point: the released tarball isn't on npm yet — check whether `hub deploy --package` takes a tarball/URL, else `--ref <sha>` with swap or a bigger server type.

## Checklist IDs not yet in a scenario

See the "Not yet in a scenario" line in [`test-plan.md`](./test-plan.md). Candidates, in order of value: CLAUDE-003 (`claude start` resumes a stopped box), RELAY-009 (`git fetch` from the box), CKPT-007 (`--merged`), DL-002..005, CLAW-003/004 (overlay), TOOLS-006/008, URL-003/004.
