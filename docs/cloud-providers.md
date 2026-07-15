# Cloud providers

> _Status: v1 ships with Daytona + Hetzner + Vercel + E2B + DigitalOcean. The provider abstraction is generic — adding another cloud is ~150 lines (see §6)._

AgentBox runs on six backends today, behind a single `Provider` interface
(`packages/core/src/provider.ts`):

| Provider | Where the box lives | When to use it |
| --- | --- | --- |
| `docker` (default) | Local Docker container | Fast, free, owns the host. Good default. |
| `daytona` | Daytona Cloud sandbox | When the workload outgrows the laptop, when teammates need to attach, when you want a snapshot-ready remote env. |
| `hetzner` | Hetzner Cloud VPS (1:1 per box) | When you want bare-VPS control (root, full kernel, your own region), pure OpenSSH (no third-party agent in the box), and a Cloud Firewall locked to your egress IP. ~€4/mo per running box. |
| `vercel` | Vercel Sandbox (Firecracker microVM) | When you want a fast snapshot-based remote env with public HTTPS preview URLs and persistent pause/resume. In-box `docker` (DinD) is baked in and auto-started; region `iad1` only. See §3b. |
| `e2b` | E2B Sandbox (Firecracker microVM) | When you want a Firecracker microVM with public HTTPS preview URLs and **the base image built straight from a Dockerfile** (`Template.build()`) — the only cloud provider that bakes from a Dockerfile rather than a one-time snapshot. In-box docker (DinD) supported, no SSH; 1-hour platform session cap on Hobby. See §3c. |
| `digitalocean` | DigitalOcean Droplet (1:1 per box) | Same VPS-over-OpenSSH shape as Hetzner — bare-Droplet control (root, full kernel, your own region), pure OpenSSH, and a Cloud Firewall locked to your egress IP. Auth is a single Personal Access Token; the firewall attaches at boot via a per-box tag (with explicit allow-all egress, since DO blocks outbound otherwise); checkpoints are droplet snapshots. ~$24/mo per running `s-2vcpu-4gb` box. See §3d. |

Switch backends per box: `agentbox create --provider daytona` (or `--provider
hetzner` / `--provider vercel` / `--provider e2b` / `--provider digitalocean`),
or pin project-wide via `box.provider: <name>` in `agentbox.yaml`. The rest of
the CLI surface (`shell`, `claude`, `url`, `cp`, `checkpoint`, …) routes on
`box.provider` and Just Works for all six.

### §3d. DigitalOcean specifics

DigitalOcean is a near-exact clone of the Hetzner backend (1 Droplet per box,
OpenSSH ControlMaster for all I/O, snapshot-based checkpoints, a one-time base
snapshot baked by `agentbox prepare --provider digitalocean` since DO can't
build images from a Dockerfile). Three things differ from Hetzner:

- **Auth** is a single Personal Access Token (`DIGITALOCEAN_TOKEN`), pasted via
  `agentbox digitalocean login` from `https://cloud.digitalocean.com/account/api/tokens`.
- **Firewall attach is tag-based.** Hetzner attaches the firewall at
  server-create; DO can't, so the per-box firewall is created *first* with a
  unique tag and the droplet is created with that same tag — DO auto-applies it
  at boot, leaving no unprotected window.
- **Egress must be explicitly allowed.** A DO firewall with only inbound rules
  blocks *all* outbound traffic, so the per-box firewall ships allow-all
  outbound rules (tcp/udp/icmp → `0.0.0.0/0` + `::/0`) alongside the SSH-only
  inbound rule locked to the host egress IP.

Defaults: size `s-2vcpu-4gb`, region `nyc3`, stock image `ubuntu-24-04-x64`.
Override per box with `box.sizeDigitalocean` / `AGENTBOX_DIGITALOCEAN_REGION`.
**DO Project**: `box.digitaloceanProject` (name or UUID; picked at `digitalocean login`) places boxes
in a specific DigitalOcean Project. DO has no project field on droplet-create, so the backend resolves
the name in the create preflight (fail-fast on a typo, before anything bills) and then assigns via
`POST /projects/{id}/resources` **best-effort** after the droplet exists — a failed assign warns and
keeps the box rather than tearing a working box down. Unset = the account's default project.

## 1. The provider abstraction

The orchestration code uses `Provider` (`packages/core/src/provider.ts`):

