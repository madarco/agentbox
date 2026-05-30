---
name: agentbox-setup
description: Generate an agentbox.yaml for the current AgentBox workspace. Invoke when the user opens a sandbox without an agentbox.yaml or asks to (re)configure one.
---

# /agentbox-setup

## Box layout (what you're configuring against)

Your user i `vscode` and you can use `sudo` to run commands as root.

`/workspace` is where the user code lives, a per-box git worktree on a fresh `agentbox/<box-name>` branch (or a tar-piped copy of the host workspace for non-git projects).
Run `agentbox checkpoint --set-default` (similar to `docker commit`) to save any changes make to the system and workspace so that new boxes will start from a warm state. Everything is wiped on `agentbox destroy`.

Some special folders:

- **Host main repo's `.git/`** — If the box bind-mounted RW at its identical absolute host path. In-box commits land on the host's branch refs (visible to `git log` on the host immediately); the box itself carries no SSH/git creds, so `git push` goes through the host relay (`agentbox-ctl git push`). The host's **working tree is never written to** — only refs/objects under `.git/`. GitHub PR ops (`agentbox-ctl git pr create|view|list|comment|review|merge|close|reopen|checkout`) flow the same way through host `gh`; write ops require host confirmation (deny → exit 10), `merge` and `checkout` have additional opt-in guards.
- **`~/.claude`** — and similar home folders for coding agents are seeded from the host's `~/.claude` on each create so auth, skills, and plugins persist without leaking the host's home dir.
- **`agentbox.yaml`** — read by `agentbox-ctl` from `/workspace`. Tasks and services declared here are what the supervisor will run.

Exposed ports and services:
- **portless** - every port with `expose:` setting in agentbox.yaml, will be exposed not only as a local port but also as a special domain name `https://<name>.localhost` (so on https) using `portless` cli and proxy. This will be also mapped to the host where also `portless` proxy is running so users can access the same service on the same looking url.
- **vnc** - the webVNC server exposed on 6080 will be proxies to the host on a random port.
- **vscode** - the vscode server is proxied to the host on a random port.

## Goal

Produce a `/workspace/agentbox.yaml` that captures this project's services, tasks, and box defaults so the in-box supervisor (`agentbox-ctl`) can boot the workspace deterministically.

`agentbox.yaml` is **declarative**. The supervisor reads it on box start, but you don't have to restart the box: after you write the file, `agentbox-ctl reload` (run from inside the box) makes the already-running supervisor re-read it and immediately run the declared tasks and autostart the services. See step 8.

## 1. Discover the project

Look at `/workspace`:

- Top-level manifests: `package.json`, `pyproject.toml` / `requirements.txt`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, etc. — these tell you the runtime.
- `docker-compose.yaml` / `docker-compose.yml` — often lists the real services the project expects.
- `package.json` → `scripts`: look for `dev`, `start`, `build`, `test`, `migrate`, `seed`.
- `Makefile` / `justfile` / `Taskfile.yaml` — alternative task runners.
- Listening ports: grep for `listen(`, `PORT=`, framework defaults (3000 for Next.js / Nuxt, 5173 for Vite, 8000 for Django, 8080 for Spring, etc.).
- Database / cache deps to spin up locally (Postgres, Redis, …) — declare them as services if the project doesn't expect them to be external.

## 2. Pick services and tasks

- **Services** = long-running. Web servers, watchers, queue workers, databases. `restart: on-failure` by default.
- **Tasks** = one-shot. `pnpm install`, DB migrations, codegen, fixture loaders, install apt packages. Wire dependent services with `needs:` so they wait for the task to finish successfully.
- Names: must match `[A-Za-z0-9_-]+`. Task names and service names share a namespace — no collisions.
- No cycles in `needs:`.
- **Always generate a dependency-install task** and make it the root of the `needs:` graph (every service that needs deps gets `needs: [install, …]`). Future boxes start from a snapshot of the final filesystem so they won't need this, but updates or moving to a cloud provider might need to rebuild the container from scratch. The filesystem can be then later captured by `agentbox-ctl checkpoint --set-default`. The task must be **idempotent and self-healing**: `agentbox-ctl` re-runs pending tasks on every box stop/start (the daemon dies with the container and is relaunched), so a plain `rm -rf node_modules && install` would wipe + reinstall on every start. Guard the rebuild with a marker file *inside* `node_modules` (the `.agentbox-installed` convention AgentBox uses internally): rebuild only when the marker is absent (fresh box), and be a fast no-op once it exists. Detect the package manager from the lockfile — never hardcode `pnpm`. See the worked example below.
- **Add a comment to the beginning** of the file to explain what you did and what issues you encountered, so that future run might use this information in case the project evolves and you need to update the agentbox.yaml file.
-

## 3. Wire readiness probes (services only)

`ready_when:` lets the supervisor decide when a service is "ready" (vs. just "running"). Exactly one of these must be present:

- `port: 3000` — TCP connect (default host `127.0.0.1`; override with `host:`).
- `log_match: "Listening on"` — regex matched against stdout/stderr. First match flips the service to ready.
- `http: "http://127.0.0.1:3000/health"` — GET probe. Optional `expect_status: 200` (default: any 2xx).

Tunables: `interval_ms` (default 500), `initial_delay_ms` (default 0), `timeout_ms` (default 60000), `on_timeout: kill | mark_unhealthy` (default `kill` — re-enters the restart policy).

### Mark the web service with `expose:`

The box's primary web app (the dev server / Next.js / API the user opens in a browser) should declare:

```yaml
    expose:
      port: 3000   # the port this service listens on inside the box
      as: 80        # must be 80 — the container port AgentBox publishes
```

