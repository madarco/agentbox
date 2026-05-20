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

If you install a skill/plugin (or otherwise change `~/.claude`), tell the
user to run `agentbox download claude` on the host to copy it back. If you
create or change `.env`/`.envrc`/secrets files, tell them to run
`agentbox download env`. Both are additive and never overwrite host files.

Box identity: /etc/agentbox/box.env and the AGENTBOX_* env vars.
