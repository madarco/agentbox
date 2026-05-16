# agent-box — Architecture Handoff

## Goal

Spawn isolated, disposable Linux containers ("boxes") for each Claude agent instance against a host workspace. Fast cold start, full host-side isolation, instant switching between agents in VS Code.

## Filesystem layout per box

Three-layer FUSE overlay inside the container:

- **lower** — host workspace, bind-mounted read-only via VirtioFS (`/host-src`)
- **upper** — named volume, captures all agent writes (`/upper`)
- **snapshot** — named volume, background-rsynced mirror of lower (`/snapshot`)

Boot sequence: overlay mounts immediately with `lower=/host-src`, container is usable in ~1s. Background job rsyncs `/host-src → /snapshot`, then atomically remounts overlay with `lower=/snapshot`. Host is fully decoupled from that point on.

Tools: `fuse-overlayfs`, `rsync`. Container needs `/dev/fuse` + `SYS_ADMIN`.

## First-run setup (per host workspace)

1. Build base image with `node`, `pnpm`, `fuse3`, `fuse-overlayfs`, `rsync`, `openssh-server`.
2. Run one-time "seed box" that executes `pnpm install` against the project, populating a **shared `pnpm_store` named volume** (content-addressable, reused by all future boxes).
3. Prompt user: _"Create a frozen base snapshot of the workspace? (Recommended — lets you keep editing the host while agents run against a stable copy.)"_
   - If yes: APFS clone via `cp -c project/ ~/.agent-box/base/<workspace-hash>/` (instant on APFS, CoW). Future boxes bind this path as `/host-src` instead of the live project. Re-snapshot on demand.
   - If no: boxes bind the live project. Cheaper, but host edits during the rsync window leak into the snapshot.

## Per-box volumes

```yaml
volumes:
  - ${LOWER_PATH}:/host-src:ro # frozen base OR live project
  - upper-${BOX_ID}:/upper # agent writes, COW (node_modules etc. land here)
  - snapshot-${BOX_ID}:/snapshot # background mirror
  - pnpm_store:/root/.local/share/pnpm/store # shared, content-addressable
  - vscode-server-${BOX_ID}:/root/.vscode-server # per-box TS cache, extension state
  - vscode-extensions:/root/.vscode-server/extensions # shared across boxes
```

`node_modules` is **not** a separate volume — it falls through to the per-box overlay upper (`agentbox-upper-<id>`), so it (and `.next`, `target`, `.venv`, …) is isolated per box and captured by per-box upper exports/snapshots. The host's macOS `node_modules` only reaches the box through the read-only overlay *lower*, and only on the raw-host-workspace path: the snapshot path prunes `EXCLUDE_DIRS` (incl. `node_modules`) and the git-worktree path uses `git ls-files --others --exclude-standard`, so gitignored `node_modules` never reaches the lower there. The wizard-generated `agentbox.yaml` install task force-rebuilds Linux-native deps on first box start, guarded by a `node_modules/.agentbox-installed` marker so it self-heals a stale host-leaked tree once but is a no-op on subsequent box starts.

## VS Code integration

- Each box runs `sshd` on a unique port (or use `Dev Containers: Attach to Running Container`).
- User opens a box → VS Code attaches, spawns `vscode-server` inside the container, hydrates extensions from the shared volume.
- TS server, file watchers, language services all live in the container. Cache stays warm across the box's lifetime.

## Pause strategy (the core efficiency trick)

Inactive boxes are **`docker pause`d**, not stopped.

- `docker pause` freezes all processes via cgroup freezer: 0 CPU, RAM stays mapped but pageable, kernel can reclaim under pressure (optionally forced via `memory.reclaim` to zram swap).
- `docker unpause` resumes instantly. `vscode-server` and its TS server pick up mid-instruction — no cache rehydration, no watcher storms, no re-parse.
- Switching boxes: pause the outgoing, unpause the incoming, focus the VS Code window. Sub-second.

Host-side switcher (sketch):

```bash
agent-box switch <id>
  → docker pause $(other boxes)
  → docker unpause <id>
  → open "vscode://vscode-remote/attached-container+<id>/workspace"
```

## Lifecycle

| State           | Trigger                   | Cost                |
| --------------- | ------------------------- | ------------------- |
| Running, active | User attached             | Full                |
| Paused          | User switched away        | 0 CPU, RAM pageable |
| Stopped         | Explicit, or N hours idle | 0                   |
| Destroyed       | User discards agent       | Volumes purged      |

Upper volume is the agent's "diff against base". Persists across pause/stop. Discarded on destroy. Easy to inspect (`git diff` inside the box) or export (`rsync /workspace → host`) for PR review.

## What we explicitly rejected

- **Mount/symlink swapping under a single VS Code window** — causes TS server cache invalidation storms and watcher floods on every switch. Per-box server + pause is strictly better.
- **Using the host's `node_modules` as-is** — platform mismatch (macOS binaries on Linux). Native modules with prebuilt `.node` files won't be fixed by `pnpm install` without `--force` or `rebuild`. We do **not** shadow it with a separate Linux volume (that splits the box's writable state across two volumes the snapshot/export path has to track); instead `node_modules` lives in the per-box overlay upper and the wizard-generated install task does a clean Linux rebuild on first box start.
- **Git push/pull between container and host** — slower than rsync, pollutes history, doesn't handle untracked artifacts. Use rsync or direct `docker exec` reads for review.

## Open questions for implementation

- Idle-timeout policy: auto-pause after N minutes of no VS Code activity? Auto-stop after M hours?
- Snapshot refresh UX: how does the user re-base a running agent on an updated host snapshot? (Likely: spawn a new box, migrate the upper.)
- Memory ceiling: cap concurrent unpaused boxes, or rely on swap pressure?
- Cross-box diff dashboard: single pane showing `git diff --stat` per box with deep-links into the right attached VS Code window.
