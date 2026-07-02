# AgentBox Hub — base Next.js Web UI on the relay's port (implementation plan)

> Status: planned, not started. Each phase below is intended to be implemented in
> its own session. Check off phases as they land and keep this doc live (see
> `feedback-backlog-doc-during-implementation`).

## Context

Today the "control-plane" is a bare Next.js app (`apps/control-plane`) whose only
UI is a single inline-styled client component (`app/page.tsx`) polling `/admin/*`
with an admin bearer. It has no shadcn, no auth, and only runs deployed (Vercel +
Postgres, or a Hetzner docker-compose). The laptop relay (`agentbox relay`,
`node:http` on port **8787**, JSON-only) serves no UI at all, so there is no
localhost box-list interface.

We want a proper base Next.js app — structured like the reference
`/Users/marco/Projects/Evinto/optima/apps/saas` (shadcn, better-auth, shared
`components/`+`lib/`, per-domain `app/(module)/{lib,components}`) — whose layout
is ported from the `../agentbox-design/control/` prototype, running in three
profiles:

- **localhost** — box state in JSON files (as today), no login.
- **hetzner** — box state in local JSON files (NOT Postgres), login required.
- **vercel** — box state in Postgres/Neon, login required.

Load-bearing constraint: on localhost the UI must be served on the **same port as
the relay (8787)** so no extra port is opened. Box state must stay readable as
JSON files on localhost/hetzner; better-auth may use sqlite there.

This matches the roadmap's "hub runs on your PC by default, Web UI shared between
the hub and the local relay" direction (`docs/control-plane-roadmap.md`), and
adopts the roadmap rename **control-plane → hub**.

### Decisions locked (with the user)

1. **Data layer: lightweight.** Next Route Handlers + server actions + a
   zod-validated `lib/boxes/source.ts` seam (kept oRPC-shaped for a later
   mechanical migration). No oRPC now.
2. **sqlite driver: Node built-in `node:sqlite`.** Zero native deps. Requires the
   hub server to run on Node ≥ 22.5 (stable/no-flag on Node 24+, the local
   version). The lean relay/CLI keep `engines.node >=20.10`; only the hub server
   carries the higher floor (spawn with `--experimental-sqlite` on Node 22.5–23).
