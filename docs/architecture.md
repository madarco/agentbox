# agentbox — Architecture Handoff

## Goal

Spawn isolated, disposable Linux containers ("boxes") for each Claude agent instance against a host workspace. Fast cold start, full host-side isolation, instant switching between agents in VS Code.

## Filesystem layout per box

`/workspace` is a plain directory in the **container's writable layer** — created by the image (`mkdir /workspace && chown vscode:vscode /workspace` in `Dockerfile.box`), populated at create time, and wiped on `agentbox destroy`. No FUSE overlay, no upper volume, no virtiofs bridge for working-tree reads.

How `/workspace` gets populated depends on the source:

- **Git repo (the common case)**: `agentbox create` runs `git worktree add -b agentbox/<box-name> /workspace HEAD` **inside the container** against the host main repo's `.git/`, which is bind-mounted at its identical absolute host path (RW). Branch + uncommitted-state replay (host `git stash create` SHA + `tar`-piped untracked files) are applied in-container as user `vscode`.
- **No git repo**: a `tar`-pipe from the host workspace (or its `--host-snapshot` APFS clone) into `/workspace`.
- **Checkpoint restore (`--snapshot <ref>`)**: the box is started with the checkpoint Docker image as its base — `/workspace` is already populated; no `git worktree add`, no tar pipe.

The retired FUSE overlay had `lowerdir=/host-src,upperdir=/upper/upper` and reasonable boot speed, but every advantage it had against macOS hosts evaporated once we depended on per-box git worktrees + a bind-mounted `.git` — the worktree path *was* the isolation, the overlay added nothing.

Container needs `/dev/fuse` + `SYS_ADMIN` + `apparmor:unconfined`/`seccomp=unconfined` not for the outer FS but for the **in-box dockerd**'s `fuse-overlayfs` storage driver and cgroup remounts.

## First-run setup (per host workspace)

1. Build base image with `node`, `pnpm`, `fuse3`, `fuse-overlayfs` (for inner dockerd), `rsync`, `git`, `tmux`, plus Claude Code and agent-browser.
2. Run the in-box `/agentbox-setup` wizard once: it inspects the workspace, writes `agentbox.yaml` with install + service definitions, and (optionally) takes the first checkpoint.
3. `--host-snapshot` is the optional "freeze the source bytes" knob: `cp -c` APFS clone of the workspace into `~/.agentbox/snapshots/<id>/` before the tar pipe so host edits during create don't leak in. No-op when a git repo is detected (worktree content comes from `.git`).

## Per-box volumes

```yaml
volumes:
  # Per-box (wiped on destroy)
  - <hostMainRepo>/.git:<hostMainRepo>/.git              # identical-path RW so worktree pointers resolve symmetrically
  - <boxDir>/run:/run/agentbox                            # agentbox-ctl unix socket
  - <boxDir>/workspace:/host-export                       # rsync target for `agentbox open`
  - agentbox-docker-<id>:/var/lib/docker                  # in-box dockerd data root
  - agentbox-vscode-server-<id>:/home/vscode/.vscode-server
  - agentbox-cursor-server-<id>:/home/vscode/.cursor-server

  # Shared across boxes (allowlisted in `prune --all`, never auto-removed)
  - agentbox-claude-config:/home/vscode/.claude           # user identity (auth, skills, plugins)
  - agentbox-vscode-extensions:/home/vscode/.vscode-server/extensions
  - agentbox-cursor-extensions:/home/vscode/.cursor-server/extensions
```

`/workspace` is **not** a volume — it lives in the container's writable layer. `node_modules`, `.next`, `target`, `.venv` land there alongside the rest of the working tree; the wizard-generated `agentbox.yaml` install task rebuilds them on first start (marker-guarded by `node_modules/.agentbox-installed`).

## VS Code integration

- Each box exposes container `:80` (web service) + `:6080` (noVNC) via random ephemeral host ports, and is reachable via the Dev Containers extension (`agentbox code <box>`).
- Per-box `agentbox-{vscode,cursor}-server-<id>` volumes hold the downloaded server binary; shared `agentbox-{vscode,cursor}-extensions` volumes hold installed extensions.
- TS server, file watchers, language services live in the container. Cache stays warm across the box's lifetime.

## Pause strategy (the core efficiency trick)

Inactive boxes are **`docker pause`d**, not stopped.

- `docker pause` freezes all processes via cgroup freezer: 0 CPU, RAM stays mapped but pageable.
- `docker unpause` resumes instantly. `vscode-server` and its TS server pick up mid-instruction — no cache rehydration.
- Switching boxes: pause the outgoing, unpause the incoming, focus the VS Code window. Sub-second.

