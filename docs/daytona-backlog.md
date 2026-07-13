# Daytona Cloud Provider — Backlog

The full 6-phase plan lives at `~/.claude/plans/synthetic-jumping-flame.md`. This file tracks **what's still missing** after the foundation + comms + Daytona backend + most of Phase 3 routing landed and were e2e-verified against a real Daytona sandbox.

Status legend:
- 🔴 **blocking** — cloud users hit this often / no workaround.
- 🟡 **friction** — has a workaround; smooths UX when fixed.
- 🟢 **polish** — nice-to-have / cleanup / aesthetics.

## Idle auto-stop was inert, and three bugs behind it (2026-07-13)

Closing out the linux-vm handoff's untested paths. All five were run against live Daytona; four of
the five were fine, and the fifth — the auto-stop — turned out not to work at all, taking three
other bugs down with it.

### The finding: our own polling kept every box alive

`box.daytonaTimeoutMs` (25 min) is passed as Daytona's `autoStopInterval`, an **inactivity window
that any request to the sandbox resets**. The host relay's `CloudBoxPoller` long-polls each cloud
box's preview URL continuously — so *our own polling was the activity*. Daytona's timer restarted on
every poll and an idle box ran, and billed, forever. The feature was inert exactly when AgentBox was
in normal use; it only worked with the relay down.

Measured with `autoStopInterval: 3`:

| sandbox | traffic | result |
| --- | --- | --- |
| control | none | stopped at **3.0 min** |
| test | one request / 15 s | **still running at 7.0 min** (28 requests) |
| the same test box, once requests ceased | none | stopped **3 min later** |

The third row is the control that names the cause — a node server ran in the box throughout, so it
is the **requests** that reset the clock, not activity inside the sandbox. (It also proves the
instrument: the REST state-polling used to observe all this does *not* count as activity, or the
control would never have stopped.)

**Fix:** the host enforces the timeout. `CloudBackend.timeoutModel` (`'inactivity'` | `'absolute'`)
marks the difference, and `cloud-keepalive.ts` pauses a box whose agent has been idle for the box's
own `daytonaTimeoutMs` (`shouldIdlePause`). **vercel/e2b are unaffected** — their deadlines are
absolute and nothing the box receives defers them.

Design notes worth keeping:

- The pause window is the **box's own** `daytonaTimeoutMs`, not the 5-min autopause/keepalive
  renewal window. Using the renewal window would have paused boxes 5× sooner than the config key
  advertises.
- A box with **no agent state** is never auto-paused (an attached shell with no agent is exactly who
  we must not stop under). The window is therefore measured on *agent* idleness, not raw requests —
  a deliberate divergence from what Daytona's own timer would have counted.
- We **pause**, not stop: a linux-vm freeze keeps memory and running processes, and every attach path
  already resumes a paused box.
- Daytona's `autoStopInterval` is still set, as the backstop for when the relay isn't running.

### Three bugs it uncovered

