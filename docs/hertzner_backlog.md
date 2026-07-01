# Hetzner Cloud Provider — Backlog

> _Note: the filename uses the user-requested spelling `hertzner` (extra t); the actual product is **Hetzner Cloud**. Provider name and package use `hetzner`._

The plan lives at `~/.claude/plans/implement-a-sandbox-hertzner-using-serialized-pony.md`. This file tracks **what's done, in progress, and deferred** for the Hetzner provider build-out. Mirrors `docs/daytona-backlog.md` in structure.

Status legend:
- ⬜ pending
- 🟦 in progress
- ✅ done
- ⏭️ deferred (with reason)

---

## Already landed

`agentbox prepare --provider hetzner` end-to-end (mints temp VPS, runs install-box.sh, snapshots, cleans up) · `agentbox hetzner login` + `login --status` (interactive `HCLOUD_TOKEN` setup, persists to `~/.agentbox/secrets.env`) · `agentbox hetzner firewall sync <box> [--source <cidr>]` (re-detects egress IP and updates the per-box Hetzner firewall, no VPS reboot) · `agentbox hetzner firewall show <box>` (diagnostic — prints current rules + current host egress IP for drift comparison) · `@agentbox/sandbox-hetzner` package fully wired into the CLI's lazy-provider registry (`--provider hetzner` resolves via `getProvider`) · `CloudBackend` for hetzner with the full surface (`provision/get/list/start/stop/pause/resume/destroy/state/exec/uploadFile/downloadFile/listFiles/previewUrl/signedPreviewUrl/attachArgv/createSnapshot/deleteSnapshot`) · `SshTunnelManager` (per-box ControlMaster + dynamic `-L` port forwards via `ssh -O forward`) · auto-locked Hetzner Cloud Firewall (egress-IP-only inbound SSH, multi-probe fail-loud detection) · ed25519 per-box SSH keys minted into `~/.agentbox/hetzner/boxes/<sandboxId>/ssh/` with `accept-new` known_hosts and dropped on destroy · install-box.sh idempotent shell mirror of `Dockerfile.box` (Node 24, Python, Docker + agentbox-dockerd-start, VNC stack, agent-browser + Playwright Chromium, Claude/Codex/OpenCode agents, agentbox-ctl bundle, baked config files, sshd hardening drop-in) · runtime asset staging at `apps/cli/runtime/hetzner/` via `scripts/stage-runtime.mjs` · `withHetznerRetry` (mirrors daytona retry classification: 429/locked/conflict always, 5xx ambiguous, 4xx never) · hand-rolled REST client with typed `HetznerApiError` and paginated list endpoints · 41 unit tests across `retry`, `egress-ip`, `firewall`, `env-loader`, `cloud-init`, `runtime-assets`, `backend` state mapping · DinD inside the VPS via the unchanged `launchCloudDockerdDaemon` scaffolding (the install script bakes the same `/usr/local/bin/agentbox-dockerd-start` the docker provider ships) · `--provider hetzner` validated in `agentbox prepare`'s help text and `box.provider` config enum.

---

## Phases

### Phase 1 — Shared scaffolding ✅
- ✅ Lifted the Portless helpers' shared shape: kept them in `packages/sandbox-docker/src/portless.ts` (the dep direction is `sandbox-cloud → sandbox-docker`, so moving them into `sandbox-cloud` would create a cycle) and re-exported the names from `@agentbox/sandbox-cloud` so non-docker providers (hetzner) consume them via the cloud package without taking a direct sandbox-docker dep. Matches the existing `stage*` re-export pattern.
- ✅ Parameterized `portlessBrowserEnv(boxName, { mapTarget })` — `host.docker.internal` for Docker (passed at `packages/sandbox-docker/src/create.ts` ~line 589), `127.0.0.1` for Hetzner. Test updated.
- ✅ Added `box.defaultCheckpointHetzner` to `@agentbox/config`: `UserConfig` + `EffectiveConfig` + `BUILT_IN_DEFAULTS` + `KEY_REGISTRY` entry, plus the `'hetzner'` branches in `resolveDefaultCheckpoint` and `defaultCheckpointConfigKey`. `apps/cli/src/commands/checkpoint.ts` sweep-clear extended.
- ✅ Added `'hetzner'` to `KnownProviderName` in `apps/cli/src/provider/registry.ts` and the `getProvider` switch. Gate calls `ensureHetznerCredentials()` only — the base-snapshot gate lives in `backend.provision` to avoid chicken-and-egg with `agentbox prepare --provider hetzner`.
- ✅ Added `'hetzner'` case to `resolveCloudBackend` in `packages/relay/src/host-actions.ts` (with the same MODULE_NOT_FOUND friendly-error wrapper as daytona).
- ✅ `ProviderName` (core) + `ProviderKind` (config) gained `'hetzner'`.