```ts
interface Provider {
  readonly name: ProviderName;          // 'docker' | 'daytona' | future
  create(req: CreateBoxRequest): Promise<CreatedBox>;
  start/reconnect/pause/resume/stop/destroy(box): Promise<…>;
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

`reconnect(box)` is the **no-power-cycle** sibling of `start`, used by
`agentbox recover` to re-attach this host to a box that's already running (host
reboot, relay restart, fresh CLI process). The cloud provider `probeState`s the
sandbox: when it's `running` it calls `reEnsureCloudBox` directly (re-resolve
preview URLs, re-open the Hetzner tunnel + forwards, re-register host portless
aliases + the relay poller, relaunch the in-box ctl/dockerd/vnc daemons) and
skips `backend.start`; only a `paused`/`stopped` sandbox falls back to the
power-cycling `resume`/`start`. `reEnsureCloudBox` also finishes with a
best-effort `reconcileAgentCredentials` (gated by `box.credentialSync`): a
woken box carries pause-time agent credentials, and if another box rotated the
claude refresh token meanwhile that copy is dead — claude is compared both
directions via `claudeAiOauth.expiresAt` (push host-newer / capture box-newer),
codex/opencode are host-wins push-if-different. Note the SDK's *implicit*
auto-resume (an `exec` against a paused vercel/e2b sandbox) bypasses this hook
until the next explicit resume/start/reconnect. Docker's `reconnect` is the
idempotent `startBox` (a `docker start` on a live container is a no-op). `recover --provider <cloud>
--adopt` additionally rebuilds a missing `BoxRecord` from `backend.list()` (the
`agentbox.name` tag), minting fresh relay/bridge tokens that reach the in-box
agent when `reconnect` relaunches the ctl daemon (it writes
`/run/agentbox/relay.env`). Hetzner adoption needs the box's per-host SSH key
(`~/.agentbox/boxes/<sandboxId>/ssh/id_ed25519`); a box created elsewhere can't
be controlled and `recover` says so.

This split is why "add a new cloud" is small: only the SDK shim differs.

### 1.0.1 `AGENTBOX_BOX_HOST` on cloud boxes

The `{{AGENTBOX_BOX_HOST}}` placeholder (used by `agentbox-ctl render` and carry
`replaceEnvs`) is normally derived as `<box-name>.localhost` — correct for the
portless providers (docker via `host.docker.internal`, hetzner via the in-VPS
mirror). On the **public-URL clouds** (Vercel/Daytona/E2B) `<name>.localhost` is
unreachable, so the cloud create/start flow resolves the box's web preview URL
*before* launching the in-box `agentbox-ctl` daemon and passes the **bare host**
(e.g. `<sub>.vercel.run`) to `launchCloudCtlDaemon` as `AGENTBOX_BOX_HOST`
(`deriveCloudBoxHost` in `cloud-provider.ts`: loopback preview → `<name>.localhost`;
public preview → `new URL(url).host`). It's both exported into the daemon's env
(so every supervisor task/service child — e.g. a first-boot `render` task — sees
it) and persisted to `/etc/agentbox/box.env` (so `agentbox shell` login shells and
manual `agentbox-ctl render` resolve it too). The placeholder engine prefers this
explicit value over the derived fallback, so `https://{{AGENTBOX_BOX_HOST}}`
matches what `agentbox url` returns.

The relay/bridge **tokens** are deliberately kept out of the world-readable
`box.env`. The per-box relay URL + token go to a `0600 /run/agentbox/relay.env`
(tmpfs, never snapshotted) written by the in-box ctl daemon, which `agentbox-ctl`
reads on demand (`resolveRelayEnv`); the bridge token stays in the daemon's
process env only. This is what lets the in-box agent and the host-driven
`agentbox git push` reach the relay on cloud boxes, which (unlike docker) have no
global env to inherit the token from. See [`host-relay.md`](./host-relay.md).

### 1.1 Per-provider base-image pins

