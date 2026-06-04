# `agentbox create` + Checkpoints — implementation reference

Companion to [`architecture.md`](./architecture.md) (the *why*). This doc is the
*how*: file/git handling during `create`, and the full checkpoint
capture/restore mechanics, with code pointers. Source of truth:
`packages/sandbox-docker/src/create.ts`, `in-box-git.ts`,
`git-worktree.ts`, `checkpoint.ts`.

## `agentbox create` — files and git

### Git: in-container worktree against a bind-mounted `.git`

1. **Detect repos** — `detectGitRepos(workspace)` (`git-worktree.ts`) scans for
   a `.git` *directory* at the workspace root and at every 1st-level
   subdirectory (monorepo case). Worktree-form `.git` *files* are skipped
   (rare and weird).
2. **Pick branches on the host** — for each detected repo,
   `pickFreshBranch(hostMainRepo, "agentbox/<box-name>")` bumps `-2`, `-3`, …
   until git reports no such branch. Runs against the host's refs before
   `docker run` so the branch name is committed to the `BoxRecord` regardless
   of whether the in-container `git worktree add` succeeds.
3. **Capture carry-over (host)** — `collectRepoCarryOver(...)` in
   `in-box-git.ts`:
   - `git -C <repo> stash create` produces a stash commit *without* touching
     the working tree or stash list. The commit lands in the host's `.git/`
     object DB, which is bind-mounted into the container — so the in-box
     worktree can `stash apply <sha>` against it.
   - `git -C <repo> ls-files --others --exclude-standard -z` enumerates the
     untracked paths.
4. **Bind-mount `.git`** — `runBox` binds each `<hostMainRepo>/.git` at its
   identical absolute host path inside the container, RW. Worktree pointer
   files (`<wt>/.git`) and the back-reference at
   `<main>/.git/worktrees/<name>/gitdir` contain absolute paths — both sides
   must resolve to the same path for git to function symmetrically.
5. **Seed `/workspace`** — `seedWorkspace(...)` in `in-box-git.ts` runs as
   user `vscode` inside the container:
   ```
   git -C <hostMainRepo> worktree add -b agentbox/<name>[--<sub>] <containerPath> HEAD
   git -C <hostMainRepo> config extensions.worktreeConfig true
   git -C <containerPath> config --worktree commit.gpgsign false
   ```
   Then if a stash SHA was captured: `git -C <containerPath> stash apply --index <sha>`
   (falls back to apply-without-index on conflict). Then if untracked files
   exist: tar them in host-side and `docker exec -i tar -x -C
   <containerPath>`.
6. **No host worktree dir.** The worktree's working tree lives only in the
   container's writable layer. The host's `.git/worktrees/<name>/gitdir`
   points to the container-only `/workspace` path — cosmetic in `git
   worktree list` on the host, otherwise inert (`git push` doesn't need a
   working tree).
7. **Push/pull go through the relay** (`packages/relay/src/server.ts`):
   `git.push` runs `git -C <hostMainRepo> push <remote> <branch>` on host
   with user creds (refs are up-to-date in the shared `.git`); `git.pull` in
   the in-box `agentbox-ctl git pull` first calls a host-side `git.fetch`
   RPC, then runs a local `git merge` in `/workspace` (no creds needed).

### Files (no git)

- **Plain (no `--host-snapshot`)**: `seedWorkspaceFromDir({ container,
  hostSource: workspace })` — `tar -C <workspace> -cf - .` host-side, piped
  into `docker exec -i tar -C /workspace -xf -` as uid:gid 1000:1000 so
  extracted files land owned by `vscode`.
- **`--host-snapshot`**: `cp -c` APFS clone of the workspace into
  `~/.agentbox/snapshots/<id>/` first, then the same tar pipe from the clone.
  Stabilizes the source bytes against host edits during create.
- **Checkpoint restore (`--snapshot <ref>`)**: `seedWorkspace` is skipped
  entirely — the checkpoint Docker image already has `/workspace` populated.

### `/workspace` lives in the container's writable layer

- All writes go to the container's writable layer (the same place Docker
  layers any in-container write that isn't a volume).
- `node_modules`, `.next`, `target`, `.venv` — all land there. Persists
  across pause/stop/start; wiped on `destroy`.
- The host filesystem is never written by the box directly. `agentbox open`
  rsyncs `/workspace` → `~/.agentbox/boxes/<id>/workspace` on demand.
- `--with-env` additionally copies host `.env*`/`secrets.toml`/`agentbox.yaml`
  -style files (`DEFAULT_ENV_PATTERNS`) into `/workspace` after seeding,
  bypassing gitignore — the reverse of `agentbox download env`.

Net effect: the agent gets a full, writable copy of the repo on its own
branch, with the user's uncommitted work carried over, fully isolated from
the host checkout and host filesystem.

## Checkpoints — `docker commit` + periodic flatten

Purpose: let a new box start warm (deps installed, project built) instead of
cold, without baking anything into the base image. Code: `checkpoint.ts`
(capture + resolve) and the restore path in `create.ts`.

### Storage model

- **One Docker image *tag* per checkpoint**:
  `agentbox-ckpt-<sha1-16(projectRoot)>:<name>` (`checkpointImageTag`,
  deterministic from the project root — same `hashProjectPath` the per-project
  config dir uses).
- Host-side, only metadata:
  `~/.agentbox/checkpoints/<projectHash>/<name>/manifest.json` (`schema: 2`,
  `type`, `image`, `parents`, `base`, `sourceBox*`, `createdAt`). The
  captured filesystem is never on the host — it's a regular Docker image.
- Naming is monotonic per box-name (`computeNextCheckpointName` is max+1;
  gaps from deleted checkpoints never recycled).