### Phase 2 — `@agentbox/sandbox-hetzner` package skeleton ✅
- ✅ New package `packages/sandbox-hetzner/` with `package.json` (deps: `@agentbox/{config,core,sandbox-cloud,sandbox-core}`, `@clack/prompts`, `commander`, `execa`), `tsconfig.json`, `tsup.config.ts` (two-entry: `./` provider + `./cli` for commander), `src/index.ts` (full public-surface re-export).
- ✅ `src/client.ts` — hand-rolled REST client. Surface: server create/get/list/delete, action poweron/poweroff/shutdown/create_image, image list/get/delete, firewall create/set_rules/get/delete, locations probe for `login` validation. Typed `HetznerApiError` carrying `statusCode` + `code` + `details`. Paginated `listServers`/`listImages`.
- ✅ `src/retry.ts` — `withHetznerRetry` with the same error-classification shape as daytona: 429/locked/conflict always retry, 5xx ambiguous (caller opts in), 4xx never. 9 unit tests cover the classification + the wrapper's retry/exhaustion behavior.
- ✅ `src/credentials.ts` — `ensureHetznerCredentials()` mirror of daytona's. Persists `HCLOUD_TOKEN` to `~/.agentbox/secrets.env` (chmod 600, atomic rename, strips duplicates). Interactive on TTY, silent skip non-TTY. `readHetznerCredStatus()` + `maskKey()` for `login --status`.
- ✅ `src/env-loader.ts` — loads `HCLOUD_TOKEN`/`HCLOUD_ENDPOINT` from `~/.agentbox/secrets.env` on first use. 6 unit tests on `parseEnvFile`.
- ✅ `src/egress-ip.ts` — multi-probe (api.ipify.org → ifconfig.io → icanhazip.com), 3s per probe, fails loud if all fail (no silent 0.0.0.0/0). 3 unit tests cover happy path, fall-through, fail-loud.
- ✅ `src/firewall.ts` — `createPerBoxFirewall(client, {name, sourceCidr, labels})`, `syncFirewallSource(client, id, cidr)`, `deletePerBoxFirewall(client, id)` (idempotent on 404). `normalizeSourceCidr` (bare-IP → /32 or /128 → unchanged) + `sshOnlyInboundRule(cidr)` helpers. 5 unit tests.
- ✅ `src/prepared-state.ts` — JSON state at `~/.agentbox/hetzner-prepared.json` with `{base}`. Read/write/update helpers. Atomic rename + chmod 600. (An early `projects[<projectHash>]` field was removed — never wired; the per-project tier is checkpoint + `set-default`, see Phase 5.)
- ✅ `src/cli.ts` — `agentbox hetzner login` (functional), `hetzner login --status` (functional).