Each provider's `agentbox prepare --provider X` writes the resulting
identifier into a per-provider config key — `box.imageDocker` /
`box.imageDaytona` / `box.imageHetzner` / `box.imageVercel` /
`box.imageE2b` — never the generic `box.image`. Reads resolve
per-provider first, then fall back to `box.image`, then to the built-in
`agentbox/box:dev` sentinel. This prevents the cross-provider footgun
where running `prepare --provider vercel` would pin a `snap_…` id into
the generic key and then break subsequent `create --provider hetzner`
calls (Hetzner doesn't know that id). `--image <ref>` on `create` is
resolved at the call site and wins over both the per-provider and
generic keys. As a one-shot migration, any `prepare` that finds a stale
non-default `box.image` in project config unsets it and logs a warning.

### 1.2 Create-time base-freshness check

`prepare` stamps a SHA over the baked-runtime files
(`base.contextSha256` in `~/.agentbox/<provider>-prepared.json`). Every
`create` / `claude` recomputes that SHA from the current install
(`evaluateBaseFreshness`) and compares. A mismatch surfaces in the
existing setup wizard:

- **TTY** → merged confirm offers to rebuild via
  `runPrepare(force: true)` before the create.
- **`-y` / non-TTY** → loud warn (`▲`), then proceed on the existing
  base; the user is told to run
  `agentbox prepare --provider X --force`. No auto-bake in scripted runs.
- **Docker** → silent: `ensureImage` self-heals inline on its own
  mismatch.

Staleness is decided **purely** by content checksum — a CLI patch that
doesn't change any baked file produces an identical SHA, so the base
stays `fresh`. See `docs/cloud-create-flow.md` → "Stale base detection
at create" for the full state machine.

### 1.2.1 Claude install method (`box.claudeInstall`)

Every provider bakes Claude Code with Anthropic's **native installer**
(`curl claude.ai/install.sh`) by default. Its CDN intermittently 403s
cloud-datacenter egress IPs; the bake retries 3× then aborts (exit 71)
rather than shipping a Claude-less base. `box.claudeInstall=npm` (or
`agentbox prepare --claude-install npm`) is the opt-in escape hatch: the
bake runs `npm install -g @anthropic-ai/claude-code` and symlinks it into
`/home/vscode/.local/bin/claude` — the path the attach command, PATH
shim, and host-side `installMethod=native` coercion all hardcode — so the
box stays indistinguishable from a native install. It's **bake-time
only** (never read at create), and the mode is folded into the base
fingerprint (`claudeInstallFingerprint`, `@agentbox/sandbox-core`) so a
switch re-bakes. Plumbing per provider: shell-script bakes (hetzner,
vercel, e2b) read `AGENTBOX_CLAUDE_INSTALL` in their install script;
docker passes a Dockerfile `--build-arg` (and folds the mode into
`ensureImage`'s create-time fingerprint so the lazy rebuild doesn't
clobber an npm image); daytona — whose SDK has no build-arg — builds from
a sibling temp Dockerfile with the ARG default flipped.

### 1.3 Login → prepare nudge

Each cloud's `agentbox <provider> login` only persists credentials.
Without a baked base, the next `create` trips the "no base
template/snapshot" error. To avoid that, each provider's `login` checks
for a baked base on success and, when none is recorded, prints a
one-line nudge: *"Base &lt;template|snapshot&gt; not built yet — run
`agentbox prepare --provider X` (or `agentbox install`) to bake it."*
The `agentbox install` wizard already calls `runPrepare` directly, so
users who go through `install` skip both the error and the nudge.

## 2. The Daytona shape

### 2.0 Sandbox class: `linux-vm` (default) vs `container`

Daytona has two sandbox **classes**, and they are not interchangeable — the class
is a property of the *snapshot*, and a snapshot of one class cannot create a
sandbox of the other. `box.daytonaClass` picks it; changing it forces a re-bake.

|                                | `linux-vm` (default)                                     | `container`                          |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------ |
| `agentbox pause` / `unpause`   | **real VM freeze** — CPU *and memory*; running processes and tmux sessions survive | archive (cold storage, filesystem only) |
| Archive                        | not supported (rejected)                                  | yes — this is what pause maps to     |
| Checkpoints                    | cold snapshot (~2 s capture)                              | cold snapshot                        |
| Base bake                      | ~1 min (boots a prebuilt registry image)                  | ~7 min (Dockerfile build)            |
| Region                         | **`us-east-1` only**                                      | any (`us`, `eu`, …)                  |
| Volume mounts                  | **silently ignored** (see 2.2)                            | supported                            |

**The region lock is the tradeoff.** Only `us-east-1` has linux-vm runners; asking
for a VM anywhere else fails at create with *"No runners are configured in region
'<r>' for sandbox class 'linux-vm'"*. So `box.daytonaRegion` defaults to empty and
is *derived* from the class — `linux-vm` ⇒ `us-east-1`, `container` ⇒ the account
default — rather than to a constant that would contradict the default class. If you
need EU data residency or lower EU latency, set `box.daytonaClass=container`.

Only two calls are region-sensitive: `snapshot.create` (takes `regionId`) and
`Daytona.create` (takes its region from the **client target**, not a param — the
`regionId` create param is ignored). `get`/`exec`/`list`/lifecycle are
region-agnostic, so the backend keeps a small per-target client cache rather than
threading a region through every call.

#### Why the VM base is baked from a registry image

Daytona builds a VM snapshot **only from a prebuilt registry image**, never from a
Dockerfile — handing `snapshot.create` a declarative `Image` with
`sandboxClass: LINUX_VM` fails with `build snapshot: rpc error: code =
Unauthenticated`. So `prepare --provider daytona` can't use the declarative
builder for VMs. Instead it boots the box image CI already publishes to GHCR
(`ghcr.io/madarco/agentbox/box:sha-<docker-context-sha>`, public + amd64), then
seeds and cold-snapshots it — the same "boot, provision in place, snapshot" shape
Hetzner and Vercel use.

Consequences:

- **`--claude-install npm` gets a VM too, as of the two-variant publish.** The
  install mode is part of the image's identity (the sha is folded with
  `claudeInstallFingerprint`, same as the docker pull path), and CI now matrixes
  over it, so both `native` and `npm` images are published under their own
  fingerprint tags. Only the native build claims `latest` / the version tag — it
  is the default image. (Before this, only native was ever built, so npm mode had
  no image to boot from and prepare fell back to a container.)
- **Monorepo contributors can't bake a VM by default.** A local `pnpm build`
  regenerates `packages/ctl/dist/bin.cjs`, which shifts the build-context sha off
  the one CI published, so no tag matches. Prepare falls back to a container.
  Set **`box.daytonaVmBaseImage`** to bake from an explicit image instead (this is
  also the knob for a private registry mirror).

#### `sudo` is repaired at bake time

Converting the container image into a VM rootfs **strips setuid bits**: `sudo`
lands as mode 0755 and cannot escalate (only `mount`/`umount`/`su` keep theirs).
That would break the seed (`/etc/claude-code/CLAUDE.md` needs root) and the
passwordless sudo the in-box agent is told it has. `create({ user: 'root' })` is
not a way out — the sandbox then fails to start.

The bake repairs it through the docker socket, which the image already grants
(`dockerd` runs at boot; `vscode` is in the `docker` group, which is
root-equivalent by construction):

```
docker run --rm --privileged -v /:/host alpine \
  sh -c 'chown root:root /host/usr/bin/sudo && chmod 4755 /host/usr/bin/sudo'
```

The fix persists into the snapshot, so every box booted from that base has working
sudo from the start.

#### Snapshot names are never reused

Recreating a snapshot under a **recently deleted name** yields one that reports
`active` but cannot boot (*"Sandbox failed to start: internal error"*) — Daytona's
delete is async and racing it corrupts the new snapshot. So every capture takes a
fresh name (a nonce suffix), the bake reaps the snapshot it replaces *after* the
new one is recorded, and a base that fails to boot is treated as poisoned and
rebuilt once under a never-used name.

#### Idle handling

`box.daytonaTimeoutMs` (default **25 min**, `0` disables) is passed as Daytona's
`autoStopInterval`. Unlike vercel/e2b — where the timeout is an absolute session
TTL — Daytona's is an **inactivity window**, reset by *any* request to the
sandbox.

