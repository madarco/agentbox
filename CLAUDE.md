# AgentBox — context for Claude Code

`agentbox` is an npm CLI that spins up isolated Docker containers ("boxes") for coding agents (Claude Code, Codex, others) to work in, so they can't touch the host. Each box gets a FUSE overlay filesystem: the host workspace is bind-mounted read-only (or as a frozen APFS clone) and all writes go to a per-box named volume.

The full design — three-layer overlay, snapshot rationale, pause/resume strategy, what we explicitly rejected — lives in [`docs/architecture.md`](./docs/architecture.md). **Read it before making non-trivial changes to the lifecycle code.**

## Important notes

 - You have docker and you are authorized to run docker commands, inspect containers, run commands inside containers, etc.

## Repo layout

```
apps/cli/                   commander-based npm bin (`agentbox`), entry `src/index.ts`
  src/commands/             one file per subcommand (create, claude, list, inspect, pause, unpause, stop, start, open, path, destroy, prune)
  src/commands/_errors.ts   shared lifecycle-error → user-facing message mapper
packages/core/              @agentbox/core — SandboxProvider interface, BoxState, etc.
packages/sandbox-docker/    @agentbox/sandbox-docker — the local Docker provider
  Dockerfile.box            base:ubuntu + fuse-overlayfs + node + python + tmux + claude (native installer, stable channel) + bundled agentbox-ctl
  src/create.ts             create orchestrator: image → snapshot? → volumes → run → mount → verify → ctl daemon → persist
  src/claude.ts             helpers for the named claude-config volume and the in-box tmux session (start/attach/info)
  src/lifecycle.ts          list/inspect/pause/unpause/stop/start/destroy/prune/open/path; BoxNotFoundError + AmbiguousBoxError
  src/host-export.ts        per-box host export plumbing (merged + upper layers, OrbStack live-upper)
  src/ctl.ts                launchCtlDaemon — `docker exec -d` the in-box supervisor
  src/{docker,image,overlay,snapshot,state}.ts
packages/ctl/               @agentbox/ctl — in-container supervisor + CLI (`agentbox-ctl`)
  src/bin.ts                bundled CJS bin (dist/bin.cjs, baked into the image)
  src/{daemon,supervisor,socket,client,config,render}.ts
docs/architecture.md        the design doc — source of truth for *why*
```

**Box identifier resolution** (shared by every lifecycle command that takes `<box>`): `findBox(idOrName, state)` in `state.ts` matches in order: exact id → unique id prefix → exact name → exact container. Ambiguous prefix → `AmbiguousBoxError`; no match → `BoxNotFoundError`. Use `resolveBox()` in `lifecycle.ts` to get a `BoxRecord` from a CLI arg.

Internal deps are wired via `workspace:*`. Build order is enforced by Turborepo (`^build`).

## Conventions

- **TypeScript strict, ESM, `verbatimModuleSyntax`** — always `import type { … }` for types.
- **tsup** builds each package's `src/index.ts` → `dist/`. Don't reach into another package's `src/` from a sibling; consume via the package name.
- **vitest** for tests, default discovery (`test/**/*.test.ts`). Keep unit tests pure — no docker, no network. Integration testing is manual for now (see README → Development).
- **eslint + prettier**, flat config at repo root. `pnpm lint` and `pnpm format` are the commands.
- **commander** for CLI surface; **@clack/prompts** for any interactivity. Don't add a third prompts/CLI lib.
- **execa** for shelling out to `docker` (debuggable, no native deps). Don't introduce `dockerode` without a good reason.
- **No emojis in code or output** unless explicitly requested.
- **Comments only when the WHY is non-obvious** (a constraint, a workaround, a surprising invariant). Names should carry the WHAT.

## Where state lives

