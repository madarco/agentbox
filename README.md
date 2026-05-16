# AgentBox

Launch Claude Code, Codex, and other coding agents inside isolated sandboxes — local Docker today, remote providers (E2B / Modal / Daytona / Vercel Sandbox) later.

**Status:** early work in progress. See [`docs/architecture.md`](./docs/architecture.md) for the design.

## What it does

`agentbox create` spins up a Docker container per project, with a three-layer **FUSE overlay** filesystem:

- **lower** — your host workspace, bind-mounted read-only (or a frozen APFS clone of it)
- **upper** — a per-box named volume that captures all writes
- **`/workspace`** — the merged overlay the agent actually sees

Result: the agent can `git commit`, install packages, scribble files — without touching your host. `node_modules` (and `.next`, `target`, `.venv`, …) lives in the per-box writable overlay layer — isolated per box, captured by `agentbox open --upper`; the generated `agentbox.yaml` install task rebuilds it inside the Linux box so macOS binaries don't leak in. `~/.codex` and `~/.gitconfig` are bind-mounted opportunistically so the agent inherits your identity. **Claude Code state** (auth tokens, skills, plugins, settings, MCP config) lives in a named Docker volume `agentbox-claude-config` mounted at `/home/vscode/.claude`; the host is the authoritative source — every `agentbox create` / `agentbox claude` rsyncs your host's `~/.claude` into the volume so updates on the host (new login, new skills, new MCP servers) flow into the next box you spin up. Sync is additive: files written inside earlier boxes (session history, etc.) are preserved.

## Quick start

Requires macOS (arm64 or Intel), Docker (Docker Desktop or OrbStack), Node `>=20.10`, and pnpm `>=9`.

```sh
pnpm install
pnpm build
node apps/cli/dist/index.js create --help
```

Create your first box against the current directory:

```sh
node apps/cli/dist/index.js create
# pick "yes" at the snapshot prompt (recommended)
```

First run pulls and builds the `agentbox/box:dev` image (~1 GB, ~30 s on a warm pull). Subsequent runs are instant.

Once the box is up:

```sh
docker exec -it agentbox-<id> bash
# inside: cd /workspace; ls; echo hi > note.txt; ls /upper/upper/
```

## Commands

```sh
agentbox create [-w <path>] [-n <name>] [--snapshot | --no-snapshot] [--with-env] [--attach] [-y]
                                    # --with-env copies host .env*/secrets.toml/agentbox.yaml into /workspace
agentbox claude [-w <path>] [-n <name>] [--snapshot | --no-snapshot] [--isolate-claude-config]
                [--with-env] [--session-name <name>] [-y] [-- <claude-args>...]
                                    # create + start Claude Code in detached tmux + attach
agentbox claude attach <box> [--session-name <name>]   # reattach to the running session
agentbox list                       # alias: ls
agentbox inspect <box> [--json]
agentbox status <box> [--json]                  # services + claude session state
agentbox logs <box> <service> [-f] [-n <tail>]  # tail or stream a service's stdout/stderr
# inside a box: agentbox-ctl validate [path]    # check agentbox.yaml shape without starting the daemon
# inside a box: agentbox-ctl claude-session [--json]   # report tmux 'claude' session state
agentbox pause <box>                # docker pause — 0 CPU, RAM stays mapped
agentbox unpause <box>              # docker unpause — sub-second resume
agentbox stop <box>                 # docker stop — preserves the upper volume (node_modules included)
agentbox start <box>                # docker start + re-mount the FUSE overlay + relaunch ctl daemon
agentbox open <box> [--upper] [--no-refresh] [--include-node-modules] [--print]
                                    # open the box's workspace in Finder (refreshes via rsync first)
agentbox path <box> [--upper] [--refresh] [--include-node-modules]
                                    # print the host path; --refresh runs the same rsync as `open`
agentbox pull [box] [--with-env] [--dry-run] [-y]   # box -> host pull of /workspace (gitignore-aware)
agentbox pull env [box] [--dry-run] [-y]            # just gitignored env/config files
agentbox pull config [box] [--dry-run] [-y]         # just agentbox.yaml (gitignore-bypassing)
agentbox pull claude [box] [--dry-run] [-y]         # additive box -> host pull of ~/.claude skills/plugins/agents/commands
                                    # reads the claude-config volume (box may be stopped); never overwrites; skips agentbox-* skills
agentbox destroy <box> [-y] [--keep-snapshot]   # alias: rm — discards upper volume
agentbox prune [--dry-run] [--all] [-y]         # default: drops "missing" state records
```

