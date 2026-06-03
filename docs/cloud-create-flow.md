# `agentbox create --provider daytona` — cloud create flow

Companion to [`cloud-providers.md`](./cloud-providers.md) (the abstraction +
caveats) and [`create-and-checkpoints.md`](./create-and-checkpoints.md) (the
docker equivalent). This doc walks the cloud `create` end-to-end: every step
that runs on the host, every step that runs inside the Daytona sandbox, how
`.git` and workspace files land inside the box, and what changes between the
first box you ever create and the next one. Source of truth:
`packages/sandbox-cloud/src/cloud-provider.ts`,
`packages/sandbox-cloud/src/workspace-seed.ts`,
`packages/sandbox-cloud/src/agent-credentials.ts`,
`packages/sandbox-daytona/src/backend.ts`.

> **Hetzner / Vercel / E2B follow the same flow.** The steps below
> (mint-identity → reserve volumes → provision → workspace seed → credential
> seed → env-upload → ctl/dockerd/VNC launch → preview URLs → relay register
> → BoxRecord persist) are provider-agnostic; only the `provision` step
> differs (Daytona snapshot vs. Hetzner snapshot vs. Vercel snapshot vs. E2B
> custom template baked from a Dockerfile via `Template.build()`).
> `agentbox prepare --provider e2b` is the one E2B-specific prerequisite,
> and `box.imageE2b` pins the resulting template id — see
> [`e2b_backlog.md`](./e2b_backlog.md). The `launchDockerd` step is skipped
> for Vercel and E2B (Firecracker microVMs can't run nested containers).

## The flow (per box)

Routed through `daytonaProvider` → `createCloudProvider(daytonaBackend)`
(`packages/sandbox-cloud/src/cloud-provider.ts:142`):

1. **Mint identity** — `id`, `name`, branch `agentbox/<name>`, and two per-box
   bearer tokens (`relayToken` for the in-box agent, `bridgeToken` for the
   host poller). Bring up the host relay (`ensureRelay`).
2. **Reserve agent credential volumes** — `ensureAgentVolumesForCloud` calls
   `backend.ensureVolume()` for `agentbox-claude-config`,
   `agentbox-codex-config`, `agentbox-opencode-config`. These are
   **org-scoped** in Daytona, so they exist once per org and get reused by
   every future box.
3. **Provision the sandbox** —
   `backend.provision({ image | snapshot, volumes, env, resources })`.
   `image` is either:
   - a published snapshot name (`agentbox prepare --provider daytona` bakes the
     Dockerfile.box once, ~7 min, and lets every future create skip the build
     → seconds), or
   - `agentbox/box:dev` (`FALLBACK_IMAGE`) → translated by `resolveImage()` to
     `Image.fromDockerfile(...)`, which uploads the build context and triggers
     Daytona's cold build (the slow path).
4. **Seed `/workspace`** — `seedCloudWorkspace`
   (`packages/sandbox-cloud/src/workspace-seed.ts`). Skipped entirely if you
   booted from a checkpoint snapshot — the snapshot already carries
   `/workspace`.
5. **Seed credentials volume if fresh** — `seedAgentVolumesIfFresh` checks
   the shared `agentbox-credentials` volume's per-agent subpath for
   `.agentbox-seeded-at`; if missing, tar + upload **only the auth-token
   files** (`.credentials.json` for claude, `auth.json` for codex/opencode)
   and drop the marker. Tiny payload (~KBs), seconds to extract. The bulk
   *static config* (plugins / skills / marketplaces / settings) is **not**
   shipped here — it's baked into the snapshot at `prepare --provider daytona` time
   (see [Snapshot bake](#snapshot-bake)).
6. **Upload env/config files** (`uploadEnvFiles`) — the `.env`/`secrets.toml`/
   etc. the setup wizard collected.
7. **Launch `agentbox-ctl`** (`launchCloudCtlDaemon`), **in-box dockerd**
   (`launchCloudDockerdDaemon`, best-effort — mirrors the docker provider's
   always-on dockerd), and **VNC stack** (`launchCloudVncDaemon`, best-effort).
8. **Mint preview URLs** — webproxy (8080), per-`expose.port` service URLs
   from `agentbox.yaml`, and the **bridge URL on 8788** so the host's
   `CloudBoxPoller` can reach the in-box relay.
9. **Register with host relay** (`registerBoxWithRelay`) → spawns the
   `CloudBoxPoller` for this box.
10. **Persist `BoxRecord`** (`recordBox`). On any failure:
    `backend.destroy(handle)` to avoid a paid orphan.

## How `.git` and workspace files get in

All implemented in `packages/sandbox-cloud/src/workspace-seed.ts`. For a git
workspace, **per repo** (root + any 1st-level nested repos):

1. On host: `git stash create` → SHA of a one-off commit holding staged +
   tracked-modified changes (without disturbing your worktree).
2. Park that SHA under `refs/agentbox-carryover/stash` (a temp host-side ref)
   so the clone can fetch it.
3. `git clone --no-checkout [--depth=N] file://<hostRepo> <stage>/clone` —
   a shallow clone (default cap 200; adaptive: redo at 100 if the resulting
   tar exceeds 20 MB). `--no-checkout` skips materializing the host-side
   working tree (we'd just discard it); the in-box `git checkout` does that
   later. Cap controlled by `box.bundleDepth` (`--bundle-depth <n>` flag, or
   `agentbox config set box.bundleDepth N`): unset → adaptive; `N > 0` →
   fixed shallow depth; `0` → no `--depth` (full history). Cloud-only —
   docker bind-mounts `.git/`.
   Note: `git bundle create` has no `--depth` flag in any git version
   (`--depth` only exists on clone/fetch). The shallow-clone-then-tar dance
   is the portable way to cap commit count.
4. `git -C <stage>/clone fetch [--depth=N] file://<hostRepo>
   +refs/agentbox-carryover/stash:refs/remotes/origin/agentbox-carryover/stash`
   — pulls the carryover ref into the shallow clone.
5. `tar -C <stage>/clone -czf <stage>/workspace.tar.gz .` — tars `.git/`
   (the only thing in the clone dir after `--no-checkout`).
6. `git ls-files --others --exclude-standard -z` + `tar -czf untracked.tar.gz`
   → captures untracked-not-ignored files (stash create doesn't).
7. Delete the temp host ref.
8. `backend.uploadFile` ships `workspace.tar.gz` (and `untracked.tar.gz` if
   non-empty) to `/tmp/` in the sandbox.
9. Inside the sandbox (run as one `bash -c` script):
   - `cd /tmp` (avoid stale-cwd FD when we wipe `/workspace`)
   - `sudo rm -rf /workspace && mkdir -p /workspace && chown ...`
   - `tar -C /workspace -xzf /tmp/agentbox-workspace.tar.gz` — **this is how
     `.git` lands in the box** (extracted from the shallow clone's `.git/`)
   - `git remote set-url origin <host's origin>` — repoint from the `file://`
     placeholder to the real upstream so `git push` later works (it gets
     tunneled back through the host relay)
   - `git checkout -B agentbox/<box-name>` — materializes the working tree
     from HEAD (the clone was `--no-checkout`)
   - `git stash apply refs/remotes/origin/agentbox-carryover/stash`
     (best-effort; soft-fails on shallow-clone merge conflicts)
   - `tar -xzf /tmp/agentbox-carryover-untracked.tar.gz` into `/workspace`
   - clean up tars

If the host workspace **isn't** a git repo, `seedFromTar` just `tar -czf .`
the whole dir, uploads, extracts. No clone, no branch.

## First time vs. next time

| | First time | Subsequent boxes |
|---|---|---|
| **Box image build** | ~7 min Dockerfile.box build on Daytona | Reuses the snapshot (built once or via `agentbox prepare --provider daytona`) — seconds |
| **Agent static config** (plugins/skills/marketplaces/settings) | Already baked into the snapshot — no per-create work | Same — baked once at `prepare --provider daytona` |
| **Agent credentials volume** (`.credentials.json` / `auth.json`) | Tar + upload + extract (~KBs, seconds) | Marker present → skipped; the volume mount carries the tokens forward |
| **Workspace bundle** | Always built + uploaded + cloned (per box — each gets a fresh `/workspace` on a fresh branch) | Same — every box reseeds |
| **Per-agent SSH keys / Daytona auth** | `agentbox daytona login` prompts and writes `~/.agentbox/secrets.env` | Read from `secrets.env` silently |
| **Host relay** | `ensureRelay` boots the relay daemon | Already running — no-op |

The "cold once, warm forever" optimizations are the **published snapshot**
(which now bundles the Dockerfile build *and* all agent static config) and the
**credentials volume** (which keeps the token files alive across boxes so
re-auth doesn't need a snapshot re-publish). Workspace bundle is a per-box
cost by design — each box needs its own isolated `/workspace` on its own
branch.

<a id="snapshot-bake"></a>
### Snapshot bake (the way static config lands in the box)

`agentbox prepare --provider daytona` (`packages/sandbox-daytona/src/prepare.ts`)
calls the documented Daytona snapshot API — no sandbox is provisioned. The
whole build + register happens server-side in one operation:

1. Host-side: stage filtered tarballs of `~/.claude` (minus `.credentials.json`),
   `~/.codex` (minus `auth.json`), and opencode `data/` + `config/` (minus
   `auth.json`). See `stage{Claude,Codex,Opencode}StaticForUpload` in
   `packages/sandbox-docker/src/host-stage.ts`.
2. Build an `Image` fluently:

   ```ts
   const image = Image.fromDockerfile(Dockerfile.box)
     .addLocalFile(claudeTar,   '/tmp/agentbox-seed-claude.tar.gz')
     .addLocalFile(codexTar,    '/tmp/agentbox-seed-codex.tar.gz')
     .addLocalFile(opencodeTar, '/tmp/agentbox-seed-opencode.tar.gz')
     .runCommands(
       'mkdir -p /home/vscode/.claude /home/vscode/.codex /home/vscode/.local/share/opencode',
       'tar -xzf /tmp/agentbox-seed-claude.tar.gz   -C /home/vscode/.claude',
       'tar -xzf /tmp/agentbox-seed-codex.tar.gz    -C /home/vscode/.codex',
       'tar -xzf /tmp/agentbox-seed-opencode.tar.gz -C /home/vscode/.local/share/opencode',
       'chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.local',
       'rm -f /tmp/agentbox-seed-*.tar.gz',
     );
   ```
3. `daytona.snapshot.create({ name, image })` — Daytona uploads the layered
   build context to object storage, builds the image, and registers the
   result as an org-scoped named snapshot. Returns when the snapshot is
   `active`.
4. The `prepare` CLI command pins `box.image: <name>` into the project
   config so subsequent `agentbox create --provider daytona` boots from it.

Replaces the old `agentbox daytona publish-snapshot`, which used the
broken `sandbox._experimental_createSnapshot` API
(`POST /api/sandbox/<id>/snapshot` now 404s on Daytona's side). See
https://www.daytona.io/docs/en/snapshots/ for the documented API.

The resulting snapshot carries plugins/skills/marketplaces/settings pre-
populated. Every subsequent `agentbox create --provider daytona` boots from
this snapshot and skips the static seed entirely.

Run `agentbox prepare` (no args) at any point to print the current inventory:
docker's `agentbox/box:dev` image, the three shared docker volumes, and on
the Daytona side all `agentbox*` snapshots (state / size / age / `(pinned)`
marker) and `agentbox*` volumes — handy for spotting orphaned legacy volumes
and confirming the snapshot pinned in the project config still exists.

### Credentials symlinks (the way the per-create credentials volume reaches the agent)

The Dockerfile bakes three symlinks at the agent-expected credential paths:

```
~/.claude/.credentials.json            -> /home/vscode/.agentbox-creds/claude/.credentials.json
~/.codex/auth.json                     -> /home/vscode/.agentbox-creds/codex/auth.json
~/.local/share/opencode/auth.json      -> /home/vscode/.agentbox-creds/opencode/auth.json
```

At runtime, `agentbox-credentials` (a single per-org Daytona volume) is
mounted three times via `subpath` (`claude/`, `codex/`, `opencode/`) under
`/home/vscode/.agentbox-creds/`. The dangling symlinks resolve through to
the mounted credential files. `agentbox daytona resync` re-uploads into the
same volume after a host re-auth — no snapshot republish needed.

If you want to skip even the workspace seed, use
`agentbox create --provider daytona --checkpoint <name>`: the snapshot already
carries `/workspace`, and step 4 is skipped
(`cloud-provider.ts:218`).

## Cloud checkpoints

Cloud checkpoints work in three layers: a Daytona-native snapshot primitive,
the cloud-provider capability that wraps it, and the CLI command that drives
the workflow.

### 1. Daytona primitive

`daytonaBackend.createSnapshot(handle, snapshotName)` (`packages/sandbox-daytona/src/backend.ts:470`)
calls `sb._experimental_createSnapshot(snapshotName)`. Daytona puts the
sandbox into the `snapshotting` state, freezes its filesystem (including any
warmed agent volumes + the seeded `/workspace`), and registers an
**org-scoped** named snapshot. 15-min timeout, no retry on ambiguous
failures — a 504 mid-snapshot could leave a half-built name a retry would
collide on.

The sandbox must be **running** to snapshot, so the CLI command resumes/starts
paused or stopped boxes first (`apps/cli/src/commands/checkpoint.ts:320`).

The peer `deleteSnapshot(name)` is idempotent (already-gone counts as
success).

### 2. Provider capability: bind a snapshot to a project-scoped checkpoint name

Each user-facing checkpoint maps to **two** records:

**A. Org-wide Daytona snapshot**, named deterministically by `cloudSnapshotName`
(`packages/sandbox-cloud/src/checkpoint.ts:61`):

```
agentbox-ckpt-<hash(projectRoot)>_<mnemonic(basename)>-<userName>
```

The project-hash prefix prevents collisions across projects and across users
in the same Daytona org. The `agentbox-ckpt-` prefix makes orphans
recognisable in the dashboard.

**B. Local host manifest** at:

```
~/.agentbox/cloud-checkpoints/<backend>/<projectHash-mnemonic>/<name>/manifest.json
```

A thin JSON pointer from the user-facing project-scoped name (e.g. `setup`)
to the unique Daytona snapshot name + source box metadata. This is how
`agentbox checkpoint ls` works without round-tripping the cloud.

`makeCloudCheckpoint(backend)` (`cloud-provider.ts:707`) wires it up:

- `create(box, name)` → `backend.createSnapshot(...)` then
  `writeCloudCheckpointManifest(...)`.
- `list(projectRoot)` → reads the manifest dir.
- `remove(projectRoot, ref)` → `backend.deleteSnapshot(...)` (best-effort)
  then **unconditionally** removes the local manifest, so a remote-only
  failure doesn't strand a dead pointer.

### 3. CLI surface

`agentbox checkpoint create [--name X] [--set-default]` for cloud boxes
routes to `runCloudCheckpointCreate` (`apps/cli/src/commands/checkpoint.ts:308`):

1. Resolve `projectRoot`; default name is `<box-name>-<last6 of ts>`.
2. Probe state → resume/start if paused/stopped (snapshot needs the sandbox
   running).
3. Post a relay notice (`CHECKPOINT_NOTICE`) so attached `claude`/`codex`
   sessions see a banner that the box is freezing.
4. `provider.checkpoint.create(box, name)` → snapshot + manifest.
5. If `--set-default`, write `box.defaultCheckpointDaytona` (or whatever
   `defaultCheckpointConfigKey(provider)` returns) to project config —
   separate per-provider keys so docker creates in the same project don't
   pick up a snapshot they can't resolve.
6. Clear the relay notice in `finally`.

Differences from the docker path:

- **No `--merged`** — Daytona snapshots are flattened by construction
  (warned + ignored).
- **No `--replace`** — Daytona snapshot deletes are async on their side, so
  re-creation can race the delete; the workflow is explicit
  `agentbox checkpoint rm <name>` then re-create.

### 4. Booting from a checkpoint

`agentbox create --provider daytona --checkpoint <name>` (or `--checkpoint`
set as the default via `box.defaultCheckpointDaytona`):

In `cloud-provider.ts:171`, before provision:

```ts
const found = await resolveCloudCheckpoint(req.projectRoot, backend.name, req.checkpointRef);
if (found) snapshotName = found.manifest.snapshotName;
```

Then `backend.provision({ snapshot: snapshotName, … })` instead of
`{ image }`. The Daytona SDK takes the `CreateSandboxFromSnapshotParams`
overload (`backend.ts:193`) — no Dockerfile build, no
`onSnapshotCreateLogs`, just rehydrate the named snapshot in seconds. The
workspace-seed step is **skipped** because the snapshot already contains
`/workspace`; reseeding would clobber whatever setup state you captured.

If you pass a checkpoint name that doesn't have a manifest for the cloud
backend, it's logged and dropped (you might have a docker checkpoint with
the same name; that's not our store) and create falls back to the base
image.

### 5. The in-box `agentbox checkpoint` path

An agent inside the box can call `agentbox checkpoint create` over the
relay; the host-side handler (`packages/relay/src/host-actions.ts:117`)
doesn't re-implement the snapshot — it just shells out to the host CLI's
`checkpoint create <boxId>`, which routes back through
`provider.checkpoint.create`. Same decoupling as the docker handler.
Requires `AGENTBOX_CLI_ENTRY` to be set in the relay env (it is, when
`ensureRelay` starts it).

## Two snapshot tiers: base vs project

AgentBox actually maintains **two distinct snapshot tiers** in Daytona, used
for different purposes and reached through different mechanisms. They are
**not** unified under one "snapshot" concept.

| | Base / "image" snapshot | Project / "setup" snapshot |
|---|---|---|
| **What it captures** | Just the Dockerfile.box runtime (Node, Playwright, Chromium, agent CLIs, ctl, VNC stack). **No `/workspace`.** | Everything in the box at capture time, **including `/workspace`** (installed deps, generated files, dev DB seed, etc.) |
| **Scope** | Org-wide; **shared across all projects** | Org-wide registry but **prefixed by project hash** (`agentbox-ckpt-<hash>_<mn>-<name>`) so two projects can't collide |
| **Created by** | `agentbox daytona prepare --provider daytona [--name X]` (one-off, manual; rebuilds ~7 min) | `agentbox checkpoint create [--name X] [--set-default]` (per-box, anytime) |
| **Stored as** | Daytona snapshot `agentbox-box-prebuilt-<ts>` (or whatever `--name` you pass) | Daytona snapshot `agentbox-ckpt-<projectHash>_<mn>-<name>` + host manifest |
| **Consumed via config** | `box.image: <name>` (project or user config) | `box.defaultCheckpointDaytona: <name>` (or per-box `--checkpoint <name>`) |
| **Daytona SDK call** | `client.create({ image: "<name>", … })` | `client.create({ snapshot: "<name>", … })` |
| **What still runs on create** | Workspace seed (git bundle + clone), agent-volume seed if first time | **Workspace seed is SKIPPED** (`cloud-provider.ts:218`); agent volumes still mounted |

### How they compose

```
Dockerfile.box  --(prepare --provider daytona)-->  base snapshot      (one-off, org-wide)
                                                │
                                                ▼ box.image
                       agentbox create  --(provision + seed /workspace)-->  fresh box
                                                │
                                       run setup wizard / installs / migrations
                                                │
                                                ▼
                       checkpoint create --set-default  -->  project setup snapshot   (per-project)
                                                │
                                                ▼ box.defaultCheckpointDaytona
                       agentbox create  --(provision, /workspace already there)-->  warm box
```

- Without the **base snapshot**: every first-box-per-project pays the ~7-min
  Dockerfile build (Daytona's internal layer cache helps for *unchanged*
  build contexts, but there's no AgentBox-side guarantee).
- Without the **project setup snapshot**: every box re-runs whatever the
  setup wizard did (`pnpm install`, `prisma generate`, populating a dev DB,
  etc.).
- With both: cold create ≈ seconds, and `/workspace` is already at the state
  you snapshotted.

### Naming convention that keeps them disjoint

- Base: `agentbox-box-prebuilt-*` (no project hash — they're meant to be
  shared).
- Project: `agentbox-ckpt-<hash>_<mnemonic>-<name>` (project hash baked in,
  so two projects in the same Daytona org can both have a `setup` checkpoint
  without colliding).

Both prefixes are deliberately recognisable in the Daytona dashboard so you
can hand-clean orphans if needed.

## Base-snapshot bootstrap: docker vs daytona asymmetry

This is the one place the docker and daytona providers behave **differently
by default** for new users, and it's worth knowing.

### Docker: auto-built on first `agentbox create`

`ensureImage(ref)` (`packages/sandbox-docker/src/image.ts:90`) is called at
the top of every box-creating command (create, claude, codex, opencode). It
checks `imageExists(ref)` and, if missing, runs `buildImage(...)` against
the bundled `Dockerfile.box`. That builds + tags `agentbox/box:dev` in the
local Docker daemon. Subsequent creates short-circuit on `imageExists` and
reuse the cached image. The user is never told to do anything — first
create just takes longer.

### Daytona: **NOT** auto-built — explicit `prepare --provider daytona` required

On a fresh `--provider daytona` install with no `box.image` set:

1. `req.image` is undefined → falls back to `FALLBACK_IMAGE = 'agentbox/box:dev'`
   (`cloud-provider.ts:145`).
2. `daytonaBackend.provision({ image: 'agentbox/box:dev', … })` →
   `resolveImage('agentbox/box:dev')` (`backend.ts:144`) returns
   `Image.fromDockerfile(ctx.dockerfile)`.
3. Daytona builds the Dockerfile.box from scratch → **~7 min cold build,
   every time** a fresh sandbox is provisioned without a base snapshot.

Daytona's control plane does its own internal layer caching keyed by build
context, so repeated cold builds for the *exact same* Dockerfile in the
*same org* tend to be faster than 7 min in practice — but there's no
AgentBox-side guarantee, and any tweak to the build context invalidates it.

To opt into the base snapshot, two manual steps performed once per org:

```bash
agentbox daytona prepare --provider daytona --name agentbox-box   # ~7 min, one-off
agentbox config set --user box.image agentbox-box       # or --project
```

After that, every `agentbox create --provider daytona` provisions from the
named snapshot in seconds.

### Why daytona doesn't auto-publish on first create (today)

A few constraints that make auto-publish a worse default than docker's:

- Publishing **provisions a real sandbox** for the duration of the build →
  costs sandbox slot + compute on the user's Daytona org. Doing it
  implicitly on every `agentbox daytona login` (or first create) would
  surprise users who only wanted to provision one box.
- Snapshots are **org-scoped**, not user-scoped. The first person to publish
  picks the canonical name everyone in the org shares; that's a
  coordination choice, not a per-user default.
- There's no AgentBox-hosted "public" snapshot under an Anthropic-owned
  Daytona org we could ship as a default `box.image`. That's the natural
  next step but isn't built — would need an Anthropic-managed publishing
  pipeline + cross-org snapshot access in Daytona.

A worthwhile UX improvement (not yet built): after the first Dockerfile
build, hint `agentbox prepare --provider daytona` in the success log so users
discover it before paying the cold cost twice.
