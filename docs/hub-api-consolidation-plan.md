# Hub API consolidation — one hub, one REST API, switch the URL

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Design/roadmap doc for collapsing the
> "local hub" and the "remote control box" into a single hub whose only local↔remote difference is a
> deploy-time profile flag, and for unifying the client-facing HTTP surface so the CLI, the macOS tray,
> and the web UI all speak **one** REST API and switch only the base URL.
>
> Related: [`control-box-plan.md`](./control-box-plan.md) (the control box — the plan of record for the
> deployed hub, incl. the earlier per-command remote-support audit in its appendix),
> [`local-adoption-plan.md`](./local-adoption-plan.md) (PC as thin client), [`host-relay.md`](./host-relay.md)
> (the relay core), and the public API reference [`apps/web/content/docs/api.mdx`](../apps/web/content/docs/api.mdx).
> Status: **analysis + design (not yet implemented)**. Maintain status live per project convention.

## Context

Today there is a **"local hub"** (`agentbox hub` on `127.0.0.1:8787`) and a **"remote control box"**
(the same hub deployed on a Hetzner VPS, driven by `agentbox control-plane *`). The product intent:

- **One conceptual hub.** Local = simple install; remote = complete install (scheduled events, PR
  reviews, Linear-ticket runs, always-on boxes with leased credentials). The local hub was only ever
  an early step toward the remote one.
- **Rename `control-plane *` → `hub *`.** When a remote hub is enabled, the PC stops using the local
  hub (remote becomes the default) — **except local docker boxes**, which stay on the PC.
- **One REST API for CLI + tray + web.** They should differ only by **base URL** (localhost vs remote)
  + token. ~90% of actions just call the hub URL; the rest are inherently local (terminal attach,
  filesystem, local docker).

This doc analyzes **every place we call the hub / remote hub**, whether each should be **consolidated
onto one API** or **kept as a separate internal wire**, and gives a phased plan to get there.

## Codebase reality — it's already one project + a flag

There is **no second codebase to merge.** The local hub and the remote control box are the **same
binary**: `agentbox hub` (local) and the deployed control box both run
`apps/hub/dist-standalone/apps/hub/server.js` — the standalone build of the one `apps/hub/server.ts`
— which starts `startRelayDaemon` from `packages/relay`. Confirmed: `apps/` holds only `cli`, `hub`,
`web`; `apps/hub/Dockerfile:49` runs that same `server.js`; `apps/hub/server.ts:102` boots the relay.

So **the hub already IS the relay** (a superset of the lean `agentbox relay`), and the only difference
between local and remote is a **runtime profile flag**, `AGENTBOX_HUB_PROFILE`
(`apps/hub/lib/auth-config.ts`):

| Profile | Bind | Auth | Store | Worker | Git auth |
|---|---|---|---|---|---|
| `localhost` | 127.0.0.1 | token-cookie | in-memory / `~/.agentbox` | off | host relay (your git creds) |
| `hetzner` (control box) | 0.0.0.0 | better-auth password | SQLite | **on** (resident create worker) | **GitHub App leasing** |
| `vercel` | serverless | password | Postgres | — | GitHub App leasing |

**Therefore "consolidation" is NOT a code merge** — the server code is already unified. It's two
narrower jobs: (1) unify the **client-facing API surface** (`/api/v1` vs `/admin`+`/remote`) so CLI +
tray + web all speak one API and switch only the base URL; (2) shrink the **behavioral divergence**
across the profile flag to the few things that genuinely must differ.

## Goal — one hub, a deploy flag, remote = "remote relay" (laptop off)

- **One hub, one flag.** Keep exactly one hub codebase; `AGENTBOX_HUB_PROFILE` (local ⇄ remote) is the
  switch, set at deploy. Aim to keep the two profiles as close as possible.
- **The remote hub is a remote relay.** Cloud boxes register on it, lease git tokens from it, and post
  events/approvals to it — so **the local relay/hub can be off and the laptop can be shut down.** This
  is already the "control-plane topology" (cloud boxes register on the control box, not loopback, and
  push host-off via a leased token — verified in [`control-box-plan.md`](./control-box-plan.md)); the
  remaining work is to make the remote hub the **default relay** for cloud boxes whenever it's
  configured, so nothing depends on the laptop relay except local docker + inherently-host-side actions.

