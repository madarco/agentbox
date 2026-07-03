# @agentbox/hub

The AgentBox **hub** — the `@agentbox/relay` core wrapped as a
Next.js app. The **same code** deploys to Vercel (managed) or self-hosts on a
VPS (Postgres + `next start`). It holds the centralized concerns so boxes don't
have to:

- **git credentials** — a GitHub App; it leases 1-hour, single-repo installation
  tokens to boxes on demand (`git.lease-token`). The plane never holds a PAT and
  never a box's repo.
- **permission state** — pending approvals live in Postgres; boxes poll
  `/rpc/status/:id`, approvers answer via `/admin/prompts/answer` (or the
  dashboard). No long-lived connections.
- **registry / events / status** — one cross-machine view of every box.

It is **stateless per request** (all state in Postgres) and does **no host
execution**: host-local actions (`cp`, `download`, `checkpoint`, docker-style
`git push`) are rejected — cloud boxes push via leasing. The long-lived laptop
relay (`agentbox-relay serve`) is unchanged and shares the same core.

## Endpoints

Box (per-box bearer): `POST /events`, `POST /rpc` (`git.lease-token`,
`browser.open`), `GET /rpc/status/:promptId`.
Admin (the `AGENTBOX_RELAY_ADMIN_TOKEN` bearer, never loopback):
`POST /admin/register-box`, `POST /admin/forget-box`, `GET /admin/box-status`,
`GET /admin/events`, `GET /admin/registry`, `GET /admin/prompts`,
`POST /admin/prompts/answer`. `GET /healthz` is open.

Those are the **internal** relay wire (per-box / loopback / admin-bearer). The
**public** REST API is a separate, versioned surface — see below.

## Public REST API (`/api/v1`)

A stable, documented HTTP API for external callers (IDEs, scripts, the future
macOS app) — a thin facade over the in-process backend, served on the relay port
via the `uiHandler` seam (Next routes under `app/(dashboard)/api/v1/`). It does
**not** reuse the internal `/admin`+`/rpc` wire (loopback-only, exit-code-coupled
statuses, no schema).

- **Auth:** `Authorization: Bearer <AGENTBOX_HUB_TOKEN>` in token mode (or the
  better-auth session in password mode); always a JSON `401`, never a `/signin`
  redirect. `/health`, `/openapi.json`, `/docs` are public.
- **Envelope:** success returns the resource directly; errors are
  `{ error: { code, message, details? } }` with a matching HTTP status.
- **Routes:** `GET /boxes`, `GET /boxes/:id`,
  `POST /boxes/:id/{pause,resume,stop,destroy}`, `POST /boxes` (create →
  `202 {jobId}`), `GET|POST /projects`, `GET /approvals`,
  `POST /approvals/:id/answer`, `GET /jobs/:id`, `GET /jobs/:id/logs` (SSE),
  `GET /health`, `GET /openapi.json` (OpenAPI 3.1), `GET /docs` (Scalar).
- **Reads** are topology-agnostic (in-process → Postgres via `getDashboardData()`);
  **writes** use the in-process backend (hosted-plane writes are a follow-up).