3. **Localhost: no login.** The hub binds `127.0.0.1`; the loopback browser is
   already trusted (same model as today's dashboard). Auth is enforced on hetzner
   (`0.0.0.0`) and vercel.
4. **Scope of the first pass: shell + boxes + approvals.** App shell
   (sidebar/topbar), Dashboard (boxes grouped by project), Box detail, and a
   net-new Approvals view over the prompt mailbox. Live updates via polling first.
   Projects/settings/create-modals deferred.

### Architecture decision (fixed, not an open question)

**The hub owns the combined server; the relay never imports Next.** The relay
package stays a lean, Next-free, bundle-able CJS bin (`agentbox-relay`, spawned
detached via tsup output). A new hub server entry imports `@agentbox/relay`,
prepares Next, and hands Next's request handler to the relay as a delegate.
Dependency graph stays one-way (`hub → relay`) — no cycle, CLI runtime stays
lean, Next lives only in `apps/hub`.

**No `JsonFileStore`.** The embedded profiles (localhost + hetzner) reach box
state through the running relay, whose default `MemoryStore` already persists
boxes to `~/.agentbox/state.json` and status to
`~/.agentbox/boxes/<id>-<n>-<mnemonic>/status.json`. A second file-store owner
would race the relay (split-brain against `state.ts`'s `withStateLock`). Vercel
keeps `PostgresStore` (unchanged `dispatch()` path).

---

## Same-port embedding (the mechanism)

The relay is a plain `node:http` server: `createServer` at
`packages/relay/src/server.ts:314`, dispatched by a single flat `handle()` whose
only unknown-route exit is the 404 at `server.ts:1249`. Every relay-owned route
(`/healthz`, `/events`, `/rpc`, `/rpc/status/:id`, `/admin/*` loopback-only,
`/bridge/*`, `/remote/*`) matches *before* that line. The relay has **no `/api/*`
prefix**, so Next's `/api/auth/*`, `/_next/*`, `/`, `/dashboard` never collide.

**Seam:** add one optional field to `RelayServerOptions` (`server.ts:89`):

```ts
uiHandler?: (req: IncomingMessage, res: ServerResponse) => void; // Next getRequestHandler()
```

and delegate at the 404 fallthrough (`server.ts:1249`):

```ts
if (uiHandler) { uiHandler(req, res); return; }
send(res, 404, { error: 'not found', route });
```

Delegating at the fallthrough (not the top) means every relay route still matches
first — Next can never shadow `/admin`, `/rpc`, etc., and there is no allowlist to
maintain. `/admin/*` keeps its loopback-403 guard, which is what makes the hetzner
auth story safe (a remote browser cannot reach `/admin`; it authenticates to the
hub, whose server-side code reads the in-process store on the same loopback).

**In-process box source (not loopback):** the hub server constructs the relay and
holds the live `Store`. Hand it to Next via a module singleton set before
`app.prepare()`:

```ts
globalThis.__AGENTBOX_BOX_SOURCE = relayLiveSource(handle.store);
```

Next server components / route handlers read `globalThis.__AGENTBOX_BOX_SOURCE`
(standard custom-server pattern for sharing a pool). Zero serialization, exact
live view of the store that also backs `state.json`. Loopback HTTP is used
**only** for SSE `/events` proxying (Phase 4), where re-piping an in-process
stream through Next is more awkward than proxying an authed route.

**No cycle / packaging:** extract the relay daemon wiring (relay + autopause +
keepalive + queue loops, currently inline in `packages/relay/src/bin.ts`) into an
exported `startRelayDaemon(opts & { uiHandler? })`, surfaced at a
`@agentbox/relay/daemon` subpath export. The relay's own `bin.ts serve` becomes a
thin caller *without* `uiHandler` (byte-for-byte today's behavior). The hub
(`apps/hub/server.ts`) imports `startRelayDaemon` + `next`, builds Next with
`output: 'standalone'`, and is spawned as its own process (`node
.next/standalone/server.js` / an `agentbox-hub` bin) — never bundled into the
relay CJS bin.

---

## Profiles (one switch: `AGENTBOX_HUB_PROFILE ∈ {localhost, hetzner, vercel}`)

| Profile | Runtime | Box source | Auth store | Bind | Login |
|---|---|---|---|---|---|
| localhost | hub bin = relay+Next, one process | relay live in-process store | `node:sqlite` @ `~/.agentbox/hub/auth.db` | 127.0.0.1 | off |
| hetzner | hub bin = relay+Next, one process | relay live in-process store | `node:sqlite` @ `~/.agentbox/hub/auth.db` | 0.0.0.0 | on |
| vercel | Next only (serverless) | `PostgresStore` (today's `dispatch()`) | Postgres (drizzle) | — | on |

localhost and hetzner are the **same binary and same data path** — they differ
only in bind address and whether auth is enforced. Box state on both is the
relay's JSON-backed `MemoryStore` → satisfies "local JSON, not Postgres" and
"readable as JSON files" for free.

---

## better-auth (dual dialect, one config)

`apps/hub/lib/auth.ts` (server-only), mirroring optima's `lib/auth.ts`:

- **vercel** → `drizzleAdapter(pgDb, { provider: 'pg' })` (optima's exact
  pattern); hand-written drizzle auth schema (`lib/db/schema/auth.ts`, copied from
  optima); tables in Postgres.
- **localhost/hetzner** → `node:sqlite` via a Kysely sqlite dialect
  (`{ dialect, type: 'sqlite' }`); better-auth `migrate` creates/upgrades tables
  on boot (no drizzle-kit against sqlite). File at `~/.agentbox/hub/auth.db`.
- `emailAndPassword.enabled` on hetzner/vercel; localhost auto-provisions a single
  local user with **no login screen** (`AGENTBOX_HUB_AUTH=off`).
- `lib/auth.client.ts` + mount `app/(auth)/api/auth/[...all]/route.ts` via
  `toNextJsHandler` — copied from optima conventions.
- Next-16 `proxy.ts` (middleware equivalent) gates the `(dashboard)` group + the
  hub's own `/api/*` on hetzner/vercel; localhost middleware is a no-op.

**Verification risk to resolve in Phase 3:** confirm better-auth 1.3 accepts a
`node:sqlite`-backed Kysely dialect. If there's no ready dialect, wrap
`DatabaseSync` in a ~40-line Kysely driver. Spawn the hub with
`--experimental-sqlite` on Node 22.5–23 (stable, no flag, on Node 24+).

---

## App structure (optima conventions + agentbox-design layout)

Rename `apps/control-plane` → **`apps/hub`** (package `@agentbox/hub`). Keep the
Vercel path (catch-all `app/[...path]/route.ts` + `lib/plane.ts` + `PostgresStore`)
intact — it becomes one *mode* of the same app.

```
apps/hub/
  server.ts                                  # NEW: prepare Next → startRelayDaemon({uiHandler}); sets global box source
  app/
    globals.css                              # Tailwind v4 @theme inline tokens ported from agentbox-design/control/styles.css
    layout.tsx                               # fonts (IBM Plex Sans/Mono), ThemeProvider
    (auth)/api/auth/[...all]/route.ts         # better-auth mount
    (dashboard)/
      layout.tsx                             # Sidebar(232px) + Topbar shell (ported from control/app.jsx)
      page.tsx                               # Dashboard: boxes grouped by project → BoxTable
      boxes/[id]/page.tsx                     # BoxDetail: stat grid, agent terminal panel, detail rows
      approvals/page.tsx                      # NEW view (no design) — built in the same tokens
      api/events/route.ts                     # authed SSE proxy of loopback /events (Phase 4)
      boxes/
        lib/source.ts                        # Store-facing data source (relay-live | postgres); oRPC-shaped
        lib/box.schema.ts                    # zod: BoxStatus union, actions
        components/{box-table,box-row,status-badge,box-detail,create-box-modal}.tsx
    [...path]/route.ts                        # KEPT: vercel /admin/* passthrough → handleRelayRequest(PostgresStore)
  components/
    ui/*                                     # shadcn new-york primitives
    app-sidebar.tsx  topbar.tsx
  lib/
    utils.ts                                 # cn()
    auth.ts  auth.client.ts                  # better-auth (dual dialect)
    db/{index.ts, schema/auth.ts}            # drizzle+pg for vercel
    boxes/source.ts helpers
    plane.ts                                 # KEPT (renamed from control-plane): vercel PostgresStore dispatch
  components.json  proxy.ts  next.config.ts  tsconfig.json (@/* → root)  postcss.config.mjs
```

**Design tokens** (`app/globals.css`, Tailwind v4 `@theme inline`): paper
`#f6f6f3`, panel `#fff`, ink `#16181c`, accent `#128a4f` (green), status colors,
IBM Plex Sans/Mono, `--side-w: 232px`, ~7–16px radii, uppercase-mono section
labels — copied from `agentbox-design/control/styles.css`.

**Box view model** (`id, projectId, repo, branch, task, agent, status
[running|paused|stopped|creating|error], createdAt, lastActivity, host, commits,
filesTouched, error`) is normalized by `lib/boxes/source.ts` from the relay's
`BoxRegistration` + `BoxStatusSnapshot`, so the components are identical across
profiles.

**Approvals view** (net-new, no design exists): a `BoxTable`-style grid
(Box | Action | Requested | Approve/Deny) fed by the relay prompt mailbox —
`Store.listPendingPrompts` / `answerPrompt` (already in the interface,
`packages/relay/src/store/store.ts:110-116`) surfaced through `lib/boxes/source.ts`.

---

## Critical files to create / modify

**Relay (add the seam, no Next):**
- `packages/relay/src/server.ts` — add `uiHandler` to `RelayServerOptions` (`:89`);
  delegate at the 404 fallthrough (`:1249`).
- `packages/relay/src/bin.ts` — extract `startRelayDaemon(opts & {uiHandler?})`;
  keep `serve` a thin caller. Add `@agentbox/relay/daemon` export (package.json
  `exports`).
- `packages/sandbox-docker/src/relay.ts` — branch spawn (`:223`): `agentbox hub` /
  `AGENTBOX_HUB=1` spawns the hub server on 8787; default CLI keeps the lean relay
  bin. Reuse existing bin-locator/reclaim logic.

**Hub app (rename + build):**
- `apps/control-plane/**` → `apps/hub/**` (package rename `@agentbox/hub`; move
  `vercel.json`, `Dockerfile`, `docker-compose.yml`, turbo wiring).
- New: `server.ts`, shadcn init (`components.json`, `components/ui/*`,
  `lib/utils.ts`), `app/globals.css` tokens, `lib/auth.ts`/`auth.client.ts`,
  `proxy.ts`, `app/(auth)/api/auth/[...all]/route.ts`, `lib/boxes/source.ts`, the
  `(dashboard)` routes + components above.
- Keep: `app/[...path]/route.ts` + `lib/plane.ts` (rename import) for Vercel.

**CLI:**
- New `agentbox hub` command (start/stop/status wrapper around the hub spawn) —
  extend or sit beside `apps/cli/src/commands/control-plane.ts` (the
  setup/deploy/worker subcommands stay for the hosted path).

---

## Phases (one session each)

### Phase 0 — Relay seam (no UI) — DONE
Add `uiHandler` to `RelayServerOptions`; delegate at `server.ts` 404 fallthrough;
extract `startRelayDaemon` into `packages/relay/src/daemon.ts` and export
`@agentbox/relay/daemon` (package.json `exports` + tsup entry). The relay's own
`serve` calls it without `uiHandler` (byte-for-byte today's behavior).
- **Verify:** existing relay tests green; new `test/daemon-seam.test.ts` — a
  *handled* route (`GET /healthz`) bypasses a stub `uiHandler` (proves relay routes
  match first), `GET /anything-else` hits it, and with no `uiHandler` the unknown
  route still returns the `404 { error, route }` JSON. (`GET /rpc` is NOT a good
  bypass example — only `POST /rpc` is a relay route, so `GET /rpc` falls through to
  the delegate.) Bin `serve` smoke: `listening …` + healthz + clean SIGINT unchanged.

### Phase 1 — Rename + scaffold
`control-plane → hub`; shadcn init; Tailwind v4 tokens from the design; `@/*`
alias; port Sidebar/Topbar/shell (static, mock data OK).
- **Verify:** `next build` clean; the Vercel path (`dispatch()` + PostgresStore)
  still answers `/admin/*` + `/healthz` (regression vs today's app).

### Phase 2 — Embedded server + in-process source
`apps/hub/server.ts` (prepare Next → `startRelayDaemon({uiHandler})`),
`globalThis.__AGENTBOX_BOX_SOURCE`, `lib/boxes/source.ts` relay-live impl;
Dashboard + Box detail wired to real data.
- **Verify (localhost):** `node server.js`; open `http://127.0.0.1:8787/` →
  dashboard renders; `curl :8787/healthz` and `:8787/admin/registry` still return
  relay JSON; `agentbox create -y -n smoke` → box appears in the UI;
  `~/.agentbox/state.json` still updates.

### Phase 3 — better-auth dual dialect
`lib/auth.ts` (`node:sqlite` vs pg), mount route, `proxy.ts` gate;
`AGENTBOX_HUB_AUTH=off` on localhost. Resolve the node:sqlite/Kysely dialect
question.
- **Verify (hetzner):** bind `0.0.0.0`, hit from a second machine → redirected to
  login; after login boxes load; `curl http://<host>:8787/admin/registry` from
  off-box → **403** (loopback guard intact).
- **Verify (vercel):** preview deploy, Postgres login works, `/admin/*` still
  bearer-gated.

### Phase 4 — Live updates + approvals
SSE proxy route (hetzner) / same-origin subscribe (localhost); Approvals view over
the prompt mailbox.
- **Verify:** trigger a host-action approval in a box → appears in Approvals →
  answering y/n unblocks the box.

### Phase 5 — CLI wiring
`agentbox hub` / `AGENTBOX_HUB=1` spawns the hub on 8787; default CLI keeps the
lean relay bin.
- **Verify:** audit the relay bin's module graph has no Next (bundle size
  unchanged); hub mode serves UI + API on the single port 8787.

---

## Docs to update (in the phase that changes the behavior)

- `docs/control-plane-roadmap.md` / `docs/control-plane-guide.md` — the local hub
  now serves the UI on the relay port; rename control-plane → hub where it lands.
- `apps/web/content/docs/**` — new `agentbox hub` command + the localhost UI.
- `apps/hub/README.md` — the three profiles and env (`AGENTBOX_HUB_PROFILE`,
  `AGENTBOX_HUB_AUTH`).
