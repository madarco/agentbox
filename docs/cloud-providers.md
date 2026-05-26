# Cloud providers

> _Status: v1 ships with Daytona + Hetzner. The provider abstraction is generic — adding another cloud is ~150 lines (see §6)._

AgentBox runs on three backends today, behind a single `Provider` interface
(`packages/core/src/provider.ts`):

| Provider | Where the box lives | When to use it |
| --- | --- | --- |
| `docker` (default) | Local Docker container | Fast, free, owns the host. Good default. |
| `daytona` | Daytona Cloud sandbox | When the workload outgrows the laptop, when teammates need to attach, when you want a snapshot-ready remote env. |
| `hetzner` | Hetzner Cloud VPS (1:1 per box) | When you want bare-VPS control (root, full kernel, your own region), pure OpenSSH (no third-party agent in the box), and a Cloud Firewall locked to your egress IP. ~€4/mo per running box. |

Switch backends per box: `agentbox create --provider daytona` (or `--provider hetzner`),
or pin project-wide via `box.provider: <name>` in `agentbox.yaml`. The rest of
the CLI surface (`shell`, `claude`, `url`, `cp`, `checkpoint`, …) routes
on `box.provider` and Just Works for all three.

## 1. The provider abstraction

The orchestration code uses `Provider` (`packages/core/src/provider.ts`):

```ts
interface Provider {
  readonly name: ProviderName;          // 'docker' | 'daytona' | future
  create(req: CreateBoxRequest): Promise<CreatedBox>;
  start/pause/resume/stop/destroy(box): Promise<…>;
  inspect/probeState(box): Promise<…>;
  exec(box, argv, opts): Promise<ExecResult>;
  resolveUrl(box, opts): Promise<string>;
  buildAttach?(box, kind, opts): Promise<AttachSpec>;
  uploadPath?(box, src, dst): Promise<…>;
  downloadPath?(box, src, dst): Promise<…>;
  downloadDirContents?(box, src, dst): Promise<…>;
  checkpoint?: ProviderCheckpoint;
  stats?(box): Promise<BoxResourceStats>;
}
```

For cloud backends the `Provider` is composed from a thin `CloudBackend`
SDK shim (`packages/core/src/cloud-backend.ts`) by
`createCloudProvider(backend)` (`packages/sandbox-cloud/src/cloud-provider.ts`).
The cloud provider owns workspace seeding, ctl-daemon launch, agent
credential sync, in-box dockerd launch, VNC daemon launch, signed preview URLs,
snapshot manifests, and (eventually) per-service preview URLs. The `CloudBackend`
just implements the SDK primitives (`provision`, `exec`, `uploadFile`,
`previewUrl`, `attachArgv`, optionally `createSnapshot` / `list` / …).

This split is why "add a new cloud" is small: only the SDK shim differs.

## 2. The Daytona shape

### 2.1 Workspace seeding

`seedCloudWorkspace` (`packages/sandbox-cloud/src/workspace-seed.ts`) ships
the host workspace into the sandbox:

1. `git bundle create` on the host for the root repo and every nested
   git repo (1.4). Optional `AGENTBOX_BUNDLE_DEPTH=N` for shallow seeding
   on monorepos with deep history (1.3).
2. `git stash create` + `git ls-files --others` on the host capture the
   user's uncommitted changes; the stash SHA rides in the bundle via a
   temp `refs/agentbox-carryover/stash` ref, untracked files in a side-
   channel tar (1.5).
3. `backend.uploadFile` ships the bundle (+ optional untracked tar).
4. In-sandbox: `rm -rf /workspace && git clone <bundle> /workspace`,
   repoint `origin` to the real upstream, checkout per-box branch
   `agentbox/<box-name>`, `git stash apply` carry-over, untar untracked.

### 2.2 Agent state split: snapshot bake + credentials volume

Agent state lives in two distinct places:

