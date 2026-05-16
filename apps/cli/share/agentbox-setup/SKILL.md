---
name: agentbox-setup
description: Generate an agentbox.yaml for the current AgentBox workspace. Invoke when the user opens a sandbox without an agentbox.yaml or asks to (re)configure one.
---

# /agentbox-setup

Goal: produce a `/workspace/agentbox.yaml` that captures this project's services, tasks, and box defaults so the in-box supervisor (`agentbox-ctl`) can boot the workspace deterministically.

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
- **Tasks** = one-shot. `pnpm install`, DB migrations, codegen, fixture loaders. Wire dependent services with `needs:` so they wait for the task to finish successfully.
- Names: must match `[A-Za-z0-9_-]+`. Task names and service names share a namespace — no collisions.
- No cycles in `needs:`.

## 3. Wire readiness probes (services only)

`ready_when:` lets the supervisor decide when a service is "ready" (vs. just "running"). Exactly one of these must be present:

- `port: 3000` — TCP connect (default host `127.0.0.1`; override with `host:`).
- `log_match: "Listening on"` — regex matched against stdout/stderr. First match flips the service to ready.
- `http: "http://127.0.0.1:3000/health"` — GET probe. Optional `expect_status: 200` (default: any 2xx).

Tunables: `interval_ms` (default 500), `initial_delay_ms` (default 0), `timeout_ms` (default 60000), `on_timeout: kill | mark_unhealthy` (default `kill` — re-enters the restart policy).

## 4. Restart + backoff

Per service:

- `restart: always | on-failure | never` (default `on-failure`).
- `backoff:` — `initial_ms` (default 500), `max_ms` (default 30000; must be `>= initial_ms`), `factor` (default 2).

## 5. (Optional) `defaults:` block

Sets per-project defaults for `agentbox create`/`claude`/`code`/`shell` — same shape as `~/.agentbox/config.yaml`. CLI flags still override. Common keys:

- `box.snapshot` (bool) — frozen APFS clone of the workspace as overlay lower.
- `box.withPlaywright` (bool) — install `@playwright/cli` globally inside the box.
- `box.vnc` (bool) — run Xvnc + noVNC on container port 6080.
- `box.isolateClaudeConfig` (bool) — per-box `~/.claude` volume instead of the shared one.
- `code.ide` — `vscode | cursor | auto`.
- `code.autoTerminals` (bool) — auto-generate `.vscode/tasks.json` with per-service tails.
- `browser.default` — `agent-browser | playwright | both`.

Full key list (run on the host): `agentbox config list --keys`.

## 6. Worked example

```yaml
# yaml-language-server: $schema=https://agentbox.dev/schema/agentbox.schema.json
defaults:
  box:
    withPlaywright: true
  code:
    ide: cursor

tasks:
  install:
    command: pnpm install

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

1. Write the file to `/workspace/agentbox.yaml`.
2. **Apply it live**: from inside the box run `agentbox-ctl reload`. The already-running supervisor re-reads the config and immediately runs the declared tasks and autostarts the services — no box restart needed. It prints the `added` / `removed` / `changed` diff. If it errors because the daemon isn't running, the config is still valid: the next `agentbox start` (or `agentbox create` in this workspace) picks it up automatically.
3. Confirm with `agentbox-ctl status`: tasks should be `running` or `done`, autostart services `starting` or `ready`. If something failed, tail it with `agentbox-ctl logs <service>` and fix the config, then `agentbox-ctl reload` again.
4. Tell the user:

   > I wrote `/workspace/agentbox.yaml` and ran `agentbox-ctl reload` so the supervisor is already running the declared tasks/services. To land the file on the host:
   > - commit it inside the box (`git add agentbox.yaml && git commit -m 'add agentbox config'`) — the box's `.git/` is bind-mounted, so the commit shows up on the host immediately; or
   > - on the host, tell the user to run `agentbox pull config` to update their original host workspace. `agentbox pull env` if you also create env files.

## 9. Known issues

- For Nextjs/Vite/Tasnstack projects, makes sure to forward also websocket for hot reload.