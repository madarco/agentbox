# remote-docker provider — status + backlog

Run a box as a container on a machine the user already owns, over SSH.
Design rationale lives in [`cloud-providers.md` §3e](./cloud-providers.md); this
file tracks what is done, what was verified, and what is left.

## Shipped

| Area | State |
| --- | --- |
| `CloudBackend` (`packages/sandbox-remote-docker/src/backend.ts`) | provision / get / list / start / stop / pause / resume / destroy / state / exec / uploadFile / downloadFile / listFiles / previewUrl / signedPreviewUrl / refreshPreviewUrl / createSnapshot / deleteSnapshot / snapshotExists |
| Transport (`src/remote-docker.ts`) | one ControlMaster per box; every `docker` call through `ssh <dest> bash -lc 'docker …'`; binary-safe file streams |
| Addressing (`src/target.ts`, `apps/cli/src/provider/spec.ts`) | `docker:<host>` spec, sandbox-id encodes the SSH destination, multi-host |
| Image (`src/image.ts`) | fingerprint-tagged ref; present → GHCR pull (multi-arch) → streamed remote build |
| `prepare` | optional (create ensures the image itself); records history in `~/.agentbox/remote-docker-prepared.json` |
| Checkpoints | `docker commit`, host-qualified snapshot name, restore + stale-manifest fallback |
| Attach | `ssh -t <engine> docker exec -it … bash -lc '<tmux>'` |
| `open` / `code` / `connect` | box sshd + per-box key, reached by `ProxyJump` through the engine (`src/box-ssh.ts`, `Provider.sshTarget`) |
| VNC + web preview | published on the engine's loopback, forwarded, portless alias |
| `prune` | `backend.list()` sweeps every engine named by a box record or the config default |
| Doctor | ssh reachable / docker present / image baked |
| CLI | `agentbox remote-docker add | update | list | doctor | remove` — a named host-alias registry (no login — there is no credential) |

## Verified end-to-end

Against a real SSH-reached engine (2026-07-12):

- `prepare` — GHCR miss on a dev-tree fingerprint → streamed build context → image on the remote.
- `create` — container up; `/workspace` seeded as a real git clone on `agentbox/<box>`, with the host's uncommitted **and** untracked changes carried over byte-identical to the host's files.
- Bootstrap — dockerd + ctl + VNC up in the box; portless aliases on the forwarded ports.
- Attach — driven in a PTY: lands in the container (`hostname=agentbox-<box>`, `pwd=/workspace`, correct branch).
- `ssh <box>` — lands in the container through `ProxyJump`. A stop/start reassigns the engine's ephemeral port and the config re-syncs; ssh still connects.
- Checkpoint — `docker commit` on the engine; manifest carries `<host>#<image-ref>`.
- `pause` / `unpause` — `docker pause` / `unpause`.
- `destroy` — no container and no volume left behind.

### First real macOS/OrbStack remote (2026-07-15)

A live run from a laptop against a **mac mini** (`docker:macmini`, OrbStack engine)
surfaced three host-side bugs, all fixed — none reproduce on the nested/loopback
path the earlier verify used, which is why they slipped through:

1. **ControlMaster socket path too long.** The per-box ssh dir
   (`~/.agentbox/remote-docker/boxes/<sanitized-box-id>/ssh/control.sock`) plus ssh's
   17-char temp suffix overflows the ~104-byte `sun_path` limit on macOS, because
   remote-docker's box-id embeds the SSH destination + project + hash. Fixed by
   hanging the ControlMaster socket off a short, flat `~/.agentbox/cm/<hash>.sock`
   (`controlSockPath` in `sandbox-core/src/ssh-tunnel.ts`); keys/known_hosts stay in
   the deep per-box dir. VPS providers never hit this — their box-ids are short ints.
2. **Attach ran the remote command in a non-login shell.** `buildRemoteDockerAttach`
   built a bare `docker exec …` string; ssh runs it in the remote user's *non-login*
   shell, where `docker` (Docker Desktop `/usr/local/bin`, OrbStack `~/.orbstack/bin`)
   isn't on PATH → `command not found: docker`, so the tmux session was never created.
   Fixed by wrapping in `loginShell()` like every other remote invocation.
3. **Credential seed relied on in-box passwordless sudo.** The ephemeral credential
   extract ran `sudo -u vscode …`, but the shared docker box image doesn't grant
   vscode sudo (the e2b/vercel/hetzner *snapshots* do), so it failed with "user vscode
   is not allowed to execute … as vscode" and the box came up unauthenticated. Fixed
   by running the extract via `backend.exec`'s `user` option instead of an in-shell
   sudo (`sandbox-cloud/src/sync/agent-credentials.ts`) — benefits all non-volume
   backends. Verified: fresh box seeds all three agents and `claude -p` returns a live
   answer in-box.

## Backlog

- **Live-verify against a non-nested Linux remote.** A macOS/OrbStack remote now has a
  real run (above); a plain Linux server should get one too. `scripts/linux-dev-vm.sh
  up` spins an Ubuntu VM with docker for exactly this.
- **`agentbox recover --adopt`** for a remote-docker box created on another host —
  needs the per-box key, like hetzner.
- **Ports are fixed at create.** A service added to `agentbox.yaml` afterwards is
  reachable through the WebProxy but gets no direct preview URL. Same constraint as
  Vercel; a recreate is the only fix today.
- **Checkpoints don't follow you between engines.** Could be lifted by
  `docker save | ssh <other> docker load`, at the cost of moving GBs.
- **Shared agent-credential volumes.** Today credentials are seeded per box (like
  hetzner). A named volume on the engine would let a login persist across boxes on
  that machine, as it does for local docker — but two boxes would then share one
  `~/.claude`, so it needs thought.
- **`box.remoteDockerHost` in the install wizard.** The provider shows up in the
  picker but has no wizard step to set its default host (there is no credential to
  prompt for); `agentbox remote-docker add <alias> <ssh>` covers it for now.

## Adjacent bug found while building this (not remote-docker's)

`detectGitRepos` (`packages/sandbox-core/src/git-detect.ts`) only accepts `.git` as
a **directory**. When the source workspace is a git *worktree* — `.git` is a pointer
file, which is exactly what `/workspace` is inside any AgentBox box — every cloud
provider silently falls back to `seedFromTar` and the new box gets a dangling `.git`
pointer. Affects daytona/hetzner/vercel/e2b/digitalocean equally. Worth its own fix.