**That window never elapses for a box AgentBox is tracking.** The host relay's
`CloudBoxPoller` long-polls each cloud box's preview URL continuously (it's how
host↔box comms work), and that traffic is itself the activity Daytona measures.
So Daytona's timer restarts on every poll, and an idle box would run — and bill
— forever. Measured against live Daytona with `autoStopInterval: 3`
(2026-07-13):

| sandbox | traffic | result |
| --- | --- | --- |
| control | none | stopped at **3.0 min** |
| test | one request / 15 s | **still running at 7.0 min** (28 requests) |
| the same test box, after the requests stopped | none | stopped **3 min later** |

The third row is the control that names the cause: a node server kept running in
the box the whole time, so it's the **requests** that reset the clock, not
activity inside the sandbox.

So the **host enforces the timeout itself**. `packages/relay/src/cloud-keepalive.ts`
pauses a box whose agent has been idle for its own `daytonaTimeoutMs`
(`shouldIdlePause`) — the box's configured window, deliberately not the 5-min
keepalive/autopause renewal window, or we'd pause five times sooner than the key
advertises. `CloudBackend.timeoutModel` (`'inactivity'` for daytona,
`'absolute'` elsewhere) is what selects this path: **vercel and e2b are
unaffected**, since their deadlines can't be deferred by anything the box
receives, so an idle box still lapses on its own.

Two consequences worth knowing:

- The window is measured against the **agent's** idle state, not raw requests.
  A box with no agent at all (a plain `agentbox shell` box) is never
  auto-paused — we have no evidence it's unused, and an attached human is
  precisely who we must not pull the floor out from under.
- Daytona's `autoStopInterval` is still set, and still useful: it's the backstop
  for when the relay *isn't* running (laptop asleep, `agentbox relay stop`) —
  exactly when the host can't do it and no polling is resetting the clock.

Pausing (rather than stopping) is deliberate: a `linux-vm` box is frozen with
its memory, so running processes and tmux sessions survive, and every attach
path resumes a paused box automatically.

### 2.0.1 Sizing

Default sandbox shape is **2 vCPU / 4 GB RAM / 8 GB disk**. Size is
`cpu-mem-disk` GB (e.g. `4-8-20`), from `--size` / `box.sizeDaytona` /
`box.size` (precedence: `--size` > `box.sizeDaytona` > `box.size` >
built-in). **Caveat:** Daytona rejects `resources` on the snapshot-resume
path, so size is fixed at **bake time**: `agentbox prepare --provider
daytona --size <spec>` bakes it into the snapshot (the snapshot name gets a
`-<cpu>-<mem>-<disk>` suffix so re-sized bakes don't collide, and the size
is recorded in `daytona-prepared.json` `extras.size` so a changed size
re-bakes — NOT folded into `contextSha256`, so live freshness checks are
unchanged). A `create --size` that differs from the baked snapshot's size
still boots but logs a loud warning pointing at `prepare … --size … --force`.
On the rare from-image create path the size is applied directly. Invalid
specs (anything other than positive integers separated by `-`) throw at
prepare time with the `4-8-20` example.

### 2.1 Workspace seeding

`seedCloudWorkspace` (`packages/sandbox-cloud/src/workspace-seed.ts`) ships
the host workspace into the sandbox:

1. `git clone --no-checkout [--depth=N] file://<hostRepo>` on the host for
   the root repo and every nested git repo (1.4). Default cap: last 200
   commits, redo at 100 if the resulting tar exceeds 20 MB. Override via
   `box.bundleDepth` / `--bundle-depth <n>` (0 = full history) (1.3).
2. `git stash create` + `git ls-files --others` on the host capture the
   user's uncommitted changes; the stash SHA is fetched into the shallow
   clone under `refs/remotes/origin/agentbox-carryover/stash`, untracked
   files in a side-channel tar (1.5).
3. `backend.uploadFile` ships `workspace.tar.gz` (the tarred `.git/` from
   the shallow clone) + optional untracked tar.
4. In-sandbox: `rm -rf /workspace && tar -xzf workspace.tar.gz` extracts
   `.git/` into `/workspace`, then `git remote set-url origin <real>`,
   `git checkout -B agentbox/<box-name>` (materializes the working tree
   from HEAD), `git stash apply` carry-over, untar untracked.

### 2.2 Agent state split: snapshot bake + credentials volume

> **`linux-vm` caveat — volume mounts are silently ignored.** A VM sandbox
> *accepts* `create({ volumes: [...] })`, echoes the mount back in its DTO, and
> then the path simply does not exist in the guest. So the shared
> `agentbox-credentials` volume described below **does not work on VM boxes**.
> They take the per-create upload path instead — the same one Hetzner uses (it has
> no shared-volume primitive either): `ensureAgentVolumesForCloud` is told the
> volume is unusable and returns no mounts, and credentials are uploaded into
> `~/.agentbox-creds/<agent>/` at create time. The practical difference: a
> credential refresh no longer propagates to already-running boxes by rewriting one
> volume — each box gets its own copy at create. Container boxes are unaffected.

Agent state lives in two distinct places:

**Static config** (plugins, skills, marketplaces, settings, `_claude.json`,
codex `config.toml` + `prompts/`, opencode `config/`) is baked into the base
snapshot at `agentbox prepare --provider daytona` time — see `prepareDaytona` in
`packages/sandbox-daytona/src/prepare.ts`. **How** it's baked depends on the class:

- **container** — layered with Daytona's declarative builder:
  `Image.fromDockerfile(Dockerfile.box)` + `.dockerfileCommands(...)`, then
  `daytona.snapshot.create({ name, image })`. Build + register in one server-side
  operation.
- **linux-vm** — the declarative builder is unavailable (§2.0), so the seed runs
  against a *live* sandbox instead: boot the GHCR base, upload the staged
  tarballs, extract them, cold-snapshot the result. The upload+extract step is
  provider-neutral (`seedAgentStaticIntoCloudBox` in `@agentbox/sandbox-cloud`,
  built on just `uploadFile` + `exec`), so Hetzner can adopt it in place of its
  inline ssh/scp copy.

Either way the resulting snapshot
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

- `git.push` / `git.fetch` — bundle pull-back through the host's main
  repo (lets the host's SSH keys do the real push without ever sending
  them into the sandbox).
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
  per provision request (`CloudProvisionRequest.size` / `.location`, threaded
  from the CLI by `cloudSizingProviderOptions`).
- **Per-box VM size** — set via `--size <server-type>` on `agentbox create`,
  or `box.sizeHetzner` (per-provider override) / `box.size` (generic
  fallback) in config. Precedence: `--size` > `box.sizeHetzner` >
  `box.size` > built-in `cx23`. Value is passed through as Hetzner's
  `server_type` (e.g. `cx33`, `cx43`).
- **Per-box location** — set via `--location <name>` on `agentbox create`, or
  `box.hetznerLocation` in config (default `nbg1`). Precedence: `--location` >
  `box.hetznerLocation`. `--location` on a non-hetzner provider is warned and
  ignored. `agentbox prepare --provider hetzner --location <name>` sets the
  bake VPS location the same way.
- **Preflight validation** (`src/preflight.ts`, pure) — before any billable
  resource is created, `validateServerChoice` checks the choice against the
  live `/server_types` catalog + the base image, in order: type exists (else
  suggests non-deprecated x86 names) → x86-only (`cax*`/ARM rejected — base
  snapshots are x86) → not deprecated → the type's disk fits the snapshot's
  `disk_size` → the location offers the type (`prices[].location`). Each failure
  throws a `UserFacingError` with the fix. This runs *before* firewall/SSH-key
  creation, so a bad `--size`/`--location` never bills a half-created box.
- **Provision error mapping** (`mapHetznerProvisionError`) — the create call is
  wrapped so late Hetzner errors become actionable: `resource_limit_exceeded` →
  account-limits explanation + the Hetzner Console Limits page (dedicated `ccx*`
  types trip this on new accounts); `resource_unavailable` / `placement_error` →
  "no capacity for `<type>` in `<location>`, try another `--location`". Original
  messages are preserved; unrecognized codes pass through untouched.
- **Real reported resources** — `provision` reads the actual
  `server.server_type` back from the create response and returns
  `CloudHandle.resources {cpu, memory, disk}`. The cloud scaffold stores this on
  the box record and logs `provisioned <c> vCPU / <m> GB RAM / <d> GB disk`
  (falling back to the provider's static `defaultResources` for old records).
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

When the host Portless proxy runs in **TLS** mode, the in-box mirror serves a
self-signed CA the box doesn't trust by default, so in-box Chromium (VNC window)
and Playwright would reject `https://<box>.localhost`. The baked
`agentbox-portless-trust` helper fixes this: `startInBoxPortless` (hetzner) and
docker `create` invoke it to trust the CA in both the system store
(`update-ca-certificates`) and the box user's NSS db (`certutil`, from
`libnss3-tools`), and export `NODE_EXTRA_CA_CERTS` for Node clients. No-TLS host
proxies (the no-root `--no-tls -p 1355` fallback) serve plain `http` and skip this entirely.

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

The install script bakes `/usr/local/bin/agentbox-dockerd-start` (the same
script the docker provider ships), and the in-box bootstrap
(`agentbox-ctl bootstrap`, kicked by `createCloudProvider.create()` /
`reEnsureCloudBox()` at provision + resume) launches it before the ctl daemon.
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

## 3b. The Vercel shape

Vercel Sandbox is a Firecracker microVM on Amazon Linux 2023 with first-class
snapshots and `sandbox.domain(port)` public preview URLs. Full build-out status
and the live-verify checklist live in [`vercel-backlog.md`](./vercel-backlog.md);
the shape in brief:

- **Base via snapshot, not Dockerfile.** Vercel can't build an image, so
  `agentbox prepare --provider vercel` boots a fresh `node24` sandbox, runs
  `packages/sandbox-vercel/scripts/provision.sh` (dnf deps, `vscode` user,
  agentbox-ctl + shims, Claude native installer, codex/opencode), then
  `sandbox.snapshot({ expiration: 0 })`. The snapshot id is persisted to
  `~/.agentbox/vercel-prepared.json` and every `create` boots from it.
- **No nested containers.** Seccomp blocks the namespace syscalls a container
  runtime needs (validated), so the provider passes `launchDockerd: false`;
  in-box `docker` is unavailable. Everything else (node, python, git, tmux,
  VNC, Claude Code) runs as plain processes.
- **Persistent → pause/resume for free.** Sandboxes are created `persistent:
  true` with `keepLastSnapshots: { count: 1, expiration: 0 }`. `pause`/`stop`
  call `sb.stop()` (auto-snapshot + shut down); `resume`/`start` call
  `Sandbox.get({ resume: true })`. `destroy` deletes the sandbox and purges its
  current snapshot so storage doesn't linger.
