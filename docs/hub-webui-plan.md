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

### Phase 1 — Rename + scaffold — DONE
`control-plane → hub`; shadcn tooling (`components.json`, `cn()`, postcss); Tailwind
v4 tokens via `@theme inline`; `@/*` alias; IBM Plex fonts. Ported the **shadcn
prototype** (`../agentbox-design/control-shadcn/`) in full, static with a mock
**client** store: UI kit (`components/ui/*`), icons, shell (Sidebar 232px + Topbar),
and **all views** — Dashboard, Box detail (stat grid + streaming terminal), Project
detail, Settings, and the Create-box / Create-project modals. Routing = App Router
(`/`, `/boxes/[id]`, `/projects/[id]`, `/settings`); the mock store + modal state
live in a client `HubProvider` (mount-gated to dodge `Date.now()` hydration drift).
Kept the Vercel path (`app/[...path]/route.ts` + `lib/plane.ts`) byte-intact.
- **Extra rename refs fixed** beyond vercel.json/Dockerfile/docker-compose (these
  break the hosted deploy if missed): `apps/cli/src/control-plane/deploy-vercel.ts`
  (`ROOT_DIRECTORY`), `packages/sandbox-hetzner/src/control-plane-deploy.ts`
  (`REMOTE_APP_DIR`), `.dockerignore`, the `agentbox control-plane` self-host help
  path, and the `apps/web/.../control-plane.mdx` deploy-path references. The
  `agentbox control-plane` **command** name + the `agentbox-control-plane` Vercel
  **project** name are unchanged (Phase 5 / deployed-resource concerns).
- **Verified:** `next build` clean — route list shows `/` (page) coexisting with
  `/[...path]` (dispatch handler), no conflict; `typecheck` clean; regression on the
  built app: `GET /healthz` → 200 relay JSON, `GET /admin/registry` → 503 (hit the
  configured Postgres, not a Next 404 — dispatch intact); `/` + all views render in
  a headless browser (dashboard, box detail terminal, create-project modal).

### Phase 2 — Embedded server + real box data + live lifecycle — DONE
`apps/hub/server.ts` prepares Next and hands `getRequestHandler()` to
`startRelayDaemon({uiHandler})` — one process on 8787 serves the relay + UI.
- **Corrected data source (plan premise was wrong):** the relay `Store` is
  in-process/thin and NOT the box registry. Rich box data lives in the CLI's
  `~/.agentbox/state.json` (`BoxRecord`); the displayed status is `listBoxes()`
  (`@agentbox/sandbox-docker`: state.json + `docker inspect` / `cloud.lastState` +
  `status.json` activity). The hub source reuses `listBoxes()`.
- **globalThis backend seam (load-bearing):** importing the sandbox/relay
  toolchain into a Next server component drags the cloud dynamic-imports into
  Turbopack and fails the build. So the Node/docker work lives in
  `lib/hub-backend.ts` (loaded only by `server.ts`, run via `tsx`), exposed to Next
  via `globalThis.__AGENTBOX_HUB_BACKEND` (list + lifecycle) and
  `__AGENTBOX_BOX_SOURCE` (relay Store, for Phase 4). Next's `source.ts`/`actions.ts`
  are thin wrappers importing zero runtime packages → clean bundle.
- **Lifecycle = real** (user decision): pause/resume/stop/destroy are server
  actions → `providerForBox(box).{…}` (self-mutate state.json) + `revalidatePath` +
  `router.refresh()`. Create modals disabled; GitHub-App settings disabled on
  localhost; user chip = OS username; commits/filesTouched = "—" (no source);
  agent terminal is a truthful placeholder (real streaming is Phase 4). Data flow
  refactored from the client mock store to a read-only server-data context.
- **Verified (localhost):** `tsx server.ts` → `listening on 127.0.0.1:8787`;
  `curl :8787/healthz` → 200 daemon relay JSON (pid/cliEntry), `:8787/admin/registry`
  → relay JSON, `:8787/` → 200 HTML; a real `agentbox create` box appeared grouped
  under its project with live `running` status; Pause → `docker inspect`=paused +
  UI paused; Resume → running; Destroy → container removed + `BoxRecord` gone from
  `state.json` (all confirmed via ground truth). Build + typecheck + lint clean.