**Static config** (plugins, skills, marketplaces, settings, `_claude.json`,
codex `config.toml` + `prompts/`, opencode `config/`) is **layered into a
published Daytona snapshot** at `agentbox prepare --provider daytona` time
via the documented snapshot API — see `prepareDaytona` in
`packages/sandbox-daytona/src/prepare.ts`. It builds an `Image` fluently
(`Image.fromDockerfile(Dockerfile.box).addLocalFile(...).runCommands(...)`)
and calls `daytona.snapshot.create({ name, image })`. Daytona handles the
build + register in one server-side operation; the resulting snapshot
already contains `/home/vscode/.claude/`, `/home/vscode/.codex/`, and
`/home/vscode/.local/share/opencode/` populated from the host's filtered
config. Subsequent boxes boot from this snapshot — no per-create extract.

**Renewable credentials** (`.credentials.json` for claude, `auth.json` for
codex/opencode) live on a single per-org Daytona volume,
`agentbox-credentials`, mounted three times via `subpath` at
`/home/vscode/.agentbox-creds/{claude,codex,opencode}/`. The Dockerfile bakes
three symlinks (`~/.claude/.credentials.json` → the cred volume path, etc.)
so the agents find their tokens through the mount. `agentbox daytona resync
[--agent ...]` re-uploads after a host re-auth; the snapshot stays untouched.

Why split: Daytona's volumes are S3-backed FUSE mounts. Many-small-file
writes serialize on per-file S3 round-trips, so extracting a 22 MB
`~/.claude` (~2.5k files) into the volume took 10+ minutes empirically. The
snapshot is regular ext4 — bulk writes complete in seconds. The credentials
payload is tiny (handful of KB) so the FUSE penalty is irrelevant there.

Key wrinkles around Daytona's FUSE-mounted volumes (still relevant for the
credentials extract path):