`<box>` resolves against `~/.agentbox/state.json` in this order: exact id → unique id prefix → exact name → exact container name. So `agentbox destroy abc1` works as long as the prefix is unique.

Quick tour:

```sh
agentbox create -n alpha          # spin one up
agentbox list                     # see it
agentbox inspect alpha            # state, overlay status, claude session, sizes
agentbox pause alpha              # freeze (TS server cache, RAM all stays)
agentbox unpause alpha            # resume
agentbox stop alpha               # full shutdown
agentbox start alpha              # restart + re-mount the overlay
agentbox destroy alpha            # nuke it (prompts to confirm — `-y` to skip)
agentbox prune --all              # clean up any orphan containers/volumes/snapshots
```

### Browsing what the agent did (`open` / `path`)

The box's `/workspace` is a **FUSE-overlay filesystem that only exists inside the container** — it composes the read-only lower (your snapshot) with the writable upper (a named Docker volume) on the fly. That means the merged view can't be browsed live from macOS: there's nothing on the host side for the in-container FUSE mount to point at. `agentbox open` works around this by rsyncing the merged view into a per-box host directory you can open in Finder.

```sh
agentbox open mybox                       # rsync /workspace → ~/.agentbox/boxes/<id>/workspace, then Finder
agentbox open mybox --upper               # the writes layer only (see live note below)
agentbox open mybox --no-refresh          # open whatever's already on disk; skip the rsync
agentbox open mybox --include-node-modules# merged export: include /workspace/node_modules (off by default — it's big; --upper always carries it)
agentbox open mybox --print               # still refreshes; prints the host path instead of launching Finder
agentbox path mybox [--upper] [--refresh] # just the host path — pipe it into your editor / scripts
```

The merged export lives at `~/.agentbox/boxes/<id>/workspace`, the upper-only export at `~/.agentbox/boxes/<id>/upper`. The rsync runs inside the box (`docker exec rsync`) targeting a virtiofs bind-mount, so a refresh is a single mostly-zero-copy operation.

**OrbStack only — live upper layer.** OrbStack exposes every Docker volume at `~/OrbStack/docker/volumes/<name>/`, so the writes layer (`agentbox-upper-<id>/upper/`) is **already** browsable live on macOS without any refresh. `agentbox open --upper` returns that path directly when OrbStack is detected and falls back to an rsync of `/upper/upper` into `~/.agentbox/boxes/<id>/upper/` on Docker Desktop or any other engine. The merged view still requires a refresh on both engines — the FUSE composition only exists inside the container.

### Running Claude Code in a box

```sh
agentbox claude -n cc                          # snapshot + start claude REPL, attach via tmux
# (in tmux) press Ctrl-b d to detach — claude keeps running
agentbox claude attach cc                      # reattach later
agentbox claude -n one-off -- --model sonnet   # pass-through args after `--`
agentbox claude -n iso --isolate-claude-config # opt out of the shared identity volume
```

By default every `claude` box mounts the shared `agentbox-claude-config` Docker volume at `/home/vscode/.claude`. On every box creation the host's `~/.claude` is rsynced into that volume, so the host is the source of truth — install skills and sign in on the host once, and every new box picks up the latest. Host's `~/.claude.json` (the file at home root, containing onboarding state, anonymous id, plugin/cache state, and OAuth account info) is also synced in via an in-volume symlink, so a fresh box doesn't re-trigger first-run onboarding. `--isolate-claude-config` opts into a per-box volume (`agentbox-claude-config-<id>`) that still gets seeded from host on creation but then diverges independently; it's removed when the box is destroyed. `agentbox destroy` **never** auto-removes the shared volume — delete it manually with `docker volume rm agentbox-claude-config` if you need to. Setting `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` on the host forwards it into the container at create time.