- **Deferred:** vercel/hosted source (Postgres), the `agentbox hub` bin +
  `output:'standalone'` packaging (Phase 5), real agent-output streaming (Phase 4).

### Phase 3 — better-auth dual dialect — DONE
`lib/auth.ts` (`node:sqlite` vs pg), mount route, `proxy.ts` gate;
`AGENTBOX_HUB_AUTH` per profile.
- **node:sqlite/Kysely question resolved — simpler than feared:** better-auth's
  built-in Kysely adapter accepts the **driver instance directly** for both
  dialects (`new DatabaseSync(path)` / `new Pool({connectionString})`), and
  `getMigrations(auth.options).runMigrations()` creates the tables. **No drizzle,
  no kysely-adapter, no hand-written schema** were built (the plan's
  `drizzleAdapter` + copied `lib/db/schema/auth.ts` are dropped). Node 24 → stable
  `node:sqlite`, no flag.
- **Auth is secret-gated (design refinement):** `authEnabled()` = explicit
  `AGENTBOX_HUB_AUTH` if set, else `Boolean(BETTER_AUTH_SECRET)`. This makes auth
  a deliberate opt-in and prevents a secretless vercel deploy from serving a login
  page with **no user** (a lockout). `vercel.json` sets only `AGENTBOX_HUB_PROFILE=vercel`;
  `db:auth-migrate` self-skips when auth is off, so a secretless build never
  touches the DB.
- **First admin env-seeded** (`AGENTBOX_HUB_ADMIN_EMAIL/PASSWORD`) on boot
  (embedded) / on `db:auth-migrate` (vercel); no public signup. localhost stays
  fully off/lazy (better-auth + sqlite never constructed; no `auth.db` created).
- **`lib/auth.ts` intentionally omits `import 'server-only'`** — `server.ts` and
  `scripts/auth-migrate.ts` import it under plain node/tsx, where the Next-aliased
  `server-only` module does not resolve; it stays out of the client bundle by
  discipline (client uses `auth.client.ts`).
- **New:** `lib/auth-config.ts`, `lib/auth.ts`, `lib/auth.client.ts`,
  `app/(auth)/api/auth/[...all]/route.ts` (404s when auth off),
  `app/(auth)/signin/page.tsx`, `proxy.ts`, `scripts/auth-migrate.ts`. **Modified:**
  `server.ts` (profile/auth env from bind host + `ensureAuthReady` when on),
  `package.json` (better-auth, `engines.node>=22.5`, `db:auth-migrate`),
  `vercel.json`, `.env.example`, `components/topbar.tsx` (sign-out, gated on
  `authEnabled`), `lib/boxes/{types,source,backend-types}.ts` + `lib/hub-backend.ts`
  (thread `authEnabled` into `HubState`). **Setup prompt (§7):**
  `apps/cli/src/control-plane/hub-auth-env.ts` + wired into the **vercel** branch
  of `apps/cli/src/commands/control-plane.ts`.
- **Verified (build):** `next build` clean — routes `/`, `/[...path]`,
  `/api/auth/[...all]`, `/signin` + Proxy, no conflict; typecheck + lint clean
  (hub + CLI). **Verified (runtime, via `next start` on a throwaway port + isolated
  `$HOME`):**
  - localhost (auth off): `/` → 200 no redirect; `/api/auth/session` → 404;
    `/settings` → 200 (ungated); no `~/.agentbox/hub/auth.db` created.
  - hetzner sim (auth on): `db:auth-migrate` created the 4 tables + seeded the
    admin; `/` unauth → 307 `/signin?returnUrl=/`; `/signin` → 200;
    `/admin/registry` → 503 (NOT a signin redirect — proxy exclusion holds);
    `POST /api/auth/sign-in/email` with the seeded creds → 200 + session cookie;
    `/` with cookie → 200; wrong password → 401.