- `~/.agentbox/state.json` — registry of created boxes
- `~/.agentbox/auth.json` (mode 0600) — long-lived Claude OAuth token captured on first `agentbox claude` via `claude setup-token`. Forwarded to every box as `CLAUDE_CODE_OAUTH_TOKEN`. Host env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) override it.
- `~/.agentbox/snapshots/<id>/` — frozen APFS clones of host workspaces
- `~/.agentbox/boxes/<id>/run/ctl.sock` — host-side view of the in-box ctl socket (bind-mounted to `/run/agentbox/` in the container)
- `~/.agentbox/boxes/<id>/workspace` and `~/.agentbox/boxes/<id>/upper` — per-box host export targets for `agentbox open` / `agentbox path`. **They are empty until refresh runs** — that's by design. `createBox` `mkdir`s both at create-time and bind-mounts them into the container at `/host-export` and `/host-export-upper` (virtiofs on OrbStack); `refreshExport` in `host-export.ts` does `docker exec rsync /workspace/ /host-export/` (or `--exclude=node_modules` by default for the merged layer). The container `/workspace` mount is `fuse-overlayfs` and lives **only inside the container's mount namespace** — it cannot be reached from the Mac directly, which is why a copy is needed. The upper layer (`agentbox-upper-<id>/upper/`) is a different story on OrbStack: every Docker volume is exposed live at `~/OrbStack/docker/volumes/<name>/`, so `resolveUpperLiveOnHost` returns that path and `agentbox open --upper` skips the rsync entirely. Docker Desktop has no equivalent, so we fall back to the same rsync into `boxes/<id>/upper/`. `agentbox open --print` still refreshes (use `--no-refresh` to skip), so scripts that pipe the path get a fresh snapshot in one call. Boxes created before the bind-mounts existed (`/host-export` absent) fall back to a `docker exec tar | tar -x` pipe into the host dir — slower but doesn't need a container restart.
- Docker objects: containers `agentbox-<id|name>`, volumes `agentbox-upper-<id>` + `agentbox-nm-<id>` + the Claude Code config volume (`agentbox-claude-config` shared by default, or `agentbox-claude-config-<id>` when `--isolate-claude-config` is set). Host's `~/.claude` is the authoritative source: every `create` / `claude` rsyncs host -> volume (additive — host wins on overlap, box-only files like session logs are preserved). Host's `~/.claude.json` (file, not directory) also syncs into the volume as `_claude.json`; an image-baked symlink at `/home/vscode/.claude.json -> /home/vscode/.claude/_claude.json` routes claude's reads/writes through the volume. Hook commands referencing host-absolute paths under `$HOME/` are filtered out during sync (`packages/sandbox-docker/src/claude-hooks-filter.ts`) so the in-box claude doesn't spam `cc-status: not found` errors. The same module's `clearInstallMethod` strips the top-level `installMethod` field from the synced `_claude.json` so the in-box claude (installed via Anthropic's native installer at `/home/vscode/.local/bin/claude`) redetects rather than trip an integrity warning when the host recorded a different install method. The rsync also runs with `--copy-unsafe-links` so user-skill symlinks (e.g. `~/.claude/skills/<x> -> ../../.agents/skills/<x>`) are dereferenced into real directories inside the volume — `~/.agents` is **not** bind-mounted. The rsync excludes `node_modules` so the host's darwin-arm64 plugin binaries (`fsevents.node`, `@esbuild/darwin-arm64`, `@rollup/rollup-darwin-arm64`, sharp, …) never reach the linux box; `rebuildPluginNativeDeps()` then re-runs `npm install` for each plugin cache the first time `agentbox claude` launches in a fresh box (idempotent — gated by a per-plugin `.agentbox-installed` marker, since some plugins have empty dep lists that don't produce a `node_modules/` dir). A one-shot migration in the rsync helper wipes pre-existing `node_modules/` from the shared volume the first time a post-upgrade sync runs (sentinel `~/.claude/.agentbox-cleaned-nm-v1`); without it, existing users would keep darwin binaries indefinitely. Every top-level JSON under `~/.claude/plugins/` (currently `installed_plugins.json` + `known_marketplaces.json`) has its host-home prefix rewritten to `/home/vscode` via an inline `sed` sweep in the helper container — without rewriting `known_marketplaces.json.installLocation`, claude can't load the marketplaces (it falls back to a `<org>-<repo>` slug derived from `source.repo` like `microsoft-playwright-cli`, which doesn't exist on disk, masquerading as "Plugin X not found in marketplace Y" for every plugin in the marketplace). `claude-hooks-filter.ts`'s `addProjectAlias` duplicates `_claude.json.projects[<host-cwd>]` to `projects['/workspace']` so project-scoped MCP servers / trust / history apply inside the box (workspace is always `/workspace` regardless of host path). The shared volume is **never** auto-removed by `destroy` or `prune` (it holds user identity); per-box isolated volumes are removed with their box.
- The box image is `agentbox/box:dev`, built locally from `packages/sandbox-docker/Dockerfile.box`. **Build context is the monorepo root** (so the Dockerfile can `COPY packages/ctl/dist/bin.cjs`); see `BUILD_CONTEXT_DIR` in `image.ts`.