`docker stop` + `docker start` works too — `/workspace` lives in the container writable layer, so it survives a stop/start natively. `agentbox start` only needs to relaunch ctl/dockerd/Xvnc (they die with the container).

## Lifecycle

| State           | Trigger                   | Cost                |
| --------------- | ------------------------- | ------------------- |
| Running, active | User attached             | Full                |
| Paused          | User switched away        | 0 CPU, RAM pageable |
| Stopped         | Explicit, or N hours idle | 0                   |
| Destroyed       | User discards agent       | Container + volumes purged |

The container's writable layer is the agent's "diff against base image". Persists across pause/stop. Discarded on destroy. Inspectable with `agentbox open` (rsync `/workspace` → host scratch dir → Finder) or exportable via `agentbox checkpoint` (`docker commit`).

## Checkpoints

A **checkpoint** captures a box's accumulated state — `/workspace` (incl. `node_modules`, build caches, in-box `.env` files) plus everything else the agent wrote into the container's writable layer — so a *new* box can start warm instead of from bare host code. Primary use: after a setup wizard or a merged PR, `agentbox checkpoint <box> --set-default` makes every future box in the project inherit the warm state.

- **Cleanup** runs first: `docker exec --user root <ctr> /usr/local/bin/agentbox-checkpoint-cleanup` strips apt cache + `/tmp` + `/var/log` + bash history. Caches under `~/.npm`/`~/.cache` and `/var/lib/docker` are kept (warm state worth carrying).
- **Layered checkpoint** (default, fast): `docker commit <ctr> agentbox-ckpt-<projectHash>:<name>`. New layer on top of the box's current image; lineage is implicit in Docker image history. The `parents` chain in the manifest tracks refs for display and the auto-flatten threshold.
- **Flattened checkpoint** (`--merged`, or auto when `chainDepth >= checkpoint.maxLayers`, default 3): `docker commit` → `docker create` → `docker export <tmp> > rootfs.tar` → tiny `FROM scratch` Dockerfile that `ADD`s the rootfs and replays the base image's `Env`/`Cmd`/`Entrypoint`/`WorkingDir`/`User`/`ExposedPorts` (lost by `docker export`) → `docker build`. The resulting image is a single ADD layer; lineage resets.
- **Restore**: `agentbox create/claude --snapshot <ref>` (or per-project default `box.defaultCheckpoint`) passes the checkpoint image tag to `runBox` as the base image. No mount, no overlay; `/workspace` is already there.

Storage:

- Host metadata only: `~/.agentbox/checkpoints/<projectHash>/<name>/manifest.json` (schema 2, references the image tag).
- Image tags use the deterministic `agentbox-ckpt-<sha1-16(projectRoot)>` repo prefix (parallel to the per-project config-dir hash); `agentbox prune --all` reaps any tag under that prefix not referenced by a surviving `BoxRecord.checkpointImage`.
- `agentbox checkpoint rm <ref>` deletes the manifest + `docker image rm` the tag.

In-box agents trigger capture via the existing relay (`agentbox-ctl checkpoint` → `/rpc checkpoint.create` → host `agentbox checkpoint` CLI). No host creds in the box.

This is distinct from the host **snapshot** (`--host-snapshot`, config `box.hostSnapshot`): a per-box APFS clone of the host workspace used only as a stable source for the create-time `tar` pipe. Orthogonal to checkpoints, which capture box-side state.

## What we explicitly rejected

- **FUSE overlay with the host workspace as lower** — retired once isolation moved into the per-box git worktree + container fs. With `.git` bind-mounted and a fresh branch per box, the overlay added no isolation and lost the speed argument (linux native deps are rebuilt anyway). See `docs/create-and-checkpoints.md` for the new create flow.
- **Per-project checkpoint volume** (the previous design) — replaced by `docker commit` images. Layered chain is now native Docker image history; flatten is `docker export` + `FROM scratch` rebuild.
- **Mount/symlink swapping under a single VS Code window** — causes TS server cache invalidation storms and watcher floods on every switch. Per-box server + pause is strictly better.
- **Using the host's `node_modules` as-is** — platform mismatch (macOS binaries on Linux). The wizard install task force-rebuilds Linux-native deps on first box start.
- **Git push/pull from inside the container with credential forwarding** — leaks creds. Push goes through the relay (`git -C <hostMainRepo> push origin <branch>` runs on host with user SSH/gitconfig); pull splits into a relay `git.fetch` plus a creds-free in-container merge.

## Open questions for implementation

- Idle-timeout policy: auto-pause after N minutes of no VS Code activity? Auto-stop after M hours?
- Memory ceiling: cap concurrent unpaused boxes, or rely on swap pressure?
- Cross-box diff dashboard: single pane showing `git diff --stat` per box with deep-links into the right attached VS Code window.
