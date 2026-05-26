---
name: agentbox
description: "Drive AgentBox from the host: spin up isolated sandboxes (\"boxes\") for coding agents, run them in parallel, queue background runs with -i, and push commits safely through the host relay. Use when the user wants to run Claude Code / Codex / OpenCode in a sandbox, start more boxes, attach to a running box, or otherwise operate the `agentbox` CLI on their laptop."
---

# AgentBox (host-side)

You are operating on the **user's host machine** (laptop / dev workstation), not inside a box. Use the `agentbox` CLI to provision isolated sandboxes for coding agents and to attach to them.

If you find yourself *inside* a box (`/workspace` exists and `AGENTBOX_RELAY_URL` is set in the env), this is the wrong skill — use the in-box `/agentbox-setup` skill instead.

## What AgentBox is, in one paragraph

AgentBox spins up one isolated sandbox per agent run — a local Docker container (default), a Daytona cloud sandbox (`--provider daytona`), or a Hetzner VPS (`--provider hetzner`). Each box has its own `/workspace`, but the host's `.git/` is shared, so commits made inside the box land on the host immediately. The agent inside the box has **no host credentials** — `git push`, opening URLs in the host browser, capturing checkpoints, and all other host-side operations flow through a small host process called the **relay** that runs alongside the CLI.

## The two starting commands

### `agentbox create`

Provision a box and stop. The box exists and is ready, but nothing is launched inside it.

```sh
agentbox create                       # docker, auto-named after the workspace
agentbox create -n review             # docker, friendly name
agentbox create --provider hetzner    # cloud VPS (requires `agentbox prepare --provider hetzner` once)
agentbox create --attach              # drop into a shell inside the box after create
```

Useful flags: `-n <name>` (friendly box name), `--provider docker|daytona|hetzner`, `--attach`, `-w <path>` (workspace to mount; defaults to `cwd`), `--snapshot <ref>` (start from a checkpoint).

Non-docker providers require a one-time `agentbox prepare --provider <name>` to bake the base image / snapshot.

### `agentbox claude`

Provision (same as `create`) and launch **Claude Code** inside the box, in a detachable tmux session. This is the main entry point most users want.

```sh
agentbox claude                       # docker, attaches your terminal
agentbox claude -n review             # second box, named
agentbox claude --provider hetzner    # cloud
agentbox claude -- --model sonnet     # extra args after `--` go to claude itself
```

While attached: **`Ctrl+a d`** detaches without killing claude. The box keeps running. Reattach with `agentbox claude attach <name|n>`.

Variants with the same shape for other agents: **`agentbox codex`**, **`agentbox opencode`**.

## `-i` / `--initial-prompt`: background queue

With `-i "<prompt>"`, `agentbox claude` (and `codex` / `opencode`) does **not** attach. It writes a job manifest to `~/.agentbox/queue/<id>.json` and exits immediately, printing the job id and log path. The host relay's queue loop drains these manifests respecting `queue.maxConcurrent` (global config; override per invocation with `--max-running <n>`).

Use this to fan out parallel agent runs:

```sh
agentbox claude -i "fix the failing test in src/auth and open a PR"
agentbox claude -i "draft a CHANGELOG entry from the last 20 commits"
agentbox claude -i "audit our dependencies for known CVEs"
```

Each call returns instantly. The queue drains them concurrently up to `queue.maxConcurrent`. Inspect / attach later:

```sh
agentbox dashboard                    # TUI with status + leader-key actions
agentbox claude attach <name|n>       # reattach to a specific box
```

Caveats: `-i` is currently **docker-only** (cloud sessions only start on attach, so background-mode has no place to seed the prompt). The host must have valid Claude Code credentials.

## Git through the host relay

**The box has no SSH keys, GPG keys, or git remote credentials.** Don't ask the user to add any. When an in-box agent (or a script you run inside the box) does `git push` or `git pull`, the AgentBox-provided `agentbox-ctl git` wrapper POSTs a JSON-RPC call to the host relay (`POST /rpc`, bearer-auth, loopback-only). The relay runs the **real** `git push origin …` on the host, using the user's `SSH_AUTH_SOCK`, `~/.gitconfig`, and identity — and streams stdout/stderr back into the box's terminal. The box's exit code matches the host's.

Implications for you, the host-side agent:

- Inside the box you can `git commit … && git push` exactly as normal. No setup needed.
- Pushes are gated host-side: the relay can require a confirm prompt for destructive operations (the user sees it in the dashboard footer, ~25 s TTL). If a push appears to hang, tell the user to check the dashboard.
- The relay process is started lazily by the first `agentbox create` / `agentbox claude` and persists across runs (PID at `~/.agentbox/relay.pid`, log at `~/.agentbox/relay.log`). You normally don't need to manage it.

## Other commands worth knowing

| Command | What it does |
| --- | --- |
| `agentbox dashboard` | TUI status + switcher across all boxes. The leader is **`Ctrl+a`** (e.g. `Ctrl+a u` opens the box's web URL; `Ctrl+a s` opens the in-box browser; `Ctrl+a q` quits). |
| `agentbox shell [n\|name]` | Interactive `bash -l` inside the box (also wrapped in tmux by default — detach with `Ctrl+a d`). |
| `agentbox url [n\|name]` | Open the box's web app URL (`<box-name>.localhost` via Portless) in the host browser. |
| `agentbox screen [n\|name]` | Open the box's **own** Chromium via VNC — useful for OAuth flows the agent inside the box initiates. |
| `agentbox code [n\|name]` | Open VS Code / Cursor pointed at the box. |
| `agentbox prepare --provider <name>` | One-time base image / snapshot build for `daytona` or `hetzner`. With no `--provider`, prints status across all providers. |
| `agentbox prune --provider <name>` | Clean up orphan boxes / images / snapshots for a provider (docker + daytona supported; hetzner pending). |

Per-project numeric index (`1`, `2`, …) and friendly name (`review`, `smoke`) both work wherever `<box>` is accepted. Index `1` is the first box created in the current workspace.

## Operating principles

1. **Never assume the host needs SSH keys forwarded into a box** — git is handled by the relay, by design.
2. **Use `-i` whenever the user asks for parallel agent work** rather than spawning multiple foreground sessions. Then point them at `agentbox dashboard` to watch progress.
3. **Pick the provider deliberately.** `docker` is the fast default. `--provider hetzner` gives a real VPS (heavier, isolated, requires `agentbox prepare --provider hetzner` once). `--provider daytona` is the managed cloud option.
4. **Cross-check before recommending a command.** If a flag isn't listed here, run `agentbox <command> --help` (it's safe and read-only) before suggesting it to the user.
5. **`/agentbox-setup` is a different skill.** It runs *inside* a box to generate `/workspace/agentbox.yaml`. Don't conflate the two.

## Reference

- Full docs live in the repo at `docs/` — start with `docs/architecture.md` and `docs/create-and-checkpoints.md` for the model, `docs/host-relay.md` for the relay, `docs/cloud-providers.md` for the cloud paths.
- npm package: `@madarco/agentbox` — `npm -g install @madarco/agentbox` (or `npx @madarco/agentbox <command>`).
