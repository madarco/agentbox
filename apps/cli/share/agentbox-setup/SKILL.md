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
- **Always generate a dependency-install task** and make it the root of the `needs:` graph (every service that needs deps gets `needs: [install, …]`). Future boxes start from a snapshot of the final filesystem so they won't need this, but updates or moving to a cloud provider might need to rebuild the container from scratch. The filesystem can be then later captured by `agentbox-ctl checkpoint --set-default`. The task must be **idempotent**: `agentbox-ctl` re-runs pending tasks on every box stop/start (the daemon dies with the container and is relaunched), so an unguarded install would reinstall on every start. The clean way is the **`run_once: true`** field — the supervisor stores a marker keyed by a hash of the command and skips warm boots automatically (the marker lives at `/var/lib/agentbox/tasks/<name>`, on the box rootfs, captured by checkpoints, never polluting `/workspace`). Editing the command re-runs it. Detect the package manager from the lockfile — never hardcode `pnpm`. See the worked example below.
- **Add a comment to the beginning** of the file to explain what you did and what issues you encountered, so that future run might use this information in case the project evolves and you need to update the agentbox.yaml file.

### Stateful services: data persistence & re-seeding (read this for databases)

**Declare a containerized dependency with the `image:` service form** — AgentBox
generates the `docker start`-or-`run` shell (no hand-written `docker run … || docker
start …`). The container runs in the box's dockerd; a published port is reachable
from other in-box services at `127.0.0.1:<host port>`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports: ["5432:5432"]
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    args: "-c max_connections=200"   # string or ["-c","max_connections=200"]
    container_name: app_db            # optional; default = service name
    ready_when: { port: 5432 }
    restart: always
```

The container is reused by name across box stop/start. (Changing `image`/`env`
reuses the existing container as-is; `docker rm <container_name>` + `agentbox-ctl
reload` to apply.) Install the DB client the migrate/seed tasks need (e.g.
`postgresql-client`) in the `install` task and reach the DB over TCP — don't
`docker exec` the container (nested exec fails with a `setns` error in a box).

**A checkpoint does NOT capture docker-in-docker data.** `agentbox checkpoint` is a `docker commit` of the box's writable filesystem (the system + `/workspace`). The in-box `dockerd` keeps its storage in a *separate* per-box volume (`/var/lib/docker`), which is **not** part of that image — it's fresh on every new box and wiped on `agentbox destroy`. So a database or cache you run as a **docker container** (e.g. `docker run … postgres`) starts **empty on every new box** created from a checkpoint (every `agentbox claude` / `agentbox create`), even though `/workspace` and any marker files you wrote were restored. (A DB run as a **native process** with its data dir on the box filesystem — e.g. `postgres -D /var/lib/postgresql/data` — *is* captured by the checkpoint, since it lives in the writable layer.)

**Consequence for migrate/seed tasks of a containerized DB: do NOT use `run_once: true` (the marker form).** A command-hash marker is correct for deps (they live in `/workspace`, which the checkpoint captures), but **wrong** for DB data living in a docker volume: the marker is restored from the checkpoint while the DB is empty, so a marker-guarded seed wrongly skips and the app boots against an empty database. Instead use the **`run_once: { check: <cmd> }`** form — the probe runs first and the seed runs unless the probe exits 0, and **no marker is written** (the DB is the source of truth). Gate on the actual data:

```yaml
  seed:
    # Re-seed when the DB is empty. The postgres data lives in the in-box docker
    # volume, which is NOT captured by `agentbox checkpoint` — so a box started
    # from a checkpoint has the workspace warm but an empty DB. The marker form
    # would be restored while the DB is blank and wrongly skip; the `check` probe
    # gates on the data itself. Exit 0 = already seeded, skip. Fast no-op once
    # the data is present.
    command: pnpm db:seed
    needs: [install, migrate]
    run_once:
      check: |
        export PGPASSWORD=postgres
        psql -h 127.0.0.1 -p 5432 -U postgres -d app -tAc \
          "SELECT EXISTS (SELECT 1 FROM users LIMIT 1)" 2>/dev/null | grep -q t