- **Preview URLs are public HTTPS.** `previewUrl`/`signedPreviewUrl` both return
  `sandbox.domain(port)` — reachable from the host browser AND from inside the
  box, so (like Daytona) the Portless in-box mirror is skipped. Max 4 exposed
  ports; we declare 80 (WebProxy), 6080 (noVNC), 8788 (relay/ctl bridge).
- **No SSH → custom attach.** `@vercel/sandbox` exposes no stdin/PTY channel, so
  `buildAttach` is overridden to spawn `attach-helper.js`, which bridges the
  local terminal to a box-side tmux session via `send-keys`/`capture-pane` over
  the SDK. (A ttyd/WebSocket terminal is the planned latency upgrade — see the
  backlog.)
- **Checkpoints store the snapshot id.** Vercel snapshots are id-addressed, so
  the provider overrides `checkpoint` to write the Vercel snapshot id into the
  cloud-checkpoint manifest's `snapshotName` field; restore boots from it.
  Caveat: `sb.snapshot()` stops the source box (it auto-resumes on next call).
- **Hard platform limits:** region `iad1` only, 32 GB fixed disk, 2048 MB RAM
  per vCPU, 45 min (Hobby) / 5 hr (Pro+) sessions.
- **Session keepalive.** The host relay (`cloud-keepalive` loop, sibling to
  auto-pause) renews a running box's session timeout while its in-box agent is
  active — holding the death-time a rolling `autopause.idleMinutes` window ahead
  of now so a long agent run isn't killed mid-work; once idle the box stops being
  renewed and lapses ~one window later. The active case anchors on `now` (not the
  agent's `updatedAt`, which freezes during a long single `working` op). Bounded
  by the plan's max session (mainly benefits Pro+). Same mechanism on E2B. Uses
  `CloudBackend.renewTimeout` (vercel `extendTimeout`, e2b `setTimeout`).

## 3c. The E2B shape

E2B Sandbox is a Firecracker microVM on Debian 12 with `Sandbox.createSnapshot`
checkpoints and public `{port}-{sandboxId}.e2b.app` preview URLs. Full
build-out status lives in [`e2b_backlog.md`](./e2b_backlog.md); the shape in
brief:

- **Base via `Template.build()` from a Dockerfile — the key differentiator.**
  Unlike Daytona's published snapshot, Hetzner's `create_image` snapshot, or
  Vercel's `sb.snapshot()` (none of which accept a Dockerfile), E2B builds
  the base image **directly from a Dockerfile**. `agentbox prepare --provider
  e2b` drives the SDK's `Template.build()` using a TypeScript-described
  template that reuses the staged docker runtime assets (Claude / Codex /
  OpenCode, agentbox-ctl, the vscode user, VNC, tmux). The resulting
  `templateId:tag` is persisted to `~/.agentbox/e2b-prepared.json` and to
  `box.imageE2b`; every `create --provider e2b` boots from it in seconds.
- **In-box docker (DinD).** Contrary to the original "same as Vercel"
  assumption, E2B's microVM grants the capabilities a container runtime needs
  (full root + `cap_sys_admin` + working namespaces, verified 2026-06-23). The
  base template bakes the docker engine and the provider passes
  `launchDockerd: true`, so `dockerd` auto-launches on create/resume (same as
  daytona/hetzner/vercel). Pulled images carry across pause/resume.
- **Pause/resume is free.** `Sandbox.pause(id)` pauses; `Sandbox.connect(id)`
  auto-resumes lazily on the next op. The provider's `state()`/`get()` use
  the non-resuming `Sandbox.getInfo()` so existence checks don't wake (and
  bill) a paused sandbox. `previewUrl()` is also resume-free — it constructs
  the URL locally from `sandboxId + port + E2B_DOMAIN` rather than going
  through `Sandbox.connect`.
- **Preview URLs are public HTTPS.** `getHost(port)` returns
  `{port}-{sandboxId}.e2b.app` over HTTPS with no token (verified via plain
  `curl`). Like Daytona/Vercel, this reaches the host browser AND the in-box
  bridge, so the Portless in-box mirror is skipped. The WebProxy runs on
  port 8080. Optional `network: { allowPublicTraffic: false }` (not enabled
  by default) gates the URL behind an `e2b-traffic-access-token` header;
  Task 3 leaves it public to match Vercel.
- **No SSH → SDK-streaming PTY attach.** `buildAttach` spawns
  `attach-helper.cjs`, which `Sandbox.connect`s, opens a `pty.create({ cols,
  rows, onData })` stream, and bridges stdin / stdout / `SIGWINCH` to the
  host TTY. The helper caps `timeoutMs` at **55 minutes** to leave headroom
  under E2B's 1-hour platform session cap on Hobby. This caps only the live
  PTY connection — the **box lifetime** is held open independently by the
  `cloud-keepalive` loop (see §3, "Session keepalive") while the agent works,
  so after 55 min the attach drops but the box stays alive; just reattach.
