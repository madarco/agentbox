# remote-docker — session handoff (2026-07-12)

Built and merged into PR [#207](https://github.com/madarco/agentbox/pull/207)
(`feat/remote-docker` → `main`). This file is the pick-up point for **testing it
from the host**, which is the one thing the build session could not do properly.

Status + backlog: [`remote-docker-backlog.md`](./remote-docker-backlog.md).
Design rationale: [`cloud-providers.md` §3e](./cloud-providers.md).

---

## Why the host has to finish the testing

Everything was verified end-to-end, but against **an engine that is itself an
AgentBox box** (the build session ran inside a box, and pointed the provider at
that box's own dockerd over loopback ssh). That proved the whole path — but it is
not the case users will actually hit, and it is the *weird* case:

- It's the only reason the uid-0 workaround exists (a nested dockerd has no
  `CAP_SYS_PTRACE`, so it can't set up netns for a non-root container init).
- It says nothing about a **plain Linux server**, and nothing at all about a
  **macOS remote** — where the whole `bash -lc` login-shell design is what makes
  OrbStack/Colima's `docker` findable in the first place.

So: do not trust "works on Linux" or "works on a Mac remote" until one of each has
actually run. Neither has.

---

## Test 1 — a real Linux server (the priority)

The repo already provisions exactly the right target: a Hetzner `cx23` / Ubuntu
24.04 VM with `docker.io` and a non-root `dev` user in the `docker` group. It is
**amd64**, so it also exercises the cross-arch GHCR pull from an arm64 Mac — which
a local test never would.

```bash
scripts/linux-dev-vm.sh up          # ~2 min; prints the IP
scripts/linux-dev-vm.sh info        # ssh line + key path
```

The VM uses a dedicated key (`~/.agentbox/linux-dev-vm/id_ed25519`), and this
provider deliberately takes its SSH config from **your** `~/.ssh/config` — it
mints nothing. So add a Host block (a `sshconfig` subcommand for the script is a
nice-to-have, not written):

```
Host agentbox-linux-vm
  HostName <vm-ip>
  User dev
  IdentityFile ~/.agentbox/linux-dev-vm/id_ed25519
```

Then, from the repo (or any project):

```bash
ssh agentbox-linux-vm docker version                      # must work first — nothing else will
agentbox remote-docker doctor agentbox-linux-vm          # ssh + docker + arch

agentbox prepare --provider docker:agentbox-linux-vm      # expect an amd64 GHCR PULL, not a build
agentbox create -y -n rd-vm --provider docker:agentbox-linux-vm &
tail -f ~/.agentbox/logs/create.log                       # watch BEGIN/END per step; never a blind timeout

agentbox list                                             # PROVIDER = remote-docker
ssh agentbox-linux-vm docker ps                           # the container is on the VM
agentbox url rd-vm                                        # forwarded web URL opens
agentbox shell rd-vm                                      # ssh -> docker exec -> tmux
agentbox open rd-vm                                       # sshfs mount (ProxyJump)
agentbox code rd-vm                                       # VS Code Remote-SSH

agentbox checkpoint create rd-vm --name setup             # docker commit on the VM
agentbox destroy rd-vm -y
ssh agentbox-linux-vm 'docker ps -a; docker volume ls'    # must be clean

scripts/linux-dev-vm.sh down                              # it bills by the hour
```

**What to watch for specifically:**

- `prepare` should **pull** here, not build. If it builds, the build-context
  fingerprint didn't match a published GHCR tag — fine on a dev tree, but on a
  release build a miss means the fingerprint drifted and is worth understanding.
- The uid-0 path must **not** trigger: the VM is not an AgentBox box, so
  `remoteIsNested()` is false and the box init runs as `vscode`. If you see
  "remote engine is itself an AgentBox box" in the create log, the probe is wrong.
- `agentbox open` / `code` go through `ProxyJump`. Check the generated block:
  `grep -A6 'Host rd-vm' ~/.agentbox/ssh/config` — HostName must be `127.0.0.1`
  (resolved *on the VM*), with `ProxyJump agentbox-linux-vm`.

## Test 2 — the relay round-trip (the one that actually matters)

A box reaching "ready" does **not** mean it works. The real test is a git push
travelling home through the host relay:

```bash
cd ../agentbox-test-repo
agentbox docker:agentbox-linux-vm claude
# in the box: make a commit, then `agentbox-ctl git push`
```

It must bundle the branch back to the host, prompt you for approval, and push with
*your* credentials — the VM never sees a git credential. Verify with
`git ls-remote`, not an exit code.

## Test 3 — a macOS remote (OrbStack)

The least-tested surface and the one with the most specific design behind it. Any
Mac you can `ssh` into with Docker Desktop / OrbStack / Colima:

```bash
agentbox remote-docker doctor my-mac
agentbox docker:my-mac create -y -n rd-mac
```

The whole point of running `docker` inside `bash -lc` on the remote is that
OrbStack lives in `~/.orbstack/bin`, which is *not* on the non-login PATH — which
is also precisely why `DOCKER_HOST=ssh://` was rejected (it runs `docker system
dial-stdio` on the remote without a login shell). If `remote-docker doctor` passes
but a create fails with "command not found", that assumption broke.

## Test 4 — a second engine at once

Multi-host is meant to need no setup. Two boxes on two machines, simultaneously:

```bash
agentbox docker:agentbox-linux-vm claude
agentbox docker:my-mac claude
agentbox list                     # both, each on its own engine
```

Each box's sandbox id embeds its engine (`<ssh-dest>/<container>`), so nothing
host-side has to remember which is which.

---

## Gotchas already found (so you don't re-find them)

| Symptom | Cause |
| --- | --- |
| `bind-mount /proc/N/ns/net: permission denied` on `docker run` | The engine is itself an AgentBox box (no `CAP_SYS_PTRACE`). Handled: the provider asks the *engine* (`test -f /etc/agentbox/box.env`) and forces box init to uid 0. Should never fire on a real server. |
| Workspace seed fails with `rm: cannot remove /tmp/agentbox-*.tar.gz: Operation not permitted` | File written as root, `exec` runs as vscode. Fixed: both name `CONTAINER_USER` explicitly instead of inheriting the container's default user. |
| Box `/workspace` has a dangling `.git` pointer | **Pre-existing, not this provider.** See below. |
| `agentbox shell` opens the install wizard | First-run gate, unrelated. |

## Open issues to pick up

1. **`detectGitRepos` rejects a git worktree** (`packages/sandbox-core/src/git-detect.ts`)
   — it only accepts `.git` as a *directory*. When the source workspace is a
   worktree (`.git` is a pointer file — which is exactly what `/workspace` is
   inside **any** AgentBox box), every cloud provider silently falls back to
   `seedFromTar` and the new box gets a dangling `.git`. Hits
   daytona/hetzner/vercel/e2b/digitalocean equally. Deserves its own fix + test.

2. **git-push branch asymmetry.** Cloud boxes push whatever branch is checked out
   in the box (`rev-parse HEAD` in `runGitRpc`, approval-gated). Local-docker boxes
   are pinned to the host-registered branch (`sanctionedBranch ?? branch` in
   `handleGitRpc`) and the box's HEAD never reaches the push. Not a regression —
   it has been that way since `b0c5e4903` (2026-05-20) — but the two paths make
   opposite claims about whether an agent may choose its push target. This is what
   blocked the box from publishing its own feature branch during this session.

3. **`scripts/linux-dev-vm.sh sshconfig`** — a small subcommand to emit the Host
   block above, since the VM uses a non-default key.

4. **Install-wizard step for `box.remoteDockerHost`.** The provider appears in the
   picker but has no wizard step (there is no credential to prompt for);
   `agentbox remote-docker add <host>` covers it for now.