1. **`agentbox pause` was broken for container-class boxes** — `■ Sandbox is not stopped`. Daytona
   archives only a *stopped* sandbox, and `pause()` went straight to `sb.archive()`. Not a linux-vm
   regression: `main` has the same bare call. It survived because the class plumbing made linux-vm
   the default and the container path was never re-tested (this handoff's open item #4). Now stops
   first.
2. **`agentbox shell <box> -- cmd` never resumed a paused cloud box** — it called `provider.exec`
   with no `probeState`/`start` guard, so it just failed (daytona: a 502 from the proxy). Every other
   cloud entry point already resumed. Pre-existing and provider-wide; the idle sweep merely made
   paused boxes common enough to trip it.
3. **The container fallback asked for a container in a VM-only region.** With no published box image
   (`box.claudeInstall: npm`, or any locally shifted build fingerprint — i.e. every monorepo
   contributor) the linux-vm bake correctly falls back to a container, but the CLI had already
   resolved the *class-derived* region and passed `us-east-1`, which has no container runners. The
   whole `prepare` died instead of degrading. The CLI now passes only an explicitly pinned
   `box.daytonaRegion`.

### Verified working (the handoff's other open items)

- A real logged-in **`claude -p` turn** in a linux-vm box.
- In-box **`agentbox-ctl git push`** through the host relay — the commit landed on GitHub (checked
  with `git ls-remote`, not the exit code).
- **Container-class create** end-to-end after the class plumbing.
- The **`--claude-install npm` → container fallback** (once bug 3 above was fixed).
- **Pause/resume preserves processes**: a marker `sleep` kept the same PID across a host-driven
  freeze, and its tmux session survived.

### Still open

- 🟡 **A container box's Claude credentials come from the shared volume and go stale.** A fresh
  container box failed its first `claude -p` with `OAuth session expired and could not be refreshed`,
  while a VM box (which takes the per-create upload path, since VM ignores volume mounts) worked.
  The shared `agentbox-credentials` volume is only re-seeded on a content-hash change, so a
  refreshed host token doesn't necessarily reach it. Needs its own look.

## Linux-VM sandbox class — PoC findings (2026-07-12)

Daytona added a second sandbox **class** (`linux-vm` beside the default `container`). PoC run live
against `@daytona/sdk@0.196.0` before writing any provider code. Every claim below is measured, not
read off the docs — several contradict the docs.

**Green (VM works, and is fast):**

| Probe | Result |
|---|---|
| GHCR box image → VM snapshot | **66s** (vs ~7 min for today's container Dockerfile build) |
| `pause()` / `start()` | 5s / 1s. A running `sleep` **and** a live tmux session survive — real memory freeze |
| Cold snapshot (`_experimental_createSnapshot`) | stop 4s → capture **2s** → `active`. Endpoint is live again (it 404'd when §5.1.1 was written) |
| Restore from that snapshot | 1s; filesystem intact; the restored box is **still a VM** (class inherits) |
| toolbox `exec` | runs as `vscode`, `HOME=/home/vscode` — same as container |
| `fs.uploadFile`, `getPreviewLink`, `getSignedPreviewUrl`, `createSshAccess` | all work |
| DinD | `dockerd` is **already running** at boot; `vscode` is in the `docker` group; `docker run hello-world` works with no sudo |
| `archive()` on a VM | Rejected — *"Sandboxes in this region or class cannot be archived"* |

**Three constraints that shape the implementation:**

1. **`linux-vm` exists in exactly one region: `us-east-1`.** Both shared regions (`us` — the
   default — and `eu`) return *"No runners are configured in region '<r>' for sandbox class
   'linux-vm'"*. Scope is contained, though: `get` / `exec` / `list` / lifecycle are
   **region-agnostic** (a default-target client reaches a `us-east-1` VM fine, and `list()` spans
   regions). Only two calls are region-sensitive — `snapshot.create` needs `regionId`, and
   `daytona.create` takes its region from the **client target** (`new Daytona({ target })`; the
   `regionId` create param is ignored). So: a per-target client cache, not per-box region plumbing.

2. **Volume mounts are silently ignored on `linux-vm`.** `create({ volumes: [...] })` is *accepted*,
   the mount is echoed back in the sandbox DTO — and the path simply does not exist in the guest
   (nothing in the mount table). Today every Daytona box mounts the org-scoped
   `agentbox-credentials` volume, so **VM boxes must push credentials with `uploadFile` at create
   instead** — the shape Hetzner already uses (it has no shared-volume primitive either).

3. **The VM rootfs conversion strips setuid bits — `sudo` is mode `755`, so it cannot escalate.**
   Only `mount`, `umount`, `su` keep theirs. This breaks the agent-static seed (installing
   `/etc/claude-code/CLAUDE.md` needs root), and breaks the passwordless-sudo the in-box agent is
   told it has. `create({ user: 'root' })` is **not** a way out — the sandbox fails to start.
   The fix is the docker socket, which we already have: a privileged container repairs it, and the
   repair **persists into the baked snapshot**:
   ```
   docker run --rm --privileged -v /:/host alpine \
     sh -c 'chown root:root /host/usr/bin/sudo && chmod 4755 /host/usr/bin/sudo'
   ```
   Verified: `sudo -n id -un` → `root` afterwards, and it survives stop → snapshot → restore.
   (Minor: `sudo` also warns `unable to resolve host sandbox` — add the hostname to `/etc/hosts` in
   the same bake step.)

**Also confirmed:** the declarative builder really is container-only. `snapshot.create({ image:
Image.fromDockerfile(...), sandboxClass: LINUX_VM })` fails with `build snapshot: rpc error: code =
Unauthenticated` — but *only once you're in a region that has VM runners*; elsewhere the region
error masks it. So a VM base **must** come from a prebuilt registry image, which is why the bake
targets the public multi-arch `ghcr.io/madarco/agentbox/box:sha-<fingerprint>` that
`.github/workflows/box-image.yml` already publishes (amd64 present; anonymous pull confirmed).

Consequence for §5.1.1 below: **no longer blocked** — cold snapshot-from-sandbox works on both
classes now.

---

## Already landed (for context — not in backlog)

`create --provider daytona` · `list` (with `PROVIDER` column distinguishing `docker` / `daytona` rows) · `status` · `inspect` · `url --print` · `pause`/`unpause`/`stop`/`start` · `destroy` (with sync stop+delete) · `shell` (incl. `-- <cmd>` one-shot) · `claude attach`/`start`, `codex attach`/`start`, `opencode attach`/`start` (via SSH + tmux) · `cp` both directions (file + dir, via `provider.uploadPath`/`downloadPath`) · `download` bulk workspace pull (via `provider.downloadDirContents`) · in-box `agentbox-ctl git push` (host bundle pull-back executor with `askPrompt` gate) · `relay restart` rehydrates cloud pollers from persisted state · `agentbox daytona login` interactive credential setup (auto-prompts on first `--provider daytona`, persists to `~/.agentbox/secrets.env`, never harvests creds from project `.env` files).

---

## 1. Sandbox seeding & agent config (Phase 6 core)

### 1.1 ✅ `envFilesToImport` uploaded to cloud sandboxes (done)
Cloud `create()` now packs the wizard-selected env/config files on the host (same `find` + `tar --null -T -` mechanic Docker uses) and ships the tarball into the sandbox via `backend.uploadFile` + `backend.exec(tar -xf -C /workspace --no-same-permissions --no-same-owner -m)`.

Implementation: `packages/sandbox-cloud/src/env-files.ts` (`uploadEnvFiles`), called from `packages/sandbox-cloud/src/cloud-provider.ts` `create()` between `seedCloudWorkspace` and `launchCloudCtlDaemon`. Reuses `buildHostEnvFindArgs` (exported from `@agentbox/sandbox-docker`) so the glob + prune set are identical across providers.

### 1.2 ✅ Claude / Codex / OpenCode credentials synced to cloud (done — reshaped 2026-05-24)
Cloud boxes now keep agent state on two distinct tracks because Daytona's S3-backed FUSE volumes are unusably slow for many-small-file workloads (`cp -r` of `~/.claude`'s 2.5k files into a volume took 10+ min empirically):

- **Static config** (plugins, skills, marketplaces, settings, `_claude.json`, codex `config.toml`/`prompts`, opencode `config/`) is **layered into a published Daytona snapshot** at `agentbox prepare --provider daytona` time via the documented `daytona.snapshot.create({ name, image })` API and a fluent `Image.fromDockerfile(...).addLocalFile(...).runCommands(...)` chain. The build runs entirely server-side on Daytona — no temporary sandbox is provisioned on our end. Every subsequent `create` boots from the snapshot with the static config already in place.
- **Renewable credentials** (`.credentials.json` for claude, `auth.json` for codex/opencode) live on a single per-org Daytona volume `agentbox-credentials`, mounted three times via `subpath` at `/home/vscode/.agentbox-creds/{claude,codex,opencode}/`. Tiny payload (~KBs each), seconds to extract. Symlinks baked into the box image route the agent-expected credential paths through to the mount.

Refresh is **explicit only** — `agentbox daytona resync [--agent claude|codex|opencode|all]` provisions a throwaway sandbox, force-re-uploads credentials, and destroys. Static-config changes (new plugin, settings edit) need a snapshot re-publish.

Implementation: host-side staging lives in `packages/sandbox-docker/src/host-stage.ts` (six functions — `stage{Claude,Codex,Opencode}{Static,Credentials}ForUpload`, re-exported through `@agentbox/sandbox-cloud`). The Daytona-specific image-build chain + snapshot registration is in `packages/sandbox-daytona/src/prepare.ts` (`prepareDaytona`), wired through `daytonaProvider.prepare` and exposed as `agentbox prepare --provider daytona`. Per-create credentials seed in `packages/sandbox-cloud/src/agent-credentials.ts` (`seedAgentVolumesIfFresh`, `ensureAgentVolumesForCloud`). Symlinks baked in `packages/sandbox-docker/Dockerfile.box`. `CloudBackend` has `ensureVolume(name)` + `CloudProvisionRequest.volumes` + `CloudVolumeMount.subpath` (Daytona S3-prefix mount).

**Migration**: the legacy per-agent volumes (`agentbox-claude-config`, `agentbox-codex-config`, `agentbox-opencode-config`) are abandoned. Delete manually via the Daytona dashboard. Re-run `agentbox prepare --provider daytona` after picking up this change to capture the baked static content.

**Claude OAuth `.credentials.json`**: the host's `~/.agentbox/claude-credentials.json` backup (managed by the existing `syncClaudeCredentials` for Docker) is bundled into the claude tarball at `.credentials.json`. Without this, the in-box claude reads `_claude.json` (account info), can't find the token, falls back to interactive `/login`, and inside a tmux-over-SSH session that manifests as an immediate exit with no error.

**macOS AppleDouble suppression**: the host tarball is built with `COPYFILE_DISABLE=1` set on the `tar` exec — without it macOS' `bsdtar` emits `._<name>` sidecar files for any source with extended attributes, which then clutter `~/.claude` inside the box and confuse claude's top-level directory scan.

**Codex macOS Keychain landmine**: detected and surfaced as a one-time warning during seed (skip codex for the box, claude + opencode still work). User fixes by setting `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` then `codex login` again, or by setting `OPENAI_API_KEY`.

**Daytona FUSE-mounted volume quirks** (relevant to any code that writes to a mounted volume, not just credential seeding):
- `chmod(2)` / `utime(2)` / `chown(2)` all return EPERM — even with sudo/root. Files come up owned by `nobody:nogroup` and you can't change that. We pass `--no-same-permissions --no-same-owner -m` to every `tar -xzf` that lands inside a volume mount (`agent-credentials.ts`, `cloud-cp.ts`, `env-files.ts`).
- `rename(2)` returns ENOSYS. Use `cp -f` + `rm -f` instead. (Applied in `cloud-cp.ts`.)
- `symlink(2)` returns EPERM. Stage with `rsync -L` (dereference all symlinks) so the tarball is symlink-free.

**Remaining follow-up**: box→host pull (the reverse direction of `agentbox download claude|codex|opencode` against a cloud volume) is deferred. Today the docker `download` paths still work for docker boxes only.

### 1.3 ✅ Workspace shallow-clone depth cap (done)
~~Always `--all`~~ — `seedFromGitClone` (renamed from `seedFromGitBundle`) now defaults to an adaptive shallow cap. The transport is `git clone --no-checkout --depth=200 file://<hostRepo>` on the host, tar the resulting `.git/`, upload, extract into `/workspace` in the box, then `git checkout -B <branch>` materializes the working tree. If the tar exceeds 20 MB the clone is redone at `--depth=100`. Override via the `box.bundleDepth` config key (CLI flag `--bundle-depth <n>` on `agentbox create`, or `agentbox config set box.bundleDepth N`): `N > 0` pins a fixed shallow depth with no adaptive rebuild; `0` ships full history (no `--depth`). The previous `AGENTBOX_BUNDLE_DEPTH` env var has been removed (AgentBox is unreleased; no alias). `git push` from inside the sandbox still resolves merge bases because the host relay's pull-back fetches the per-box branch and lets the real `git push` find common ancestors via the host repo's full history.

**Why clone-and-tar instead of `git bundle`?** Empirically verified: `git bundle create` has no `--depth` flag in any released git version (tested 2.39 and 2.52). The portable workarounds — range bundles (`HEAD ^HEAD~N`) and shallow-clone-then-bundle — both produce bundles with unsatisfiable prerequisites that fail at `git clone` time. A shallow `git clone --depth=N file://...` is the only portable way to ship the last N commits as a usable repo. The original `AGENTBOX_BUNDLE_DEPTH` code path that tried `git bundle create --depth=N HEAD` had been broken since it was written; nobody ever exercised it.

### 1.4 ✅ Nested-repo monorepos seeded (done)
~~Root-only~~ — `seedCloudWorkspace` now also loops over every `kind === 'nested'` entry from `detectGitRepos`. For each, it bundles + clones at `/workspace/<rel>` on the same per-box branch. The clone-then-rm script targets only `args.workspaceDir` so the nested clone wipes just its own subdir without disturbing the root checkout. Matches the docker `seedWorkspace` semantics (one branch per repo, all named `agentbox/<box-name>`).

### 1.5 ✅ Host uncommitted changes carry-over (done)
~~Skipped~~ — `seedFromGitBundle` now mirrors `collectRepoCarryOver`. For every seeded repo (root + nested):

1. `safeStashCreate` runs `git stash create` on the host — captures every staged + tracked-modified change (including deletes / renames) as a one-off commit without touching the working tree.
2. The stash SHA is updated into the temp ref `refs/agentbox-carryover/stash` so it rides along with the bundle (the ref is passed explicitly to `git bundle create` so it works with both `--all` and `--depth=N` modes).
3. `maybeBuildUntrackedTar` tars `git ls-files --others --exclude-standard` (NUL-delimited, `COPYFILE_DISABLE=1` to skip macOS AppleDouble sidecars). Uploaded separately to `/tmp/agentbox-carryover-untracked.tar.gz` (skipped when empty).
4. In-sandbox script (best-effort, soft-fails on conflict): `git stash apply refs/remotes/origin/agentbox-carryover/stash` to restore tracked changes, then untars the untracked archive over the working tree. Stash ref + tar file are deleted post-apply.

Soft-fail keeps `agentbox create --provider daytona` from blocking when a shallow bundle drops the merge base for an old local modification; an explicit `agentbox: stash apply soft-failed; carry-over may be incomplete` warning surfaces in the create log.

---

## 2. Host executor & comms layer (Phase 4 polish)

### 2.1 ✅ In-box `agentbox-ctl cp` cloud executor (done)
~~Stub~~ — `executeCloudAction` in `packages/relay/src/host-actions.ts` now handles `cp.toHost` and `cp.fromHost`. The executor `askPrompt`-gates the call (same UX as Docker's `/rpc` route), resolves the `CloudBackend` lazily via `resolveCloudBackend`, and dispatches to `uploadToCloudBox` / `downloadFromCloudBox` from `@agentbox/sandbox-cloud` (lazy-imported via the same computed-string trick as `sandbox-daytona` so the relay bundle stays slim). Refusal returns exit 10 with `denied by user`; success writes the resolved host or box path to stdout.

### 2.2 ✅ In-box `agentbox-ctl download workspace` cloud executor (done)
~~Stub~~ — `executeCloudAction` handles `download.workspace` via `pullCloudDirContents` (`/workspace → box.workspacePath`). `download.env` / `download.config` / `download.claude` still return a clear "not yet supported on cloud" because the source paths live in per-agent volumes that aren't routed yet — Phase 6 follow-up.

### 2.3 ✅ `checkpoint.create` cloud executor (done)
~~Stubbed~~ — `executeCloudAction` handles `checkpoint.create` by shelling out to `AGENTBOX_CLI_ENTRY` with `agentbox checkpoint create <boxId>` plus the original `--name`/`--merged`/`--set-default`/`--replace` flags. The CLI's `checkpoint create` is already provider-aware (`apps/cli/src/commands/checkpoint.ts` dispatches on `box.provider`), so the cloud branch calls `provider.checkpoint.create(box, name)` which captures the live sandbox via `backend.createSnapshot` and writes the project-scoped manifest at `~/.agentbox/cloud-checkpoints/...`. `--merged` is docker-only and the cloud branch ignores it; `--set-default` writes `box.defaultCheckpoint` in the project config; `--replace` rms the prior snapshot+manifest first.

### 2.3.1 ✅ Per-provider defaultCheckpoint (done)
~~Global only~~ — config schema gained two optional per-provider override keys: `box.defaultCheckpointDocker` and `box.defaultCheckpointDaytona`. Resolution order: per-provider override (when set) > `box.defaultCheckpoint` (cross-provider fallback) > empty/none. The helper `resolveDefaultCheckpoint(cfg, provider)` lives in `@agentbox/config/checkpoint.ts`; every place that previously read `cfg.effective.box.defaultCheckpoint` now goes through it (create, claude/codex/opencode, dashboard, checkpoint ls). `agentbox checkpoint set-default [--provider docker|daytona] <ref>` writes the right key via `defaultCheckpointConfigKey(provider)`; without `--provider` the global fallback key is still used. `checkpoint create --set-default` writes the provider-specific key (docker → defaultCheckpointDocker; daytona → defaultCheckpointDaytona) so the same project can hold separate docker and cloud defaults safely. `checkpoint rm` sweeps all three keys and clears whichever the project layer pointed at the deleted ref.

### 2.4 ✅ Bounded cloud `git.push` prompt with no-subscriber fallback (done)
~~Indefinite block~~ — `executeCloudAction`'s `git.push` path now checks `deps.subscribers.forBox(boxId).length`. With **zero subscribers** it consults `AGENTBOX_GIT_PUSH_NO_SUB`: `deny` (default) returns exit 10 with a clear "no wrapper attached" message, `allow` falls through and runs the push, `prompt` falls back to a 5-minute-TTL `askPrompt` (legacy blocking shape but bounded). With **one or more subscribers** the prompt blocks as before (the user can answer from any attached window). `AGENTBOX_PROMPT=off` still auto-approves universally (script / test path), preserving existing semantics.

### 2.5 ✅ `browser.open` host-mirror for cloud (done)
~~Cloud-silent~~ — the in-sandbox `browser.open` handler now queues a fire-and-forget `browser.open.mirror` action on the `HostActionQueue` when running in `mode === 'box'` and `AGENTBOX_PROMPT !== 'off'`. The host poller drains it; `executeCloudAction`'s new `runBrowserOpenMirror` runs the standard askPrompt against host SSE subscribers (90s TTL — bounded blocking) and on `y` spawns `open <url>` detached on the host. The in-box agent isn't blocked at any step (the original `/rpc` already returned 200), and the queued entry GCs via 6.4's `maxAgeMs` if no host ever drains it.

### 2.6 ✅ Cloud poller 504 fast-mode (done)
~~Unmitigated~~ — `CloudBoxPoller` now detects 504 responses (matched on `→ 504` / `504:` in the error message) and arms `fastModePolls = FAST_MODE_DECAY_POLLS` (5). While the counter is > 0 the next `pollOnce` uses `FAST_REQUEST_TIMEOUT_MS = 8s` (vs the default 25s), so the request clips short of the edge proxy's next 504 window. Successful polls decrement the counter; after ~5 healthy round-trips the poller drifts back to the long timeout. No persistent state required.

---

## 3. CLI routing (Phase 3 polish)

### 3.1 ✅ Default `agentbox claude` / `codex` / `opencode` actions accept `--provider` (done)
Each of the three default actions takes `--provider <name>` (and respects `box.provider` in the user config). On `daytona` they delegate to `cloudAgentCreate` (`apps/cli/src/commands/_cloud-agent-create.ts`), which runs `provider.create(...)` + `cloudAgentAttach(...)`. The Docker fast path is unchanged.

Implementation: per-agent option added to the `.option(...)` chain + provider-name branch right after the setup wizard runs in each of `apps/cli/src/commands/{claude,codex,opencode}.ts`. The wizard's `envFilesToImport` and (for claude) initial-prompt threading work for cloud too.

### 3.2 ✅ Extra agent args after `--` forwarded for cloud (done)
`cloudAgentAttach` (`apps/cli/src/commands/_cloud-attach.ts`) now builds the inner shell command via a base64-encoded launcher (`buildCloudAttachInnerCommand`) when `extraArgs` is non-empty: argv is joined newline-delimited, base64-encoded, and reconstructed inside the sandbox via `mapfile -t A < <(echo … | base64 -d); exec <binary> "${A[@]}"`. Base64 is opaque to every shell-quoting layer (SSH → tmux → bash), so args with spaces / quotes / shell metachars survive verbatim. Unit-tested in `apps/cli/test/cloud-attach.test.ts`. Limitation: args containing literal newlines aren't supported (none of claude/codex/opencode flags carry newlines in practice).

### 3.3 ✅ `agentbox shell --name/--new` for cloud (done)
~~Single fixed session~~ — `agentbox shell` cloud branch now calls `resolveCloudShellSessionName(box, provider, user, opts)`. With `--name` it maps through `shellSessionName(label)` (same map as docker — `shell` / `shell-<label>`). With `--new` it runs `tmux list-sessions -F '#{session_name}\\t#{session_created}\\t#{session_attached}'` via `provider.exec` over SSH, parses with the pure-string `parseShellSessionList`, then picks the lowest-free with `allocateShellSessionName`. Empty list, tmux-not-running, or any exec failure degrades to the default `shell` (matches docker's best-effort listing).

### 3.4 ✅ `agentbox cp` / `download` cloud-routed (done)
~~Cloud-guarded~~ — routed through `provider.uploadPath` / `downloadPath` / `downloadDirContents`. See "Already landed".

### 3.5 ✅ `agentbox logs` cloud-routed (done)
~~Cloud-guarded~~ — `logs.ts` resolves the provider via `providerForBox(box)`. Non-follow rounds through `provider.exec(box, ['agentbox-ctl', 'logs', service, '--tail', N])` on both providers (same `agentbox-ctl logs` ring-buffer snapshot, so timestamp + stream-marker output matches docker). Follow mode keeps the existing `docker exec` spawn for docker, and for cloud spawns the SSH argv returned by `provider.buildAttach(box, 'logs', { service, tail, follow: true })` — `buildAttach`'s `logs` kind skips the tmux wrap and runs `agentbox-ctl logs <service> --tail N --follow` directly over SSH, so Ctrl-C tears the stream down cleanly. The cloud `defaultCommand('logs', ...)` switched from raw `tail -F` to `agentbox-ctl logs` for output parity with docker.

### 3.6 ✅ `agentbox screen` (noVNC) cloud-routed (done)
~~Cloud-guarded~~ — `screen.ts` now branches on provider and calls `provider.resolveUrl(box, { kind: 'vnc', ttl })` for cloud boxes, which mints a signed preview URL on port 6080. The cloud provider launches the in-sandbox VNC stack (Xvnc + websockify + noVNC) at create time and re-launches it on `start` via `launchCloudVncDaemon` (mirrors Docker's `launchVncDaemon`); the per-box `vncPassword` is generated host-side and persisted on the cloud `BoxRecord`. `agentbox screen <cloud-box>` appends `/vnc.html?autoconnect=1&password=…` to the signed URL so the browser auto-connects without prompting. `--no-vnc` at create skips the daemon launch and the screen command refuses with the same "VNC is disabled" message Docker uses.

### 3.7 ✅ `agentbox wait` cloud-routed (done)
~~Cloud-guarded~~ — `wait.ts` now resolves the provider via `providerForBox(box)` and dispatches `provider.exec(box, ['agentbox-ctl', 'wait-ready', '--json', ...])`. The exit-code / JSON contract is identical across providers because both Docker `execInBox` and the cloud `backend.exec` proxy the same in-box `agentbox-ctl wait-ready` invocation. The Docker fast path is unchanged in behavior — only the call site changed.

### 3.8 ✅ `agentbox code` (VS Code / Cursor Remote-SSH) cloud-routed (done)
~~Cloud-guarded~~ — `code.ts` now branches on provider. For cloud boxes it mints a fresh 60-min SSH token via `provider.buildAttach(box, 'shell', { noTmux: true })` (which calls `backend.attachArgv` → `sb.createSshAccess(60)`), writes a BEGIN/END-bracketed managed block to `~/.ssh/config` (`apps/cli/src/ssh-config.ts`) mapping a stable alias (`agentbox-cloud-<name>`) to `ssh.app.daytona.io` with the token as `User`, then opens `vscode-remote://ssh-remote+<alias>/workspace` via the existing `code --folder-uri` / `cursor --folder-uri` launcher. `agentbox destroy` removes the alias block. Token expires after 60 min → re-run `agentbox code` to rewrite it. Auto-terminals (`/workspace/.vscode/tasks.json`) is docker-only for now.

### 3.9 ✅ `agentbox open` cloud-routed via sshfs (done)
~~Guarded~~ — `open.ts` branches on provider. For cloud boxes it reuses the SSH alias machinery from `agentbox code` (`writeAgentboxSshAlias`) to mint a fresh 60-min token and rewrite the `~/.ssh/config` block, then `sshfs <alias>:/workspace ~/.agentbox/mounts/<box-name>/ -o reconnect -o volname=agentbox-<box> -o noappledouble` and `open` the mount in Finder. Existing stale mounts at the path are auto-unmounted first. `--path/--print` reports the mount path without mounting. `--unmount` tears down an existing mount. sshfs missing → clear `brew install macfuse sshfs` hint. The docker path is unchanged.

### 3.10 ✅ `agentbox top` surfaces cloud rows (no live stats) (done)
~~Cloud entries filtered out~~ — `selectBoxes` returns docker + cloud boxes; cloud rows get a placeholder `BoxResourceStats` (`live: false`, every metric `null`) from a local `emptyStats(source)` helper, with `warnings: ['cloud box: live metrics not yet exposed by the backend SDK']`. State still comes from `listBoxes` (which probes the provider). Daytona's SDK doesn't expose CPU/mem live stats yet — when it does, hook a `provider.stats?(box)` impl and drop the placeholder branch.

### 3.11 ✅ `agentbox dashboard` surfaces cloud rows (placeholder pane) (done)
~~Refused via requireDockerProvider~~ — dashboard now accepts cloud boxes as the focused row. The right pane renders a static placeholder pointing the user at the corresponding `agentbox attach <box>` (or the per-agent `agentbox claude/codex/opencode attach <box>` variant), `agentbox shell`, and `agentbox url` commands (run from a separate terminal). The live tmux-capture panes remain docker-only by design. Sidebar listing was already provider-agnostic; the change is the explicit cloud branch in `resolveTarget`.

### 3.12 ✅ `agentbox checkpoint` cloud-routed (done) — `prune` / `update` still Docker-only
~~Checkpoint deferred for cloud~~ — `agentbox checkpoint create / ls / rm / set-default` all dispatch on `box.provider` (`apps/cli/src/commands/checkpoint.ts`). For cloud boxes the create flow calls `provider.checkpoint.create()`, which captures the live sandbox via the new `CloudBackend.createSnapshot` primitive (Daytona: `sb._experimental_createSnapshot(name)`) and persists a thin manifest at `~/.agentbox/cloud-checkpoints/<backend>/<projectHash-mnemonic>/<name>/manifest.json`. Cloud snapshots are org-scoped and project-prefixed (`agentbox-ckpt-<hash>_<mnemonic>-<name>`) to avoid name collisions. `agentbox create --checkpoint <name>` (and `box.defaultCheckpoint`) now resolves to a Daytona snapshot and provisions from `client.create({ snapshot })` — workspace seeding is skipped because the snapshot already carries `/workspace`. The wizard's "starting from checkpoint" announcement is provider-aware (`apps/cli/src/checkpoint-lookup.ts`): if the named checkpoint doesn't exist for the active provider, the wizard silently falls through to normal setup instead of misleadingly skipping it.

`prune` / `update` remain Docker-only by design — they're docker-image lifecycle ops. Daytona snapshot cleanup goes through `agentbox checkpoint rm <name>`.

---

## 4. URL / browser UX

### 4.1 ✅ `agentbox url <cloud-box>` now uses signed preview URLs (done)
~~Browser-rejected bare URL~~ — `CloudBackend.signedPreviewUrl` (Daytona: `sb.getSignedPreviewUrl(port, expiresInSeconds)`) mints a URL with the token embedded in the host (`https://{port}-{token}.proxy.daytona.work`). The cloud provider's `resolveUrl` calls it with a 3600s default expiry, overridable via `agentbox url --ttl <seconds>` (max 86400). Standard header-token URLs (`getPreviewLink`) stay in use for bridge/poller traffic where headers are controlled.

### 4.2 ✅ Cloud `previewUrls` includes per-service expose ports (done)
~~Only port 8080~~ — At create + start the cloud provider now parses `agentbox.yaml` via `readExposedServicePorts(workspacePath)` (minimal YAML extractor, ignores everything but `services.*.expose.port`) and calls `backend.previewUrl(port)` for each. The resulting URLs land in `box.cloud.previewUrls[port]` alongside the WebProxy URL. `inspect()` surfaces each as a `kind: 'web'` endpoint named `service-<port>`. Best-effort: a `previewUrl` call that fails for one port doesn't drop the others (and the cached value is kept across a stop/start if the resolver throws).

---

## 5. Image / provisioning

### 5.1 ✅ `agentbox prepare --provider daytona` cuts cold creates to seconds (done — reshaped 2026-05-24)
~~~7-min Dockerfile every time~~ — added a one-time publish step. `agentbox prepare --provider daytona [--name X] [-y]` builds a layered `Image` (`Image.fromDockerfile(Dockerfile.box).addLocalFile(...).runCommands(...)` for the three host agent static tarballs) and calls `daytona.snapshot.create({ name, image })`. Daytona handles the build + register in one server-side operation; no temporary sandbox is provisioned on our end. After success, the command pins `box.image: <name>` into the project config so subsequent `agentbox create --provider daytona` boots from it.

**API note**: Replaces the old `agentbox daytona publish-snapshot`, which used `sandbox._experimental_createSnapshot(name)` — Daytona deprecated that endpoint (`POST /api/sandbox/<id>/snapshot` now 404s). The new path uses the documented snapshot API (https://www.daytona.io/docs/en/snapshots/) and never touches the broken experimental method.

### 5.1.1 ✅ Sandbox workspace-state checkpoint (done — 2026-07-12)
The user-facing need: snapshot a running box after `npm install` / build cache warm-up, so future `create`s skip the same setup.

~~Deferred — no stable API~~. The endpoint this was blocked on is **live again** (Daytona changelog V0.165.0, "Sandbox Fork & Snapshot Endpoints"); it 404'd when this item was written. `sandbox._experimental_createSnapshot` now works on **both** sandbox classes, capturing the filesystem in ~2 s. No tarball workaround needed.

Two properties made it more than a re-enable, so `daytonaProvider` overrides the generic cloud checkpoint (`makeDaytonaCheckpoint`, `packages/sandbox-daytona/src/checkpoint.ts`):

- **A cold capture requires the sandbox STOPPED, and the API won't stop it for you.** So the backend stops → captures → starts. That kills the in-box `ctl`, dockerd, VNC and the agent's tmux session, so the checkpoint must `reconnect(box)` afterwards or the user is left with a running sandbox whose services are all dead. `agentbox checkpoint` now warns daytona users the box will reboot, as it already did for vercel.
- **A snapshot name must never be reused** (see the PoC findings at the top). The Daytona-side name carries a nonce; the user-facing checkpoint name is unchanged, and the manifest maps one to the other.

The hot (filesystem **+ memory**, linux-vm only) variant would skip the stop entirely, but it needs `includeMemory`, which the published TS SDK silently drops — out of reach until upstream fixes the wrapper. Tracked below.

### 5.1.2 ⏭️ Hot (memory-inclusive) checkpoints — blocked on the SDK
`linux-vm` supports a filesystem **+ memory** snapshot of a *running* sandbox — no stop, no reboot, and the restored box comes back with its process state intact. That is strictly better than the cold path for our use case (it's the true analogue of `docker commit`'s no-pause default). The REST layer supports it (`CreateSandboxSnapshot { name, includeMemory }`), but `@daytona/sdk@0.196.0`'s wrapper takes only `(name, timeout)` and **drops the third argument on the floor**, so it cannot be reached from the SDK. Options when we want it: call `@daytona/api-client`'s `SandboxApi.createSandboxSnapshot` directly, or wait for an upstream fix (worth filing).

### 5.2 ✅ Cloud boxes auto-start in-box dockerd (done)
~~Manual `dockerd &` / explicit `agentbox dockerd <box>`~~ — `cloudProvider.create()` and `cloudProvider.start()` now call `launchCloudDockerdDaemon({ backend, handle, timeoutMs: 60_000 })` automatically (best-effort, after `launchCloudCtlDaemon`, before VNC). Mirrors the docker provider's always-on pattern (`packages/sandbox-docker/src/create.ts:788` + `lifecycle.ts:276`).

The helper still lives at `packages/sandbox-cloud/src/dockerd-launch.ts` — it runs `nohup sudo -n /usr/local/bin/agentbox-dockerd-start >> /var/log/agentbox/dockerd.log 2>&1 &` over `backend.exec` (the agentbox image bakes the start script) and polls `/var/run/docker.sock` until `docker info` succeeds. Idempotent across stop/start. Daytona sandboxes have CAP_SYS_ADMIN per the earlier PoC, so the in-sandbox dockerd starts cleanly.

The standalone `agentbox dockerd <box>` CLI command was removed — there's nothing left for the user to invoke. Logs land at `/var/log/agentbox/dockerd.log` inside the sandbox; `agentbox shell <box> -- tail -F /var/log/agentbox/dockerd.log` is still the way to peek.

### 5.3 ✅ `agentbox logs --daemon` surfaces ctl-daemon log (done)
~~No CLI path~~ — `logs.ts` accepts `--daemon`, which tails `/var/log/agentbox/ctl-daemon.log` directly via `tail -n N [-F]`. Works on both docker (over `provider.exec`) and cloud (non-follow → `provider.exec`; follow → `provider.buildAttach(kind: 'shell', noTmux: true)` running the tail argv over SSH). The service positional argument is optional when `--daemon` is set; usage hint updated.

---

## 6. Operational / robustness

### 6.1 ✅ Daytona 504s from CloudFront — bounded retry wrapper (done)
~~Unbounded wedge on edge 504s~~ — `packages/sandbox-daytona/src/retry.ts` (`withDaytonaRetry`) wraps every `daytonaBackend` method. Three attempts with 1s/2s/4s backoff, per-attempt timeout via `Promise.race`. Classifies errors using the SDK's typed classes: `DaytonaRateLimitError` always retries; `DaytonaConnectionError` / `DaytonaTimeoutError` / `DaytonaError(statusCode >= 500)` retry only when the caller passes `retryOnAmbiguous: true`; `DaytonaNotFoundError` / `DaytonaAuthenticationError` / `DaytonaAuthorizationError` / `DaytonaValidationError` / `DaytonaConflictError` never retry. Original typed errors pass through untouched on exhaustion so caller `instanceof` checks still work. Retry chatter goes to `process.stderr` with a `[daytona-retry]` prefix.

Per-method policy in `backend.ts`:
- `provision` — `retryOnAmbiguous: false`, 900s timeout. Non-idempotent — a retry post-origin could create a duplicate billable sandbox. Wrapper just bounds wall-clock vs. infinite hang.
- `uploadFile` / `downloadFile` — 300s timeout, retry on ambiguous (file ops are atomic per call; re-sending is wasteful but safe).
- `exec` / `destroy` — 120s timeout.
- `start` / `stop` / `pause` / `resume` — 60s timeout.
- Everything else (`get`, `state`, `previewUrl`, `signedPreviewUrl`, `attachArgv`, `revokeAttachToken`, `listFiles`, `ensureVolume`'s individual `volume.get` calls) — 30s timeout, retry on ambiguous.

### 6.2 ✅ Destroy lag documented as a Daytona consistency window (done)
Captured in `docs/cloud-providers.md` §4. The resource is actually deleted (`sb.delete()` returns immediately, local `state.json` clears synchronously); only the Daytona web UI polls slowly. Refresh shows the up-to-date list. Nothing for us to fix.

### 6.3 ✅ `agentbox prune --provider daytona` cleans up orphans (done)
~~Manual via Daytona API~~ — added `CloudBackend.list?()` returning `CloudSandboxSummary[]` (id, name, state, createdAt). Daytona's implementation calls `client.list()` and unwraps the SDK's `PaginatedSandboxes.items`. The CLI's `prune --provider daytona` flow loads local state, finds sandboxes whose `agentbox.name` label is set (i.e. created by this CLI) but whose id isn't in `state.json`, and offers to delete them. `--dry-run` lists without deleting; `-y` skips the confirm. Outputs `deleted N, failed M` so the user sees what happened.

### 6.4 ✅ Max age on parked host actions (done)
~~Unbounded~~ — `HostActionQueue` gained a `maxAgeMs` (default 15 min, override per instance). On every `drain()` any action older than that is settled with `exitCode: 124` / `stderr: "host action '<method>' expired before the host could execute it"` so the in-box RPC unblocks, and the action never reaches the host poller. Keeps a host relay restart from replaying a long-forgotten `git.push`. Unit tests cover both single-action expiry and the mixed expired+fresh drain case.

---

## 7. Architecture / cleanup

### 7.1 ✅ `BoxRecord.docker?:` nesting shape landed (sweep optional)
The discriminator shape is fully in place:

- `DockerBoxFields` interface (`packages/core/src/box-record.ts`) parallels `CloudBoxFields`.
- `BoxRecord.docker?: DockerBoxFields` added; populated on every write for docker records and backfilled from flat fields on read for legacy state.json files. Cloud records skip the mirror (the discriminator is `provider !== 'docker'`).
- `dockerField(box, key)` helper in `@agentbox/core` reads nested-with-fallback so new call sites can target the nested shape without a flag day.
- 7.2 lands cleanly on top: cloud records use `container: cloud:<sandboxId>`; the `agentbox-cloud-*` fake docker name is gone everywhere.

**Optional follow-up**: the flat docker-only fields (`box.container` / `box.image` / `box.claudeConfigVolume` / …) are still the primary source for the ~120 docker-internal read sites inside sandbox-docker. Moving them to `box.docker.<field>` is a search-and-replace, but the duplication is harmless (writers + readState keep both shapes in sync), and the discriminator already gives the type system everything it needs. Defer to a focused refactor session if the duplication becomes a maintenance burden; it doesn't block any user-visible work.

### 7.2 ✅ Cloud `container` is now `cloud:<sandboxId>`, no `agentbox-cloud-*` (done)
~~Synthetic fake docker name~~ — cloud records now set `container: cloud:${handle.sandboxId}`. A `grep -r 'agentbox-cloud-'` over the codebase finds only the SSH alias (`agentbox-cloud-<boxname>` in `~/.ssh/config`, user-facing) and the comment that explains the cleanup; nothing in `docker ps` output, no state-file grep ever matches. The value is unique within state (the sandbox id is the backend's canonical handle) and serves `findBox`'s by-container lookup. `BoxRecord.container: string` stays required, avoiding the 100+ call-site sweep the truly-optional shape would have required.

### 7.3 ✅ relay→sandbox-* runtime contract documented + guarded (done)
~~Fragile~~ — the dynamic-import contract is now spelled out in three load-bearing places:

1. `packages/relay/src/host-actions.ts`: a long-form comment on `resolveCloudBackend` describes the cycle that motivates the dynamic import, names the owner (`@madarco/agentbox` CLI) responsible for keeping `@agentbox/sandbox-daytona` and `@agentbox/sandbox-cloud` resolvable next to the relay bin, and explains what happens for standalone embedders. The same note is referenced from `loadCloudCp`.
2. `packages/relay/tsup.config.ts`: the `externalAtRuntime` list now includes `@agentbox/sandbox-cloud` (matching the runtime reality — it was de-facto external already), with a comment cataloguing the three motivations (cycle, lazy load, bin size).
3. Both `resolveCloudBackend` and `loadCloudCp` catch `MODULE_NOT_FOUND` and rethrow with a clear "install it alongside @agentbox/relay" message instead of the raw Node error. Standalone embedders get an actionable failure mode.

### 7.4 ✅ Backend pluggability: mock backend + contract tests (done)
~~Future work~~ — `@agentbox/sandbox-cloud` now exports `makeMockCloudBackend(opts)`, a fully in-memory `CloudBackend` implementation that records every call and lets tests inject failures via `beforeCall`. The contract suite at `packages/sandbox-cloud/test/mock-backend-contract.test.ts` exercises every required + optional method (lifecycle, `list`, signed previews, snapshots, volumes, `createCloudProvider` composition, failure injection). New backends — `@agentbox/sandbox-vercel`, etc. — can adapt this suite to certify compliance. The "Adding a new cloud backend" section of `docs/cloud-providers.md` walks through the workflow.

---

## 8. Docs

### 8.1 ✅ Docs cover the cloud path (done)
~~Docker-only world~~ — added [`docs/cloud-providers.md`](./cloud-providers.md): the design + the running surface inventory (provider abstraction, Daytona shape, workspace seed, comms layer, preview URLs, snapshots, attach flow, robustness wrapper, knobs that exist today). Cross-references plumbed in at each existing doc's intro: `architecture.md`, `host-relay.md`, `state.md`, `features.md` each link out to `cloud-providers.md`. README's "How it works" picks up the local-or-cloud bullet.

### 8.2 ✅ CLAUDE.md mentions the cloud path (done)
~~Docker box model only~~ — CLAUDE.md's intro now spells out "two backends share one provider abstraction", the architecture-overview bullets call out the docker/daytona shape per box / supervisor / relay / checkpoint, the "Important notes" section names `~/.agentbox/secrets.env` + the `prune --provider daytona` orphan path, and the doc map adds `cloud-providers.md` and `daytona-backlog.md` entries.

---

## 9. Testing

### 9.1 ✅ Cloud E2E test gated on DAYTONA_API_KEY (done)
~~Manual only~~ — `apps/cli/test/cloud-e2e.test.ts` runs a full `create → shell --echo → status → destroy` round-trip against a real Daytona sandbox. Uses `describe.skipIf(!hasCreds)` so the suite stays silent when `DAYTONA_API_KEY` isn't set (CI without secrets sees nothing). Test bootstraps a tmp git workspace so `seedCloudWorkspace` has a bundle to ship; `afterAll` always destroys (with `agentbox prune --provider daytona` as the orphan fallback). Per-step timeouts are generous (15 min total budget) to absorb the ~7-minute cold Dockerfile.box build on first run.

### 9.2 ✅ Unit tests for sandbox-cloud composition + expose-ports (done)
~~Only `shell.test.ts`~~ — added:

- `expose-ports.test.ts` — covers `readExposedServicePorts` happy + edge paths (missing file, no services key, single port, dedup+sort, ignoring services without expose, type/range filtering).
- `cloud-provider.test.ts` — `createCloudProvider` composition smoke tests with an in-test mock `CloudBackend`: `name` propagation, `buildAttach` "no attachArgv" error, `inspect` surfacing per-service `service-<port>` endpoints, `resolveUrl` preferring `signedPreviewUrl` when available + clear error when not.

`workspace-seed.ts` script construction + `ctl-launch.ts` are still covered only via end-to-end runs — they're tightly coupled to `execa` shell-outs and would require heavier mocking. Acceptable for now; coverage can grow as those surfaces stabilize.

### 9.3 ✅ Routing-level unit tests for `host-actions.ts` (done)
~~No coverage~~ — `packages/relay/test/host-actions.test.ts` covers the routing surface: unknown methods, `cp.*` parameter validation, `download.env|config|claude` "not supported" branch, `checkpoint.create` without `AGENTBOX_CLI_ENTRY`, `browser.open.mirror` URL safety + no-subscribers fallback. The cloud SDK + sandbox-cloud helpers are dynamic-imported by computed string (intentionally — see 7.3), which makes them hard to vitest-mock; that's why the test stops at the routing layer rather than the full executor path. A future expansion could intercept the dynamic import via a vitest setup file if needed.

### 9.4 ✅ Drive-harness integration test (done)
~~Only manually verifiable~~ — `apps/cli/test/_harness/harness-integration.test.ts` spawns `pnpm drive` against a small stdin-echoing Node program, sends a keystroke (`hello<Enter>`), uses `drive wait --text` to block until the echo lands, then captures the screen with `drive screen` and asserts the expected text. Validates the harness end-to-end and gives future tests (`dashboard`, `claude attach`, …) a working template — copy the pattern, swap the inner command. Skipped via `describe.skipIf(!hasPty)` when `@homebridge/node-pty-prebuilt-multiarch` isn't installed (CI without the prebuilt).

---

## Quick-win order (suggested)

1. **6.1 Retry-on-504** — smallest, fixes a real flakiness everyone sees (observed multiple times during e2e).
2. **3.6 `agentbox screen` for cloud** — VNC daemon already runs in the sandbox; just resolve `backend.previewUrl(6080)` and open. Same pattern as `url`. ~30 min.
3. **3.5 `agentbox logs` for cloud** — `backend.exec("tail -F …")` over the SSH attach machinery; mirrors shell one-shot. ~30 min.
4. **3.7 `agentbox wait` for cloud** — `provider.exec(box, ['agentbox-ctl', 'wait-ready', '--json'])`. Trivial.
5. **1.1 envFilesToImport upload for cloud** — wizard collects them but `create()` drops them; easy win.
6. **4.1 URL token UX** — `agentbox url` for cloud currently 401s in browser; needs at least clear documentation + ideally a query-param or `public:true` opt-in.
7. **3.1 `--provider` on `agentbox claude/codex/opencode` default actions** — the most-confusing UX gap (`agentbox claude my-cloud-box` silently creates a docker box). Attach/start subcommands already work; this just needs the default action to honor `--provider`.
8. **1.2 Agent-config sync** — biggest UX leap (no more in-box `claude login`).
9. **2.1 / 2.2 In-box `agentbox-ctl cp` / `download` cloud executors** — unblocks the in-sandbox workflows (host-side equivalents already work).