- **Checkpoints are id-addressed (same shape as Vercel).** The provider
  overrides `checkpoint.create` to call `Sandbox.createSnapshot(sandboxId,
  { name })`, store the returned `snapshotId` in the cloud-checkpoint
  manifest's `snapshotName` field, and restore via `Sandbox.create({
  template: snapshotId })`. `createSnapshot` pauses the source while
  capturing; the next op auto-resumes it.
- **Hard platform limits:** template-level resources (vCPU / RAM baked at
  `Template.build()` time via `agentbox prepare --provider e2b --size
  <cpu-mem>`; E2B has no disk knob, and a per-create `--size` that differs
  from the baked size just logs a warning — E2B rejects per-create
  resources), 1-hour session cap on Hobby, max upload chunk constraints
  from the SDK (handled by the cloud scaffold). E2B itself runs in multiple
  regions; the SDK chooses one transparently.

## 3e. The remote-docker shape

`remote-docker` runs a box as a container on a machine the *user* supplies,
reached over SSH. It is the only provider whose "cloud" is not infrastructure we
provision — it is someone's workstation, Mac mini, or team server.

**Why it is a `CloudBackend` and not a second docker provider.** The docker
provider's load-bearing mechanism is the bind mount of the host's `.git/` into
the container at an identical absolute path: an in-box commit lands in the host
repo with no sync at all. A bind mount cannot cross a network, and everything
downstream of that assumption is equally local-only — the ctl unix socket on a
host path, `-p 127.0.0.1:0:<p>` publishing on the *laptop's* loopback,
`host.docker.internal` reaching the laptop's relay. Retargeting the docker
provider with `DOCKER_HOST=ssh://` would retarget the `docker` calls and none of
those assumptions; worse, the relay's git RPC would take the **docker** branch in
`host-actions.ts` and try to push from a `.git` that isn't there. The cloud
scaffold already solved every one of them, so the provider implements the ~14
`CloudBackend` primitives over `docker`-on-SSH and inherits `seedCloudWorkspace`,
the in-box relay + `CloudBoxPoller` bridge, git-push-by-bundle, carry, and
credential sync unchanged.

**Transport.** One OpenSSH ControlMaster per box (`@agentbox/sandbox-core`'s
`SshTunnelManager`, shared with hetzner/digitalocean), and every docker command
runs through one chokepoint: `ssh <dest> bash -lc 'docker …'`
(`src/remote-docker.ts`). Deliberately **not** `DOCKER_HOST=ssh://`:

  1. Docker's ssh transport runs `docker system dial-stdio` on the remote, which
     needs `docker` on the **non-login-shell** PATH — precisely where OrbStack
     (`~/.orbstack/bin`) and Colima break. A macOS remote is a supported case.
  2. It opens a fresh SSH connection per `docker` invocation; create issues dozens.

The trade is that docker's argv is composed into a shell string, so every
argument is quoted (`quoteShellArgv`) — nothing in the package may build a remote
command by concatenation.

**Addressing.** The SSH destination is encoded INTO the sandbox id:

    sandboxId = "<ssh-destination>/<container>"   e.g. "buildbox/agentbox-brave-otter"

The host relay resolves a backend from a bare `CloudHandle` with no access to
config or box state, so the handle must be self-describing. Multi-host support
then falls out for free, and a box keeps working after `box.remoteDockerHost`
changes. The CLI accepts a host-qualified provider spec (`docker:<host>`,
`apps/cli/src/provider/spec.ts`) anywhere a provider name is accepted; the bare
name is what keys config and lands on the record.