- **Deferred to Phase 5:** the off-box `/admin` → **403** loopback-guard check
  (needs the embedded `server.ts` relay daemon, not `next start`) — the guard is
  unchanged and the proxy matcher excludes `/admin` at the code level. **Live
  vercel preview** (Postgres login) not run this session (no live deploy) — the pg
  path uses the same native adapter as the verified sqlite path. **hetzner
  docker-compose auth wiring** (the compose/Dockerfile runs `next start` with
  Postgres, a different model than the embedded sqlite hetzner profile; needs a
  build-time `db:auth-migrate` + auth env in compose) — the setup prompt is wired
  for the vercel deploy only.

### Phase 3.1 — localhost token auth — DONE
localhost is no longer open: it now runs a lightweight **token gate** (shared-secret
cookie, no login screen). This closes the loopback-is-trusted gap (other local
processes, DNS-rebinding).
- **Three-way auth mode** in `lib/auth-config.ts` (`authMode()` → `off | token |
  password`; `authEnabled()` = `authMode() !== 'off'`). Added `AUTH_TOKEN_PATH`
  (`~/.agentbox/hub/token`) + `HUB_TOKEN_COOKIE`.
- **`lib/hub-token.ts`** (new, node-only): `ensureHubToken()` reads-or-generates a
  `randomBytes(32).hex` secret at `0600`. **`server.ts`** provisions it on the
  localhost bind (unless `AGENTBOX_HUB_AUTH=off`), sets `process.env.AGENTBOX_HUB_TOKEN`,
  logs `open http://127.0.0.1:<port>/?token=<token>`, and now gates `ensureAuthReady`
  on `authMode()==='password'` (localhost never loads better-auth/node:sqlite).
- **`proxy.ts`** branches by mode: token mode consumes `?token=` (constant-time
  compare via `node:crypto` `timingSafeEqual`), sets an httpOnly `SameSite=lax`
  cookie, redirects to the clean URL, and 401s otherwise; password mode unchanged.
- **`route.ts`** (auth mount) 404s unless `authMode()==='password'`. `HubState`
  now carries `authMode` (was `authEnabled`) so the topbar shows better-auth
  **Sign out** only in password mode.
- **On by default** (user decision): every localhost start enforces the token;
  `AGENTBOX_HUB_AUTH=off` opts out. The `agentbox hub` command that auto-opens the
  token URL is Phase 5; until then the logged URL is used directly.
- **Verified (real `server.ts`, scratch port + isolated `$HOME`):** token file
  `0600`; `/` no token → 401; `/?token=<valid>` → 307 + `Set-Cookie … HttpOnly;
  SameSite=lax`; cookie → 200; wrong token → 401; `/healthz` → 200 (relay owns it,
  bypasses the gate). Opt-out (`AGENTBOX_HUB_AUTH=off`): `/` → 200, no token file,
  no URL logged. Build + typecheck + lint clean.

### Phase 4 — Live updates + approvals — DONE
Live SSE push + a net-new **Approvals** view over the relay prompt mailbox.
- **Approvals source corrected (plan premise was wrong):** the plan referenced
  `Store.listPendingPrompts` / `daemon.handle.store`, but the laptop/hetzner relay
  runs in **block mode** — pending approvals live **in-process** in
  `handle.prompts` (`PendingPrompts`), not the Store (empty in block mode). So the
  hub reads approvals from `handle.prompts.all()` (new accessor) and answers via
  `handle.prompts.resolve(id, answer)` + `handle.subscribers.broadcast('prompt-resolved')`
  — the same primitive `POST /admin/prompts/answer`'s block branch uses, in-process
  (resolving the parked `/rpc` Promise unblocks the box). Approvals ride along in
  `getData()` → `HubState.approvals`, so the sidebar badge + view + SSE refresh all
  share one read. Vercel/poll-mode approvals deferred (no daemon; consistent with
  Phase 2 deferring the hosted source).
