# Release e2e — backlog

> Live list for [`release-e2e-plan.md`](./release-e2e-plan.md). Product bugs the suite found, harness gaps, and the checklist IDs not yet in a scenario.

## Product bugs found by the suite

Found while building and first running the suite on nightly `0.33.0-nightly.202609211038` (2026-09-21). Not fixed in the suite's branch; each needs its own change.

- **`agentbox dashboard` is unavailable on Node ≥ 25 for npm installs.** Its terminal backend, the optional `@homebridge/node-pty-prebuilt-multiarch@0.13`, declares `engines: node <25`, so npm silently skips it and the dashboard prints "native terminal backend failed to load". Seen on Node 26.8 with the packed nightly.
- **A codex box fails to create while the Codex desktop app is running.** Seeding the codex config volume rsyncs `~/.codex`, and the app's `ipc/ipc.sock` vanishes mid-copy: rsync exits 24 ("some files vanished") and `ensureCodexVolume` treats it as fatal. Exclude sockets, or accept exit 24.
- **Every plain `agentbox create` box runs a broken openclaw service, so `agentbox wait` never returns ready.** A box created without an agent registers no `agent`, `registrationAgents` (`packages/relay/src/registration-to-record.ts`) returns undefined, and `agents.list` falls back to shipping every agent's units, openclaw's included. In the box, `openclaw-onboard` exits 127 (not installed), the `openclaw` service waits forever on `openclaw-render`, and `agentbox wait <box>` times out. S4's "a plain `wait`" step tracks it; the rest of S4 waits on `--units postgres web`.
- **`openclaw --restore <bot>` names the new box `restored-<id>`**, not after the bot it restores, unless `-n` is given.
- **A scratch `HOME` kills the user's hub.** `applyRelayPortAtStartup` (`apps/cli/src/relay-port-override.ts`) always pins the port to the effective `relay.port`, whose default is 8787, so the documented `AGENTBOX_RELAY_PORT` override is dead at CLI startup. A hub started from any other `HOME` then reclaims 8787 and kills the running hub. Seen when `agentbox install` ran in a scratch home with only the env var set. The suite works around it by writing `relay.port` into every scratch config.
- **opencode boxes don't inherit the host's model.** Only the login is synced, not `~/.local/state/opencode/model.json`, so the box falls back to a provider the login doesn't cover (here Google, with no key) and the session exits at once. The suite pins `--model` from the host's last-used model.
- **A queued docker create reports `done` although the agent session died.** The opencode job above logged `starting opencode session … done` with no tmux session left in the box. The cloud path verifies the detached session came up; the docker path doesn't.
- **The agent-state probe lags.** `agent state` read `working` well after claude had committed and stopped; `agent wait-for input-needed` can also match `idle` before the turn starts. The suite waits on the git result instead.
- **Nested `--help` prints the root help.** `agentbox workspace add --help`, `tasks add --help`, `manager start --help`, `checkpoint create --help` all print the top-level help instead of their own options.
- **`doctor` says "docker not prepared" right after a bake.** The summary token maps any warning in a provider group to "not prepared"; the only docker warning was "portless not installed". The same happens for hetzner/digitalocean.
- **`doctor` in one `HOME` reports another `HOME`'s boxes** ("box relay port: agentbox-e2e-… still dial a relay port this host no longer serves"), because it reads the engine-wide container list.
- **"local hub restarted" without restarting.** With a stale hub on the port whose home had been wiped, the install wizard printed "local hub restarted on :8798", then "The local hub reports no API token"; the stale process kept the port.
- **Bare `agentbox` exits 1.** It prints the short help; the old checklist (BOOT-002) expected exit 0.
- **Tray: the menu rebuilt 3–10 times a second against a quiet hub.** The tray branch `feat/e2e-testability` adds a fingerprint that skips unchanged rebuilds; why a quiet hub triggers that many refreshes is still open.

## Harness gaps

- **Environment, not product:** the first docker run failed opencode because this Mac's own opencode login had expired (`Token refresh failed: 401` in the box; the host `auth.json` was last refreshed in May). Re-login with `opencode auth login`. The harness now stops as soon as the agent reports `error` instead of waiting out the timeout.
- **A host `claude` under the e2e HOME reads as logged out** (the macOS login is keyed to the home). The harness passes the access token from `~/.agentbox/claude-credentials.json` as `CLAUDE_CODE_OAUTH_TOKEN`; the hub doesn't scrub it and boxes don't receive it.

- **Old e2e bakes are never deleted.** Every forced bake leaves a base snapshot/template per cloud in the account. Delete the previous e2e bake after a new one succeeds (never one the real `~/.agentbox/*-prepared.json` points at).
- **Tray on-screen steps need an idle Mac.** The AX reads and presses work with the menu closed; opening the menu and screenshots wait for a minute of user idle time and an unlocked screen. A Tart VM (or Daytona's use.computer Macs) would remove the constraint; needs a one-hour proof of concept each.
- **No judge on the Linux worker** (no `claude` on the VM); its steps are all scripted.
- **S2's tray check** (the box row with its PR label) is only in S8's generic row check; a PR label assertion needs a box with a merged PR while the tray runs.

## Checklist IDs not yet in a scenario

See the "Not yet in a scenario" line in [`test-plan.md`](./test-plan.md). Candidates, in order of value: CLAUDE-003 (`claude start` resumes a stopped box), RELAY-009 (`git fetch` from the box), CKPT-007 (`--merged`), DL-002..005, CLAW-003/004 (overlay), TOOLS-006/008, URL-003/004.
