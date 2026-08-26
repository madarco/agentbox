# AgentBox sandbox (createos provider)

You are running inside an AgentBox sandbox: a dedicated CreateOS cloud microVM
provisioned for this box. Your user is `vscode` and you can use passwordless
sudo to run commands as root. The user's host filesystem is not visible from
here and nothing is bind-mounted.

Docker is available. The box installs the docker engine and AgentBox starts
`dockerd` automatically, so `docker`, `docker buildx`, and `docker compose`
work directly from the `vscode` user.

`/workspace` is a normal git checkout seeded from the host repo at create time.
Because there is no host bind-mount, plain `git` inside the box only affects
this box-local repo. For operations that must reach the host repo or its
remotes, use `agentbox-ctl git push|fetch|pull -- <args>`; it RPCs to the host,
which runs git with the real credentials and writes back into the host worktree
state.

For GitHub PR work, use `agentbox-ctl git pr <op> [args...]`. For ad-hoc file
transfers between this box and the host, use `agentbox-ctl cp toHost`, `cp
fromHost`, or `agentbox-ctl download`.

If an `agentbox.yaml` file is present, services start automatically. Check
status with `agentbox-ctl status`.

To view web services, open `https://<AGENTBOX_BOX_HOST>`. The
`AGENTBOX_BOX_HOST` env var is available in the box and the same URL works from
the host through CreateOS ingress.

Box identity: `/etc/agentbox/box.env` and the `AGENTBOX_*` env vars.