- `chmod` / `chown` / `utime` all EPERM. The credentials extract uses
  `tar -xzf` into a local-fs staging dir followed by `cp -r` into the mount
  (plain `cp`, no `-p`, doesn't call chmod/utime).
- `rename(2)` returns ENOSYS. We use `cp -f` + `rm -f` instead.
- `symlink(2)` returns EPERM. Host-side staging uses `rsync -L` to
  dereference symlinks before tar.
- macOS `bsdtar` emits `._<name>` AppleDouble sidecars unless
  `COPYFILE_DISABLE=1` is set on the tar exec. We set it everywhere.

**Migration note**: the legacy per-agent volumes (`agentbox-claude-config`,
`agentbox-codex-config`, `agentbox-opencode-config`) are abandoned. Delete
them via the Daytona dashboard if you want to reclaim the space. Anyone who
published a snapshot before the static-bake change must re-run
`agentbox prepare --provider daytona` to capture the baked content. Run
`agentbox prepare` (no args) to print the current inventory of base images,
snapshots, and shared volumes across both providers — including the legacy
per-agent volumes (`agentbox-{claude,codex,opencode}-config`) the daytona
path no longer uses, as a visible reminder to clean them up.

### 2.3 Comms: the bridge relay

Cloud boxes ship the same `@agentbox/relay` binary as docker, but in
**box mode**. Inside the sandbox the relay binds `0.0.0.0:8788`
(`DEFAULT_BOX_RELAY_PORT`; override `AGENTBOX_BOX_RELAY_PORT`); the host
relay stays on `:8787` outside the box. Daytona mints a signed preview URL
pointing at the in-box port, which the host's
`CloudBoxPoller` (`packages/relay/src/cloud-poller.ts`) long-polls. The
poller drains events + parked host actions through `/bridge/poll`, runs
`executeCloudAction` for each (`packages/relay/src/host-actions.ts`),
and POSTs results back to `/bridge/action-result`. Per-box bearer tokens
(`relayToken` for the in-box agent, `bridgeToken` for the host poller)
keep the two channels isolated.

Host actions implemented today (every other method gets a clear "not
supported" error so the in-box RPC unblocks):

- `git.push` / `git.fetch` — by default, bundle pull-back through the
  host's main repo (lets the host's SSH keys do the real push without
  ever sending them into the sandbox). On Hetzner, a faster path runs:
  the host opens a fresh `ssh -A` connection into the box and runs
  `git push` / `git fetch` *inside* the box against `origin` directly.
  For SSH origins (`git@…`/`ssh://…`), the in-box git uses the host's
  forwarded SSH agent. For HTTPS origins, the host additionally spins
  up a short-lived loopback credential proxy and `-R`-forwards it into
  the box for the duration of the SSH session, so the in-box git
  credential helper can authenticate without the token entering the
  box's filesystem or env. The forwarded agent socket and reverse-
  forwarded port disappear with the SSH session — no persistent
  credential exposure. Falls back to the bundle path on any failure
  (no host agent, permission denied, helper unconfigured, etc.).
  The `askPrompt()` confirmation gate runs before either path.
- `cp.toHost` / `cp.fromHost` — via `uploadToCloudBox` /
  `downloadFromCloudBox` from sandbox-cloud, gated by `askPrompt`.
- `download.workspace` — bulk pull via `pullCloudDirContents`.
- `checkpoint.create` — shells to the host CLI's `agentbox checkpoint
  create`, which routes back through `provider.checkpoint.create`.
- `browser.open.mirror` — fire-and-forget; host opens the URL in the
  user's browser after an SSE prompt (90s TTL).

### 2.4 Preview URLs

Three flavors, one per use case:

- **Signed** (`backend.signedPreviewUrl`): `https://{port}-{token}.proxy.daytona.work`.
  Used by `agentbox url` / `agentbox screen` — the token is in the URL
  itself so browsers can attach via a click. Default 1h TTL, override
  with `--ttl <seconds>` up to 24h.
- **Header-token** (`backend.previewUrl`): standard preview URL + an
  `x-daytona-preview-token` header the caller attaches. Used by the
  bridge poller and the cp/upload helpers — programmatic clients that
  can set headers.
- **Per-service** (4.2): `cloud.previewUrls[port]` for every
  `services.*.expose.port` value in `agentbox.yaml`. Lets users hit
  services directly, in addition to the WebProxy URL on port 8080.

### 2.5 Snapshots

Cloud checkpoints map to Daytona snapshots
(`sb._experimental_createSnapshot`). Manifests live under
`~/.agentbox/cloud-checkpoints/<backend>/<projectHash-mnemonic>/<name>/`.
Snapshots are org-scoped + project-prefixed
(`agentbox-ckpt-<hash>_<mnemonic>-<name>`) so two projects can't collide.
`agentbox create --checkpoint <name>` provisions via
`client.create({ snapshot })` and skips workspace seeding (the snapshot
already has `/workspace`).

Per-provider default checkpoint: `box.defaultCheckpoint` is the cross-
provider fallback, `box.defaultCheckpointDocker` /
`box.defaultCheckpointDaytona` override per provider. Set via
`agentbox checkpoint set-default [--provider daytona] <ref>`.

### 2.6 Interactive attach (shell / claude / codex / opencode / code)

Daytona mints a short-lived SSH token per attach (`sb.createSshAccess(60)`).
The provider's `buildAttach` returns the SSH argv; the CLI wraps it in
`tmux new-session -A -s <session>` (or skips tmux for `--no-tmux` /
one-shot exec). `agentbox code` writes a managed block into
`~/.ssh/config` so VS Code Remote-SSH and `cursor --folder-uri` can
attach by alias.

`agentbox open` for cloud boxes reuses that SSH alias to `sshfs`-mount
`/workspace` at `~/.agentbox/mounts/<box>/` and reveal in Finder.

### 2.7 Robustness

- **Retry wrapper**: `withDaytonaRetry` (`packages/sandbox-daytona/src/retry.ts`)
  wraps every backend method. 3 attempts with 1s/2s/4s backoff, per-attempt
  timeout, typed-error-based decisions (`DaytonaRateLimitError` always
  retries; `provision` never retries on ambiguous errors).
- **CloudFront 504 fast-mode**: `CloudBoxPoller` shortens its request
  timeout to 8s for the next 5 polls after a 504, so a flaky edge
  recovers quickly (2.6).
- **Orphan cleanup**: `agentbox prune --provider daytona` lists every
  sandbox the credentials can see, cross-references local `state.json`,
  and offers to delete the ones we created (label `agentbox.name`) but
  no longer track (6.3).
- **Action expiry**: `HostActionQueue` GCs parked actions after 15 min
  so a host relay restart doesn't replay forgotten `git.push` attempts
  (6.4).

### 2.8 `carry:` block (host→box file copy)

The cloud `carry:` path is symmetric to the docker one (see `docs/features.md`
for the schema, flags, and security rationale). `uploadCarryPaths`
(`packages/sandbox-cloud/src/carry.ts`) runs in the create pipeline right
after `uploadEnvFiles` and before the supervisor launches, so the first
declared task can already see `~/.agentbox/secrets.env`, etc.

Per-entry flow:

1. Host: `tar` the source on disk into `/tmp/agentbox-carry-<i>.tar`
   (single file → `-C dirname <basename>`; directory → `-C dir .`).
2. `backend.uploadFile` ships the tar to `/tmp/agentbox-carry-<i>.tar` in
   the sandbox.
3. `backend.exec` runs one bash one-liner: `mkdir -p $(dirname dest) &&
   tar -xf … -C … --no-same-permissions --no-same-owner -m && [mv if file
   src/dest basenames differ] && [chmod -R <mode>] && [chown -R 1000:1000
   when dest is under /home/vscode] && rm -f /tmp/agentbox-carry-<i>.tar`.

Per-entry isolation (one tar per entry rather than one combined tar) keeps
arbitrary destinations safe — a failing entry never poisons the
`/workspace` seed, and the audit summary on `BoxRecord.carry` reflects
only what actually landed. The same `uploadCarryPaths` powers Hetzner
(scp over ControlMaster) and Daytona (SDK upload+exec) without per-backend
code — both already implement `uploadFile` + `exec`.

`~/` in the user-declared dest expands to `/home/vscode` host-side (never
in-box) so the path is explicit before it leaves the host — the supervisor
runs as `vscode` (uid 1000) and that's the only home we care about.

## 3. The Hetzner shape

Hetzner is structurally different from Daytona: instead of a managed
sandbox service with its own SDK + signed preview URLs, each box is a
bare Hetzner Cloud VPS reached over pure OpenSSH. No third-party agent
runs inside the box. The user owns root.

The `CloudBackend` interface is the same, but the implementation
(`packages/sandbox-hetzner/`) maps onto a small hand-rolled REST client
(`src/client.ts`) over `https://api.hetzner.cloud/v1`, plus a system
`ssh`/`scp` for everything that's not a Hetzner API call.

### 3.1 Topology + lifecycle

- **One VPS per box** (1:1, like Daytona). Default `cx23` (2 vCPU / 4 GB / 40 GB
  x86, ~€4/mo while running). Default location `nbg1`. Both configurable
  per provision request.
- **Per-box ed25519 SSH key** minted at `provision` time into
  `~/.agentbox/boxes/<sandboxId>/ssh/{id_ed25519,id_ed25519.pub,known_hosts}`.
  Private key never leaves the host. Pubkey is injected via cloud-init's
  `users.vscode.ssh_authorized_keys` — explicitly NOT via Hetzner's
  SSH-keys-import API (that would make the key reusable on other VPSes).
- **Per-box Hetzner Cloud Firewall**, also minted at provision time,
  rule set = `[{direction: 'in', port: '22', protocol: 'tcp', source_ips: ['<host-egress>/32']}]`.
  Outbound unrestricted. Source IP auto-detected via a 3-probe race
  (api.ipify.org → ifconfig.io → icanhazip.com); if all three fail, the
  call **fails loud** rather than silently opening `0.0.0.0/0`. Override
  via `AGENTBOX_HETZNER_FIREWALL_SOURCE` env or `--firewall-source <cidr>`
  on the prepare command.
- **State mapping** (`backend.state`): Hetzner `running` → `running`;
  transitional states (`starting`/`initializing`/`stopping`/`migrating`/`rebuilding`)
  all report `running` so callers don't ping-pong; `off` → `paused`
  (pause ≡ stop ≡ poweroff for Hetzner — no archive primitive); deleting
  / missing → `missing`.

### 3.2 The `prepare` flow — a one-time base snapshot

Hetzner can't build images from a Dockerfile, so `agentbox prepare
--provider hetzner` does the bake by running an install script on a
throwaway VPS, snapshotting the result, then deleting the VPS.

Flow (`packages/sandbox-hetzner/src/prepare.ts`):

1. Mint ephemeral SSH key under `~/.agentbox/hetzner/prepare-<ts>/`.
2. Detect egress IP + create a per-prepare firewall locked to it.
3. Create a temp VPS (Ubuntu 24.04, cx23, `start_after_create: true`)
   with cloud-init injecting the pubkey for `root` and clearing the
   first-login password expiry (Hetzner Ubuntu enforces it; without
   the clear, key-only SSH gets "Password change required").
4. Poll `waitForSsh` (5-min deadline).
5. scp the 10 runtime assets to `/tmp/` **sequentially** (parallel scp
   trips sshd's MaxStartups on a freshly-booted VPS).
6. Run `bash -x /tmp/agentbox-install.sh 2>&1 | sudo tee /var/log/agentbox/install.log`
   over ssh — script runs ~5-15 min, output streams through `onLog`.
7. `create_image` snapshot of the live VPS; poll until `available` (20-min deadline).
8. Persist `{base.imageId, description, createdAt, installScriptSha256}`
   into `~/.agentbox/hetzner-prepared.json`.
9. Delete VPS + firewall.

Every failure path runs cleanup of VPS + firewall (best-effort, with a
"check Hetzner dashboard manually" warning on a cleanup-failure). The
user never ends up with a forgotten €4/mo VPS due to a transient error.

**Skip-fast**: when prepared.json already records a base AND that image
is still on Hetzner AND `installScriptSha256` matches AND `--force`
wasn't passed → return the existing record without rebuilding.

The install script (`packages/sandbox-hetzner/scripts/install-box.sh`)
is a shell mirror of `packages/sandbox-docker/Dockerfile.box`: Node 24
+ Python + corepack, docker.io + the same `/usr/local/bin/agentbox-dockerd-start`
the docker provider ships, TigerVNC + noVNC + websockify + autocutsel,
Playwright Chromium + agent-browser + portless, Claude Code (native
installer) + Codex + OpenCode, sshd hardening drop-in, vscode user (UID
1000) with passwordless sudo. Order matters: all small file-install
steps run BEFORE the long Chromium download (see follow-ups in
`docs/hertzner_backlog.md` for the diagnostic on why).

### 3.3 SSH tunnel manager — the load-bearing comms primitive

`SshTunnelManager` (`packages/sandbox-hetzner/src/ssh-tunnel.ts`) owns
one persistent `ssh -fNT -M` ControlMaster per box. The socket lives at
`~/.agentbox/boxes/<sandboxId>/ssh/control.sock`. Every `backend.exec`,
`uploadFile`, `downloadFile`, `previewUrl`, `attachArgv` call reuses
that master via `-S <socket>` — no per-call SSH handshake.

- `open(boxId, vpsHost, identity)` — spawns the master, idempotent.
- `forward(boxId, remotePort) → localPort` — mints
  `ssh -O forward -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`,
  caches the local port per `(boxId, remotePort)` pair.
- `unforward(boxId, remotePort)`, `close(boxId)`, `closeAll()` — symmetric.

`previewUrl(handle, port)` calls `forward()` and returns
`http://127.0.0.1:<localPort>`. The cloud-provider scaffolding then
decorates these URLs with Portless aliases for symmetric
`<box-name>.localhost` URLs (handled provider-side, not in the
backend, so the backend stays focused on plumbing).

### 3.4 Checkpoints

Map to Hetzner's `create_image` API (`type: snapshot`). Defaults to
**no-pause** — `create_image` works on a running server, matching
`docker commit`'s default. Optional opt-in pause (powdoff → snapshot
→ poweron) is gated on `CloudBackend.createSnapshot` signature
extension (open follow-up).