Full reference: `apps/web/content/docs/hub-api.mdx` (published at
https://agent-box.sh/docs/hub-api).

## Configuration

See [`.env.example`](./.env.example). Required: `POSTGRES_URL`,
`AGENTBOX_RELAY_ADMIN_TOKEN`. Optional (enables leasing): `GITHUB_APP_ID` +
`GITHUB_APP_PRIVATE_KEY` (raw or base64 PEM). Tables are created automatically on
first request (`PostgresStore.migrate`).

## Profiles + auth (Web UI)

The hub runs in one of three profiles, selected by `AGENTBOX_HUB_PROFILE`:

| Profile | Runtime | Box source | Auth store | Login |
|---|---|---|---|---|
| `localhost` | embedded `server.ts` (relay + Next, one process on 8787) | relay live in-process + `~/.agentbox` state | — | **token** (shared-secret cookie) |
| `hetzner` | embedded `server.ts`, bind `0.0.0.0` | same as localhost | `node:sqlite` @ `~/.agentbox/hub/auth.db` | password |
| `vercel` | Next only (serverless) | Postgres (`PostgresStore`) | Postgres | password |

`server.ts` defaults the profile from the bind host (`127.0.0.1` → localhost,
else hetzner); set `AGENTBOX_HUB_PROFILE=vercel` explicitly for the serverless
path. `AGENTBOX_HUB_AUTH=off` disables all protection on any profile.

**Run it locally.** `agentbox hub` (start/stop/status/restart) spawns the
embedded hub on 8787 and opens `http://127.0.0.1:8787/?token=<secret>`. It ships a
self-contained Next `output:'standalone'` build (a compiled `server.ts` + traced
`node_modules` staged under the CLI's `runtime/hub/`), so it runs from a published
install (Node ≥ 22.5). The hub is a superset of the lean relay: `agentbox hub`
reclaims any lean relay on 8787, and once it's up the create path reuses it (both
answer `/healthz`, distinguished by a `ui` flag).

**localhost — token gate.** There is no login screen: `server.ts` auto-generates
`~/.agentbox/hub/token` (0600) and logs the entry URL
`http://127.0.0.1:8787/?token=<secret>`. The hub validates the token, stores it in an httpOnly cookie,
and redirects to the clean URL; later requests are authorized by the cookie, and
direct access without it is locked (401). This protects the loopback bind from
other local processes and DNS-rebinding.

**hetzner/vercel — password auth is secret-gated.** Login is enforced when `AGENTBOX_HUB_AUTH=on`, or (when
unset) whenever `BETTER_AUTH_SECRET` is present — so a secretless deploy never
serves a login page with no user (no lockout). better-auth uses its built-in
Kysely adapter with the driver instance directly (`node:sqlite` `DatabaseSync` or
`pg` `Pool`); tables are created by boot-time migration (embedded) or the
`db:auth-migrate` script (vercel, run in the build). The first admin is
**env-seeded** on first boot / migrate from `AGENTBOX_HUB_ADMIN_EMAIL` +
`AGENTBOX_HUB_ADMIN_PASSWORD` (idempotent; no public signup).

Auth env (see [`.env.example`](./.env.example)): `AGENTBOX_HUB_PROFILE`,
`AGENTBOX_HUB_AUTH`, `BETTER_AUTH_SECRET` (>= 32 chars), `AGENTBOX_HUB_ADMIN_EMAIL`,
`AGENTBOX_HUB_ADMIN_PASSWORD`, optional `BETTER_AUTH_URL` (pins the trusted origin;
otherwise the request origin is trusted — fine for a single-origin self-hosted hub).
The embedded server needs Node >= 22.5 for `node:sqlite` (stable on Node 24; pass
`--experimental-sqlite` on 22.5–23).

> The hub server needs Node >= 22.5; the lean relay/CLI keep the lower floor.

## Web UI views

Dashboard (boxes grouped by project), Box detail, and **Approvals** — a live view
of pending host-action approvals (git push, `cp`, `download`, gh/integration
writes) a box is blocked on. Approve/Deny answers the parked in-box RPC and
unblocks the box. On the embedded profiles (localhost/hetzner) the relay runs in
**block mode**, so approvals are read from the relay handle's in-process prompt
map (`handle.prompts`), not the Store; the sidebar badge shows the pending count.

**Live updates** are pushed over SSE: the browser subscribes to `/api/events`
(same-origin, gated by the auth cookie); the custom server's in-process
`HubNotifier` fires a `change` whenever the pending-approval set mutates, and a
15s `ping` heartbeat doubles as a catch-all refresh for box changes made outside
the hub. Each event triggers a `router.refresh()` of the force-dynamic layout, so
box states and approvals stay current without polling. (Vercel/serverless has no
in-process notifier — its stream degrades to heartbeats only; poll-mode approvals
over `PostgresStore` are a later item.)

## Deploy

The turnkey path is `agentbox control-plane setup` (creates the GitHub App, then
`--deploy vercel|hetzner`, then points the CLI at it). The recipes below are the
manual equivalents / self-host path.

### Self-host (docker-compose)

```bash
export AGENTBOX_RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose up --build      # Postgres + the app on :8787
curl localhost:8787/healthz
```

### Vercel

`agentbox control-plane setup --deploy vercel` builds the plane **from GitHub** via the
Vercel API — no local upload, so it works from a global npm install. If you don't own
`--repo` (default `madarco/agentbox`) it **auto-forks via `gh`** and deploys the fork;
auto-provisions Neon; sets the App env; builds `--ref` (default `main`). If Vercel's GitHub
App isn't on your account it falls back to the **Deploy Button** (clone + App install +
Postgres in-browser), then sets the secrets + redeploys. The app **boots even with no
secrets** (`/healthz` always 200; admin/leasing 503 until wired), so the bare→wire→redeploy
sequence is never broken. Manual equivalent: create the project with Root Directory
`apps/hub`, attach Neon, set the three env vars, deploy.

Then point boxes/CLI at it: `agentbox control-plane set-url https://<deployment>`.

## GitHub App setup (for leasing)

Create a GitHub App, grant **Repository permissions → Contents: Read & write**
and **Pull requests: Read & write**, install it on the repos your boxes work in,
download a private key, and set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
Installation tokens are repo-scoped and expire in 1 hour; the plane re-mints as
needed and never persists them.
