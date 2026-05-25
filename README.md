<h1 style="font-weight:normal">
  AgentBox&nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/madarco/agentbox.svg?colorB=ff0000"></a>
  <a href="https://www.npmjs.com/package/@madarco/agentbox"><img src="https://img.shields.io/npm/d18m/%40madarco%2Fagentbox?label=npm" /></a>
  <img src="https://img.shields.io/github/stars/madarco/agentbox" />
</h1>

Run multiple agents in parallel, with a single command, on your PC, self-hosted
<br>

<p align="center">

![AgentBox](./docs/cover.jpg)
</p>

## How it works

Just run `agentbox claude` to automatically spin a new VM from the current folder.

- 📦 **Teleport** - Move your project to a dedicated VM, local on in the cloud, with a single command.
- 🤖 **Automatic** - Bring all your skills, plugins, and settings for **Claude Code**, **Codex**, **Open Code**
- 🌐 **A full Computer** — Dedicated browser, screen sharing, persisten shells and wermed up VS Code / Cursor IDE, with each box.
- 💾 **Checkpoints** — Sub <1s startup of new boxes from a previous checkpoint, auto pause to save cost/resources when not in use.
- 🔒 **Safe** - Your git credentials are kept on your local machine, with permission requests to push to the remote repository.

```sh
npx @madarco/agentbox claude # Start a persistent Claude Code in LOCAL docker box in a worktree, docker-in-docker, dedicated browser, etc.
```

### Complete setup:

```sh
npm -g install @madarco/agentbox

# Optionally pre-build the VM images:
agentbox prepare
agentbox prepare --provider hetzner

agentbox hetzner claude
# Ctrl +d to detach, claude keep going

# Persistent shells: 
agentbox shell

# add a second box:
agentbox claude
agentbox claude attach 2
agentbox shell 2

# Open local tunnel preview
agentbox url 2
# Or the in-box browser via webVNC:
agentbox screen 2
# Or connect to vscode/cursor:
agentbox code 2

# See status and quickly switch between agents:
agentbox dashboard

# Launch web screen viewer (VNC), open the web app URL, open VSCode/Cursor
agentbox screen
agentbox url
agentbox code
```

## Demo

![AgentBox demo](docs/demo.gif)

## Install

```sh
npm -g install @madarco/agentbox
```

Requirements: macOS (arm64 or Intel), Docker ([Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev/)), Node `>=20.10`. The first `agentbox create` / `agentbox claude` builds the `agentbox/box:dev` image (~1 GB, one-time).
Uses `portless` to give box web apps the same URL from inside the box and on the host.

## Cloud Providers

|                     | local docker              | hetzner                | daytona            |
| ------------------- | ------------------------- | ---------------------- | ------------------ |
| Support             | ✅                        | ✅                     | ⚠️ Partial         |
| Base image          | Dockerfile                | Setup script (Ubuntu)  | Dockerfile         |
| Live snapshots      | ✅                        | ✅                     | 🧪 Experimental    |
| Private preview URLs| ✅ (portless or OrbStack) | ✅ (portless)          | ✅ (native)        |

**Cloud setup** (optional — skip for local Docker)

- `agentbox daytona login` — interactive Daytona API key setup, saved to `~/.agentbox/secrets.env`
- `agentbox hetzner login` — interactive Hetzner Cloud token setup, saved to `~/.agentbox/secrets.env`
- `agentbox prepare [--provider daytona|hetzner]` — build the image and initial snapshot

## How to use

`<box>` is optional almost everywhere — it defaults to the box for the current project, or use its short index (`1`, `2`, …), name, or id prefix.

**Create & run**

- `agentbox create` — Create and start a new agent box (Docker container with FUSE overlay)
- `agentbox claude` — Create a sandboxed box and launch Claude Code in a detachable tmux session

**Access**

- `agentbox dashboard` — Box list + the selected box's live agent session
- `agentbox url` — Open a box's web app URL in the browser (even with no `expose:` service)
- `agentbox screen` — Open a box's VNC (noVNC) viewer in the browser
- `agentbox code` — Open a box in VS Code or Cursor via the Dev Containers extension
- `agentbox shell` — Open an interactive bash shell in a box
- `agentbox open` — Open a box's merged workspace in Finder
- `agentbox logs` — Print recent log lines from a box service; `-f` to stream

**Inspect**

- `agentbox list` (`ls`) — List all known agent boxes
- `agentbox status` — Show service + task status from a box's `agentbox-ctl` daemon
- `agentbox top` — Live resource monitor (cpu/mem/pids/disk) for a box, project, or all boxes

**Lifecycle**

- `agentbox start` — Start a stopped box (docker start + re-mount the FUSE overlay)
- `agentbox stop` — Stop a box (preserves the upper volume, `node_modules` included)
- `agentbox destroy` (`rm`) — Destroy a box and discard its upper volume
- `agentbox pause` / `agentbox unpause` — Freeze / resume a box (sub-second)

**Sync & state**

- `agentbox download` — Download a box's `/workspace` back into your host workspace (gitignore-aware)
- `agentbox cp <src> [dst]` — Copy individual files between host and box (like `docker cp`; direction picked by `name:` prefix)
- `agentbox checkpoint` (alias `checkpoints`) — List and manage project checkpoints (warm box state to start new boxes from); bare command lists, `checkpoint create` captures

**Advanced**

- `agentbox wait` — Block until the box reports all autostart units ready
- `agentbox prune` — Clean up orphan state records (and with `--all`, orphan docker resources)
- `agentbox self-update` — Update agentbox, wipe the box image so it rebuilds, reload the relay
- `agentbox config` — Read / write layered config (global, per-project, workspace `defaults:`)
- `agentbox relay` — Manage the host relay process (`status` / `stop` / `start` / `restart`)

Run `agentbox <command> --help` for command-specific options, or see the full [guide](./docs/guide.md).

## Development

```sh
git clone https://github.com/madarco/agentbox && cd agentbox
pnpm install && pnpm build
node apps/cli/dist/index.js --help
```

The full development workflow, stack, end-to-end smoke tests, and teardown live in the [guide](./docs/guide.md#development).

# Author

[Marco D'Alia](https://www.madarco.net) - [@madarco](https://x.com/madarco) - [Linkedin](https://www.linkedin.com/in/marcodalia/)

# License

MIT. See [LICENSE](./LICENSE).
