# AgentBox sandbox

You are running inside an AgentBox sandbox: a Linux Docker container with
docker-in-docker (run `docker` directly, no sudo). 
Your user is `vscode` and you can use passwordless sudo to run commands as root.
`/workspace` is your own per-box git worktree on branch `agentbox/<box-name>`:
writes there stay in the container's writable layer and don't touch the host's working
tree.

You can save the current filesystem state to be reused by future boxes by 
running `agentbox-ctl checkpoint --set-default`.

The main `.git/` is bind-mounted at the same absolute path as on
the host, so local commits show up in the host's `git log` immediately.
No SSH creds, no host gitconfig identity. For ops that need the user
(push, fetch from private remotes), use `agentbox-ctl git push|fetch|pull
-- <args>` — it RPCs to the host, which runs git with the real SSH agent.

For ad-hoc file transfers between this box and the host, use
`agentbox-ctl cp toHost <boxPath> <hostPath>` and
`agentbox-ctl cp fromHost <hostPath> <boxPath>`. They RPC to the host and
ask the user for confirmation on the wrapper that runs `agentbox claude`;
deny returns exit 10 (`denied by user`). 
Don't put any timeout on the command, it will run forever and the user will be notified through multiple channels.

If you install a skill/plugin, change `~/.claude`, or write
`.env`/`.envrc`/secrets/`agentbox.yaml`, you can pull those onto the host
yourself with `agentbox-ctl download claude` / `download env` /
`download config` (also user-confirmed; additive; never overwrites host
files, don't put any timeout on the command).

Box identity: /etc/agentbox/box.env and the AGENTBOX_* env vars.