Manifests share the same on-disk layout as Daytona:
`~/.agentbox/cloud-checkpoints/hetzner/<projectSegment>/<name>/manifest.json`.
The snapshot is labeled `agentbox.role=ckpt + agentbox.box=<sandboxId>`
for orphan discovery.

`box.defaultCheckpointHetzner` (per-provider config key) takes
precedence over `box.defaultCheckpoint` for Hetzner boxes. Set via
`agentbox checkpoint set-default --provider hetzner <ref>`.

### 3.5 DinD inside the VPS

Reuses the unchanged `launchCloudDockerdDaemon` scaffolding — the
install script bakes `/usr/local/bin/agentbox-dockerd-start` (the same
script the docker provider ships), and `createCloudProvider.create()`
auto-launches it via `backend.exec` at provision + resume time.
`docker run --rm hello-world` works inside the box without any
hetzner-specific code (verified live in Phase-7 smoke).

### 3.6 Known shape differences vs Daytona

- **No shared volume primitive.** Hetzner Block Volumes are per-server,
  not shared. Daytona's `agentbox-credentials` per-org volume has no
  equivalent — agent credentials get pushed via scp at create time
  instead (see follow-ups for the wiring).
- **No signed-preview-URL primitive.** SSH local forwards are already
  loopback + auth-gated by the bridge token; `signedPreviewUrl` is the
  same as `previewUrl` for hetzner.