Hook commands whose path is under your host home (e.g. `/Users/you/.config/iterm2/...`) are filtered out of the in-volume copy automatically. Hooks resolved via `PATH`, hooks under `/workspace`, and project-level hooks in your workspace's `.claude/settings.json` are kept untouched. The host file is never modified — the filter only affects the synced copy. (Smarter remapping of project-internal paths is a future enhancement.) The synced `.claude.json` also has its `installMethod` field stripped, because the box image installs Claude Code via Anthropic's native installer (`curl https://claude.ai/install.sh | bash -s stable`) and the host's recorded install method may not match; claude inside the box redetects on first run.

**First-run auth onboarding.** macOS Keychain doesn't transfer into containers, so the first `agentbox claude` without a token offers to run `claude setup-token` for you. After the OAuth flow you paste the printed token once, and it's saved to `~/.agentbox/auth.json` (mode 0600). Every later `agentbox claude` forwards it silently as `CLAUDE_CODE_OAUTH_TOKEN`. Resolution order: `ANTHROPIC_API_KEY` env → `CLAUDE_CODE_OAUTH_TOKEN` env → `~/.agentbox/auth.json`. To rotate the saved token: `rm ~/.agentbox/auth.json` then run `agentbox claude` again. Pass `-y` (or run with stdin not a TTY) to skip the prompt entirely — useful for CI; the box will just show "Run /login" inside.

### Docker inside the box (Docker-in-Docker)

Every box ships with its own `dockerd` so the agent can `docker build`, `docker run`, and bring up compose stacks **without** seeing your host's Docker daemon. The inner daemon runs in the box's own mount + network namespaces, so anything it spawns is contained. Storage driver is `fuse-overlayfs` (no host kernel module required), and the outer container is **not** `--privileged` — just the same `SYS_ADMIN` / `/dev/fuse` set the FUSE workspace overlay already needs, plus `NET_ADMIN`, `seccomp=unconfined`, and `--cgroupns=private` so the inner bridge networking + cgroup slice work.

```sh
agentbox shell mybox -- docker version            # client + server, both inside the box
agentbox shell mybox -- docker run --rm hello-world
agentbox shell mybox -- bash -lc 'cd /workspace && docker compose up -d'
```

The in-container `vscode` user is in the `docker` group, so no `sudo` needed.

The data root `/var/lib/docker` lives in a per-box named volume (`agentbox-docker-<id>`) that's wiped on `agentbox destroy` — clean slate per box. If you want pulled image layers to persist across boxes, opt into the shared cache:

```sh
agentbox create --shared-docker-cache -n cached-box   # uses agentbox-docker-cache volume
# or set it as the default for every box
agentbox config set box.dockerCacheShared true --global
```

The shared cache is preserved on `destroy` and allowlisted in `prune --all`. Caveat: dockerd takes an exclusive lock on `/var/lib/docker`, so only **one** box at a time can run with the shared cache mounted — fine for serial workflows, not for parallel ones.

`--privileged` is intentionally avoided so the same setup runs in cloud sandboxes (E2B, Modal, Vercel Sandbox, …) that accept the `cap_add` path but reject privileged. Tested on OrbStack; the same flags work on Docker Desktop (`--cgroupns=private` + the in-box remount of `/sys/fs/cgroup` and `/proc/sys` are the load-bearing bits — both engines bind those RO into containers under their default hardening, and the box does the remount itself with its `SYS_ADMIN` capability without affecting the host).

## Layout

```
apps/cli/                 → published as `agentbox` (the npm bin, commander-based)
packages/core/            → @agentbox/core — sandbox provider interface, types
packages/sandbox-docker/  → @agentbox/sandbox-docker — local Docker provider
packages/ctl/             → @agentbox/ctl — in-box supervisor daemon (`agentbox-ctl`)
packages/relay/           → @agentbox/relay — host-side HTTP relay (`agentbox-relay`) for box→host push & RPCs
docs/architecture.md      → the FUSE-overlay design + lifecycle rationale
```

Remote sandbox adapters (E2B, Modal, Daytona, Vercel Sandbox) will be added as separate packages.

## Running services inside a box (`agentbox.yaml`)

Each box ships with `agentbox-ctl`, a supervisor that reads `/workspace/agentbox.yaml` (i.e. an `agentbox.yaml` at the root of your project) and keeps the declared services alive. It starts automatically on `agentbox create` and `agentbox start`.

