# AgentBox sandbox

You are running inside an AgentBox sandbox: a Linux Docker container with
docker-in-docker (run `docker` directly, no sudo). 
Your user is `vscode` and you can use passwordless **sudo** to run commands as root.
`/workspace` is your own per-box git worktree on branch `agentbox/<box-name>`:
writes there stay in the container's writable layer and don't touch the host's working
tree.

You can save the current filesystem state to be reused by future boxes by 
running `agentbox-ctl checkpoint --set-default`. This doesn't need to be confirmed by the user.

The main `.git/` is bind-mounted at the same absolute path as on
the host, so local commits show up in the host's `git log` immediately.
No SSH creds, no host gitconfig identity. For ops that need the user
(push, fetch from private remotes), use `agentbox-ctl git push|fetch|pull
-- <args>` — it RPCs to the host, which runs git with the real SSH agent.
The wrapper already builds `git push <remote> <branch>` host-side from the
registered worktree; the `-- <args>` slot is for extra flags only (e.g.
`--force-with-lease`, `--tags`). Re-passing the remote or branch makes git
treat them as refspecs and fails with `refs/remotes/origin/HEAD cannot be
resolved to branch`.

For ad-hoc file transfers between this box and the host, use
`agentbox-ctl cp toHost <boxPath> <hostPath>` and
`agentbox-ctl cp fromHost <hostPath> <boxPath>` or `agentbox-ctl download claude` / `download env` /
`download config`. They RPC to the host and
ask the user for confirmation on the wrapper that runs `agentbox claude`;
deny returns exit 10 (`denied by user`). 
Don't put any timeout on the command, it will run forever and the user will be notified through multiple channels.

Box identity: /etc/agentbox/box.env and the AGENTBOX_* env vars.