### Behavioral divergence: intentional vs accidental

**Intentional (must differ across the flag — keep, don't fight):**
- **Git auth mode** — the biggest one. Local hub pushes with **your host git credentials** via the
  relay; the remote hub has no host creds, so it leases **GitHub-App** installation tokens
  (`git.pushMode`, `GitHubAppLeaser`). This is exactly why the remote hub enables laptop-off pushes.
- **Auth gate** — localhost token-cookie vs remote password/login (a public internet endpoint needs
  real auth). Plus the missing **headless API key** for remote `/api/v1` (blocker P0 below).
- **Resident worker on/off** — the remote hub runs the create worker in-process (always-on); the
  laptop hub creates locally.

**Accidental (eliminate — this is the consolidation):**
- The **`/api/v1` vs `/admin`+`/remote` client split** (the whole table below).
- The **`vercel`/serverless profile** diverging hard (Next-only, no `server.ts`, writes 503). It's
  already frozen ([`control-box-plan.md`](./control-box-plan.md): "Vercel deploy… not extended"); treat
  it as the odd-one-out / candidate for deprecation rather than a third path to keep in sync.
- **Two approval mailboxes** (block-mode in-proc vs poll-mode Store).
- **`/api/v1` writes needing the in-process backend** (503 on the plane path) — a profile accident,
  not a real requirement.

## The core finding: two disjoint surfaces, functionally parallel

Both surfaces are served by the **one** `apps/hub` app (one process, one port). Relay routes match
first in `packages/relay/src/server.ts`; everything else falls through to the Next handlers.

| | **`/api/v1/*`** (+ `/api/events`) | **`/admin/*` + `/remote/*` + `/rpc` + `/bridge` + custody** |
|---|---|---|
| Server | Next route handlers (`apps/hub/app/(dashboard)/api/v1/**`) | relay daemon (`packages/relay/src/server.ts`) / hosted plane (`core/handler.ts`) |
| Purpose | **public client API** (rich, versioned, OpenAPI) | **internal wire**: box↔hub RPC, host-admin, custody, create-queue, cross-machine `RemoteStore` |
| Auth | Bearer `AGENTBOX_HUB_TOKEN` **or** cookie (localhost); **session cookie only** on the control box (no headless key yet) | admin Bearer `AGENTBOX_RELAY_ADMIN_TOKEN` (`/admin`,`/remote`); per-box bearer (`/rpc`,`/events`); bridge token (`/bridge`) |
| Writes | need the **in-process backend** (`globalThis.__AGENTBOX_HUB_BACKEND`); **503 on the Postgres/plane path** | remote-write path that works today (`POST /remote/boxes` → resident worker) |
| Clients | **tray** (hardcoded `127.0.0.1:8787`) + **web UI** | **CLI** control-plane clients + **boxes themselves** |

**No client crosses over.** The CLI is 100% on `/admin`+`/remote`; the tray + web are 100% on
`/api/v1`. Yet they expose the **same capabilities through parallel routes with different auth and
backends** — that split is the whole problem.

### Where the same capability is exposed twice (consolidation targets)

| Capability | `/api/v1` (tray/web) | `/admin`+`/remote` (CLI) | Backend split |
|---|---|---|---|
| List boxes | `GET /api/v1/boxes` (rich `HubState`) | `POST /admin/store {listBoxes}` + `GET /admin/registry` (raw) | reads topology-agnostic on both |
| Create box | `POST /api/v1/boxes` → `{jobId}` | `POST /remote/boxes` → `{jobId}` | `/api/v1` needs in-proc backend (503 on plane); `/remote/boxes` uses the resident worker |
| Job status | `GET /api/v1/jobs/:id` | `GET /remote/boxes/:jobId` | — |
| Approvals list | `GET /api/v1/approvals` (block-mode, in-proc mailbox) | `GET /admin/prompts` (poll mailbox, Store) | **two approval subsystems** |
| Approvals answer | `POST /api/v1/approvals/:id/answer` | `POST /admin/prompts/answer` | same |
| Remove box | `POST /api/v1/boxes/:id/destroy` (destroys the real box) | `DELETE /remote/boxes/:id` (reaps registration+custody only) | **different semantics** |

## Full call-site table — current status + verdict

Legend — **Verdict**: *Consolidate* = should become one `/api/v1` route all clients call (URL-swappable);
*Internal* = genuinely box↔hub / custody plumbing, keep on the relay wire (not a client API);
*Client-local* = never an HTTP-to-hub call, runs on the host.

| # | Call site / capability | On `/api/v1`? | On `/admin`/`/remote`/`/rpc`? | Called by | Local/Remote today | Verdict |
|---|---|---|---|---|---|---|
| 1 | Box list / read | `GET /api/v1/boxes`,`/boxes/:id` | `POST /admin/store`, `GET /admin/registry` | tray/web; **CLI** (`hub-list`,`hub-adopt`,`ls`) | both (CLI remote via admin) | **Consolidate** onto `/api/v1/boxes` |
| 2 | Box create | `POST /api/v1/boxes` | `POST /remote/boxes` | tray/web; **CLI** (`create --via-hub`) | remote-write only on `/remote/boxes` | **Consolidate** (give `/api/v1` the worker write path) |
| 3 | Job status / logs | `GET /api/v1/jobs/:id`,`/logs`,`login-code` | `GET /remote/boxes/:jobId` | tray/web; CLI | both | **Consolidate** onto `/api/v1/jobs` |
| 4 | Lifecycle start/stop/pause/resume | `POST /api/v1/boxes/:id/:action` | — (CLI does these **locally**, not via hub) | tray/web | local (in-proc backend) | **Consolidate** + add remote-write |
| 5 | Destroy vs reap | `POST /api/v1/boxes/:id/destroy` | `DELETE /remote/boxes/:id` (reap) | tray/web; **CLI** (`boxes rm`) | both, **different semantics** | **Consolidate** — one destroy that also reaps |
| 6 | Git ops (checkout/branch/pull/push/push-host) | `GET/POST /api/v1/boxes/:id/git*` | box-driven `POST /rpc {git.*}` (per-box) | tray/web; boxes | local (in-proc) | **Consolidate** client-facing git onto `/api/v1`; `/rpc` lease stays **Internal** |
| 7 | Services list / restart | `GET/POST /api/v1/boxes/:id/services*` | — | tray/web | local | **Consolidate** + remote-write |
| 8 | Rename | `POST /api/v1/boxes/:id/rename` | — | tray/web | local | **Consolidate** + remote-write |
| 9 | Branches (box/project) | `GET /api/v1/boxes/:id/branches`,`/projects/:id/branches` | — | tray/web | both (read) | **Consolidate** (reads already topology-agnostic) |
| 10 | Approvals list / answer | `GET/POST /api/v1/approvals*` | `GET/POST /admin/prompts*` | tray/web; **CLI** (`prompts`,`agent approve`) | both, **two mailboxes** | **Consolidate** — converge on one mailbox behind `/api/v1/approvals` |
| 11 | Projects list / register / unregister | `GET/POST/DELETE /api/v1/projects*` | — | tray/web | both (read) | **Consolidate** + remote-write |
| 12 | Providers list / credentials / prepare | `GET/POST /api/v1/providers*` | — | tray/web | local | **Consolidate** (remote bake already fits the worker/queue) |
| 13 | Remote-docker hosts | `GET/POST/DELETE /api/v1/hosts*` | — | tray/web | local | **Consolidate**; note remote-docker itself never routes via a remote hub |
| 14 | Live updates | SSE `GET /api/events` (cookie) | `GET /admin/prompts/stream` (SSE, admin) | tray/web; (CLI polls) | both | **Consolidate** onto `/api/events` (add a headless-token accept) |
| 15 | Health | `GET /api/v1/health` | `GET /healthz` | tray/web; CLI (`relay/control-plane status`) | both | Keep both (`/healthz` is the ops probe; `/api/v1/health` the client one) |
| 16 | Open-in / open-targets (host GUI attach) | `POST /api/v1/boxes/:id/open`,`GET /open-targets` | — | tray (also **shells CLI**) | **local** (host GUI) | **Client-local** — inherently host-side |
| 17 | Custody: agent creds / secrets / box SSH keys | — | `GET/PUT/DELETE /admin/custody/*` | **CLI** (`credentials`,`secrets`,`custody`,`hub pull/adopt`) | remote | **Internal** — credential plane, not a client API |
| 18 | Box registration | — | `POST /admin/register-box`,`forget-box` | boxes / worker / `plane-register` | remote | **Internal** |
| 19 | Box RPC wire (git-lease-token, cp, download, checkpoint, browser.open) | — | `POST /rpc`, `GET /rpc/status/:id` (per-box) | boxes | box↔hub | **Internal** |
| 20 | Box events | — | `POST /events` (per-box) | boxes | box↔hub | **Internal** |
| 21 | In-sandbox bridge relay | — | `GET/POST /bridge/*` | host poller ↔ Daytona box | box↔host | **Internal** |
| 22 | GitHub-App repo-installed | — | `GET /admin/app/repo-installed` | CLI (`control-plane add`, ensure-repo) | remote | **Internal** (or fold under `/api/v1/projects`) |
| 23 | Cross-machine Store RPC | — | `POST /admin/store` (`RemoteStore`) | CLI (list/adopt) | remote | Subsumed by #1 — retire once CLI uses `/api/v1/boxes` |
| 24 | Attach / shell / cp / download / screen (CLI) | — | — (drives the box directly) | CLI | **local** | **Client-local** |

### Net picture

- **Consolidate onto `/api/v1`** (the single URL-swappable client API): box list, create, job status,
  lifecycle, destroy(+reap), client git, services, rename, branches, approvals, projects, providers,
  hosts, live SSE. These are the ~90% we want pointed at the hub URL.
- **Keep Internal** (box↔hub + credential plane; not a client API, stays admin/per-box-bearer):
  custody, register-box, `/rpc` lease/cp/download/checkpoint, `/events`, `/bridge`, repo-installed.
- **Client-local** (never a hub HTTP call): open-in / attach / shell / cp / download / screen / local
  docker.

## The three blockers to "just switch the base URL"

1. **`/api/v1` has no headless auth on the control box.** In password mode it accepts only the
   better-auth **session cookie** — `apps/hub/proxy.ts:46-49` literally notes "a dedicated API-key
   scheme for headless clients lands with the hosted-remote phase." This is the linchpin: without it
   neither the CLI nor the tray can call `/api/v1` remotely.
2. **`/api/v1` writes require the in-process backend** (`api/v1/lib/backend.ts`), so they **503 on the
   Postgres/plane path** and can only drive boxes the hub owns in-process — a remote hub cannot yet
   drive a PC-created box (reverse-adoption gap). The remote-write path today lives only on
   `/remote/boxes` (the resident worker).
3. **Three clients speak two surfaces.** CLI = `/admin`+`/remote`; tray/web = `/api/v1`; and the web
   UI's *mutations are React Server Actions* (in-process), not HTTP — so "hub web = pure REST client"
   is aspirational, not literal.

## Recommended consolidation (phased)

**Direction:** keep the **one hub codebase** and the `AGENTBOX_HUB_PROFILE` flag; make `/api/v1` **the**
single public hub API for CLI + tray + web + IDE, URL-swappable (local token vs remote key). Keep
`/admin`+`/rpc`+`/bridge`+custody as the internal box↔hub + credential wire. Make the remote hub the
**default relay** for cloud boxes when configured (they register/lease/report there → laptop can be
off); local docker + host-side actions stay on the laptop. Rename `control-plane *` → `hub *`.
Guiding principle: **new hub features go behind `/api/v1` and work in both profiles**; only the
intentional divergences above (git auth, gate, worker) branch on the profile.

- **Phase 0 — Headless key for `/api/v1` (linchpin). DONE.** `gateApi`'s password branch now accepts
  `Authorization: Bearer <AGENTBOX_HUB_API_KEY>` before the session-cookie fallback (`apps/hub/proxy.ts`);
  gates `/api/v1` only, never the UI pages. The key is minted at `control-plane setup`/deploy
  (`randomBytes(32).hex`), recorded in `~/.agentbox/control-plane/control-plane.env`, and injected into
  the container via `docker-compose.yml`. CLI seam `resolveHubApiTarget()` added (not yet wired).
  Unblocks CLI **and** tray remotely.
- **Phase 1 — Remote-write path for `/api/v1`.** Make `POST /api/v1/boxes`, lifecycle, git, services,
  approvals work on the control box for boxes the hub owns by routing writes through the resident
  worker / `RemoteStore` instead of 503 (`api/v1/lib/backend.ts` + the boxes/git/approvals routes).
  Add reverse-adoption so a remote hub can drive PC-registered boxes. Converge the two approval
  mailboxes on one, surfaced at `/api/v1/approvals`.
- **Phase 2 — CLI onto one client.** Add a shared `HubApiClient` (base URL = local `~/.agentbox/hub/token`
  target **or** remote `relay.controlPlaneUrl` + key, via a `resolveCustodyTarget`-style resolver).
  Move box list/create/job/lifecycle/destroy/approvals off `admin-client`/`hub-enqueue`/`hub-list`
  onto `/api/v1`. Keep `custody-client`, `plane-register`, `ensure-repo-installed`, `/rpc` lease on
  the admin wire (Internal). At the create/routing choke points, when a remote hub is configured,
  **cloud boxes register + lease + report to the remote hub by default** (the remote relay), so the
  laptop relay isn't needed and the laptop can be off — only local docker stays on the laptop hub.
- **Phase 3 — Tray remote.** Make `HubClient.baseURL` configurable + add a remote-key source
  (`../agentbox-tray/Sources/AgentBox/Source/HubClient.swift:6`, SSE cookie in `SSEClient.swift`). The
  `BoxSource`/`HubAPIBoxSource` seam already anticipates a hosted source — no UI change. Local
  shellouts (`open --in`, `open --targets`, `hub start`) stay local (the ~10%).
- **Phase 4 — Web UI onto `/api/v1`.** Migrate `apps/hub/lib/boxes/actions.ts` server-action mutations
  to the same `/api/v1` fetches, so all three clients share one path and a remote deploy needs no
  in-process backend.
- **Phase 5 — Rename + default.** `control-plane *` → `hub *` (setup/deploy/credentials/secrets/custody
  become `hub` admin subcommands; `set-url` → hub config). Document the "remote hub is default when
  configured, except local docker" rule. (This subsumes the M1 `control-plane` → `hub` rename deferred
  in [`control-box-plan.md`](./control-box-plan.md).)