At most **one** service may set `expose:`. AgentBox forwards container `:80` to `127.0.0.1:<port>` and publishes it on the host with `portless` proxy to a <boxname>.localhost url, so `agentbox list`/`status` show it as the box's main URL on every engine (no OrbStack dependency). Set this on the same service whose `ready_when:` you just wrote (a DB or worker should **not** get `expose:`).

## 4. Restart + backoff

Per service:

- `restart: always | on-failure | never` (default `on-failure`).
- `backoff:` — `initial_ms` (default 500), `max_ms` (default 30000; must be `>= initial_ms`), `factor` (default 2).

## 5. (Optional) `defaults:` block

Sets per-project defaults for `agentbox create`/`claude`/`code`/`shell` — same shape as `~/.agentbox/config.yaml`. CLI flags still override. Common keys:

- `box.hostSnapshot` (bool) — APFS-clone the *host* workspace into a per-box scratch dir before seeding `/workspace` (stabilizes the tar-pipe source).
- `box.defaultCheckpoint` (string) — checkpoint new boxes start from (normally you set this via `agentbox-ctl checkpoint --set-default` at the end of setup — see section 9, not by hand).
- `box.withPlaywright` (bool) — install `@playwright/cli` globally inside the box.
- `box.vnc` (bool) — run Xvnc + noVNC on container port 6080.
- `box.isolateClaudeConfig` (bool) — per-box `~/.claude` volume instead of the shared one.
- `code.ide` — `vscode | cursor | auto`.
- `code.autoTerminals` (bool) — auto-generate `.vscode/tasks.json` with per-service tails.
- `browser.default` — `agent-browser | playwright | both`.

Full key list (run on the host): `agentbox config list --keys`.

## 6. Worked example

```yaml
# yaml-language-server: $schema=https://agent-box.sh/schema/agentbox.schema.json
# This agentbox.yaml setup this Next.js project, and includes:
# - a postgres database because it's used in the project
# - an inngest server for queues
# - a fix to move .turbo/cache folder to the workspace to avoid a permission error during setup
# - ...
defaults:
  box:
    withPlaywright: true
  code:
    ide: cursor

tasks:
  # Idempotent install. /workspace is the container's writable filesystem, so
  # node_modules persists across pause/stop/start and is captured by
  # `agentbox checkpoint`. The host's node_modules is macOS-native and is
  # never copied in, so force a clean Linux build the first time — but skip
  # on every subsequent box start (agentbox-ctl re-runs pending tasks after
  # stop/start). Adjust the lockfile detection to the project's package
  # manager.
  install:
    command: |
      set -e
      MARKER=node_modules/.agentbox-installed
      [ -f "$MARKER" ] && { echo "deps installed (marker present) — skip"; exit 0; }
      apt-get update && apt-get install -y postgresql-client
      rm -rf node_modules
      if [ -f pnpm-lock.yaml ]; then
        corepack enable >/dev/null 2>&1 || true
        pnpm install --frozen-lockfile || pnpm install
      fi
      touch "$MARKER"

  migrate:
    command: pnpm db:migrate
    needs: [install]

services:
  postgres:
    command: postgres -D /var/lib/postgresql/data
    ready_when:
      port: 5432
    restart: always

  dev:
    command: pnpm dev
    needs: [install, migrate, postgres]
    ready_when:
      port: 3000
      timeout_ms: 120000
    expose:
      port: 3000
      as: 80
    restart: on-failure
    backoff:
      initial_ms: 500
      max_ms: 5000
      factor: 2
```

## 7. Validate before handing off

- check with `agentbox-ctl reload` and then `agentbox-ctl status` that everything is running as expected.
- Every name in `needs:` must reference an existing task or service.
- A service with `restart: never` and an autostart dependency will block the dependent forever after one failed run — usually a mistake.
- `command:` is either a shell string (run via `bash -c`) or an argv array. Use the argv form if you need to avoid shell quoting.

## 8. Hand-off

Tell the user (verbatim):

   ```
    █████╗  ██████╗ ███████╗███╗   ██╗████████╗██████╗  ██████╗ ██╗  ██╗
   ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔═══██╗╚██╗██╔╝
   ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██████╔╝██║   ██║ ╚███╔╝
   ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██╔══██╗██║   ██║ ██╔██╗
   ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██████╔╝╚██████╔╝██╔╝ ██╗
   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝
   ```

   your box is ready, you can start more sessions with `agentbox claude`
   you can access the web app at https://<boxname>.localhost


## 9. Checkpoint the warm state - DON't SKIP THIS STEP

Checkpoint (snapshot) this box writable layer: once the box is warmed up (deps installed, services ready), checkpoint it with `agentbox-ctl checkpoint --name setup --replace --set-default` so future boxes start ready.
Run this command exactly once. The `--name setup --replace` makes it idempotent — if it ever needs to run again it overwrites the existing `setup` checkpoint instead of stacking duplicates.
On all providers except Vercel, this doesn't need to be confirmed by the user. It will pause the container for several seconds so warn the user about it and write Done when it's done.
On Vercel: this actually STOPS the sandbox, so warn the user about it. Also the system will ask confirmation.

## 10. Known issues

- For Nextjs/Vite/Tasnstack projects, makes sure to forward also websocket for hot reload.

- Service like flask, nextjs, BETTER_AUTH_URL, NEXT_PUBLIC_APP_URL should use the <boxname>.localhost url for the local development so that on the host it will use the same url as the box.

- The `install` task is intentionally a no-op once `node_modules/.agentbox-installed` exists. Do **not** remove the marker guard to "force a fresh install" — that reinstalls on every box start. To force a one-off rebuild, delete `node_modules` (or just the marker) then run `agentbox-ctl reload`.
