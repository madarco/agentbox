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
  Dockerfile.box            base:ubuntu + fuse-overlayfs + node + python + tmux + claude (native installer, stable channel) + bundled agentbox-ctl + system-wide `git config safe.directory '*'`
  src/create.ts             create orchestrator: image → relay → git-worktrees → snapshot? → volumes → run → mount → verify → ctl daemon → persist
  src/claude.ts             helpers for the named claude-config volume and the in-box tmux session (start/attach/info)
  src/lifecycle.ts          list/inspect/pause/unpause/stop/start/destroy/prune/open/path; BoxNotFoundError + AmbiguousBoxError
  src/host-export.ts        per-box host export plumbing (merged + upper layers, OrbStack live-upper)
  src/ctl.ts                launchCtlDaemon — `docker exec -d` the in-box supervisor
  src/relay.ts              ensureRelay (spawns the host relay node process) / registerBoxWithRelay / forgetBoxFromRelay / rehydrateRelayRegistry / generateRelayToken
  src/git-worktree.ts       detectGitRepos / createBoxWorktree / removeBoxWorktree / pickFreshBranch — host-side worktree management
  src/{docker,image,overlay,snapshot,state}.ts
packages/ctl/               @agentbox/ctl — in-container supervisor + CLI (`agentbox-ctl`)
  src/bin.ts                bundled CJS bin (dist/bin.cjs, baked into the image)
  src/relay-client.ts       fire-and-forget HTTP client the supervisor uses to push state events
  src/commands/git.ts       `agentbox-ctl git pull|push` — routes through the host relay (relay does the actual git op with the user's creds)
  src/{daemon,supervisor,socket,client,config,render}.ts
packages/relay/             @agentbox/relay — host-side HTTP relay (`agentbox-relay`)
  src/bin.ts                bundled CJS bin (dist/bin.cjs); `serve` subcommand is the daemon `ensureRelay` spawns
  src/server.ts             /events, /rpc (git.pull|git.push), /admin/* (loopback-only), /healthz
  src/{registry,types,index}.ts
packages/config/            @agentbox/config — host-side layered config (global / per-project / agentbox.yaml `defaults:`)
  src/types.ts              UserConfig, EffectiveConfig, BUILT_IN_DEFAULTS, KEY_REGISTRY (single source of truth)
  src/parse.ts              parseUserConfig (strict) + coerceFromString (CLI input)
  src/paths.ts              findProjectRoot (ancestor walk), hashProjectPath, configPathFor
  src/load.ts               loadEffectiveConfig (merge global+project+workspace+cli with per-leaf source map)
  src/write.ts              setConfigValue / unsetConfigValue (atomic write + meta.json) + listProjectsConfigured
  schema/user-config.schema.json   JSON schema mirrored by `packages/config/test/schema-drift.test.ts`
docs/architecture.md        the design doc — source of truth for *why*
```

**Box identifier resolution** (shared by every lifecycle command that takes `<box>`): `findBox(idOrName, state)` in `state.ts` matches in order: exact id → unique id prefix → exact name → exact container. Ambiguous prefix → `AmbiguousBoxError`; no match → `BoxNotFoundError`. Use `resolveBox()` in `lifecycle.ts` to get a `BoxRecord` from a CLI arg.

**Per-project box index + auto-pick**: each box is stamped at create time with `BoxRecord.projectRoot` (absolute path from `findProjectRoot(workspacePath)` in `@agentbox/config` — nearest ancestor dir holding `agentbox.yaml`, else workspacePath itself) and `BoxRecord.projectIndex` (1-based, monotonic per project, never recycled — `allocateProjectIndex` in `state.ts`). CLI commands take `[box]` as optional and route through `apps/cli/src/box-ref.ts`'s `resolveBoxOrExit`, which delegates to `resolveBoxRef` (`state.ts`): (1) undefined → `autoPickProjectBox` for the cwd's project; (2) pure-numeric ref like `agentbox open 3` resolves against `projectIndex` in the cwd's project and does **not** fall through to id-prefix (so `3` never accidentally matches hex id `3abc…`); (3) non-numeric → existing `findBox`. `agentbox list` renders an `N` column; `agentbox inspect` shows `project` + `n`. Pre-feature boxes lack both fields and resolve only by explicit id/name (never auto-picked). `agentbox logs` and `agentbox shell` smart-parse positionals: `agentbox logs <service>` and `agentbox shell -- ls` both auto-pick the box.

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

- `~/.agentbox/config.yaml` — global user config (layered defaults). Same shape as the per-project file and the `defaults:` block in `agentbox.yaml`. Owned by `@agentbox/config` (read by every `apps/cli` command at startup). Manage via `agentbox config get|set|unset|list|edit|path|list-projects` — `set/unset/edit` only target `--global` and `--project` (default), the workspace `defaults:` block is hand-edited. Precedence (highest wins): CLI flag > workspace `defaults:` > per-project (`~/.agentbox/projects/<sha1-16-of-abs-path>/config.yaml`) > global > built-in. Engine override (`engine.kind`) is the only key applied at CLI startup via `setEngineOverride()` in `host-export.ts`; everything else flows through `loadEffectiveConfig()` per command. The full key set + types live in `KEY_REGISTRY` (`packages/config/src/types.ts`) — single source of truth for the parser, the JSON schema, and `config set` coercion. The ctl parser accepts top-level `defaults:` as a permissive passthrough (no dep on `@agentbox/config`); the host re-validates strictly when loading.
- `~/.agentbox/state.json` — registry of created boxes
- `~/.agentbox/auth.json` (mode 0600) — long-lived Claude OAuth token captured on first `agentbox claude` via `claude setup-token`. Forwarded to every box as `CLAUDE_CODE_OAUTH_TOKEN`. Host env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) override it. `CLAUDE_EFFORT` and `ANTHROPIC_MODEL` are also forwarded when set on the host — Claude Code stores the user's model selection (Opus/Sonnet/Haiku via `/model` or `--effort`) only in the parent claude's process env, not in `~/.claude.json` or `~/.claude/settings.json`. Both create-time (`docker run -e`) and `agentbox claude start` exec-time (`docker exec -e`) re-read these from the *current* host shell, so launching from inside a host claude session propagates that session's model to the box (`packages/sandbox-docker/src/claude.ts` → `FORWARDED_ENV_KEYS`).
- `~/.agentbox/snapshots/<id>/` — frozen APFS clones of host workspaces
- `~/.agentbox/boxes/<id>/run/ctl.sock` — host-side view of the in-box ctl socket (bind-mounted to `/run/agentbox/` in the container)
- `~/.agentbox/boxes/<id>/workspace` and `~/.agentbox/boxes/<id>/upper` — per-box host export targets for `agentbox open` / `agentbox path`. **They are empty until refresh runs** — that's by design. `createBox` `mkdir`s both at create-time and bind-mounts them into the container at `/host-export` and `/host-export-upper` (virtiofs on OrbStack); `refreshExport` in `host-export.ts` does `docker exec rsync /workspace/ /host-export/` (or `--exclude=node_modules` by default for the merged layer). The container `/workspace` mount is `fuse-overlayfs` and lives **only inside the container's mount namespace** — it cannot be reached from the Mac directly, which is why a copy is needed. The upper layer (`agentbox-upper-<id>/upper/`) is a different story on OrbStack: every Docker volume is exposed live at `~/OrbStack/docker/volumes/<name>/`, so `resolveUpperLiveOnHost` returns that path and `agentbox open --upper` skips the rsync entirely. Docker Desktop has no equivalent, so we fall back to the same rsync into `boxes/<id>/upper/`. `agentbox open --print` still refreshes (use `--no-refresh` to skip), so scripts that pipe the path get a fresh snapshot in one call. Boxes created before the bind-mounts existed (`/host-export` absent) fall back to a `docker exec tar | tar -x` pipe into the host dir — slower but doesn't need a container restart.
- `~/.agentbox/boxes/<id>/worktrees/` — host-side per-box git worktrees. One subdir per detected repo: `root/` for the workspace's own `.git`, plus `<subpath>/` per 1st-level nested repo (monorepo). The root worktree replaces the box's overlay lower (`lowerPath`); nested worktrees stage at `/agentbox-worktrees/<sub>` in the container and get bind-mounted on top of `/workspace/<sub>` by `mountOverlay()` after the FUSE overlay is up. Each worktree is `git worktree add -b agentbox/<box-name>[--<sub>] HEAD`, with `extensions.worktreeConfig=true` set on the main repo so `commit.gpgsign=false` (per-worktree) can disable signing for the box's commits — boxes carry no SSH keys, so a signed-by-default host config would otherwise hang every commit. The host's tracked-uncommitted + untracked state is carried over at worktree-create via `git stash create` + `git stash apply --index` + a tar pipe for untracked files; the user's main checkout is never modified. Wiped on `destroy` via `git worktree remove --force` plus the run-dir rm. See `packages/sandbox-docker/src/git-worktree.ts`.
- `~/.agentbox/relay.pid` and `~/.agentbox/relay.log` — pidfile + log for the host relay node process spawned by `ensureRelay()`. See "Host relay" below.
- Per-box `agentbox-docker-<id>` (or shared `agentbox-docker-cache` when `box.dockerCacheShared` is set) — the in-box dockerd's `/var/lib/docker` data root. Per-box variant removed on `destroy`; shared variant preserved (allowlisted in `prune --all`). Holds images, layers, inner containers, networks, and volumes pulled/created by the agent inside the box.
- Docker objects: containers `agentbox-<id|name>`, volumes `agentbox-upper-<id>` + `agentbox-nm-<id>` + the Claude Code config volume (`agentbox-claude-config` shared by default, or `agentbox-claude-config-<id>` when `--isolate-claude-config` is set). **The relay is no longer a docker container** — `prune --all` reaps any leftover `agentbox-relay` container + `agentbox/relay:dev` image + `agentbox-net` network from previous versions. Host's `~/.claude` is the authoritative source: every `create` / `claude` rsyncs host -> volume (additive — host wins on overlap, box-only files like session logs are preserved). Host's `~/.claude.json` (file, not directory) also syncs into the volume as `_claude.json`; an image-baked symlink at `/home/vscode/.claude.json -> /home/vscode/.claude/_claude.json` routes claude's reads/writes through the volume. Hook commands referencing host-absolute paths under `$HOME/` are filtered out during sync (`packages/sandbox-docker/src/claude-hooks-filter.ts`) so the in-box claude doesn't spam `cc-status: not found` errors. The same module's `clearInstallMethod` strips the top-level `installMethod` field from the synced `_claude.json` so the in-box claude (installed via Anthropic's native installer at `/home/vscode/.local/bin/claude`) redetects rather than trip an integrity warning when the host recorded a different install method. The rsync also runs with `--copy-unsafe-links` so user-skill symlinks (e.g. `~/.claude/skills/<x> -> ../../.agents/skills/<x>`) are dereferenced into real directories inside the volume — `~/.agents` is **not** bind-mounted. The rsync excludes `node_modules` so the host's darwin-arm64 plugin binaries (`fsevents.node`, `@esbuild/darwin-arm64`, `@rollup/rollup-darwin-arm64`, sharp, …) never reach the linux box; `rebuildPluginNativeDeps()` then re-runs `npm install` for each plugin cache the first time `agentbox claude` launches in a fresh box (idempotent — gated by a per-plugin `.agentbox-installed` marker, since some plugins have empty dep lists that don't produce a `node_modules/` dir). A one-shot migration in the rsync helper wipes pre-existing `node_modules/` from the shared volume the first time a post-upgrade sync runs (sentinel `~/.claude/.agentbox-cleaned-nm-v1`); without it, existing users would keep darwin binaries indefinitely. Every top-level JSON under `~/.claude/plugins/` (currently `installed_plugins.json` + `known_marketplaces.json`) has its host-home prefix rewritten to `/home/vscode` via an inline `sed` sweep in the helper container — without rewriting `known_marketplaces.json.installLocation`, claude can't load the marketplaces (it falls back to a `<org>-<repo>` slug derived from `source.repo` like `microsoft-playwright-cli`, which doesn't exist on disk, masquerading as "Plugin X not found in marketplace Y" for every plugin in the marketplace). `claude-hooks-filter.ts`'s `addProjectAlias` duplicates `_claude.json.projects[<host-cwd>]` to `projects['/workspace']` so project-scoped MCP servers / trust / history apply inside the box (workspace is always `/workspace` regardless of host path). The shared volume is **never** auto-removed by `destroy` or `prune` (it holds user identity); per-box isolated volumes are removed with their box.
- The box image is `agentbox/box:dev`, built locally from `packages/sandbox-docker/Dockerfile.box`. **Build context is the monorepo root** (so the Dockerfile can `COPY packages/ctl/dist/bin.cjs`); see `BUILD_CONTEXT_DIR` in `image.ts`.

## In-box supervisor (`@agentbox/ctl`)

- Reads `/workspace/agentbox.yaml`; runs declared **tasks** (one-shot) and **services** (long-running) under a DAG scheduler. Tasks transition `pending → waiting → running → done | failed | skipped`; services transition `pending → waiting → starting → running → ready | unhealthy | crashed | backoff | stopped`. `waiting` is distinct from `starting` so `blockedOn` can surface in `agentbox status`. Restarts crashed services with exponential backoff and captures logs to `/var/log/agentbox/<svc>.log`.
- `needs:` on any unit forms a DAG (cycles + unknown refs rejected at config load). Independent units launch in parallel.
- `ready_when:` declares a readiness probe per service: `port` (TCP connect to `127.0.0.1:<port>` by default), `log_match` (regex over stdout/stderr), or `http` (GET; expects 2xx by default). Probe lives in `packages/ctl/src/probe.ts`. `on_timeout: kill` (default) re-enters the restart policy; `on_timeout: mark_unhealthy` leaves the process running but flags the service — the escape hatch for legitimately slow cold starts.
- Wire ops: `status` returns `{ services, tasks }`; `task-status` returns task list; `wait-ready { timeoutMs?, units? }` blocks daemon-side until all autostart units reach their satisfying state, then resolves `{ ready: true }` or `{ ready: false, timedOut, failed }`; `run-task { name, force? }` resets a task back to pending so the scheduler reruns it.
- Listens on `/run/agentbox/ctl.sock` (UNIX socket, newline-delimited JSON). Both the in-box `agentbox-ctl` client and host commands talk to the same socket — but the **host commands shell in via `docker exec`**, not the bind-mounted socket: Docker Desktop / OrbStack's VM boundary breaks `connect()` from the mac side, even though the file is visible.
- Launched by `launchCtlDaemon()` in `sandbox-docker/src/ctl.ts` (best-effort; missing/empty `agentbox.yaml` is fine and doesn't fail `create`). Same call is repeated in `startBox()` because the daemon dies with the container — same lifecycle as `mountOverlay()`.
- The bin is built as **CJS** (`dist/bin.cjs`) with all deps bundled — esbuild's ESM output poisons `require()` from CJS deps like commander. Library entry (`dist/index.js`) stays ESM.
- **Config validation has two sources of truth that must agree**: the runtime parser in `packages/ctl/src/config.ts` (used by the daemon and the host pre-flight) and the JSON Schema at `packages/ctl/schema/agentbox.schema.json` (used by editors). `packages/ctl/test/schema-drift.test.ts` feeds the same fixtures to both and asserts they accept/reject identically. The schema can't express cross-field rules (`max_ms >= initial_ms`) — those cases are marked `runtimeOnly` in the fixtures.
- `createBox` pre-validates the host's `agentbox.yaml` via `loadConfig` **before** any docker work; a `ConfigError` aborts create with the formatted message. The in-container daemon re-validates on start (defence in depth, and necessary because the file lives in the overlay and can change after create).
- Editors auto-wire via `# yaml-language-server: $schema=…` (Red Hat YAML extension reads it). The repo's `.vscode/settings.json` maps the schema for in-tree files.

## Host relay (`@agentbox/relay`)

- **Host node process**, not a container (it used to be — that was a mistake; admin endpoints can't be reached easily from the host, and the relay needs the user's SSH agent + git config for the push/pull RPCs). `ensureRelay()` in `sandbox-docker/src/relay.ts` spawns `node packages/relay/dist/bin.cjs serve --port 8787 --host 0.0.0.0` as a detached, unref'd child, with PID at `~/.agentbox/relay.pid` and stdout/stderr at `~/.agentbox/relay.log`. Lazily started on first `agentbox create` / `agentbox claude`; idempotent — subsequent calls ping `/healthz` and short-circuit if the existing process responds. Migration: a stale `agentbox-relay` docker container is removed up front so it doesn't shadow the new process.
- Boxes reach the relay at `http://host.docker.internal:8787` (env: `AGENTBOX_RELAY_URL`). `host.docker.internal` is the Docker Desktop / OrbStack alias for the host's loopback as seen from inside a container; `runBox` also passes `--add-host=host.docker.internal:host-gateway` so the same name resolves on Linux native Docker. There is no `agentbox-net` user-defined network anymore.
- Auth is a **per-box bearer token**: `generateRelayToken()` (32 random bytes hex) at create time, persisted in `BoxRecord.relayToken`, injected into the box as `AGENTBOX_RELAY_TOKEN`, registered with the relay over HTTP to `POST /admin/register-box` (loopback only). The box also gets `AGENTBOX_RELAY_URL` (above). `destroyBox` calls `POST /admin/forget-box`.
- Endpoints:
  - `POST /events` (bearer; append to 1000-entry in-memory ring buffer → 202)
  - `POST /rpc` (bearer): handles `git.pull` / `git.push` in-process by spawning `git -C <hostWorktreeDir> {pull|push} <remote> [...args]` with `process.env` (so it inherits `SSH_AUTH_SOCK`, `~/.gitconfig`, etc.) and returning `{ exitCode, stdout, stderr }`. Container path → worktree dir is resolved from the registered box's `worktrees[]`, with longest-prefix wins for nested paths. Unknown methods still return 501. 120s timeout per call.
  - `POST /admin/register-box` / `POST /admin/forget-box` / `GET /admin/events` / `GET /admin/registry` — admin. **Source-IP guarded: loopback only.** Anything else gets a 403; this is how we keep boxes from poking admin even though the listener is on 0.0.0.0.
  - `GET /healthz` — no auth.
- **Registration carries the worktree map**: `RegisterBoxBody.worktrees: BoxWorktree[]` (containerPath, hostWorktreeDir, branch). The relay needs this to resolve which dir to run git in; on box restart or relay restart, `rehydrateRelayRegistry()` replays it from `BoxRecord.gitWorktrees` so the relay's in-memory state catches back up.
- **Rehydration after restart**: every `createBox` reads `~/.agentbox/state.json` and re-pushes every known `(relayToken, gitWorktrees)` via `rehydrateRelayRegistry()`. Idempotent and cheap, so we do it unconditionally instead of trying to detect a restart. `startBox` also re-registers its own box.
- The supervisor pushes outbound: `packages/ctl/src/relay-client.ts` is a fire-and-forget POST to `/events` (node:http, 2s timeout, silent failure). `onServiceState` / `onTaskState` in `supervisor.ts` forward terminal states (`ready` / `crashed` / `backoff` / `unhealthy` / `stopped` / `done` / `failed`). Disabled at construction when `AGENTBOX_RELAY_URL` / `AGENTBOX_RELAY_TOKEN` are unset — keeps existing tests and pre-relay boxes a no-op.
- In-box CLI: `agentbox-ctl git pull|push [-- <git-args>...]` (in `packages/ctl/src/commands/git.ts`) POSTs to `/rpc` with `{ method: 'git.pull'|'git.push', params: { path: <cwd>, args: [...] } }`, streams `stdout`/`stderr` back to the agent's terminal, and exits with the host's git exit code. This is what the agent invokes to ask the host to push the box's commits — no SSH keys leak into the box.
- The bin is still built CJS with deps bundled (`packages/relay/dist/bin.cjs`). Library entry (`dist/index.js`) stays ESM and is consumed by `@agentbox/sandbox-docker` for the wire types (`BoxWorktree`, `GitRpcParams`, etc.) and constants. The bin's `register` / `forget` / `tail` subcommands still work (they POST to `127.0.0.1:8787`) but you can also just `curl` the admin endpoints directly.

## What works today

Full local-Docker lifecycle:

- `agentbox create` — builds the image on first run, detects git repos (root + 1st-level subdirs) and creates a per-box worktree per detected repo on a fresh `agentbox/<box-name>` branch carrying over the host's uncommitted state, creates the snapshot if requested, spins up the container, mounts the FUSE overlay (bind-after-overlay for nested worktrees), runs four self-checks, records the box. Mounts the `agentbox-claude-config` named volume at `/home/vscode/.claude` and rsyncs host's `~/.claude` into it (additive, host-authoritative). Bind-mounts each main repo's `.git/` at its identical absolute host path inside the container so worktree pointer files resolve symmetrically on both sides.
- `agentbox claude [-- <claude-args>...]` — does everything `create` does, then starts Claude Code in a detached tmux session inside the box and attaches the user's terminal to it. `Ctrl-b d` detaches; the claude process keeps running. Reattach with `agentbox claude attach <box>`. Forwards `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_EFFORT` / `ANTHROPIC_MODEL` from host env when set. `--isolate-claude-config` opts into a per-box `agentbox-claude-config-<id>` volume.
- `agentbox claude start [box] [-- <claude-args>...]` — start a Claude session in an **existing** box (vs `agentbox claude` which creates one). Resolves `[box]` via the usual auto-pick / index / name / id-prefix chain. Auto-unpauses/starts the container if needed (mirrors `shell`/`code`). Re-syncs `~/.claude` into the box volume by default (skip with `--no-sync-config` for speed). Re-runs `rebuildPluginNativeDeps` (idempotent — gated by per-plugin marker). If a tmux session with the configured name already exists, just attaches; otherwise starts a fresh one. Post-`--` args are forwarded to claude only when starting a fresh session.
- `agentbox list` / `inspect` — read from `~/.agentbox/state.json` and cross-reference `docker inspect` for live state (`running` / `paused` / `stopped` / `missing`). `inspect` surfaces the claude tmux session status (running / not running) when the container is up.
- `agentbox pause` / `unpause` — `docker pause` / `docker unpause`.
- `agentbox stop` / `start` — `docker stop` / `docker start`. **`start` re-runs `mountOverlay()` and re-launches `agentbox-ctl daemon`** because both processes die with the container. `start` first revalidates that all host-side git worktrees + their main `.git/` dirs still exist (Docker's bind mounts are baked in at create time; if the host dir was deleted while the box was stopped, restart would just produce an opaque mount error).
- `agentbox status` / `logs` — proxy into the in-box `agentbox-ctl` via `docker exec` (see "In-box supervisor" below). `status` renders `TASKS` + `SERVICES` sections (the service row has a `BLOCKED ON` column for `waiting` services) and reports the claude tmux session state (via the `claude-session` wire op).
- `agentbox wait <box>` — blocks until all autostart tasks + services are ready. Thin wrapper over the daemon's `wait-ready` op; useful for scripted readiness gates.
- `agentbox code <box>` — opens **VS Code or Cursor** Desktop against the box via the Dev Containers extension. Both IDEs are supported transparently: by default the CLI prefers `code` and falls back to `cursor` if `code` isn't in PATH; pass `--ide vscode` / `--ide cursor` to force a flavor. Auto-unpauses paused boxes and starts stopped ones (re-running `mountOverlay()` + `launchCtlDaemon()`). Waits for `wait-ready` (default 120s) unless `--no-wait`, then writes `/workspace/.vscode/tasks.json` (sentinel-protected; `--regen-tasks` to overwrite a user-owned file) so the IDE auto-opens terminal panels tailing each service's log. The launcher uses `<cli> --folder-uri "vscode-remote://attached-container+<hex>/workspace"` (Cursor inherits the `vscode-remote://` scheme as a VS Code fork); `--print` returns the URI instead. Each box mounts **both** server volume sets so either IDE can attach to any box without recreating: per-box `agentbox-vscode-server-<id>` + `agentbox-cursor-server-<id>` (server binary + TS cache, ~70MB downloaded on first attach), plus the shared `agentbox-vscode-extensions` + `agentbox-cursor-extensions` volumes for downloaded extensions across all boxes.
- `agentbox shell <box> [-- <cmd>...]` — `docker exec -it` convenience: drops you into `bash -l` as `vscode` in `/workspace`. Auto-unpauses paused boxes and starts stopped ones (same recovery as `agentbox code`). `--user <name>` overrides the in-container user; `--no-login` invokes `bash` without `-l`; pass-through args after `--` run as `bash -l -c '<args joined>'` for one-shot commands. Forwards host `TERM` so truecolor/hyperlinks survive.
- `agentbox pull [box]` — box→host pull of `/workspace` (gitignore-aware; `--with-env` / `pull env` for gitignored env files). `agentbox pull claude [box]` — additive box→host pull of Claude extensions (`skills/`, `plugins/`, `agents/`, `commands/` under `~/.claude`). Reads the claude-config **volume** via a throwaway helper container (the exact reverse of `ensureClaudeVolume`'s forward sync), so the box need not be running. Never overwrites an item already on the host; excludes `agentbox-*` skills (the wizard-installed `agentbox-setup`); the two plugin registry JSONs are merged host-side (only box-only keys added, the forward `/home/vscode/.claude/plugins/` rewrite reversed). With the shared `agentbox-claude-config` volume the pull aggregates extensions installed in any box (warned). `packages/sandbox-docker/src/claude.ts` `pullClaudeExtras` + pure helpers in `claude-pull.ts`.
- `agentbox destroy` — force-removes container + volumes + snapshot dir + per-box run dir (`~/.agentbox/boxes/<id>/`) + state record (prompts unless `-y`). Per-box claude-config, `agentbox-vscode-server-<id>`, and `agentbox-cursor-server-<id>` volumes are removed too; the shared `agentbox-claude-config` + `agentbox-vscode-extensions` + `agentbox-cursor-extensions` volumes are preserved. Each registered git worktree is removed from the host via `git worktree remove --force` before the box dir is wiped.
- `agentbox prune` — drops `missing` state records; `--all` also reaps orphan `agentbox-*` containers / volumes / snapshot dirs (allowlists all three shared volumes — `agentbox-claude-config`, `agentbox-vscode-extensions`, `agentbox-cursor-extensions` — and per-box variants of either kind that belong to a surviving box). `--all` also sweeps the legacy `agentbox-relay` container + `agentbox/relay:dev` image + `agentbox-net` network left over from the old in-docker relay design.
- `agentbox update` — self-updates the CLI then refreshes the local runtime. Detects how it was launched (`apps/cli/src/exec-method.ts`'s `detectExecutionMethod`): `npm` → `npm install -g agentbox@latest`, `pnpm` → `pnpm add -g agentbox@latest`, `npx`/`direct` (dev clone) → skip the package update with a note. Then best-effort `docker image rm -f agentbox/box:dev` (rebuilds lazily on next `create`/`claude` via `ensureImage()`) and reloads the relay via `stopRelay()`. The relay is only respawned in-process (`ensureRelay()`) when **no** self-update ran — after a real self-update this process is the stale build, so it just stops the relay and the next box command brings up the new one. `-y` skips the prompt, `--dry-run` previews, `--skip-self` does only the image+relay refresh. `stopRelay` lives in `packages/sandbox-docker/src/relay.ts` (reuses the existing pidfile helpers); `removeImage` in `docker.ts`.
- In-box `agentbox-ctl git pull|push [-- <args>]` (and any tool the agent runs that shells out via this command) — POSTs to the host relay's `/rpc`, which executes git on the host with the user's SSH agent + gitconfig. Commits made inside the box land in the host's main `.git/` immediately (the `.git/` is bind-mounted RW at its identical absolute path); `git push` is the only operation that needs host credentials, hence the RPC.
- Browser support — Vercel's [`agent-browser`](https://github.com/vercel-labs/agent-browser) is baked into the box image (`npm install -g agent-browser`). The Chromium binary that drives it is *not* Chrome for Testing (no Linux ARM64 build, and Noble's `chromium-browser` apt package is a snap stub that doesn't run in containers) — it's Playwright's bundled Chromium, which has working linux/arm64 + linux/amd64 builds. The Dockerfile installs `playwright` globally just for its `playwright install chromium` downloader, then symlinks the resulting versioned binary to `/usr/local/bin/chromium` and sets `ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium` so agent-browser picks it up without a CLI flag. Chrome runtime libs (libnss3, libxkbcommon0, libcups2t64, etc. — Noble names with the `t64` suffix where applicable) are installed once at image build. Agents inside the box invoke `agent-browser` directly; sessions/auth/cookies persist under `~/.agent-browser/` in the container's writable layer, so they survive `pause/unpause` and `stop/start` and are wiped on `destroy`. The flag `--with-playwright` on both `agentbox create` and `agentbox claude` additionally runs `npm install -g @playwright/cli@latest` inside the container at create time (recorded as `BoxRecord.withPlaywright` and surfaced in `agentbox inspect`) — a separate package from the `playwright` runtime baked into the image.
- VNC web client — every box launches Xvnc (TigerVNC) on display `:1` plus websockify serving noVNC at container port `6080`, by default. `ENV DISPLAY=:1` is baked into the image, so any GUI process started inside the box (Chromium via agent-browser, `chromium` from a shell) renders to that display. The image declares `EXPOSE 6080`, which is what makes OrbStack's `<container-name>.orb.local` auto-DNS route correctly. On OrbStack the URL is `http://agentbox-<name>.orb.local:6080/vnc.html?autoconnect=1&password=<pw>`; Docker Desktop hosts use the auto-allocated host port from `docker run -p 127.0.0.1:0:6080` (resolved via `docker port` after `runBox`, persisted to `BoxRecord.vncHostPort`). The password is an 8-char `[A-Za-z0-9]` per-box random (`BoxRecord.vncPassword`) embedded in the auto-connect URL. The supervisor script is `packages/sandbox-docker/scripts/agentbox-vnc-start` — baked at `/usr/local/bin/agentbox-vnc-start` in the image, launched via `docker exec -d --user vscode` from `launchVncDaemon()` (mirrors `launchCtlDaemon` — best-effort, idempotent, relaunched by `startBox()` after stop/start because Xvnc dies with the container). Opt out with `agentbox create --no-vnc` / `agentbox claude --no-vnc` — `BoxRecord.vncEnabled` decides whether `startBox` re-runs the launch.
- Box self-awareness — every box is stamped at `docker run` with `AGENTBOX=1`, `AGENTBOX_BOX_ID`, `AGENTBOX_BOX_NAME`, `AGENTBOX_HOST_WORKSPACE` (absolute *host* path of the workspace cwd — informational, not a mount), and (when the workspace has an `agentbox.yaml` ancestor) `AGENTBOX_PROJECT_ROOT` + `AGENTBOX_PROJECT_INDEX`. The same key=value pairs are written to `/etc/agentbox/box.env` after `runBox` (via `writeBoxEnvFile` in `packages/sandbox-docker/src/box-env.ts`); `/etc/profile.d/agentbox.sh` sources it so `agentbox shell <box>` and any `bash -l` see the vars even when launched outside docker-run's env. A short prose hint about sandbox constraints (DinD available, no SSH creds → use `agentbox-ctl git pull|push`) is baked at `/etc/claude-code/CLAUDE.md` — note that path is **not** currently a documented Claude Code load location, so today the hint is inspectable-only; in-box agents discover constraints via the env vars.
- Docker-in-Docker — every box ships with `docker.io` + `iptables` and runs an in-box `dockerd` (storage-driver `fuse-overlayfs`, pinned in `/etc/docker/daemon.json` baked into the image) launched after the FUSE overlay + ctl daemon are up via `launchDockerdDaemon()` (mirrors `launchVncDaemon` — `docker exec -d --user root /usr/local/bin/agentbox-dockerd-start`, best-effort, idempotent, relaunched by `startBox()` because dockerd dies with the container — gated on `BoxRecord.dockerVolume` so pre-DinD records don't try to start a daemon that isn't installed). The vscode user is added to the `docker` group at image build, so the agent invokes `docker` without sudo. The data root `/var/lib/docker` is the per-box named volume `agentbox-docker-<id>`, removed on `destroy`. Pass `--shared-docker-cache` (or set `box.dockerCacheShared: true` in any config layer) to swap to the shared `agentbox-docker-cache` volume — preserved on `destroy` and allowlisted in `prune --all`, but mutually exclusive at runtime (only one box can hold dockerd's lock on `/var/lib/docker` at a time). The outer container always gets `--cap-add=NET_ADMIN`, `--security-opt=seccomp=unconfined`, and `--cgroupns=private` (in addition to the existing `SYS_ADMIN`/`/dev/fuse`/`apparmor:unconfined`); `--privileged` is **not** used, so the same container runs cloud-portably (E2B/Modal/etc. accept the cap_add path). Three non-obvious bits in `agentbox-dockerd-start` make this work on OrbStack and Docker Desktop: (1) `mount -o remount,rw /sys/fs/cgroup` because the outer engine bind-mounts cgroup v2 RO and dockerd has to `mkdir /sys/fs/cgroup/docker` for its own slice; (2) `mount -o remount,rw /proc/sys` because dockerd writes to `/proc/sys/net/ipv6/conf/<veth>/disable_ipv6` during default-bridge setup, and `/proc/sys` is RO under the same hardening; (3) `rm -f /var/run/docker.{pid,sock}` before relaunch — `/var/run` is in the container's writable layer (not a volume), so a stale pidfile from before `docker stop` survives across `start` and dockerd refuses to launch ("PID still running" — that PID got reassigned to `sleep infinity`). Both remounts are SYS_ADMIN-gated and only affect the box's own namespaces, never the host.

## What's not built yet (don't claim it works)

- Background rsync `/host-src → /snapshot` + atomic remount (the second half of the boot sequence in `architecture.md`).
- Codex installation inside the box (Claude Code + tmux + agent-browser baked into the image; VS Code Server is downloaded on first attach).
- Pre-warming the VS Code Server in the image (server version is keyed to host's VS Code Desktop version, so first attach to a fresh box still pays the ~70MB download; subsequent attaches to the same box are instant).
- Auto-pause-on-idle / auto-stop policy.
- Auto-refresh of the merged host export (inotify-driven `agentbox open` keeps `~/.agentbox/boxes/<id>/workspace` in sync without manual refresh). Today refresh is on-demand only.
- Exporting the upper volume on destroy (`--export <path>` flag). The live exports under `~/.agentbox/boxes/<id>/` are wiped with the box.
- Additional `/rpc` methods beyond `git.pull` / `git.push`. The dispatch is a single switch in `packages/relay/src/server.ts` — easy to extend (target ideas: `git.fetch`, `gh.*`, `npm.publish`, anything else that needs host creds).
- A user-facing `agentbox events`/`agentbox notify` CLI on top of the relay's ring buffer. Today you can `agentbox-relay tail` (against the host process at 127.0.0.1:8787) or `tail -f ~/.agentbox/relay.log`.
- An `agentbox relay stop` / `restart` CLI. Today the relay is killed by `kill $(cat ~/.agentbox/relay.pid)`; it'll respawn on the next `agentbox create`.
- Event-buffer persistence (events are lost on relay restart; the token registry is rehydrated from `state.json` on next `agentbox create`, but historical events aren't).
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
node apps/cli/dist/index.js wait smoke            # block until autostart units (tasks + services) ready
node apps/cli/dist/index.js code smoke            # auto-unpause/start + wait + write .vscode/tasks.json + open VS Code (or Cursor if `code` not in PATH)
node apps/cli/dist/index.js code smoke --ide cursor  # force Cursor (default: prefer `code`, fall back to `cursor`)
node apps/cli/dist/index.js code smoke --print    # just print the vscode-remote:// URL (after the warm-up)
node apps/cli/dist/index.js shell smoke           # interactive bash in /workspace (auto-unpause/start)
node apps/cli/dist/index.js shell smoke -- whoami # one-shot exec; prints "vscode"
node apps/cli/dist/index.js pull claude smoke --dry-run  # list box-installed skills/plugins not on host (excl. agentbox-*)
node apps/cli/dist/index.js pull claude smoke -y         # additive box->host pull into ~/.claude (box may be stopped)
node apps/cli/dist/index.js destroy smoke -y
```

Git worktree end-to-end (run from inside a git checkout — this repo works):

```sh
node apps/cli/dist/index.js create -y -n git-smoke
git worktree list                              # the box's worktree shows up under ~/.agentbox/boxes/<id>/worktrees/root
docker exec agentbox-git-smoke bash -lc 'cd /workspace && git status'  # on branch agentbox/git-smoke
docker exec agentbox-git-smoke bash -lc 'cd /workspace && git commit --allow-empty -m "from-box"'
git log agentbox/git-smoke -1                  # commit visible on host immediately (.git/ is bind-mounted)
docker exec agentbox-git-smoke bash -lc 'agentbox-ctl git push -- --set-upstream origin agentbox/git-smoke'
# ↑ the RPC runs `git push` on the host with the user's creds; box has no SSH keys
node apps/cli/dist/index.js destroy git-smoke -y
git worktree list                              # cleaned up
```

Run Claude Code in a sandboxed box (detach with `Ctrl-b d`, reattach with `claude attach`):

```sh
node apps/cli/dist/index.js claude --snapshot -y -n cc -- --model sonnet
# (in tmux) Ctrl-b d to detach
node apps/cli/dist/index.js claude attach cc
node apps/cli/dist/index.js inspect cc       # shows "claude session: running (...) since ..."
node apps/cli/dist/index.js destroy cc -y
```

After **any** change that bakes into the box image, wipe the cached image so the next `create` rebuilds. The image is pinned to `agentbox/box:dev` and reused across creates — without an explicit rmi, you'll keep the stale copy. Watch out for:

- `packages/sandbox-docker/Dockerfile.box` (obvious)
- `packages/ctl/src/**` — the Dockerfile copies `packages/ctl/dist/bin.cjs` into `/usr/local/bin/agentbox-ctl`, so new wire ops / subcommands need a rebuild. The same goes for any change to `packages/ctl/tsup.config.ts` or the bundled bin.cjs output.
- Updates to the Claude Code installer (the `curl claude.ai/install.sh` step in the Dockerfile).
- Updates to the `agent-browser` install (the `npm install -g agent-browser playwright` + `playwright install chromium` + `/usr/local/bin/chromium` symlink steps). A new agent-browser release, or a Playwright chromium revision bump, won't reach existing boxes until the image is rebuilt.
- Changes to `packages/sandbox-docker/scripts/agentbox-vnc-start` — the script is `COPY`'d into the image at `/usr/local/bin/agentbox-vnc-start`. Edits to Xvnc flags, port choices, or the websockify invocation won't reach existing boxes until the image is rebuilt.
- Changes to `packages/sandbox-docker/scripts/agentbox-dockerd-start` — same reasoning as the VNC script (`COPY`'d to `/usr/local/bin/agentbox-dockerd-start`). Likewise, edits to `/etc/docker/daemon.json` (storage driver, etc.) or the `docker.io`/`iptables` apt set need a rebuild.
- Edits to the baked-in `/etc/claude-code/CLAUDE.md` hint (content in `packages/sandbox-docker/scripts/custom-system-CLAUDE.md`, `COPY`'d into the image — edit the file, not the Dockerfile), the `/etc/profile.d/agentbox.sh` shim, or the `/etc/agentbox/` perms (the latter two are `RUN printf` blocks in `Dockerfile.box`). The runtime `box.env` is written per-create via `docker exec`, so its contents change without a rebuild; the shim that sources it does not.

```sh
docker rmi agentbox/box:dev
```

Wipe everything if state drifts (see README → Development for the raw escape hatch); the preferred path is `agentbox prune --all -y`.

## Host environment assumed

macOS (arm64 tested), Docker via OrbStack or Docker Desktop. Container needs `--cap-add=SYS_ADMIN --device=/dev/fuse --security-opt=apparmor:unconfined` — `runBox` in `packages/sandbox-docker/src/docker.ts` is the single source of truth for those flags.