- **Live updates via a single in-process notifier (not the per-box loopback SSE
  the plan sketched):** new `HubNotifier` on the relay handle (`packages/relay/src/hub-notifier.ts`),
  fired by `PendingPrompts.setOnChange` (wired in `add`/`resolve`). The custom
  server exposes it at `globalThis.__AGENTBOX_HUB_NOTIFIER`; a Next route
  `app/(dashboard)/api/events/route.ts` streams a `change` on every notify + a 15s
  `ping` heartbeat. `components/live-refresh.tsx` (mounted in `hub-shell.tsx`)
  subscribes with `EventSource` and debounced-`router.refresh()`es (paused when the
  tab is hidden). `/api/events` is a same-origin Next route gated by `proxy.ts`
  (cookie rides along) — works identically on localhost + hetzner, no loopback
  proxy needed. Box changes made outside the hub surface on the ≤15s heartbeat.
- **Agent terminal hidden** (user decision): removed the "Agent output" section +
  `AgentTerminal` from box detail; real streaming is a later feature.
- **New:** `packages/relay/src/hub-notifier.ts` (+ `PendingApproval` type,
  `PendingPrompts.all()`/`setOnChange`, `hubNotifier` on `RelayServerHandle`);
  `apps/hub/app/(dashboard)/api/events/route.ts`, `components/live-refresh.tsx`,
  `app/(dashboard)/approvals/page.tsx` + `approvals/components/approval-actions.tsx`.
  **Modified:** `server.ts` (`createHubBackend(daemon.handle)` + notifier global),
  `global.d.ts`, `lib/boxes/{types,backend-types,source,actions}.ts`,
  `lib/hub-backend.ts`, `components/{app-sidebar,hub-shell}.tsx`,
  `boxes/[id]/page.tsx`. **Deleted:** `boxes/components/agent-terminal.tsx`.
- **Verified:** relay build + 261 unit tests green (new `hub-notifier.test.ts` +
  `PendingPrompts.all`/`setOnChange` cases); hub `build` (routes `/approvals`,
  `/api/events` coexist with `/[...path]`) + `typecheck` + `lint` clean.
  **Runtime (embedded `server.ts`, scratch port + isolated `$HOME`):** `/healthz`
  → 200 (relay bypass); `/api/events` + `/approvals` unauth → 401, with the token
  cookie → 200; `/api/events` streams `event: open` then `event: ping` at 15s;
  `/approvals` renders its empty state; the sidebar links `/approvals`; box detail
  no longer renders "Agent output". **Approval chain (in-process harness over the
  real `startRelayDaemon` + `createHubBackend` + notifier):** a pending prompt
  appears in `getData().approvals` with all fields mapped; `answerApproval('y')`
  **resolved the parked in-box RPC Promise** (box unblocks), fired the notifier
  both on add + resolve, and cleared the listing; unknown id → clean `{ok:false}`.
  (The relay's existing integration tests already cover block-mode
  add→`/admin/prompts/answer`→exit-10 over real HTTP.)

### Phase 5 — CLI wiring + published packaging + hosted fixes — DONE
`agentbox hub` (start/stop/status/restart) spawns the embedded relay + Next UI on
8787; default CLI keeps the lean relay bin. Shipped in three parts.
- **5a — command + lifecycle.** `/healthz` gained `ui:Boolean(uiHandler)` so the
  hub (superset of the lean relay, both on 8787, mutually exclusive) is
  distinguishable. `packages/sandbox-docker/src/hub.ts` (`ensureHub`/`stopHub`/
  `getHubStatus`, separate `hub.pid`/`hub.log`) reuses relay.ts's probes + the
  version-reclaim gate: reuses a running hub, reclaims a lean relay (or
  version-mismatched hub) to take the port. The hub spawn sets `AGENTBOX_CLI_ENTRY`
  + version so the create path's `ensureRelay()` reuses it and never reclaims it.
  `apps/cli/src/commands/hub.ts` mirrors `relay.ts`; `start` is the default
  subcommand and opens `http://127.0.0.1:8787/?token=…`.