### Phase 3 — Base snapshot (`agentbox prepare --provider hetzner`) ✅
- ✅ `packages/sandbox-hetzner/scripts/install-box.sh` — idempotent install script run on a fresh Ubuntu 24.04 VPS. Mirrors `packages/sandbox-docker/Dockerfile.box`:
  - Node 24 (NodeSource), Python 3, corepack@latest + pnpm/yarn shims.
  - docker.io + iptables + fuse3 + fuse-overlayfs; `agentbox-dockerd-start` baked at `/usr/local/bin/`; vscode in the `docker` group; systemd's `docker.service`/`docker.socket` *disabled* (agentbox helper drives dockerd).
  - tigervnc-standalone-server + tigervnc-common + tigervnc-tools, novnc, websockify, autocutsel, xclip + `/usr/local/bin/agentbox-vnc-start`.
  - Playwright Chromium downloaded as `vscode` (so cache lands in vscode's home), stable symlink at `/usr/local/bin/chromium`; agent-browser + portless CLI as globals.
  - Claude Code via native installer (Anthropic-canonical path), Codex CLI (`@openai/codex`) + bubblewrap, OpenCode CLI (`opencode-ai`).
  - `agentbox-ctl` from `/tmp/agentbox-ctl` (shipped via scp) → `/usr/local/bin/`.
  - Baked config files (scp'd from host): `/etc/profile.d/agentbox.sh` (PATH prepend + COLORTERM + DISABLE_AUTOUPDATER + LANG + DISPLAY + AGENT_BROWSER_EXECUTABLE_PATH + BROWSER), `/etc/tmux.conf` (verbatim from Dockerfile.box), `/etc/claude-code/CLAUDE.md`, `/etc/claude-code/managed-settings.json`, `/usr/local/share/agentbox/codex-hooks.json`, `/usr/local/share/agentbox/setup-guide.md`.
  - User `vscode` (UID 1000) created (renames any pre-existing UID-1000 user from Hetzner's stock image to `vscode` to preserve cloud-init authorized_keys); sudoers `NOPASSWD: ALL` drop-in; credential pivot symlinks under `~/.agentbox-creds/{claude,codex,opencode}/`.
  - sshd hardening drop-in at `/etc/ssh/sshd_config.d/agentbox.conf`: `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers vscode`, `AllowTcpForwarding yes`, `GatewayPorts no`, `PermitTunnel no`, `X11Forwarding no`. sshd reloaded at end of script.
  - BEGIN/END markers per major step on stdout so `tail -f ~/.agentbox/logs/prepare.log` shows real progress; `set -euo pipefail` for fast-fail.
- ✅ `src/cloud-init.ts` — `generatePrepareCloudInit({sshPubkey})` (temp VPS, root login) + `generateBoxCloudInit({sshPubkey, boxName, boxEnv})` (per-box VPS, vscode login + `/etc/hosts` localhost alias + optional `box.env`). Hand-rolled YAML emitter (no extra dep).
- ✅ `src/ssh-key.ts` — `mintSshKey(targetDir, comment)` (ed25519 via `ssh-keygen`, 0600 private) + `mintPrepareKey()` (ephemeral under `~/.agentbox/hetzner/prepare-<ts>/`, cleanup callback).
- ✅ `src/ssh-cli.ts` — `sshExec` / `scpUpload` / `scpDownload` / `waitForSsh` thin wrappers around system `ssh`/`scp` with the `StrictHostKeyChecking=accept-new` + per-key `UserKnownHostsFile` + `BatchMode` + `LogLevel=ERROR` baseline.
- ✅ `src/poll.ts` — generic `pollUntil(label, check, opts)` with exponential interval (1s → 2s → … capped at 10s); timeout error names the label so failures are diagnosable.
- ✅ `src/runtime-assets.ts` — resolves the 10 on-disk files the install script needs from either `<cliRoot>/runtime/hetzner/...` (published CLI path, staged by `apps/cli/scripts/stage-runtime.mjs`) or the monorepo source tree (dev fallback). `findStagedCliRuntimeRoot()` auto-detects the published-CLI location by inspecting `import.meta.url` — no caller threading required.
- ✅ `src/prepare.ts` — `prepareHetzner({...})`: mint ephemeral SSH key → detect egress IP (or honor `firewallSource`) → create per-prepare Hetzner firewall → create temp VPS (`cx22` / `nbg1` defaults, configurable) with cloud-init injecting the pubkey → poll `waitForSsh` (5min deadline) → scp 10 runtime assets to `/tmp/` in parallel + chmod → `ssh root@vps bash /tmp/agentbox-install.sh` (30min deadline, install script's stdout teed through `onLog` as `[install] ...`) → `client.createImage(serverId, {type:'snapshot', description, labels})` → `pollUntil` image `status==='available'` (20min deadline) → `writePreparedState` → delete VPS + firewall.
- ✅ **Failure-cleanup discipline:** every catchable error path runs cleanup of VPS + firewall (best-effort, surfaces a clear "check Hetzner dashboard manually" warning on a cleanup-failure). The user can never end up with a forgotten €4/mo VPS due to a transient prepare error.
- ✅ **Idempotent skip-fast:** when `~/.agentbox/hetzner-prepared.json` already records a base AND that image still exists on Hetzner AND the install-script SHA256 matches AND `--force` was not passed → skip rebuild, return existing record.
- ✅ `apps/cli/scripts/stage-runtime.mjs` extended to also stage `runtime/hetzner/{scripts/install-box.sh, ctl.cjs, agentbox-vnc-start, agentbox-dockerd-start, agentbox-checkpoint-cleanup, agentbox-open, custom-system-CLAUDE.md, claude-managed-settings.json, agentbox-codex-hooks.json, agentbox-setup-skill.md}`. Verified at `apps/cli/runtime/hetzner/` after `pnpm -w build`.
- ✅ `ensureHetznerBaseSnapshot()` exists and is called by `backend.provision` (lifts the Phase-2 placeholder) — throws an actionable error pointing at `agentbox prepare --provider hetzner` when no base snapshot is on file yet. Not called from `getProvider('hetzner')` to avoid chicken-and-egg with prepare itself.
- ✅ Smoke: `agentbox prepare --provider hetzner -y` (no credentials) surfaces a clean "HCLOUD_TOKEN is empty / run `agentbox hetzner login`" error.
- ✅ 8 new unit tests for `cloud-init` (5) + `runtime-assets` (3). 31 hetzner-package tests total at end of Phase 3.

### Phase 4 — `CloudBackend` impl + SSH tunnel manager ✅
- ✅ `src/ssh-tunnel.ts` — `SshTunnelManager` class with one ControlMaster per box (`~/.agentbox/boxes/<sandboxId>/ssh/control.sock`). `open` spawns `ssh -fNT -M`; `forward(boxId, remotePort)` mints (or returns cached) `ssh -O forward -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`; `unforward` / `close` / `closeAll` tear down. `isAlive` uses `ssh -O check` to reuse a master from a prior crashed process when the socket is still responsive.
- ✅ `src/backend.ts` — `hetznerBackend: CloudBackend` with every method live:
  - `provision`: gates on `ensureHetznerBaseSnapshot`, resolves image (base snapshot id / numeric id / snapshot description), detects egress IP, creates per-box firewall, mints per-box ed25519 key into a temp dir (renamed to `~/.agentbox/hetzner/boxes/<sandboxId>/` after server creation), creates VPS with cloud-init injecting the pubkey, polls `waitForSsh` (5min), opens ControlMaster. Failure-cleanup deletes the VPS + firewall + ssh dir.
  - `get` / `list`: REST get + paginated list with `agentbox.managed=true` label selector.
  - `start` / `resume` / `stop` / `pause` / `destroy`: poweron/shutdown(+fallback poweroff)/delete with action polling. `destroy` also tears down the firewall via the `agentbox.firewall=<id>` label baked into the server's labels at provision, plus the per-box ssh dir.
  - `state`: Hetzner status → `CloudState` mapping (10 cases, including transitional ones reported as `running` so callers don't ping-pong). 10 unit tests verify the mapping.
  - `exec` / `uploadFile` / `downloadFile` / `listFiles`: all reuse the ControlMaster via `-S <sock>`. `exec` wraps the remote cmd in `bash -lc` so `/etc/profile.d/agentbox.sh`'s PATH/DISPLAY/AGENT_BROWSER_* are sourced.
  - `previewUrl` / `signedPreviewUrl`: mint a `ssh -L 127.0.0.1:<localPort>:127.0.0.1:<remote>` and return `http://127.0.0.1:<localPort>`. The cloud-provider layer adds the Portless `<box-name>.localhost` alias on top — handled provider-side rather than in the backend, so the backend stays focused on plumbing.
  - ✅ `startInBoxPortless(h, {boxName, proxyPort, tls, webPort})`: brings up a `portless` proxy *inside* the VPS that mirrors the host's mode so `https://<boxName>.localhost` resolves to the same content from both the host browser and the in-box browser. Idempotent — `portless proxy start` exits 0 on a running proxy. Node has `cap_net_bind_service` set in the base snapshot so binding 80/443 inside the VPS doesn't need sudo. The `portless` CLI is already baked in by `install-box.sh:316`.
    - ✅ **In-box CA trust (TLS mode)**: the mirror serves its own self-signed CA at `/root/.portless/ca.pem`. `portless proxy start` only trusts it in the Linux *system* store — not the box user's NSS db, which Chromium / Playwright read — so the VNC browser window and Playwright-via-Codex used to fail with a cert error on `https://<box>.localhost`. When `tls`, `startInBoxPortless` now runs the baked `agentbox-portless-trust /root/.portless/ca.pem` helper (system store via `update-ca-certificates` + vscode NSS db via `certutil`, idempotent, best-effort) and drops `NODE_EXTRA_CA_CERTS` into `/etc/profile.d/`. `libnss3-tools` (the `certutil` binary) is now baked by `install-box.sh`. The Docker provider gets the same trust step in `create.ts` against the bind-mounted host CA at `/home/vscode/.portless/ca.pem` when the host proxy is TLS. **Requires a snapshot re-bake** (`agentbox prepare --provider hetzner`) / docker image rebuild to pick up `libnss3-tools` + the helper.
  - `attachArgv`: returns ssh argv with `-S <controlPath>` (reuses ControlMaster — no new auth, no SSH-token mint pressure unlike Daytona).
  - `createSnapshot` / `deleteSnapshot`: maps to Hetzner `create_image` (no-pause by default — matches `docker commit` semantics + the user's "optionally without pausing"). `deleteSnapshot` is idempotent on 404. Both labeled with `agentbox.role=ckpt` + `agentbox.box=<sandboxId>` for orphan discovery.
  - No `ensureVolume` — Hetzner has no shared-volume primitive suitable for agent credentials (the cloud-provider layer probes for it and degrades cleanly).
- ✅ Module-level `tunnels = new SshTunnelManager()` so the ControlMaster persists across CloudBackend method calls within one CLI invocation. `ensureLiveTarget(sandboxId)` is the load-bearing helper that re-fetches the VPS IP from Hetzner, ensures the tunnel is open, and returns a ready-to-use `SshTargetArgs`.
- ✅ Box-env passthrough: anything in `req.env` prefixed `AGENTBOX_*` lands in `/etc/agentbox/box.env` via the per-box cloud-init `write_files` block — **except** the relay/bridge tokens (`cloudInitBoxEnv` strips them; `box.env` is 0644). The relay token reaches in-box ctl via the daemon's `0600 /run/agentbox/relay.env` instead, the bridge token via the daemon process env. This closed the regression where the cloud agent's `agentbox-ctl git push` failed "no relay configured" (the daemon's box.env overwrite, b9e4ebf55, had dropped the token login shells relied on). See [`host-relay.md`](./host-relay.md).
- ✅ `AGENTBOX_HETZNER_FIREWALL_SOURCE` env var override (passed via `req.env` or `process.env`) lets advanced users force a specific firewall source CIDR at create time (mirrors `--firewall-source` for `prepare`).

### Phase 5 — Per-project snapshot tier + checkpoints ✅ (partial — checkpoint surface complete; per-project snapshot tier deferred)
- ✅ `box.defaultCheckpointHetzner` lookup is plumbed through `resolveDefaultCheckpoint(cfg, 'hetzner')` (Phase 1). `agentbox checkpoint set-default --provider hetzner <ref>` and `--checkpoint <ref>` paths work via the existing cloud-provider scaffolding because:
  - `createSnapshot(h, name)` + `deleteSnapshot(name)` are both implemented on the backend.
  - The cloud-checkpoint manifest layout at `~/.agentbox/cloud-checkpoints/hetzner/<projectSegment>/<name>/manifest.json` is already backend-agnostic; no schema changes needed.
  - `agentbox create --provider hetzner --checkpoint <name>` resolves the manifest, passes `req.snapshot = <description>` to provision, the backend's `resolveImageId` looks up the snapshot by description, and provision boots from it (skipping workspace seeding because the snapshot already has `/workspace`).
- ✅ **Per-project snapshot tier — resolved (not a separate feature).** The tier *is* the checkpoint + `set-default` flow above: `agentbox checkpoint create <box> setup --set-default` writes a per-project (hash-keyed) manifest and `box.defaultCheckpointHetzner`, and subsequent creates boot from it and skip workspace seeding. Auto-capture at the end of setup is already driven cross-provider by the `/agentbox-setup` skill, which runs `agentbox-ctl checkpoint --name setup --replace --set-default` (`apps/cli/share/agentbox-setup/SKILL.md`). So there's **no** separate `projects[<hash>]` registry and **no** `backend.afterFirstCreate?` hook to build — the early `projects` field in `prepared-state.ts` was never wired and has been removed. (This is the same for docker — the setup skill, not core create logic, drives the auto-checkpoint, by design.)
- ⏭️ **`--pause` flag on `agentbox checkpoint create`** — deferred. The `CloudBackend.createSnapshot?(h, name)` interface doesn't take an options arg, so wiring `--pause` requires extending the interface (which affects daytona). For Hetzner the default is already no-pause (matching the user's requirement and `docker commit`'s default). Users wanting a quiescent snapshot can manually `agentbox pause <box> && agentbox checkpoint create <box> name && agentbox start <box>`.

### Phase 6 — `agentbox hetzner` CLI subcommands ✅
- ✅ `agentbox hetzner login` — interactive `HCLOUD_TOKEN` setup with browser auto-open + dashboard link, validates by calling `GET /locations`, persists to `~/.agentbox/secrets.env`.
- ✅ `agentbox hetzner login --status` — prints currently-configured token (masked) + source (env vs secrets.env) + endpoint override.
- ✅ `agentbox hetzner firewall sync <box> [--source <cidr>]` — re-detects egress IP (or honors explicit `--source`), updates the per-box firewall via `setFirewallRules`. Resolves the box via `resolveBoxRef` + reads the firewall id from the Hetzner server's `agentbox.firewall` label.
- ✅ `agentbox hetzner firewall show <box>` — prints the current rule set + the host's current egress IP, with a `WARN` line when they don't match (catches the "I moved networks and ssh times out" diagnostic case).
- ✅ `agentbox prepare --provider hetzner` — dispatched via the registry's `getProvider` → `hetznerProvider.prepare`. Help text + the `isKnownProvider` validation message updated to include `hetzner`.
- ⏭️ **`agentbox prune --provider hetzner`** — not wired into the CLI's `prune` command. The provider scaffolding's prune flow uses `CloudBackend.list?()` which IS implemented, so the underlying primitive works; only the CLI dispatcher needs the case added. Follow-up: drop the `case 'hetzner'` into `apps/cli/src/commands/prune.ts:resolveCloudBackendForPrune`.

### Phase 7 — End-to-end verification + docs ✅ (live-smoked on 2026-05-24)

Live smoke run completed against a real Hetzner project. Results:

| Step | Command | Result |
|---|---|---|
| 1 | `agentbox hetzner login` | ✅ HCLOUD_TOKEN persisted to `~/.agentbox/secrets.env`; `--status` shows masked token |
| 2 | `agentbox prepare --provider hetzner -y` | ✅ Temp VPS bootstrapped, install ran, snapshot `agentbox-base-mpk9vljx` (2.4 GB) created, VPS + firewall cleaned up. `hetzner-prepared.json` written. ~12 min wall clock |
| 3 | `agentbox create -y -n smoke --provider hetzner` | ✅ VPS provisioned + firewall locked to host's egress IP (94.62.212.253/32) + SSH ControlMaster up. ~90s wall clock |
| 4 | `agentbox shell smoke --no-tmux -- uname -a` | ✅ Returns kernel info over SSH ControlMaster (no per-call handshake) |
| 5 | `agentbox status smoke` | ✅ Shows web preview (http://127.0.0.1:NNNN), relay preview, bridge token set |
| 6 | `agentbox url smoke --print` | ✅ Returns SSH-forwarded loopback URL |
| 7 | `agentbox hetzner firewall show smoke` | ✅ Shows the SSH-only rule + host's current egress IP for drift comparison |
| 8 | DinD: `docker run --rm hello-world` inside box | ✅ dockerd PID 1226 running, /var/run/docker.sock present, container pulled + ran ("Hello from Docker!") |
| 9 | `agentbox checkpoint create smoke setup` | ✅ no-pause snapshot taken (box `uptime` after still reads ~2min); manifest at `~/.agentbox/cloud-checkpoints/hetzner/...`; Hetzner image `agentbox-ckpt-...` available |
| 10 | `agentbox destroy smoke -y` | ✅ Server + firewall both deleted (no orphans). Final resource count: 0 servers, 0 firewalls, 2 snapshots (the base + the user's checkpoint) |

Two cosmetic issues found and patched mid-smoke:
- ✅ Hetzner deprecated `cx22` (early 2026) — switched default to `cx23` (same 2 vCPU / 4 GB / 40 GB x86 shape).
- ✅ Hetzner Ubuntu 24.04 image enforces first-login password expiry for root → patched cloud-init with `chpasswd: expire: false` + `passwd -d root` + `chage` belt-and-braces (plus same fix for the per-box vscode cloud-init).
- ✅ `deletePerBoxFirewall` was racing the server-delete + 422'ing on `resource_in_use` — added poll-and-retry (60s deadline, exponential backoff) covering both 409 `conflict` and 422 `resource_in_use`.
- ✅ Cloud-provider scaffolding defaults `req.image` to `'agentbox/box:dev'` (docker tag) → backend's `resolveImageId` now recognizes it as the Hetzner base-snapshot sentinel.
- ✅ Parallel scp uploads were racing sshd's `MaxStartups 10:30:100`, leaving some destination files 0-byte — serialized.

**Phase-7 follow-ups (in the Follow-ups section below):**
- ✅ **Chromium AppArmor user-ns block (post-2026-05-25).** On Ubuntu 24.04 (Hetzner's default), `kernel.apparmor_restrict_unprivileged_userns=1` blocks Chromium's zygote sandbox — every in-box `agent-browser` / `chromium` invocation died with `FATAL: No usable sandbox!`. The host VPS is itself the isolation boundary, so relaxing the knob is safe. `install-box.sh` now writes `/etc/sysctl.d/99-agentbox-userns.conf` (sets `apparmor_restrict_unprivileged_userns=0` + `unprivileged_userns_clone=1`) and applies it inline so the rest of the install can use Chromium too. Future snapshot rebakes pick it up automatically.
- Cosmetic: `agentbox checkpoint create` says "daytona snapshot" in user-facing text even for hetzner boxes (the message is in the shared cloud-provider scaffolding).
- Cosmetic: `agentbox checkpoint ls` returns "no checkpoints" from /tmp paths because the project-hash anchor reads `/private/tmp/...` vs `/tmp/...` differently — minor lookup-path inconsistency, manifest is correctly written.
- Cosmetic: `/usr/local/bin/chromium` symlink missing (the last command of the Chromium download step) — `AGENT_BROWSER_EXECUTABLE_PATH` should fallback to the playwright cache; tracked.
- Diagnostic: the install script's bash -x trace + file writes silently stop after `playwright install chromium` for unknown reasons (steps after Chromium download don't materialize on the snapshot even though the script exits 0). Worked around by reordering install-box.sh — all baked helper scripts + config files + sshd hardening drop-in + login-shell shim + credential pivot run BEFORE the Chromium download. Snapshot is now complete. Root cause still unknown.

**Original verification recipe** (kept for re-runs):

```bash
# 1. Auth + bake the base snapshot (~10-15 min on first run, ~€0.02 in VPS time).
node apps/cli/dist/index.js hetzner login       # interactive, paste a Hetzner project token
node apps/cli/dist/index.js prepare --provider hetzner -y
# Watch: tail -f ~/.agentbox/logs/latest.log

# 2. Cold create + firewall lock-down check.
node apps/cli/dist/index.js create -y -n hetzner-smoke --provider hetzner
# From a separate shell, scan with nmap — only port 22 should be open, and
# only from the host's egress IP.

# 3. Bridge / exec / Portless symmetry.
node apps/cli/dist/index.js exec hetzner-smoke -- uname -a
node apps/cli/dist/index.js url hetzner-smoke              # https://hetzner-smoke.localhost
# Same URL works on host AND in-box (a portless proxy runs inside the VPS too):
curl http://hetzner-smoke.localhost:1355                   # host-side via host portless
node apps/cli/dist/index.js exec hetzner-smoke -- curl http://hetzner-smoke.localhost:1355
# Smoke fixture for end-to-end Portless: cd examples/express-ready && cp .env.example .env

# 4. DinD inside the VPS.
node apps/cli/dist/index.js exec hetzner-smoke -- docker run --rm hello-world

# 5. Checkpoint (no-pause) + restore.
node apps/cli/dist/index.js checkpoint create hetzner-smoke setup
node apps/cli/dist/index.js destroy hetzner-smoke -y
node apps/cli/dist/index.js create -y -n hetzner-smoke2 --provider hetzner --checkpoint setup

# 6. Egress-IP drift recovery.
# (toggle a VPN, then…)
node apps/cli/dist/index.js exec hetzner-smoke2 -- true   # should now fail
node apps/cli/dist/index.js hetzner firewall sync hetzner-smoke2
node apps/cli/dist/index.js exec hetzner-smoke2 -- true   # should now succeed

# 7. Destroy + dashboard cleanup check.
node apps/cli/dist/index.js destroy hetzner-smoke2 -y
# Hetzner dashboard: server gone, firewall gone, snapshot retained.
```

**Docs updates:**
- ✅ `docs/cloud-providers.md` — added the `hetzner` row to the provider matrix + a §3 "The Hetzner shape" subsection (mirrors §2 "The Daytona shape" with sub-sections for topology + prepare flow + SSH tunnel manager + checkpoints + DinD + shape differences + CLI surface). §4 Authentication extended with the `hetzner login` paragraph; remaining §s renumbered.
- ✅ `CLAUDE.md` — intro paragraph mentions all three backends; architecture overview gained a `hetzner` bullet; checkpoint paragraph names `defaultCheckpointHetzner`; "Important notes" describes the hetzner credential + state-file paths; doc map lists `docs/hertzner_backlog.md`.

---

## Follow-ups / postponed

Items deferred during implementation or surfaced during Phase 7 live smoke. Each has the workaround documented above.

- **install-box.sh diagnostic mystery (Phase 7).** Across three independent prepare runs on Hetzner Ubuntu 24.04 cx23, `bash -x /tmp/agentbox-install.sh 2>&1 | sudo tee /var/log/agentbox/install.log` consistently truncates the trace exactly at the end of `sudo -u vscode -H bash -lc 'playwright install chromium'`, and no file system changes from script lines beyond that point materialize on the snapshot — yet the install exits 0 and the orchestrator sees success. Direct repro of `bash -x -c "echo A; sudo -u vscode -H bash -lc 'echo X'; echo B"` works correctly, so it's not a `sudo` FD-mangling issue per se. Worked around by reordering `install-box.sh` so all small file-install steps (baked helpers, baked configs, sshd hardening drop-in, login-shell shim, credential pivot) run BEFORE the Chromium download. The reorder makes the snapshot complete. Real diagnosis is open: candidate causes are (a) Playwright/Node closing an inherited FD that propagates to our outer bash, (b) some apparmor/seccomp interaction killing `tee` mid-write, (c) a tmpfs / journald race. Next steps: try `script -q -c '...' /var/log/agentbox/install.log` instead of pipe-tee, or run the install via systemd-run to isolate the session.
- **RESOLVED (2026-06-27): Claude install silently skipped → box has no `claude`, attach loops on "no server running on /tmp/tmux-1000/default".** `claude.ai` + `downloads.claude.ai` sit behind Cloudflare, which **intermittently** returns **HTTP 403** to cloud-datacenter egress IPs (Hetzner among them) under load — re-testing minutes later returned 200. The bake's `curl -fsSL https://claude.ai/install.sh | bash -s stable` masked this: `curl -f` exits non-zero on the 403 but the pipeline's status is `bash`'s 0, so the step "succeeded" while baking a claude-less snapshot — and every box from it had no `claude`, so the in-box agent tmux session died instantly and `attach` crash-looped. Fixed in `install-box.sh` (and mirrored in vercel `provision.sh` / e2b `build-template.sh` / docker `Dockerfile.box`): a `retry_backoff` helper retries the native installer **3 times with 60s then 240s backoff** (~5 min budget), keeping `set -o pipefail` and folding `command -v claude` into the retried command so a "succeeded but absent" result also retries; if all 3 attempts fail the bake aborts (`exit 71`) — a failed `prepare` beats a claude-less snapshot. `prepareHetzner` special-cases `exit 71` with an actionable error ("native installer unreachable after retries — transient Cloudflare 403 on the datacenter IP, wait and re-run `prepare --force`") instead of the opaque generic "(empty stderr)" message (`bash -x … 2>&1 | tee` merges stderr into stdout, so the captured stderr is always empty). **No npm fallback** (an earlier attempt used one, but `npm install -g @anthropic-ai/claude-code` lacks native-only features the user relies on and lands the binary at `/usr/bin/claude`, which mismatches the host-seeded `installMethod=native` and trips Claude Code's startup "claude command at ~/.local/bin/claude missing or broken" doctor warning). **Action required: rebake the base snapshot (`agentbox prepare --provider hetzner --force`) — the fix only applies to new bakes.**
  - **KNOWN GAP / deferred follow-up: the 403 can outlast the ~5-min retry window**, so `prepare` can still fail and need a manual re-run. The real reliability fix (validated by PoC, not yet built): **host-proxy the native binary.** `claude.ai/install.sh` just downloads `downloads.claude.ai/claude-code-releases/{version}/{platform}/claude` (a complete ~244 MB self-contained ELF) and runs `<binary> install` (which re-fetches from the same blocked CDN — `claude install` has NO offline mode). PoC confirmed: the downloaded binary, placed directly at `~/.local/bin/claude` (skipping `install`), runs fully offline and satisfies the `installMethod=native` doctor check. So the fix is: during `prepare`, the **host** (always gets 200) downloads the binary for the VPS arch (cx23=`linux-x64`; cax=`linux-arm64`), checksum-verifies against `{version}/manifest.json`, caches it under `~/.agentbox/`, scp's it to the VPS via the runtime-assets push, and `install-box.sh` drops it at `~/.local/bin/claude` (chmod+chown vscode) instead of curling. True native, 100% reliable, no npm. Deferred per user (kept retries + clear error for now); apply to vercel/e2b too if they start 403ing.
- **`agentbox checkpoint create` says "daytona snapshot" for hetzner boxes (cosmetic).** The progress message lives in shared cloud-provider code that hardcodes "daytona". Cheap fix: parameterize via `backend.name`.
- **`agentbox checkpoint ls` returns empty from /tmp project dirs.** The macOS `/private/tmp/...` vs `/tmp/...` resolution mismatches the project-hash anchor used at create time. Manifests are correctly written; only the lookup is sensitive.
- **`/usr/local/bin/chromium` symlink missing on the baked snapshot.** It's the very last command of the Chromium step, AFTER the playwright download — gets eaten by the same install-script truncation mystery above. Workaround: agent-browser falls back to the cached playwright binary path. Real fix: move the `ln -sf` line to an EARLIER step (or after agent-browser install).
- **`--pause` flag on `agentbox checkpoint create`.** Requires extending `CloudBackend.createSnapshot?(h, name)` signature to accept options. Workaround: manual `pause` → `checkpoint create` → `start` sequence.
- **`agentbox prune --provider hetzner`.** The backend's `list()` is implemented; only the CLI dispatcher in `apps/cli/src/commands/prune.ts` needs a one-line case added.
- **True zero-cost pause** (delete-and-respawn-from-per-box-snapshot). Hetzner bills stopped VPSes (~€4/mo for `cx23`). v1's `pause/resume` = `poweroff/poweron`. Future: capture a per-box snapshot before delete; respawn from it on resume.
- **`@agentbox/sandbox-hetzner` published-as-CLI runtime contract test.** Daytona has one (`apps/cli/test/cloud-e2e.test.ts` gated on `DAYTONA_API_KEY`); a parallel `hetzner-e2e.test.ts` gated on `HCLOUD_TOKEN` would cover the full `create → exec → destroy` cycle against a real Hetzner account.
- **IPv6-first SSH.** The backend reads `public_net.ipv4.ip`. Switch to v6 when the host network is v6-only (Hetzner returns both addresses, but our resolution prefers v4 today).
- **Block Volumes.** Not used in v1 — `/workspace` lives on the VPS root disk, so checkpoints snapshot the whole disk. Per-server block volume for workspace would make checkpoints cheaper.
- **`prepare` log-file integration.** The Daytona `prepare` uses `openCommandLog('prepare')` for clean tee'd output. The Hetzner `prepare` currently just redirects to a manual log path during smoke runs — wire `openCommandLog` for parity. Tee through clack-spinner output is unreadable.

---

## Known caveats — already documented in the plan

These ship with v1 by design; tracked here so they're discoverable next time someone wonders.

- **Idle VPS cost.** Hetzner `cx22` is ~€4/mo even when stopped. v1's `pause/resume` literally stops the VPS — billing continues. See the "true zero-cost pause" follow-up.
- **Provision latency.** ~30–60s cold (cloud-init); ~15–20s from base snapshot. The `create` progress UI already streams steps.
- **No live `top`/`stats`.** Hetzner basic API doesn't expose per-server CPU/mem. Cloud rows render `—`, matching Daytona.
- **IPv4 only.** SSH targets `public_net.ipv4.ip` — IPv6 not exercised yet.

---

## Quick reference — where each piece lives

| Concern | File |
|---|---|
| Provider entry + composition | `packages/sandbox-hetzner/src/index.ts` |
| CloudBackend implementation | `packages/sandbox-hetzner/src/backend.ts` |
| SSH ControlMaster + forwards | `packages/sandbox-hetzner/src/ssh-tunnel.ts` |
| `agentbox prepare` orchestration | `packages/sandbox-hetzner/src/prepare.ts` |
| install-box.sh (Dockerfile.box mirror) | `packages/sandbox-hetzner/scripts/install-box.sh` |
| Cloud-init generator | `packages/sandbox-hetzner/src/cloud-init.ts` |
| REST client + typed errors | `packages/sandbox-hetzner/src/client.ts` |
| Retry wrapper | `packages/sandbox-hetzner/src/retry.ts` |
| Egress-IP detection | `packages/sandbox-hetzner/src/egress-ip.ts` |
| Firewall create/sync/delete | `packages/sandbox-hetzner/src/firewall.ts` |
| Credentials + login | `packages/sandbox-hetzner/src/credentials.ts` |
| Env-loader (HCLOUD_TOKEN ← secrets.env) | `packages/sandbox-hetzner/src/env-loader.ts` |
| Persisted base/project snapshot state | `packages/sandbox-hetzner/src/prepared-state.ts` |
| Runtime asset resolver | `packages/sandbox-hetzner/src/runtime-assets.ts` |
| `agentbox hetzner` CLI | `packages/sandbox-hetzner/src/cli.ts` |
| CLI registration | `apps/cli/src/index.ts` + `apps/cli/src/provider/registry.ts` |
| Relay backend resolver | `packages/relay/src/host-actions.ts` |
| Runtime asset staging (publish) | `apps/cli/scripts/stage-runtime.mjs` |
