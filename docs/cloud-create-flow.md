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
   - a published snapshot name (`agentbox daytona publish-snapshot` bakes the
     Dockerfile.box once, ~7 min, and lets every future create skip the build
     → seconds), or
   - `agentbox/box:dev` (`FALLBACK_IMAGE`) → translated by `resolveImage()` to
     `Image.fromDockerfile(...)`, which uploads the build context and triggers
     Daytona's cold build (the slow path).
4. **Seed `/workspace`** — `seedCloudWorkspace`
   (`packages/sandbox-cloud/src/workspace-seed.ts`). Skipped entirely if you
   booted from a checkpoint snapshot — the snapshot already carries
   `/workspace`.
5. **Seed agent volumes if fresh** — `seedAgentVolumesIfFresh` checks each
   volume for `.agentbox-seeded-at`; if missing, tar + upload from host
   `~/.claude`/`~/.codex`/`~/.config/opencode` and drop the marker. **First
   box per org pays this cost; every subsequent box skips it.**
6. **Upload env/config files** (`uploadEnvFiles`) — the `.env`/`secrets.toml`/
   etc. the setup wizard collected.
7. **Launch `agentbox-ctl`** (`launchCloudCtlDaemon`) and **VNC stack**
   (`launchCloudVncDaemon`, best-effort).
8. **Mint preview URLs** — webproxy (8080), per-`expose.port` service URLs
   from `agentbox.yaml`, and the **bridge URL on 8787** so the host's
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
2. Park that SHA under `refs/agentbox-carryover/stash` so the bundle includes
   it.
3. `git bundle create workspace.bundle --all <stash-ref>` (or `--depth=N` if
   `AGENTBOX_BUNDLE_DEPTH` is set, for monorepos with huge history).
4. `git ls-files --others --exclude-standard -z` + `tar -czf untracked.tar.gz`
   → captures untracked-not-ignored files (`git stash create` doesn't).
5. Delete the temp ref on host.
6. `backend.uploadFile` ships `workspace.bundle` (and `untracked.tar.gz` if
   non-empty) to `/tmp/` in the sandbox.
7. Inside the sandbox (run as one `bash -c` script):
   - `cd /tmp` (avoid stale-cwd FD when we wipe `/workspace`)
   - `sudo rm -rf /workspace && mkdir -p /workspace && chown ...`
   - `git clone /tmp/agentbox-workspace.bundle /workspace` — **this is how
     `.git` lands in the box** (a real clone from the bundle, not a copy)
   - `git remote set-url origin <host's origin>` — repoint to the real
     upstream so `git push/fetch` later work (they get tunneled back through
     the host relay)
   - `git fetch bundle '+refs/heads/*:refs/remotes/bundle/*'` so all branches
     are visible
   - `git checkout -B agentbox/<box-name>`
   - `git stash apply refs/remotes/origin/agentbox-carryover/stash`
     (best-effort; soft-fails on shallow-clone merge conflicts)
   - `tar -xzf /tmp/agentbox-carryover-untracked.tar.gz` into `/workspace`
   - clean up bundle + tar

If the host workspace **isn't** a git repo, `seedFromTar` just `tar -czf .`
the whole dir, uploads, extracts. No bundle, no branch.

## First time vs. next time

| | First time | Subsequent boxes |
|---|---|---|
| **Box image build** | ~7 min Dockerfile.box build on Daytona | Reuses the snapshot (built once or via `agentbox daytona publish-snapshot`) — seconds |
| **Agent credential volumes** | Created + tarred + uploaded from host (`.claude`, `.codex`, `.config/opencode`); marker written | Volumes already exist (org-scoped), marker present → skipped entirely |
| **Workspace bundle** | Always built + uploaded + cloned (per box — each gets a fresh `/workspace` on a fresh branch) | Same — every box reseeds |
| **Per-agent SSH keys / Daytona auth** | `agentbox daytona login` prompts and writes `~/.agentbox/secrets.env` | Read from `secrets.env` silently |
| **Host relay** | `ensureRelay` boots the relay daemon | Already running — no-op |

The two "cold once, warm forever" optimizations are the **published snapshot**
(cuts the Dockerfile build) and the **agent credential volumes** (cuts the
credential upload). The workspace bundle, by contrast, is a per-box cost by
design — each box needs its own isolated `/workspace` on its own branch.

If you want to skip even the workspace seed, use
`agentbox create --provider daytona --checkpoint <name>`: the snapshot already
carries `/workspace`, and step 4 is skipped
(`cloud-provider.ts:218`).