### Capture (`createCheckpoint`)

1. **Pre-commit cleanup** — `docker exec --user root <ctr>
   /usr/local/bin/agentbox-checkpoint-cleanup` (script body in
   `packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup`, baked into
   the image at build time):
   ```
   apt-get clean
   rm -rf /var/lib/apt/lists/*
   rm -rf /tmp/* /var/tmp/*
   truncate -s0 /var/log/**/*.log
   : > /root/.bash_history /home/vscode/.bash_history
   ```
   Caches under `~/.npm`/`~/.cache` and `/var/lib/docker` are intentionally
   kept (warm state worth carrying). Best-effort: every step `2>/dev/null ||
   true`; cleanup failure never blocks the commit.
2. **Type selection** — `--merged`, or auto when the source box's chain
   depth `>= checkpoint.maxLayers` (default 3, caps image-layer growth).
3. **Layered (default)**: `docker commit <ctr> <ckpt-tag>`. New layer on top
   of the box's current image; lineage is implicit in Docker image history.
   `parents` in the manifest tracks the source box's
   `checkpointSource.chain` for display + the auto-flatten threshold.
4. **Flattened (`--merged` / auto)**: commit to an intermediate tag, then
   - `docker create --name <tmp> <intermediate-tag> sleep 0`
   - `docker export <tmp> > <scratch>/rootfs.tar`
   - `docker image inspect <intermediate-tag>` for `Config.Env / Cmd /
     Entrypoint / WorkingDir / User / ExposedPorts` (everything `docker
     export` discards)
   - Write a tiny `Dockerfile.flatten`:
     ```dockerfile
     FROM scratch
     ADD rootfs.tar /
     ENV ...
     WORKDIR ...
     USER ...
     EXPOSE ...
     ENTRYPOINT ...
     CMD ...
     ```
   - `docker build -t <ckpt-tag> -f Dockerfile.flatten <scratch>`
   - Remove the intermediate tag, scratch dir, and the throwaway container.
   The resulting image is a single ADD layer; `parents: []` (self-contained).

### Restore (`resolveCheckpoint` → `create.ts`)

- `resolveCheckpoint(projectRoot, ref)` reads the manifest and returns the
  image tag plus lineage. `create.ts` passes the tag to `runBox` as the base
  image and skips `seedWorkspace` entirely.
- **Fresh per-box worktree (not the manifest's).** The manifest records the
  *source* box's branch + worktree path, but reusing them verbatim is unsafe:
  every box from one checkpoint would share a single branch + index (commits
  clobber each other; `index.lock` fights), and once the source box is destroyed
  its host `.git/worktrees/<name>` metadata is pruned, leaving the baked
  `/workspace/.git` gitfile dangling (`fatal: not a git repository`). So restore
  allocates a **fresh, unique `agentbox/<box-name>` branch** (host-side
  `pickFreshBranch`, before `docker run`, like the non-checkpoint path) and,
  after `docker run`, `regenerateRestoredWorktrees` (`in-box-git.ts`) renames the
  baked content dir to the fresh path (an O(1) in-container rename), mints a
  fresh branch at the host base ref, authors fresh `.git/worktrees/<fresh>`
  metadata, repoints the gitfile, and `git reset --hard HEAD` so the box starts
  **clean at the host base ref** (same git state as a fresh create). The baked
  tracked tree was the source box's possibly-stale/divergent branch, so its
  deviations are dropped; the gitignored warm artifacts (`node_modules`,
  `.next`, build caches) are untouched by the reset — that warm state is the
  checkpoint's value. `resyncWorkspaceFromHost` then overlays the host's current
  uncommitted/untracked work, matching the non-checkpoint carry-over.
- `BoxRecord.checkpointImage` mirrors `record.image` for plain-vs-checkpoint
  disambiguation (used by `prune --all` to allowlist still-referenced
  checkpoint tags).
- `BoxRecord.checkpointSource = { ref, type, chain }` carries the lineage
  for `inspect`/`status` and the auto-flatten depth count.

### Lifecycle / triggering

- CLI: `agentbox checkpoint create <box> [--merged] [--set-default]`,
  `agentbox checkpoint ls` (the default — bare `agentbox checkpoint` or
  `agentbox checkpoints` lists), `agentbox checkpoint rm <ref>` (deletes the
  manifest *and* the image tag).
- Capture/restore is **host-side**. An in-box agent triggers it through the
  relay: `agentbox-ctl checkpoint` → `/rpc checkpoint.create` → the relay
  spawns the host `agentbox checkpoint create` CLI (`AGENTBOX_CLI_ENTRY`) — no host
  creds leak into the box, reusing the existing relay channel (same as
  `agentbox-ctl git`).

### Distinct from the host snapshot

`--host-snapshot` (config `box.hostSnapshot`) is a per-box APFS clone of the
host workspace used only as a stable source for the create-time tar pipe
(non-git case). It cannot carry box-side state — orthogonal to checkpoints.

## Image cleanup + prune

- `agentbox destroy` removes the container, per-box volumes (claude-config if
  isolated, vscode-server, cursor-server, dockerd unless shared), the
  per-box host snapshot dir, and the per-box run dir under
  `~/.agentbox/boxes/<id>/`. Per-box checkpoint images stay (they're
  cross-box project assets).
- `agentbox prune --all` reaps orphan containers/volumes, the per-box snapshot
  dirs, and `agentbox-ckpt-*` image tags **not** referenced by any surviving
  `BoxRecord.checkpointImage` and **not** referenced by any project's
  manifests on disk. Shared volumes (`agentbox-claude-config`,
  `agentbox-{vscode,cursor}-extensions`, `agentbox-docker-cache`) are
  allowlisted unconditionally.