## Critical files

- Surfaces/auth: `apps/hub/proxy.ts`, `apps/hub/lib/auth-config.ts`, `apps/hub/server.ts`,
  `apps/hub/app/[...path]/route.ts`, `apps/hub/lib/plane.ts`.
- `/api/v1` routes + seam: `apps/hub/app/(dashboard)/api/v1/**`, `.../api/v1/lib/backend.ts`,
  `apps/hub/lib/boxes/{source,actions,backend-types}.ts`.
- Relay wire: `packages/relay/src/server.ts`, `core/handler.ts`, `custody/routes.ts`,
  `remote-boxes.ts`, `store/store-rpc-routes.ts`, `store/remote-store.ts`, `admin-gate.ts`.
- CLI clients: `apps/cli/src/control-plane/{admin-client,custody-client,hub-enqueue,hub-list,hub-adopt,hub-pull,ensure-repo-installed}.ts`, `apps/cli/src/commands/{control-plane,hub,create}.ts`, `packages/sandbox-cloud/src/plane-register.ts`.
- Tray: `../agentbox-tray/Sources/AgentBox/Source/{HubClient,HubAPIBoxSource,SSEClient,BoxSource}.swift`.

## Verification

This is an analysis/design deliverable. To validate the plan's claims as changes land: (1) with a
control box configured, `curl -H 'Authorization: Bearer <key>' https://<hub>/api/v1/boxes` returns the
registry (proves the headless key); (2) `POST /api/v1/boxes` on the control box enqueues a real box
(proves remote-write, no 503); (3) point the CLI's new `HubApiClient` at the local hub and the remote
hub with only a base-URL change and confirm `ls`/create/approvals behave identically; (4) set the
tray's base URL to the remote hub and confirm boxes + actions + SSE work; (5) `pnpm typecheck` +
`pnpm test`; rebuild+restart the hub (`AGENTBOX_HUB_BIN` override) before verifying, per CLAUDE.md.
