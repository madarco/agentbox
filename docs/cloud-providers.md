# Cloud providers

> _Status: v1 ships with Daytona. The provider abstraction is generic — adding another cloud is ~150 lines (see §6)._

AgentBox runs on two backends today, behind a single `Provider` interface
(`packages/core/src/provider.ts`):

| Provider | Where the box lives | When to use it |
| --- | --- | --- |
| `docker` (default) | Local Docker container | Fast, free, owns the host. Good default. |
| `daytona` | Daytona Cloud sandbox | When the workload outgrows the laptop, when teammates need to attach, when you want a snapshot-ready remote env. |

Switch backends per box: `agentbox create --provider daytona` (or pin
project-wide via `box.provider: daytona` in `agentbox.yaml`). The rest of
the CLI surface (`shell`, `claude`, `url`, `cp`, `checkpoint`, …) routes
on `box.provider` and Just Works for both.

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
credential sync, VNC daemon launch, signed preview URLs, snapshot
manifests, and (eventually) per-service preview URLs. The `CloudBackend`
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

### 2.2 Per-agent credential volumes

Daytona volumes (`agentbox-claude-config`, `agentbox-codex-config`,
`agentbox-opencode-config`) are mounted at provision time and seeded once
per org from the host's `~/.claude`, `~/.codex`, `~/.config/opencode`.
Subsequent boxes find the `.agentbox-seeded-at` marker and skip the
upload. Refresh is explicit via `agentbox daytona resync [--agent ...]`.

Key wrinkles around Daytona's FUSE-mounted volumes:

- `chmod` / `chown` / `utime` all EPERM. We pass
  `--no-same-permissions --no-same-owner -m` to every `tar -xzf` that
  lands inside a volume mount.
- `rename(2)` returns ENOSYS. We use `cp -f` + `rm -f` instead.
- `symlink(2)` returns EPERM. Host-side staging uses `rsync -L` to
  dereference symlinks before tar.
- macOS `bsdtar` emits `._<name>` AppleDouble sidecars unless
  `COPYFILE_DISABLE=1` is set on the tar exec. We set it everywhere.

### 2.3 Comms: the bridge relay

Cloud boxes ship the same `@agentbox/relay` binary as docker, but in
**box mode**. Inside the sandbox the relay binds `0.0.0.0:8787`; Daytona
mints a signed preview URL pointing at that port, which the host's
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

## 3. Authentication

`agentbox daytona login` is the supported path. It prompts for
`DAYTONA_API_KEY` (required) and `DAYTONA_ORGANIZATION_ID` (optional)
and persists them to `~/.agentbox/secrets.env`. Subsequent runs read
that file; project `.env` is never harvested. First-time use of
`--provider daytona` triggers the login prompt automatically.

## 4. Known caveats

- **First-run Dockerfile.box build** takes ~7 min on Daytona because
  it includes Playwright + Chromium. Cached snapshot reuse is seconds.
  Future: ship a public snapshot to skip the cold build. Tracked as
  backlog 5.1.
- **No DinD in cloud yet.** The Daytona PoC validated dockerd works
  inside a sandbox, but our cloud provider doesn't launch it. Users
  can `dockerd &` manually; we don't drive it. Backlog 5.2.
- **Live stats** (`agentbox top` CPU/mem) aren't surfaced for cloud —
  Daytona's SDK doesn't expose per-sandbox metrics. We render `—` for
  every metric.
- **Daytona dashboard lag**: `sb.delete()` returns immediately but the
  UI lags ~30s. Cosmetic. (6.2)
- **`download.env|config|claude`** for cloud isn't implemented — those
  source paths live in per-agent volumes that need a separate route.
  `download.workspace` works.

## 5. CLI surface reference (cloud-routed)

Every command below honors `box.provider` automatically. Pass
`--provider <name>` on `create` / `claude` / `codex` / `opencode` to
override per invocation.

| Command | Cloud path |
| --- | --- |
| `create` | `provider.create` (workspace seed + ctl + VNC + agent volumes). |
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

## 6. Adding a new cloud backend

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

## 7. Where each cloud piece actually lives

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