## In-box supervisor (`@agentbox/ctl`)

- Reads `/workspace/agentbox.yaml`; runs declared services, restarts crashed ones with exponential backoff, captures logs to `/var/log/agentbox/<svc>.log`.
- Listens on `/run/agentbox/ctl.sock` (UNIX socket, newline-delimited JSON). Both the in-box `agentbox-ctl` client and host commands talk to the same socket — but the **host commands shell in via `docker exec`**, not the bind-mounted socket: Docker Desktop / OrbStack's VM boundary breaks `connect()` from the mac side, even though the file is visible.
- Launched by `launchCtlDaemon()` in `sandbox-docker/src/ctl.ts` (best-effort; missing/empty `agentbox.yaml` is fine and doesn't fail `create`). Same call is repeated in `startBox()` because the daemon dies with the container — same lifecycle as `mountOverlay()`.
- The bin is built as **CJS** (`dist/bin.cjs`) with all deps bundled — esbuild's ESM output poisons `require()` from CJS deps like commander. Library entry (`dist/index.js`) stays ESM.
- **Config validation has two sources of truth that must agree**: the runtime parser in `packages/ctl/src/config.ts` (used by the daemon and the host pre-flight) and the JSON Schema at `packages/ctl/schema/agentbox.schema.json` (used by editors). `packages/ctl/test/schema-drift.test.ts` feeds the same fixtures to both and asserts they accept/reject identically. The schema can't express cross-field rules (`max_ms >= initial_ms`) — those cases are marked `runtimeOnly` in the fixtures.
- `createBox` pre-validates the host's `agentbox.yaml` via `loadConfig` **before** any docker work; a `ConfigError` aborts create with the formatted message. The in-container daemon re-validates on start (defence in depth, and necessary because the file lives in the overlay and can change after create).
- Editors auto-wire via `# yaml-language-server: $schema=…` (Red Hat YAML extension reads it). The repo's `.vscode/settings.json` maps the schema for in-tree files.

## What works today

Full local-Docker lifecycle:

- `agentbox create` — builds the image on first run, creates the snapshot if requested, spins up the container, mounts the FUSE overlay, runs four self-checks, records the box. Mounts the `agentbox-claude-config` named volume at `/home/vscode/.claude` and rsyncs host's `~/.claude` into it (additive, host-authoritative).
- `agentbox claude [-- <claude-args>...]` — does everything `create` does, then starts Claude Code in a detached tmux session inside the box and attaches the user's terminal to it. `Ctrl-b d` detaches; the claude process keeps running. Reattach with `agentbox claude attach <box>`. Forwards `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from host env when set. `--isolate-claude-config` opts into a per-box `agentbox-claude-config-<id>` volume.
- `agentbox list` / `inspect` — read from `~/.agentbox/state.json` and cross-reference `docker inspect` for live state (`running` / `paused` / `stopped` / `missing`). `inspect` surfaces the claude tmux session status (running / not running) when the container is up.
- `agentbox pause` / `unpause` — `docker pause` / `docker unpause`.
- `agentbox stop` / `start` — `docker stop` / `docker start`. **`start` re-runs `mountOverlay()` and re-launches `agentbox-ctl daemon`** because both processes die with the container.
- `agentbox status` / `logs` — proxy into the in-box `agentbox-ctl` via `docker exec` (see "In-box supervisor" below). `status` also reports the claude tmux session state (via the `claude-session` wire op).
- `agentbox destroy` — force-removes container + volumes + snapshot dir + per-box run dir (`~/.agentbox/boxes/<id>/`) + state record (prompts unless `-y`). Per-box claude-config volumes are removed too; the shared volume is preserved.
- `agentbox prune` — drops `missing` state records; `--all` also reaps orphan `agentbox-*` containers / volumes / snapshot dirs (allowlists `agentbox-claude-config` and any per-box `agentbox-claude-config-<id>` that belongs to a surviving box).

## What's not built yet (don't claim it works)

- Background rsync `/host-src → /snapshot` + atomic remount (the second half of the boot sequence in `architecture.md`).
- Codex / vscode-server / browser tooling installation inside the box (only Claude Code + tmux are baked into the image today).
- VS Code Dev Containers attach automation.
- Auto-pause-on-idle / auto-stop policy.
- Auto-refresh of the merged host export (inotify-driven `agentbox open` keeps `~/.agentbox/boxes/<id>/workspace` in sync without manual refresh). Today refresh is on-demand only.
- Exporting the upper volume on destroy (`--export <path>` flag). The live exports under `~/.agentbox/boxes/<id>/` are wiped with the box.
- Remote providers (E2B / Modal / Daytona / Vercel Sandbox).
- Non-macOS host support for the snapshot path (`cp -c` is APFS-only; Linux fallback to `rsync --exclude` is TODO).

## Common workflows

Build + verify after changes:

```sh
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

Manual end-to-end on this repo (slow path on first run — builds the image if missing):

```sh
node apps/cli/dist/index.js create --snapshot -y -n smoke
node apps/cli/dist/index.js list
node apps/cli/dist/index.js inspect smoke
node apps/cli/dist/index.js status smoke                   # services + claude session state
node apps/cli/dist/index.js logs smoke <service> -f        # if you have an agentbox.yaml in the workspace
node apps/cli/dist/index.js pause smoke && node apps/cli/dist/index.js unpause smoke
node apps/cli/dist/index.js stop smoke && node apps/cli/dist/index.js start smoke   # re-mounts overlay + relaunches ctl
node apps/cli/dist/index.js open smoke           # rsync /workspace -> host export + open Finder
node apps/cli/dist/index.js open smoke --upper   # writes-layer only (live on OrbStack, rsync on Docker Desktop)
node apps/cli/dist/index.js path smoke --refresh # same rsync as `open`, but just prints the host path
node apps/cli/dist/index.js destroy smoke -y
```

Run Claude Code in a sandboxed box (detach with `Ctrl-b d`, reattach with `claude attach`):

```sh
node apps/cli/dist/index.js claude --snapshot -y -n cc -- --model sonnet
# (in tmux) Ctrl-b d to detach
node apps/cli/dist/index.js claude attach cc
node apps/cli/dist/index.js inspect cc       # shows "claude session: running (...) since ..."
node apps/cli/dist/index.js destroy cc -y
```

After Dockerfile changes (e.g. updating Claude Code), wipe the cached image so the next create rebuilds:

```sh
docker rmi agentbox/box:dev
```

Wipe everything if state drifts (see README → Development for the raw escape hatch); the preferred path is `agentbox prune --all -y`.

## Host environment assumed

macOS (arm64 tested), Docker via OrbStack or Docker Desktop. Container needs `--cap-add=SYS_ADMIN --device=/dev/fuse --security-opt=apparmor:unconfined` — `runBox` in `packages/sandbox-docker/src/docker.ts` is the single source of truth for those flags.
