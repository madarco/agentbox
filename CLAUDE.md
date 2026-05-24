# AgentBox — context for Claude Code

`agentbox` is an npm CLI that spins up isolated sandboxes ("boxes") for coding agents (Claude Code, Codex, others) to work in, so they can't touch the host. Two backends share one provider abstraction: **Docker** (the default — one local container per box, isolated by per-box git branch in an in-container worktree against the bind-mounted host `.git/`) and **Daytona Cloud** (`--provider daytona` — a remote sandbox seeded from a host git bundle + per-agent credential volumes, reached via SSH-token attach and an in-sandbox bridge relay).

## Architecture overview

- **Boxes** — one isolated sandbox per agent run. The shape differs by provider but the abstraction is one `Provider` interface (`packages/core/src/provider.ts`):
  - **docker**: container `agentbox-<id|name>`; `/workspace` is the in-container git worktree on branch `agentbox/<box-name>`; host's `.git/` is bind-mounted RW so commits land on the host immediately. Boxes pause/unpause for cheap context switching and survive stop/start; `destroy` wipes the container + per-box volumes.
  - **daytona** (cloud): Daytona sandbox with `/workspace` seeded from a host `git bundle create` (incl. stash + untracked carry-over for the user's local state). Lifecycle goes through the Daytona SDK; agent credentials (`~/.claude`, `~/.codex`, `~/.config/opencode`) live in shared per-org volumes seeded from the host. Host↔box comms go through a per-box bridge URL (CloudFront preview) that the host relay's `CloudBoxPoller` long-polls.
- **In-box supervisor** (`@agentbox/ctl`) — reads `/workspace/agentbox.yaml` and runs the declared tasks/services under a DAG scheduler. Ships as `agentbox-ctl` inside every box (docker and cloud).
- **Host relay** (`@agentbox/relay`) — a host node process boxes call for things they have no credentials for (`git push`, checkpoint capture, `cp`/`download`) and to push status events. Keeps SSH keys out of the box. The cloud path drives the same relay via `CloudBoxPoller` + `executeCloudAction`.
- **Checkpoints** — `docker commit` (+ periodic `FROM scratch` flatten) for docker; Daytona snapshots (`sb._experimental_createSnapshot`) for cloud. Both flow through `provider.checkpoint.create`. `box.defaultCheckpoint` is the cross-provider fallback; `box.defaultCheckpointDocker` / `box.defaultCheckpointDaytona` override per provider.
- The full design — file-handling rationale, the checkpoint model, pause/resume strategy, what we explicitly rejected — lives in [`docs/architecture.md`](./docs/architecture.md) and [`docs/create-and-checkpoints.md`](./docs/create-and-checkpoints.md). Cloud-specific status lives in [`docs/daytona-backlog.md`](./docs/daytona-backlog.md). **Read them before making non-trivial changes to the lifecycle code.**

## Important notes

 - You have docker and you are authorized to run docker commands, inspect containers, run commands inside containers, etc.
 - For cloud work: the Daytona API key + org id live in `~/.agentbox/secrets.env` (managed by `agentbox daytona login`). You may use the Daytona SDK directly via `node` + `@daytonaio/sdk` to inspect / clean up sandboxes when a test leaves an orphan, or `agentbox prune --provider daytona -y` for the supported path.

## Testing / verifying

`create`, `claude`, `codex`, and `opencode` tee their progress to a file at
`~/.agentbox/logs/<command>.log`. The command prints `log: <path>` to stderr at
startup, and `~/.agentbox/logs/latest.log` always points at the most recent run.
The log is rotated 1-deep — the previous run is at `<command>.log.prev`.

When verifying a change:

- **Don't pick a blind long timeout.** Start the slow command in the background
  (e.g. `node apps/cli/dist/index.js create -y -n smoke &`), then
  `tail -f ~/.agentbox/logs/latest.log` to watch real progress. Stop waiting
  the moment the log shows what you need (e.g. `box ... ready` or a failed
  step). Don't sit on a 120s blocking call hoping it returns.
- **Interactive TUIs (`dashboard`, `claude`, `codex`, `opencode`):** drive them
  through `pnpm drive` (the PTY harness at `apps/cli/test/_harness/`).
  `pnpm drive start --name X -- node apps/cli/dist/index.js dashboard`, then
  `pnpm drive screen X` to read the rendered terminal and
  `pnpm drive send X "<C-a>q"` to send keystrokes. `pnpm drive --help` and
  `apps/cli/test/_harness/README.md` cover the surface.
- **Typical create check:** `node apps/cli/dist/index.js create -y -n smoke &`,
  then `tail -f ~/.agentbox/logs/create.log` until you see the BEGIN/END
  markers for each step. If a step's END never arrives, you've found the
  hang — inspect that step rather than killing the whole command.

## Conventions

- **TypeScript strict, ESM, `verbatimModuleSyntax`** — always `import type { … }` for types.
- **tsup** builds each package's `src/index.ts` → `dist/`. Don't reach into another package's `src/` from a sibling; consume via the package name.
- **vitest** for tests, default discovery (`test/**/*.test.ts`). Keep unit tests pure — no docker, no network. Integration testing is manual for now (see README → Development).
- **eslint + prettier**, flat config at repo root. `pnpm lint` and `pnpm format` are the commands.
- **commander** for CLI surface; **@clack/prompts** for any interactivity. Don't add a third prompts/CLI lib.
- **execa** for shelling out to `docker` (debuggable, no native deps). Don't introduce `dockerode` without a good reason. **One sanctioned native-dep exception**: `@homebridge/node-pty-prebuilt-multiarch` (ships ABI-stable N-API prebuilds, no end-user compiler) is used **only** by `agentbox dashboard` for the in-process terminal compositor. It is an `optionalDependencies` of `apps/cli` with a guarded dynamic import — a missing prebuild degrades `dashboard` to a clear error, never breaks the rest of the CLI.
- **No emojis in code or output** unless explicitly requested.
- **Comments only when the WHY is non-obvious** (a constraint, a workaround, a surprising invariant). Names should carry the WHAT.

## Documentation map

Each topic has a dedicated file under [`docs/`](./docs). Read the relevant one before changing that area.

- [`docs/architecture.md`](./docs/architecture.md) — the design doc: *why* the box/worktree/checkpoint model is shaped the way it is, and what was rejected.
- [`docs/create-and-checkpoints.md`](./docs/create-and-checkpoints.md) — implementation reference for `agentbox create` (file/git handling) and the checkpoint capture/restore mechanics.
- [`docs/repo-layout.md`](./docs/repo-layout.md) — the package tree, build wiring, and box-identifier / per-project-index resolution rules.
- [`docs/state.md`](./docs/state.md) — where every piece of state lives: `~/.agentbox/*`, docker objects, volumes, worktrees, the box image.
- [`docs/in-box-supervisor.md`](./docs/in-box-supervisor.md) — `@agentbox/ctl`: the DAG scheduler, tasks vs services, `ready_when`, `expose`/`WebProxy`, wire ops, config validation.
- [`docs/host-relay.md`](./docs/host-relay.md) — `@agentbox/relay`: the host process, per-box bearer token, endpoints, registration/rehydration, in-box `agentbox-ctl git`/`open`.
- [`docs/features.md`](./docs/features.md) — what works today (the full CLI lifecycle) and what is not built yet.
- [`docs/development.md`](./docs/development.md) — build + verify commands, manual end-to-end runs, the image-rebuild checklist, and assumed host environment.
- [`docs/cloud-providers.md`](./docs/cloud-providers.md) — Daytona (and future cloud) provider: how `--provider daytona` differs from docker, the bridge relay model, agent-credential volumes, signed preview URLs, known caveats.
- [`docs/daytona-backlog.md`](./docs/daytona-backlog.md) — what's done vs still missing on the cloud path. Quick index of where each cloud feature actually lives.