```yaml
# agentbox.yaml — at the project root
services:
  web:
    command: pnpm dev
    cwd: apps/web                # relative to /workspace
    env:
      PORT: '3000'
  worker:
    command: ['node', 'dist/worker.js']
    restart: always              # always | on-failure (default) | never
    backoff:
      initial_ms: 1000
      max_ms: 60000
      factor: 2
```

Inspecting from the host:

```sh
agentbox status mybox                       # table of services + state + pid + restarts
agentbox logs mybox web --tail 200          # recent stdout/stderr
agentbox logs mybox web -f                  # stream live
```

Or from inside the box:

```sh
docker exec -it agentbox-mybox bash
agentbox-ctl status
agentbox-ctl restart web
agentbox-ctl reload                         # re-read agentbox.yaml, diff-apply
agentbox-ctl logs worker -f
```

Per-service log files live at `/var/log/agentbox/<service>.log` inside the container. The supervisor's control socket is at `/run/agentbox/ctl.sock` (also bind-mounted to `~/.agentbox/boxes/<id>/run/ctl.sock` on the host for diagnostics). Host-side `agentbox status` and `agentbox logs` reach the daemon by shelling into the container — connecting to the bind-mounted socket directly doesn't work across Docker Desktop / OrbStack's VM boundary.

## Box → host push & RPCs (`agentbox-relay`)

The supervisor's control socket is one-directional: the host opens connections, the box answers. For the other direction — boxes pushing notifications to the host, or asking the host to perform something the box doesn't have credentials for (e.g. `git push` over SSH) — there's a small HTTP service called the **relay**.

The relay runs as its own Docker container (`agentbox-relay`) on a user-defined network (`agentbox-net`). It's a singleton: lazily started on the first `agentbox create` / `agentbox claude`, reused by every subsequent box, and preserved by `agentbox destroy` / `agentbox prune --all` (like the shared `agentbox-claude-config` volume).

Each box is attached to `agentbox-net` and gets two env vars:

- `AGENTBOX_RELAY_URL` — `http://agentbox-relay:8787` (resolved via docker DNS)
- `AGENTBOX_RELAY_TOKEN` — a 32-byte per-box bearer token generated at create time

The token is registered with the relay before the box starts, so the in-box supervisor can post events immediately on boot.

### Wire protocol

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /events` | Bearer (box token) | Append a `{type, ts?, payload?}` event to the relay's in-memory ring buffer (1000 entries). Returns `202 {id}`. |
| `POST /rpc`    | Bearer | Submit `{method, params?}`. **PoC: returns `501`** with the method echoed back. The framework is in place — a host-side executor for things like `git.push` is the next step. |
| `GET /healthz` | none | Liveness probe. |
| `POST /admin/register-box` | network-internal | Called by the host CLI via `docker exec agentbox-relay agentbox-relay register …`. |
| `POST /admin/forget-box`   | network-internal | Called on `agentbox destroy`. |
| `GET /admin/events`        | network-internal | Tail the ring buffer; query: `box`, `since`. |
| `GET /admin/registry`      | network-internal | List registered boxes (tokens redacted). |

Admin endpoints have no auth because they're only reachable from inside `agentbox-net` — the relay doesn't publish a host port. To inspect from the host, shell in: `docker exec agentbox-relay agentbox-relay tail [--box <id>]`.

### Posting from inside a box

The in-box `agentbox-ctl` supervisor automatically POSTs `service-state` and `task-state` events on transitions like `ready` / `crashed` / `backoff` / `unhealthy` / `done` / `failed`. Agents and user code in the box can post their own:

```sh
# inside the box
curl -sS -H "Authorization: Bearer $AGENTBOX_RELAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"notify","payload":{"text":"long job finished"}}' \
     "$AGENTBOX_RELAY_URL/events"