- **No per-attach-token primitive** (like Daytona's
  `sb.createSshAccess(60)`). `attachArgv` reuses the ControlMaster via
  `-S <sock>` — no token rotation, no SSH-token mint pressure.
- **Pause bills.** Hetzner charges ~€4/mo for stopped VPSes; pause/
  resume = poweroff/poweron. True zero-cost pause (delete-and-respawn-
  from-per-box-snapshot) is a follow-up.

### 3.7 The `agentbox hetzner` CLI surface

- `agentbox hetzner login` — interactive `HCLOUD_TOKEN` setup, validates
  via `GET /locations`, persists to `~/.agentbox/secrets.env`.
- `agentbox hetzner login --status` — masked token + source.
- `agentbox hetzner firewall sync <box> [--source <cidr>]` —
  re-detects egress IP, updates the per-box firewall via
  `setFirewallRules`. The common "I moved networks and ssh times out"
  recovery.
- `agentbox hetzner firewall show <box>` — prints current rules + the
  host's current egress IP, with a `WARN` line on drift.

### 3.8 Faster `git push` / `git fetch` (SSH agent + credential proxy)

By default the relay's `git.push` / `git.fetch` round-trip through a
git bundle. On Hetzner that's replaced with a single fresh `ssh -A`
exec into the box that runs `git push` / `git fetch` against `origin`
directly:

- **SSH origin** (`git@…`/`ssh://…`): host SSH agent is forwarded via
  `-A`. The in-box `git` uses the forwarded agent socket to
  authenticate to GitHub. Socket disappears when the SSH session ends.
- **HTTPS origin** (`https://…`): host starts a short-lived loopback
  TCP listener that speaks git's credential-helper protocol and
  delegates to the user's actual configured helper (`osxkeychain`,
  `libsecret`, `gh auth git-credential`, …). The ephemeral `ssh -A`
  also passes `-R <inboxPort>:127.0.0.1:<proxyPort>`, so the in-box
  `git -c credential.helper='!bash -c "exec 3<>/dev/tcp/127.0.0.1/<inboxPort>; cat >&3; cat <&3"'`
  reaches the host's helper. The token transits the box's loopback
  for the push window but is never written to a file or env var
  inside the box. A box-resident attacker with simultaneous shell
  access could intercept by hitting the forwarded port while the
  push runs — but they already have the user's worktree, so this is
  not a new exposure.

Fast path auto-falls-back to the bundle path on: missing host
`SSH_AUTH_SOCK`, `Permission denied (publickey)`, helper timeout
(>5s), proxy startup failure, or `ssh -R` bind failure. Fallback is
logged once per box. The existing `askPrompt()` confirmation gate
runs before either path executes — the safety model is unchanged,
only the transport.