```

**Lifecycle nuance (this is why the data check, not a marker, is right):**

- **Box stop → start** (`agentbox stop`/`start`): the supervisor daemon dies with the container and is relaunched, so it **re-runs all tasks** from `pending`. The per-box docker volume *does* survive stop/start, so the DB still has data — the data check makes the seed a fast no-op.
- **New box from a checkpoint** (`agentbox claude`/`create`): tasks run and the DB volume is empty → the check fails → the seed runs. Correct.
- **Resume after pause** (`agentbox pause`/`unpause`): the daemon is frozen and thawed, **not** restarted, so tasks do **not** re-run at all — nothing to seed, the running DB is untouched.

(Migrations are usually safe to re-run as-is: migration tools track applied migrations in their own table, which on a fresh box is empty, so they simply re-apply. Only the *data* seed needs the existence check.) Install the DB client the seed/migrate tasks need (e.g. `postgresql-client`) in the `install` task — don't `docker exec` the DB container for these checks (nested `docker exec` fails inside a box with a `setns` error); reach it over TCP with the client tools instead.

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
  # never copied in, so the first Linux install runs; `run_once: true` then
  # skips it on every subsequent box start (the supervisor stores a marker
  # keyed by a hash of the command). Adjust the lockfile detection to the
  # project's package manager.
  install:
    command: |
      set -e
      sudo apt-get update && sudo apt-get install -y postgresql-client
      if [ -f pnpm-lock.yaml ]; then
        corepack enable >/dev/null 2>&1 || true
        pnpm install --frozen-lockfile || pnpm install
      fi
    run_once: true

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

## 6b. Bringing extra host files/folders into the box

Two ways to copy host files in (both COPY — never a live mount, so the box can't
write back to the host):

- **`carry:` block** (declarative, in `agentbox.yaml`) — for files/dirs every box
  should get at create time. Each entry is `{ src, dest }` with optional `mode`,
  `user`, `optional`, and `exclude:` (a list of tar globs / bare dir names to drop
  when copying a directory). Heavy regenerable dirs (`.git`, `node_modules`, `bin`,
  `obj`, `packages`, `dist`, `.next`, `target`) are dropped by default; `exclude:`
  is additive. Each carry entry is capped at `box.cpMaxBytes` (default 100 MiB
  after excludes) — the same limit `agentbox cp` enforces.
- **`agentbox-ctl cp fromHost <hostPath> <boxPath>`** (ad-hoc, from inside the box)
  — for a one-off copy. Prompts the user on the host to approve.

**The per-copy size limit (important for large/legacy folders).** A single copy is
blocked above `box.cpMaxBytes` (default **100 MB**) *after* default excludes, so it
fails loud instead of silently hanging. When blocked you get a `du`-style tree of
the biggest remaining folders/subfolders. To get under the limit, EITHER:

- **drop what the box can regenerate** (the default excludes already remove
  `node_modules`/`.git`/build output; add more with `--exclude=<glob-or-name>`), OR
- **copy the heavy folders one at a time** so each copy is under the limit, OR
- pass `--yes` to copy the whole thing anyway (only when you really need it all).

Example: a 2.4 GB legacy folder is mostly `packages/` (NuGet) + `.git`; those are
excluded by default, and what's left can be split:
`agentbox-ctl cp fromHost ../legacy/src /workspace/legacy/src` then
`... cp fromHost ../legacy/Database /workspace/legacy/Database`.

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
Remember the checkpoint captures the writable layer (`/workspace` + system), **not** docker-in-docker volumes — so a containerized DB's data does not carry into new boxes. That's expected; the data-existence-gated seed task from section 2 re-seeds those automatically. (If you need the data itself to persist into new boxes, run the DB as a native process with its data dir on the box filesystem, or bind a `/workspace` path as the container's data volume so it lands in the checkpoint.)
Run this command exactly once. The `--name setup --replace` makes it idempotent — if it ever needs to run again it overwrites the existing `setup` checkpoint instead of stacking duplicates.
On all providers except Vercel, this doesn't need to be confirmed by the user. It will pause the container for several seconds so warn the user about it and write Done when it's done.
On Vercel: this actually STOPS the sandbox, so warn the user about it. Also the system will ask confirmation.

## 10. Known issues

- For Nextjs/Vite/Tasnstack projects, makes sure to forward also websocket for hot reload.

- Service like flask, nextjs, BETTER_AUTH_URL, NEXT_PUBLIC_APP_URL should use the `<boxname>.localhost` url for the local development so that on the host it will use the same url as the box. Render this automatically instead of hand-writing `sed` — see section 6c.

- The `install` task above uses `run_once: true`, so it is a no-op on warm boots. Do **not** wrap it in a manual marker check too. To force a one-off rebuild, run `agentbox-ctl run-task install --force` (which bypasses the run_once marker), or edit the command (a changed command invalidates the hash and re-runs).

## 11. Pin URLs / render config files (env, secrets)

Many apps hard-code a hostname (e.g. `optima.localhost`) or read a gitignored `.env`. Instead of long `sed` commands in a task, use the built-ins:

- **`agentbox-ctl render <src>`** — a declarative `sed` for files already in the workspace. `--env` substitutes `{{AGENTBOX_*}}` placeholders; `--rules <name>` applies a named rule-set from the top-level `replacements:` block; `--rule 'from=>to'` / `--rule-regex 'pat=>repl'` are inline. Write to `--out <path>` (or `--in-place`). The whitelist placeholders are `{{AGENTBOX_BOX_NAME}}`, `{{AGENTBOX_BOX_HOST}}` (= `<boxname>.localhost`), `{{AGENTBOX_BOX_ID}}`, `{{AGENTBOX_BOX_KIND}}`, `{{AGENTBOX_HOST_WORKSPACE}}`, `{{AGENTBOX_PROJECT_ROOT}}`.

  Render a gitignored `.env` from a committed `env.example` on every boot, pinning the URLs to this box:

  ```yaml
  replacements:
    box-host:
      - { from: 'optima\.localhost', to: '{{AGENTBOX_BOX_HOST}}', regex: true }  # {{AGENTBOX_BOX_HOST}} = <box>.localhost

  tasks:
    env:
      # The render is idempotent (the rules re-pin the same lines every boot), so
      # no `run_once:` guard is needed — it self-corrects on a checkpoint-started
      # box that carries a different box's host in .env.
      command: agentbox-ctl render apps/saas/env.example --out apps/saas/.env --env --rules box-host
  ```

  Note: an `run_once: { check: <cmd> }` probe runs verbatim via `bash -c` with the box env — use shell vars like `$AGENTBOX_BOX_NAME`, NOT `{{…}}` placeholders (those are only expanded by `render`/carry, never by the supervisor).

  **Generated secrets:** put `{{AGENTBOX_AUTO_SECRET}}` in the template for a value like `BETTER_AUTH_SECRET` instead of shelling out to `openssl rand`. Unnamed → a fresh 32-byte base64url secret each render (stable when you render the template→`.env` once). `{{AGENTBOX_AUTO_SECRET:better-auth}}` → generated once, persisted at `/var/lib/agentbox/secrets/<name>`, reused on every render (stable even if you render every boot). Example `env.example` line: `BETTER_AUTH_SECRET="{{AGENTBOX_AUTO_SECRET:better-auth}}"`.

- **`carry:` + `replaceEnvs`/`replace`/`rules`** — for a host-only file (e.g. a real `.env` with secrets that never lives in the repo), carry it in and render it host-side in one step (file entries only):

  ```yaml
  carry:
    - src: ~/secrets/optima.env
      dest: /workspace/apps/saas/.env
      replaceEnvs: true
      rules: [box-host]
  ```