- **5b — published packaging (PoC-established recipe).** Next `output:'standalone'`
  (gated behind `AGENTBOX_HUB_STANDALONE`, set only by `build:standalone`, so the
  `next start`/Vercel deploy builds stay non-standalone). `apps/hub/scripts/build-standalone.mjs`
  esbuild-bundles the custom `server.ts` with **code-splitting** (lazy `lib/auth` +
  cloud-provider chunks stay unloaded in token mode), externalizing `next` + cloud
  SDKs + better-auth/pg. `server.ts` sets `__NEXT_PRIVATE_STANDALONE_CONFIG` (from
  `.next/required-server-files.json`) + `process.chdir(dir)` so the full `next()`
  API skips `loadConfig()`/webpack; the spawn forces `NODE_ENV=production`.
  `stage-runtime.mjs` stages `dist-standalone` → `runtime/hub` with
  `verbatimSymlinks:true` (keeps the traced tree's relative symlinks
  self-contained). `resolveHubServer()` locator + Node ≥ 22.5 gate +
  `--experimental-sqlite` on 22.5–23; `prepublishOnly` builds the standalone
  before staging.
- **5c — hosted-path Bugbot fixes (#140).** #1 (High): compose/hetzner auth wiring
  (docker-compose env passthrough + `AGENTBOX_HUB_PROFILE=vercel` Postgres auth,
  Dockerfile boot-time `db:auth-migrate`, `control-plane.ts` collects
  `resolveHubAuthEnv()` for hetzner + appends to the deploy `.env`). #2 (Medium):
  `PostgresStore.listStatuses()` + `apps/hub/lib/boxes/postgres-source.ts` — the
  `next start` deploy path now maps `listBoxes()`+`listStatuses()`+
  `listPendingPrompts()` → `HubState` (dynamic pg import keeps pg out of the
  localhost bundle); `source.ts` routes to it when there's no in-process backend
  but `POSTGRES_URL` is set.
- **Verified:** typecheck/lint clean across relay/sandbox-docker/cli/hub; relay 261
  tests green. Live (dev tree, real `~/.agentbox`): `hub start` → `ui:true`/
  `cliEntry:true`, token gate 401/200, `ensureRelay` reuses the hub (pid unchanged),
  a lean relay is reclaimed + replaced, idempotent restart, `stop` frees the port.
  Published shape: `runtime/hub` staged (relative symlinks) + runs out-of-tree.
  Hosted: `next start` + seeded Postgres rendered the real box; auth env → `/signin`.
- **Deferred:** shrinking the ~194M standalone (swc platform prune); the
  `AGENTBOX_HUB=1` env alias (only the `agentbox hub` command ships).

### Phase 6 — Create boxes from the hub (first slice of web/API box management) — IN PROGRESS
The hub can now **create** boxes (not just view/lifecycle). First vertical slice of
the broader "drive box management from web/API/macOS without duplicating the CLI"
effort — see `docs/web-create-boxes-backlog.md` and the approved architecture plan.
- **Project registry:** `@agentbox/config` gains `registerProject()` + exported
  `ProjectEntry`; the CLI create path registers `projectRoot`, and the hub
  self-heals (registers any box root it sees) so **zero-box folders are selectable**.
  Project id unified on `hashProjectPath` (dropped the hub's base64url id).
- **Create path:** `HubBackend.create(input)` resolves the project **by id**
  server-side (never a client path) → `enqueueQueueJob` (pure core extracted into
  `@agentbox/relay`) + `handle.pokeQueue()`. The detached queue worker runs
  `createBox()` — **full sync layer intact** — then starts the agent in a detached
  tmux session; **it never attaches**. `addProject(path)` registers a folder.
- **UI + streaming:** in-flight jobs surface as `creating` boxes (flip to `running`
  when the real box lands); `/api/jobs/[id]/logs` SSE tails the per-job log into a
  panel; create-box + add-project modals; `onStatusChange → hubNotifier` refresh.
- **Deferred:** no-agent plain box (queue is agent-only), cloud providers, carry-
  secrets/env/checkpoint surfaces, and the full `--protocol json` interaction bus
  (prompts/links) + hosted-plane parity — tracked in the backlog.

### Phase 7 — Public REST API (`/api/v1`) — DONE
A versioned, documented HTTP API so external tools (IDEs above all, and a future
macOS app) can launch + manage boxes — including when the hub runs on a **separate
host**, where there's no local CLI to shell out to. Design decision: a **new
`/api/v1/*` route group on the hub** (Next routes under
`apps/hub/app/(dashboard)/api/v1/`, served on the relay port via the existing
`uiHandler` seam), **not** an extension of the relay's internal `/admin`+`/rpc`
if-ladder — that surface is loopback-internal by design, couples HTTP status to
child-process exit codes, and has no schema. The API is a thin facade over the
already-shipped backend seam (`__AGENTBOX_HUB_BACKEND` + `getDashboardData()` +
`enqueueQueueJob`) — no new box logic.
- **Contract:** one envelope everywhere — success returns the resource directly,
  errors always `{ error: { code, message, details? } }` with a correct status.
  Routes: `GET /boxes`, `GET /boxes/:id`,
  `POST /boxes/:id/{pause,resume,stop,destroy}`, `POST /boxes` (create → `202
  {jobId}`), `GET|POST /projects`, `GET /approvals`, `POST /approvals/:id/answer`,
  `GET /jobs/:id`, `GET /jobs/:id/logs` (SSE), `GET /health`, `GET /openapi.json`,
  `GET /docs`. The box view model is the normalized hub `Box` (provider-agnostic),
  identical to what the UI and the future Postgres source produce.
- **Auth:** `proxy.ts` gates `/api/v1/*` and answers **JSON 401** (never a `/signin`
  redirect). Token mode accepts `Authorization: Bearer <AGENTBOX_HUB_TOKEN>` (or the
  same-origin cookie); password mode accepts the better-auth session. `/health`,
  `/openapi.json`, `/docs` are public. Dedicated API keys arrive with hosted-remote.
- **Topology:** reads route through `getDashboardData()` (in-process → Postgres →
  empty), so the read contract is topology-agnostic already; mutations use the
  in-process backend (the Postgres/plane write path is the documented follow-up).
- **OpenAPI + docs:** hand-authored OpenAPI 3.1 at `/api/v1/openapi.json` (no zod dep
  added — validation is hand-rolled `typeof` guards, matching the repo's convention),
  Scalar-rendered reference at `/api/v1/docs`. The per-job log SSE tail is shared with
  the internal create-modal route via `lib/job-log-stream.ts`.
- **New:** `apps/hub/app/(dashboard)/api/v1/**` (routes + `lib/{envelope,backend,
  validate,openapi}.ts`), `apps/hub/lib/job-log-stream.ts`. **Modified:**
  `apps/hub/proxy.ts` (Bearer gate), the internal `api/jobs/[id]/logs/route.ts`
  (delegates to the shared tail).
- **Verified (embedded `server.ts`, scratch port + isolated `$HOME`):** health
  public; boxes/projects/approvals 401 without Bearer, 200 with it, 401 wrong token;
  validation → 400 envelopes, unknown project → 404, unknown box/job → 404, bad
  action → 400; `openapi.json` valid 3.1 with all paths, `/docs` renders; regression
  `/healthz`, `/admin/registry`, `/api/events`, dashboard `/` all intact. Full create
  E2E through the API: `POST /boxes` → `202 {jobId}` → job `running` →
  `GET /jobs/:id/logs` streamed the real build log → box surfaced as `creating`.
- **Deferred:** `/providers`, bake/provider-install jobs, the structured
  `/jobs/:id/events` + `/jobs/:id/answer` interaction stream (Phases A–C), hosted
  writes, and API-key management.

### Phase 8 — Box git + service operations (detail page + API + CLI) — DONE
Common day-to-day box operations on the box-detail page, the public `/api/v1`, and
the host CLI: change branch, create+switch a new `agentbox/*` branch, pull/push,
push-to-host-only, and `agentbox.yaml` service status + restart-one/all.
- **Shared, provider-agnostic helper** `packages/sandbox-core/src/box-git.ts`
  (checkout / new-branch / push / pull / push-host + service argv builders). Cycle-safe:
  the host-initiated-token mint is **injected** (`BoxGitDeps.hostInitiatedArgs`), so the
  module needs no relay/ctl import (relay → sandbox-core, so it can't reach back). The
  predicted `GitRpcParams` match `agentbox-ctl git`'s exactly so the minted token's
  params-hash round-trips. The CLI `git.ts` driver refactored onto these helpers.
- **CLI:** new `agentbox git branch <box> <name> [--from <ref>]` (create+switch) and
  `agentbox services <box> [list|restart [name]]` (provider-agnostic via `provider.exec`;
  live status parsed from `agentbox-ctl status --json`, restart-all is a host-side loop —
  no new ctl wire op, works on already-baked boxes).
- **Hub backend** (`hub-backend.ts`): `gitCheckout/gitNewBranch/gitPush/gitPull/
  gitPushHost/getGit/getServices/restartService` via a `resolveBoxProvider` + `gitOp`
  helper and a `hubGitDeps` that mints tokens in-process (`mintHostInitiatedToken` +
  `hashRpcParams`). `getServices` falls back to the persisted `handle.statusStore`
  snapshot when the box isn't live; `getGit` parses `git status --porcelain=v2 --branch`.
- **Surfaces:** server actions (`actions.ts`, UI) + REST routes
  (`api/v1/boxes/[id]/git/[op]`, `.../git` GET, `.../services` GET, `.../services/restart`
  POST) + `validate.ts` parsers + `openapi.ts` entries. UI: `git-actions.tsx` +
  `services-panel.tsx` (client, poll `/api/v1` reads via same-origin cookie, mutate via
  server actions), rendered on `boxes/[id]/page.tsx`.
- **Verified (docker E2E, real hub on 8787):** `agentbox services` list + restart one/all;
  `git branch` create+switch (from HEAD and `--from main`, `agentbox/` prefix added);
  `git checkout` (incl. clean failure when the target is checked out in the host
  worktree); `push --host-only` lands in the host repo only (ground truth: branch in
  host repo, nothing on any remote). REST: every route with a Bearer token — git info +
  live branch (not stale `box.branch`), services `source:live`, branch/checkout/push-host
  succeed, restart one/all, and 400/404/409/401 envelopes; `openapi.json` valid 3.1 with
  the 4 new paths; box-detail page renders both panels. Unit: `box-git.test.ts` (argv +
  params contract) + the validators. Deferred: hosted/Postgres write path (503, same as
  the existing lifecycle actions).

### Phase 9 — Create options: base branch + setup wizard — DONE
The web/API create form gained two CLI-parity options (docker/localhost first;
cloud honored too through the shared worker).
- **Base branch** (`--from-branch`): `fromBranch` threads `CreateBoxInput` →
  `hub-backend.create()` (validated against the host repo up front, node execFile
  not execa) → `QueueJobCreateOpts.fromBranch` → the worker's `createBox()` /
  `provider.create()`. `createBox` already supported it — the queue path just
  never forwarded it. A **branch `<Select>`** in the modal (defaults to the
  project's current HEAD) is fed by `HubBackend.listBranches` +
  `GET /api/v1/projects/{id}/branches`.
- **Setup wizard**: `Project.needsSetup` (no host `agentbox.yaml` + no default
  checkpoint) drives a "Run setup wizard" toggle (default ON). Keeping it on sets
  `job.setupWizard`; the worker seeds `buildSetupInitialPrompt()` as the agent's
  first turn so the in-box agent generates `agentbox.yaml` (any agent, user prompt
  appended after). Inert for the no-agent option.
- **New:** `api/v1/projects/[id]/branches/route.ts`, `listBranches`/`BranchList`
  in the hub backend, `listBranchesAction`. **Modified:** `queue.ts`
  (`fromBranch`/`setupWizard`), `_run-queued-job.ts` (forward + seed),
  `create-box-modal.tsx`, `validate.ts`/`openapi.ts`, `types.ts`/`backend-types.ts`.
  Tracked in `docs/web-create-boxes-backlog.md` (Phase D.2).

---

## Docs to update (in the phase that changes the behavior)

- `docs/control-plane-roadmap.md` / `docs/control-plane-guide.md` — the local hub
  now serves the UI on the relay port; rename control-plane → hub where it lands.
- `apps/web/content/docs/**` — new `agentbox hub` command + the localhost UI.
- `apps/hub/README.md` — the three profiles and env (`AGENTBOX_HUB_PROFILE`,
  `AGENTBOX_HUB_AUTH`).
