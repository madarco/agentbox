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

**localhost — token gate.** There is no login screen: `server.ts` auto-generates
`~/.agentbox/hub/token` (0600) and logs the entry URL
`http://127.0.0.1:8787/?token=<secret>` (the `agentbox hub` command, Phase 5,
opens it for you). The hub validates the token, stores it in an httpOnly cookie,
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
