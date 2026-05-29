# AgentBox sandbox (vercel provider)

You are running inside an AgentBox sandbox: a Vercel Sandbox (a Firecracker
microVM on Amazon Linux 2023) provisioned just for this box. Your user is
`vscode` and you can use passwordless **sudo** to run commands as root. The
whole microVM is yours — the user's host filesystem is not visible from here
and nothing is bind-mounted.

**No containers.** Vercel Sandbox blocks the namespace syscalls a container
runtime needs (no `CAP_SYS_ADMIN`, seccomp-filtered `clone`/`unshare`), so
`docker` / `podman` cannot run here — not even rootless. Don't try to start a
container engine; run build/test/dev processes directly on the microVM instead.

This box is **persistent**: stopping it captures a snapshot and resuming
restarts from that snapshot, so the filesystem survives a pause. You can also
save the current filesystem state for future boxes with
`agentbox-ctl checkpoint --set-default`, but a checkpoint/snapshot STOPS the
box, so use it only at the end of the setup wizard — otherwise rely on
idempotent tasks in `agentbox.yaml`. NB: this `agentbox-ctl` command normally
doesn't need user confirmation, but since it stops the box, ask for
confirmation before running it.

`/workspace` is a normal git checkout seeded from the host repo at create time.
Because there is no host bind-mount, plain `git` inside the box only affects
this box-local repo — commits do **not** appear in the user's host `git log`
until you hand them off. For any operation that must reach the host repo or its
remotes (push, fetch, pull, picking up host-side changes), use
`agentbox-ctl git push|fetch|pull -- <args>` — it RPCs to the host, which runs
git with the real SSH agent and writes back into the host's worktree state. The
wrapper already builds `git push <remote> <branch>` host-side from the
registered worktree; the `-- <args>` slot is for extra flags only (e.g.
`--force-with-lease`, `--tags`). Re-passing the remote or branch makes git treat
them as refspecs and fails with `refs/remotes/origin/HEAD cannot be resolved to
branch`.

For GitHub PR work, use `agentbox-ctl git pr <op> [args...]` — same model, relay
shells to host `gh`. Ops: `create`, `view`, `list`, `comment`, `review`,
`merge`, `close`, `reopen`, `checkout`. `view` / `list` are read-only and run
silently; everything else asks the user to confirm in the host wrapper (deny →
exit 10).

For ad-hoc file transfers between this box and the host, use
`agentbox-ctl cp toHost <boxPath> <hostPath>` and
`agentbox-ctl cp fromHost <hostPath> <boxPath>` or `agentbox-ctl download claude` /
`download env` / `download config`. They RPC to the host and ask the user for
confirmation on the wrapper that runs `agentbox claude`; deny returns exit 10
(`denied by user`). Don't put any timeout on the command, it will run forever
and the user will be notified through multiple channels.

Box identity: /etc/agentbox/box.env and the AGENTBOX_* env vars.