# → HTTP 202, {"id":N}
```

### Restart resilience

The relay's registry and event buffer live in process memory. If the relay container restarts (host reboot, `docker restart agentbox-relay`, image rebuild), the registry is empty until each box re-registers — and existing boxes' tokens are no longer valid. To self-heal, `agentbox create` rehydrates the relay from `~/.agentbox/state.json` (every box's `relayToken` field) on every invocation. Idempotent and cheap.

### Roadmap

`/rpc` is the channel; the host-side executor isn't built yet. The intended first RPC is `git.push` — boxes don't carry SSH keys / git credentials by design, so they POST `{method: "git.push", params: {ref, remote}}` and a host-side worker (subscribing to relay events) runs the push using the host's identity. Designs for the executor (long-poll subscription vs. shared-volume queue) are tracked separately.

### Editor support (autocomplete + validation)

A JSON Schema ships with `@agentbox/ctl` at `packages/ctl/schema/agentbox.schema.json`. Add this comment to the top of your `agentbox.yaml` and any YAML-LSP-aware editor (VS Code with the Red Hat **YAML** extension, JetBrains IDEs, Cursor, neovim with `yaml-language-server`) gives you key completion, hover docs, and inline error squiggles:

```yaml
# yaml-language-server: $schema=<path-or-url-to-schema>
```

Three ways to point at the schema, in order of convenience:

1. **Inside this repo** — nothing to do. `.vscode/settings.json` already maps `agentbox.yaml` → the in-tree schema.
2. **Your own project, with `@agentbox/ctl` installed** — use the local path: `# yaml-language-server: $schema=./node_modules/@agentbox/ctl/schema/agentbox.schema.json`.
3. **Anywhere else** — point at a hosted copy of `agentbox.schema.json` (URL form). Once we publish the schema, the docs here will link to the canonical URL.

### `agentbox-ctl validate`

To check an `agentbox.yaml` without booting a container — useful from CI or an editor task:

```sh
docker exec -it agentbox-mybox agentbox-ctl validate              # /workspace/agentbox.yaml
# or against an arbitrary file:
docker exec -it agentbox-mybox agentbox-ctl validate /tmp/x.yaml
```

Exit code 0 with `OK: N service(s)`, or 2 with the first error (e.g. `services.web.backoff.max_ms must be >= initial_ms`).

`agentbox create` runs the same validator on the host **before** any container work, so a broken `agentbox.yaml` fails create early instead of silently crashing the in-box daemon.

## Development

### Iterating on the CLI

One-shot (after a build):

```sh
node apps/cli/dist/index.js create --help
node apps/cli/dist/index.js create --no-snapshot -n my-box
node apps/cli/dist/index.js create --snapshot -y
```

Watch-rebuild while editing source:

```sh
# terminal 1 — rebuilds on every save
pnpm --filter agentbox dev

# terminal 2 — invoke the freshly-built bin
node apps/cli/dist/index.js create
```

Use `agentbox` from anywhere on disk:

```sh
pnpm --filter agentbox exec npm link
agentbox create -w /path/to/some/other/project
# undo with: pnpm --filter agentbox exec npm unlink -g
```

### Workspace scripts

```sh
pnpm build       # turbo run build (tsup per package)
pnpm test        # turbo run test  (vitest run)
pnpm lint        # eslint via flat config
pnpm typecheck   # tsc --noEmit per package
pnpm format      # prettier --write .
pnpm clean       # nuke dist/ + .turbo/ + node_modules/
```

### Tearing down test boxes

During testing you'll create lots of boxes. The clean way:

```sh
agentbox list                     # see what's there
agentbox prune --all -y           # remove orphan containers/volumes/snapshot dirs
# or, to nuke one by one:
agentbox destroy <id|name> -y
```

If something goes really sideways and `agentbox` itself can't reach a clean state, the raw escape hatch is:

```sh
docker rm -f $(docker ps -aq --filter "name=agentbox-")
docker volume ls -q | grep "^agentbox-" | xargs -r docker volume rm
docker network rm agentbox-net 2>/dev/null || true
docker rmi agentbox/relay:dev 2>/dev/null || true
rm -rf ~/.agentbox/snapshots/*
echo '{"version":1,"boxes":[]}' > ~/.agentbox/state.json
```

### Stack

- **pnpm 9** workspaces + **Turborepo 2** for task orchestration
- **TypeScript 5** strict + `verbatimModuleSyntax`, ESM
- **tsup** (esbuild) for package builds, **vitest** for tests
- **ESLint 9** flat config + **Prettier 3**, **changesets** for versioning
- **commander** for the CLI, **@clack/prompts** for interactive prompts
- **execa** to shell out to `docker`

## License

MIT. See [`LICENSE`](./LICENSE).