### 3.9 `agentbox git box-fetch <box> [refspec...]` (host pulls box's commits)

A symmetric helper for the host side: pull a Hetzner box's commits
back into the host repo over SSH (no GitHub round-trip, no bundle,
no persistent remote). The host already has the per-box ed25519
key + known_hosts under `~/.agentbox/boxes/<id>/ssh/`, so it just
needs `GIT_SSH_COMMAND` to point at them and `git fetch ssh://vscode@<vps>/workspace`.

```
agentbox git box-fetch smoke
# → git fetch ssh://vscode@<vps>/workspace +refs/heads/*:refs/remotes/agentbox-<id>/*
```

Default refspec scopes refs under `refs/remotes/agentbox-<box-id>/*`.
No persistent remote is registered; no entries are written to
`~/.ssh/config` or `git config`. The box's `/workspace` is a regular
git clone (not a worktree), so `git-upload-pack` over SSH works
without any server-side setup. Docker boxes (which share `.git/`
via bind-mount) and Daytona boxes (no SSH passthrough) report a
clear error pointing at the bundle path.

## 4. Authentication

`agentbox daytona login` is the supported path. It prompts for
`DAYTONA_API_KEY` (required) and `DAYTONA_ORGANIZATION_ID` (optional)
and persists them to `~/.agentbox/secrets.env`. Subsequent runs read
that file; project `.env` is never harvested. First-time use of
`--provider daytona` triggers the login prompt automatically.

`agentbox hetzner login` is the analogous command for Hetzner. It
prompts for `HCLOUD_TOKEN` (Read+Write API token from a Hetzner project's
Security → API Tokens page), validates it via `GET /locations`, and
persists it to the same `~/.agentbox/secrets.env`. First-time use of
`--provider hetzner` triggers the login prompt automatically.

## 5. Known caveats

- **Destroy lag in the Daytona dashboard**: `sb.delete()` returns immediately
  and our local `state.json` clears synchronously, but the Daytona web UI
  polls slowly — the deleted sandbox keeps showing up there for ~30s. The
  resource is gone; only the dashboard is stale. Refresh the page if you
  need an immediate-consistent view. Nothing for us to fix on this side.
- **First-run Dockerfile.box build** takes ~7 min on Daytona because
  it includes Playwright + Chromium. Cached snapshot reuse is seconds.
  Future: ship a public snapshot to skip the cold build. Tracked as
  backlog 5.1.
- **Live stats** (`agentbox top` CPU/mem) aren't surfaced for cloud —
  Daytona's SDK doesn't expose per-sandbox metrics. We render `—` for
  every metric.
- **Daytona dashboard lag**: `sb.delete()` returns immediately but the
  UI lags ~30s. Cosmetic. (6.2)
- **`download.env|config|claude`** for cloud isn't implemented — those
  source paths live in per-agent volumes that need a separate route.
  `download.workspace` works.

## 6. CLI surface reference (cloud-routed)

Every command below honors `box.provider` automatically. Pass
`--provider <name>` on `create` / `claude` / `codex` / `opencode` to
override per invocation.

| Command | Cloud path |
| --- | --- |
| `create` | `provider.create` (workspace seed + ctl + dockerd + VNC + agent volumes). |
| `claude` / `codex` / `opencode` | `cloudAgentCreate` + `cloudAgentAttach` over SSH+tmux. |
| `shell` (incl. `-- <cmd>`) | `provider.buildAttach('shell')` over SSH; `--name`/`--new` map sessions via `tmux ls`. |
| `cp` / `download` | `provider.uploadPath` / `downloadPath` / `downloadDirContents`. |
| `url` (incl. `--print`, `--ttl`) | Signed preview URL via `provider.resolveUrl`. |
| `screen` | Signed preview URL on port 6080 (in-sandbox VNC stack started at create+start). |
| `code` | SSH alias in `~/.ssh/config` + `vscode-remote://`. |
| `open` | Reuses the SSH alias to `sshfs`-mount `/workspace`; `--unmount` tears down. |
| `wait` / `logs` (incl. `--daemon`, `-f`) | `provider.exec` (non-follow) / `provider.buildAttach('logs')` (follow). |
| `checkpoint create / ls / rm / set-default` | Provider-aware; cloud uses Daytona snapshots + on-disk manifests. |
| `inspect` / `status` / `list` | Provider-routed; cloud rows show `daytona` in the PROVIDER column. |
| `top` / `dashboard` | Cloud rows surface (no live stats / no live attach pane). |
| `prune --provider daytona` | Orphan cleanup. |