**Image.** The ref IS the build-context fingerprint: `agentbox/box:<sha16>`, the
same sha the local docker provider computes. So "is this host prepared?" is
answered by asking the engine (`docker image inspect`), not by trusting a local
file that could disagree with it — and it is answered **per host**, which a
single `~/.agentbox/remote-docker-prepared.json` could never be. Ensure order:
present → pull the fingerprint-tagged GHCR image (published multi-arch, so an
amd64 remote gets amd64 from an arm64 laptop) → stream the local build context to
`docker build -` on the remote. `prepare` is therefore **optional** (unlike the
VPS providers': a remote engine can build from a Dockerfile), and only records
history for `prepare --status` / `doctor`.

**Checkpoints.** `docker commit` on the engine. The snapshot name carries the
host, because `deleteSnapshot`/`snapshotExists` are handed nothing but that string
(no handle) and a docker ref admits neither `@` nor `:` outside the tag:

    "<ssh-destination>#<docker-image-ref>"   e.g. "dev@10.0.0.9:2222#agentbox-ckpt-9f2a_repo:setup"

A checkpoint is bound to the engine that made it. Booting it on another machine
reads as "snapshot gone", so the scaffold prunes the dangling manifest and builds
from base rather than failing.

**Box SSH (`open` / `code`).** The box's sshd is published on the *engine's*
loopback, so no local ssh can dial it directly. Rather than hold an `ssh -L`
forward open for the alias's lifetime, the generated `~/.agentbox/ssh/config`
block uses **`ProxyJump`**: ssh hops through the engine, which dials
`127.0.0.1:<published>` itself. That is plain OpenSSH, so VS Code Remote-SSH and
sshfs work with no tunnel for AgentBox to keep alive. The published port is
ephemeral and is re-resolved on every start. This is what `Provider.sshTarget`
exists for: a provider that knows its own SSH target says so, instead of having it
reverse-engineered from the `buildAttach` argv (an inference that only holds when
the box IS the machine).

**Nested engines.** When the engine is itself an AgentBox box (the
agentbox-in-agentbox dev loop), its dockerd has no `CAP_SYS_PTRACE` and cannot
bind-mount `/proc/<pid>/ns/net` for a container init running as a different uid
than the daemon. The provider detects this by asking the *engine*
(`test -f /etc/agentbox/box.env`) — not by reading its own `AGENTBOX=1`, which
would be the wrong signal, since the CLI can run in a box while the engine sits on
a real machine — and forces the box init to uid 0.

**No credential.** There is nothing in `secrets.env`: the provider authenticates
as the user, through their own `~/.ssh/config`, agent and `known_hosts`. Its
`providerModule` deliberately omits `ensureCredentials` / `readCredStatus`, so the
CLI and hub show no login row. `agentbox remote-docker check|use|hosts` replace it.

**Known limits.** Published ports are fixed at `docker run` (same constraint as
Vercel): a service added to `agentbox.yaml` after create is reachable through the
WebProxy but gets no direct preview URL until the box is recreated. Concurrent
boxes share the machine with no arbitration beyond `--size`. The engine is
trusted — this is a "your own machine" provider, not an isolation boundary
against that machine's owner.

## 4. Authentication

`agentbox daytona login` is the supported path. There is **no browser sign-in** —
it offers to open the dashboard's keys page for convenience, then prompts you to
paste a **`DAYTONA_API_KEY`**, and persists it to `~/.agentbox/secrets.env`.
`DAYTONA_ORGANIZATION_ID` is asked for **only** when the pasted value is a JWT
(it starts with `eyJ`), and there it's required — an API key doesn't need one,
since the SDK derives the org from the key. Subsequent runs read that file;
project `.env` is never harvested. First-time use of `--provider daytona`
triggers the login prompt automatically.

`agentbox hetzner login` is the analogous command for Hetzner. It
prompts for `HCLOUD_TOKEN` (Read+Write API token from a Hetzner project's
Security → API Tokens page), validates it via `GET /locations`, and
persists it to the same `~/.agentbox/secrets.env`. First-time use of
`--provider hetzner` triggers the login prompt automatically.

`agentbox vercel login` is the Vercel equivalent. Two auth modes: an **access
token** trio (`VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`) persisted
to `~/.agentbox/secrets.env`, or the **OIDC** path (`vercel link && vercel env
pull` mints a `VERCEL_OIDC_TOKEN`; export it in your shell or add it to
`~/.agentbox/secrets.env`). Like daytona/hetzner, agentbox reads credentials
**only** from the shell env or `~/.agentbox/secrets.env` — project-local `.env` /
`.env.local` are never harvested. First-time use of `--provider vercel` triggers
the prompt automatically.

**Which to use:** OIDC is the quickest for short-lived interactive work, but the
dev token expires on a ~12h cycle and `resolveCredentials` has **no headless
auto-refresh** (a CLI-backed refresh needs an interactive `vercel` session). So
for any long-running operation — most importantly `agentbox prepare --provider
vercel`, whose base-snapshot bake can outlive a token — use the **access-token
trio**: it doesn't expire on the 12h cycle and is the practical path for
`prepare`, CI, and other headless/long jobs. Mint a token at
`https://vercel.com/account/settings/tokens`; the team id is in the team's
General settings and the project id in the project's General settings.

`agentbox e2b login` is the E2B equivalent. It prompts for `E2B_API_KEY`
(required; mint at `https://e2b.dev/dashboard?tab=keys`) and persists it to
`~/.agentbox/secrets.env`. Like the other clouds, agentbox reads the key
**only** from the shell env or `~/.agentbox/secrets.env` — project-local
`.env`/`.env.local` are never harvested. First-time use of `--provider e2b`
triggers the login prompt automatically.

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

Compose the full `Provider` with `createCloudProvider(backend)` and export a
`providerModule` (see `packages/sandbox-core/src/doctor.ts`).

Two ways to ship it:

- **Built-in** (first-party): add one row to the `PROVIDERS` table in
  `packages/config/src/providers.ts` and one entry to the `IMPORTERS` map in
  `apps/cli/src/provider/loaders.ts` (both bundle-inlined), plus the relay's
  literal-import block in `resolveCloudBackend`
  (`packages/relay/src/host-actions.ts`).
- **External / community plugin**: publish `agentbox-provider-<name>` built on
  `@madarco/agentbox-provider-sdk` and `agentbox plugin add` it — **no edits to AgentBox**.
  This is the recommended path for third-party clouds. See
  [`provider-plugins.md`](./provider-plugins.md).

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
| Vercel SDK shim | `packages/sandbox-vercel/src/backend.ts` |
| Hetzner SDK shim | `packages/sandbox-hetzner/src/backend.ts` |
| E2B SDK shim | `packages/sandbox-e2b/src/backend.ts` |
| Workspace seeding (bundle + carry-over) | `packages/sandbox-cloud/src/workspace-seed.ts` |
| Agent credential volumes | `packages/sandbox-cloud/src/agent-credentials.ts` |
| Cloud cp / download | `packages/sandbox-cloud/src/cloud-cp.ts` |
| Per-service preview URLs | `packages/sandbox-cloud/src/expose-ports.ts` |
| Host action executor | `packages/relay/src/host-actions.ts` |
| Cloud poller | `packages/relay/src/cloud-poller.ts` |
| Retry / 504 backoff | `packages/sandbox-daytona/src/retry.ts`, `cloud-poller.ts` fast-mode |
| Per-provider default checkpoint | `packages/config/src/checkpoint.ts` |
| Orphan prune | `apps/cli/src/commands/prune.ts` `--provider <daytona\|vercel\|e2b>` |
| SSH alias management | `apps/cli/src/ssh-config.ts` |
| Cloud E2E test | `apps/cli/test/cloud-e2e.test.ts` (gated on `DAYTONA_API_KEY`) |

Track outstanding work in
[`daytona-backlog.md`](./daytona-backlog.md),
[`hertzner_backlog.md`](./hertzner_backlog.md),
[`vercel-backlog.md`](./vercel-backlog.md), and
[`e2b_backlog.md`](./e2b_backlog.md).