## 7. Adding a new cloud backend

Implementing `CloudBackend` (`packages/core/src/cloud-backend.ts`) is
the only work. Required:

```ts
provision, get, start, stop, pause, resume, destroy, state,
exec, uploadFile, downloadFile, listFiles, previewUrl
```

Optional (degrades gracefully):

```ts
signedPreviewUrl, attachArgv, revokeAttachToken, ensureVolume,
createSnapshot, deleteSnapshot, list
```

Then add a one-line case to `resolveCloudBackend` in
`packages/relay/src/host-actions.ts` and register the name in
`apps/cli/src/provider/registry.ts`'s `KNOWN`. Compose the full
`Provider` with `createCloudProvider(backend)`.

### 7.1 Validating with the mock backend + contract tests

`@agentbox/sandbox-cloud` exports a `makeMockCloudBackend()` reference
implementation:

```ts
import { makeMockCloudBackend, createCloudProvider } from '@agentbox/sandbox-cloud';
const backend = makeMockCloudBackend();
const provider = createCloudProvider(backend);
```

The mock implements every required + optional method on `CloudBackend`,
records calls in invocation order (`backend.calls`), and lets tests
inject failures via `beforeCall` (handy for retry-wrapper testing).

The contract test suite in
`packages/sandbox-cloud/test/mock-backend-contract.test.ts` exercises:

- The full lifecycle: `provision → start/stop/pause/resume → destroy`.
- `list()` shape (`CloudSandboxSummary`).
- Stable URLs from `previewUrl` / `signedPreviewUrl`.
- `createSnapshot` / `deleteSnapshot`, `ensureVolume`.
- `createCloudProvider` composition (resolveUrl prefers signed,
  buildAttach uses attachArgv when present).
- Failure injection (so backends can validate their retry semantics).

To certify a new backend (`@agentbox/sandbox-vercel`, say): copy the
suite, swap the factory, and ensure every test still passes. Any
failure flags either a backend bug or an abstraction gap.

## 8. Where each cloud piece actually lives

| Topic | File |
| --- | --- |
| Provider abstraction | `packages/core/src/provider.ts` |
| Cloud backend interface | `packages/core/src/cloud-backend.ts` |
| Cloud provider composition | `packages/sandbox-cloud/src/cloud-provider.ts` |
| Daytona SDK shim | `packages/sandbox-daytona/src/backend.ts` |
| Workspace seeding (bundle + carry-over) | `packages/sandbox-cloud/src/workspace-seed.ts` |
| Agent credential volumes | `packages/sandbox-cloud/src/agent-credentials.ts` |
| Cloud cp / download | `packages/sandbox-cloud/src/cloud-cp.ts` |
| Per-service preview URLs | `packages/sandbox-cloud/src/expose-ports.ts` |
| Host action executor | `packages/relay/src/host-actions.ts` |
| Cloud poller | `packages/relay/src/cloud-poller.ts` |
| Retry / 504 backoff | `packages/sandbox-daytona/src/retry.ts`, `cloud-poller.ts` fast-mode |
| Per-provider default checkpoint | `packages/config/src/checkpoint.ts` |
| Orphan prune | `apps/cli/src/commands/prune.ts` `--provider daytona` |
| SSH alias management | `apps/cli/src/ssh-config.ts` |
| Cloud E2E test | `apps/cli/test/cloud-e2e.test.ts` (gated on `DAYTONA_API_KEY`) |

Track outstanding work in [`daytona-backlog.md`](./daytona-backlog.md).
