# Control Box — implementation plan

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). This is the plan of record for
> turning the hosted control plane into a real **control box**: the full hub deployed on a
> persistent Hetzner VPS, acting as an **intermediary between the PC and the boxes** — the PC
> workflow stays exactly as today, but the control box holds enough state (registry, approvals,
> credentials, SSH keys, secrets) that work can also continue from mobile with the laptop off.
> Background: [`control-plane-roadmap.md`](./control-plane-roadmap.md) (architecture + milestones),
> [`control-plane-backlog.md`](./control-plane-backlog.md) (what shipped),
> [`control-plane-guide.md`](./control-plane-guide.md) (feature guide).
> One phase per session; keep this doc updated as phases land (per project convention, maintain
> status live — check boxes, note deviations inline).

## Goal

Operate from the PC exactly as today, with the control box as the intermediary:

- The control box runs the **full hub** (relay daemon + web UI + create worker) on a Hetzner VPS,
  always on.
- The PC keeps its direct connections where they are inherently direct (SSH attach, port
  forwards, file cp/download to a box it can reach) — but everything that makes those work
  (per-box SSH keys, agent credentials, project secrets/envs) can be **uploaded to / downloaded
  from the control box**, so a box created from either side is usable from both.
- Registry, status, events, approvals, and the create queue live on the control box, so the
  **hub web UI from a phone** can watch boxes, answer approvals, and spawn new boxes.

Explicitly a **custody + reach** model (roadmap §4): the PC stays the source of truth; the
control box holds copies of what boxes need.

## Postponed (out of scope for all four phases)

- **In-box create + poll** (roadmap M3). The worker keeps the current host-driven
  `makeControlPlaneCreateBox` path (lease → local clone → `provider.create()`); it runs fine on
  the VPS because the VPS is a full host.
- **Vercel deploy of the control plane.** The `--deploy vercel` path and the Postgres/serverless
  profile stay in the tree but are not extended; Hetzner is the only maintained deploy target
  for now. (PostgresStore keeps passing its conformance suite; no new features target it.)
- **DigitalOcean / AWS deploy targets** for the control box itself (the DO *box provider* is
  unaffected; the unmerged AWS provider likewise).
- **Linux-host gaps** beyond what the hub/worker path actually exercises
  ([`linux-host-backlog.md`](./linux-host-backlog.md)) — the VPS runs the hub + worker headless;
  attach/open/terminal surfaces stay PC-side.
- **Blob storage** for custody — phase 2 is plain files in a folder, behind a seam.
- Encrypted-at-rest custody, multi-user auth roles, Cloudflare target, 3-way workspace sync.

## Where we start (verified against the tree, 2026-07-14)

- `apps/hub` is one app with three profiles (`apps/hub/lib/auth-config.ts`): `localhost`
  (token gate), `hetzner` (better-auth password over **`node:sqlite`** at
  `~/.agentbox/hub/auth.db`), `vercel` (better-auth over `pg`). So better-auth is **already
  dual-dialect** — phase 1's auth work is verification, not a port.
- The relay core `Store` seam (`packages/relay/src/store/`) has `MemoryStore`, `PostgresStore`
  (~450 lines of hand-written SQL: boxes / events / status / prompts / `create_jobs`),
  and `RemoteStore`. **No SQLite store.** A conformance suite runs against Memory and
  (opt-in, live) Postgres.
- `agentbox control-plane setup --deploy hetzner` (`deployControlPlaneToHetzner`,
  `packages/sandbox-hetzner/src/control-plane-deploy.ts`) provisions a VPS, but what it runs is
  the **plane profile**: `apps/hub/Dockerfile` CMD is `next start` — the `[...path]` route
  handler over PostgresStore. No relay daemon, no `createHubBackend`, host-local RPCs
  (cp/download/checkpoint) are rejected, and the compose stack is db + app + Caddy with **no
  worker**.
- The full hub is `apps/hub/server.ts`: `startRelayDaemon` + Next UI on one port, hub backend +
  SSE notifier via `globalThis`. It already supports a non-loopback bind (`hetzner` profile,
  better-auth) — it has just never been the thing the deploy ships.
- The create queue + worker exist and are live-validated (`create_jobs`, `drainCreateJobs` in
  `packages/relay/src/create-worker.ts`, `agentbox control-plane worker`,
  `makeControlPlaneCreateBox` in `apps/cli/src/control-plane/create-box.ts`) — but the worker is
  a **laptop command**, and a box it creates seeds agent credentials and mints SSH keys from
  *its* host, not yours.
- Sync topology is already resolved per box (`packages/core/src/sync/topology.ts`):
  `docker` / `cloud` / `control-plane`; control-plane cloud boxes register on the plane
  (`packages/sandbox-cloud/src/plane-register.ts`) and lease push tokens directly. The
  backlog's "Phase 4b remaining laptop wiring" (autopause/queue over the store, admin-CLI
  retarget) is still deferred — that's this plan's phase 4.

---

## Phase 1 — SQLite parity for the hub core — DONE (box `cbx-phase1`, 2026-07-14)

- [x] Core store on drizzle, dual dialect (`SqliteStore` + `PostgresStore` on one schema).
- [x] `makeStore()` sqlite branch; hetzner hub profile defaults to SQLite when `POSTGRES_URL` is unset.
- [x] better-auth on SQLite verified (hetzner profile boots, `auth.db` created, `pg` path still boots).

Result + deviations are recorded under [implementation plan](#phase-1--implementation-plan-box-cbx-phase1)
below; open items went to the [Backlog](#backlog).

**Why first:** the control box should be a single always-on process on a small VPS. Postgres is
the serverless profile's constraint, not the VPS's; SQLite drops a container from the compose
stack, removes the db credential, and (phase 3) lets the worker share the store in-process. It
also pre-builds roadmap M2 (local-first hub).

**Work:**

1. **Core store on drizzle, dual dialect.** Introduce `drizzle-orm` with one schema for the
   relay tables (boxes, events, status, prompts, create_jobs) and two drivers:
   - `SqliteStore` — DB at `~/.agentbox/hub/store.db` (sibling of the existing `auth.db`).
     Driver: `node:sqlite` to match `apps/hub/lib/auth.ts` (verify drizzle's `node:sqlite`
     driver support at implementation time; if missing, `better-sqlite3` guarded like
     `node-pty`, or a thin hand-written adapter — decide then, record here).
   - Port `PostgresStore` onto the same drizzle schema so there is **one** set of core queries
     (this is the "core drizzle queries" step — the hand-written `SCHEMA_SQL` + SQL strings go
     away). The store conformance suite is the safety net for the port.
   - Keep the lazy-import + tsup-`external` pattern for **both** drivers (mirroring today's
     `pg`), so the laptop CLI bundle carries neither unless used. Node engines floor is 20.10
     but `node:sqlite` needs ≥ 22.5 — guard with a clear error, same posture as the hub's auth
     path (roadmap Risks).
2. `makeStore()` branch: a `sqlite:` URL (or a bare path) selects `SqliteStore`; the `hetzner`
   hub profile defaults to it when no `POSTGRES_URL` is set.
3. **better-auth on SQLite** — already implemented for the `hetzner` profile; verify login,
   migration (`ensureAuthReady`), and admin seeding against a fresh `auth.db`, and confirm the
   `vercel`/`pg` path still boots (it shares `getMigrations`).

**Concurrency note (feeds phase 3):** SQLite is effectively single-writer. The design
consequence is that the create worker must run **in the same process** as the relay daemon on
the control box (an interval loop), not as a second container hitting the same file. Record this
as a constraint, not an optimization.

**Verify:** store conformance suite green for `SqliteStore` (same suite as Memory/Postgres);
Postgres conformance still green against a disposable `postgres:16`; `AGENTBOX_HUB_PROFILE=hetzner
AGENTBOX_HUB_HOST=0.0.0.0 pnpm --filter @agentbox/hub hub:dev` boots with zero Postgres, `/healthz`
reports `db:true`, better-auth signup/login works, a registered box + prompt row survive a
process restart. `pnpm typecheck` before push.

### Phase 1 — implementation plan (box cbx-phase1)

**Driver decision (verified against the installed tree, not assumed).** `drizzle-orm@0.45.2` (the
current latest) ships **no `node:sqlite` driver**: its SQLite subpaths are `better-sqlite3`,
`bun-sqlite`, `libsql`, `op-sqlite`, `expo-sqlite`, `durable-sqlite`, `prisma/sqlite` and
`sqlite-proxy`. So the plan's first option does not exist, and its `better-sqlite3` fallback would
add a **native dependency** — against the repo's one-sanctioned-native-dep rule, and it would need a
toolchain in the hub image. Taking the plan's third option (a thin adapter):

- **SQLite = `drizzle-orm/sqlite-proxy` over `node:sqlite`.** `sqlite-proxy` is drizzle's
  bring-your-own-executor SQLite driver: you hand it
  `(sql, params, method) => Promise<{ rows }>` and drizzle's SQLite dialect does the rest. A ~20-line
  callback over `DatabaseSync` from `node:sqlite` is the whole adapter, so we get drizzle's typed
  query builder with **zero native deps** and the same driver the hub's better-auth already uses.
  Verified live in this box (Node 24): insert/`onConflictDoUpdate`/select/`delete … returning`/
  `count(*)` and json-mode columns all round-trip. Rows must be positional for drizzle's mapper —
  `StatementSync.setReturnArrays(true)` when present, else `Object.values(row)` (our queries are
  single-table, so no duplicate-column collapse).
- **Postgres = `drizzle-orm/node-postgres`** over the existing `pg` Pool. `drizzle-orm/node-postgres`
  statically `import`s `pg`, so it stays behind the **same lazy dynamic import** as today's pool
  factory (importing it at module top would drag `pg` into the box's `bin.cjs` load path).
- `drizzle-orm` itself is pure JS with no hard dependencies (28 optional peers, none required) — it
  is a normal dependency of `@agentbox/relay` and is bundled; only the two **drivers** (`pg`,
  `node:sqlite`) stay external/lazy, which is the requirement.
- Node floor: `node:sqlite` needs ≥ 22.5 (the repo's engines floor is 20.10). `SqliteStore` checks
  `process.versions.node` on first open and fails with an explicit message.

**Files.**

- `packages/relay/src/store/schema.ts` (new) — one schema module holding both dialect table sets
  (`boxes`, `events`, `box_status`, `prompts`, `create_jobs`) with identical column names, plus the
  idempotent DDL for each dialect and the shared row→domain mappers.
- `packages/relay/src/store/sqlite-store.ts` (new) — `SqliteStore` (`node:sqlite` + sqlite-proxy).
- `packages/relay/src/store/postgres-store.ts` — ported onto the drizzle schema; every hand-written
  query string removed.
- `packages/relay/src/store/index.ts` — `makeStore()` gains the sqlite branch.
- `packages/relay/src/{index,control-plane}.ts` — export `SqliteStore`; `SCHEMA_SQL` becomes
  `PG_SCHEMA_SQL` / `SQLITE_SCHEMA_SQL` (unreleased — clean rename, no alias).
- `packages/relay/{package.json,tsup.config.ts}` — add `drizzle-orm`; `pg` stays external.
- `apps/hub/server.ts` — pick the store from the profile (hetzner → sqlite when `POSTGRES_URL` is
  unset) and pass it to `startRelayDaemon`.
- `apps/hub/lib/auth-config.ts` — `STORE_DB_PATH` (`~/.agentbox/hub/store.db`), sibling of `auth.db`.

**Schema shape.** Column names and JSON payloads are identical across dialects; only the physical
types differ, so the existing Postgres tables are unchanged (no migration of deployed data):

| table | key columns | pg types | sqlite types |
| --- | --- | --- | --- |
| `boxes` | `box_id` pk, `token` (idx), `origin_url`, `data`, `registered_at` | `text` / `jsonb` / `timestamptz` | `text` / `text` json-mode / `text` ISO |
| `events` | `id` pk auto, `box_id`, `type`, `ts`, `payload`, `received_at` | `bigint` identity / `jsonb` | `integer` autoincrement / `text` json-mode |
| `box_status` | `box_id` pk, `name`, `project_index`, `status`, `updated_at` | `jsonb` | `text` json-mode |
| `prompts` | `id` pk, `box_id`, `ev`, `method`, `params`, `status`, `answer`, `cancelled`, `result`, `created_at`, `expires_at` | `jsonb` / `boolean` | `text` json-mode / `integer` boolean-mode |
| `create_jobs` | `id` pk, `status`, `request`, `result`, `claimed_by`, `created_at`, `started_at`, `finished_at` | `jsonb` | `text` json-mode |

Timestamps are written as JS-side ISO strings in both dialects (rather than a `now()` default) so the
two stores share one mapper; reads normalize `Date | string → ISO`. Two table sets are unavoidable —
drizzle's `pg-core` and `sqlite-core` builders produce dialect-typed objects, and a query is typed to
its dialect — so the stores keep parallel (but now typed, drizzle-built) query bodies over one shared
schema + mapper module rather than one generic body.

**Deviation from the plan text:** the idempotent `CREATE TABLE IF NOT EXISTS` DDL stays as SQL
strings (renamed, colocated with the schema). Drizzle only emits DDL through drizzle-kit migration
*folders*, which do not survive tsup bundling into `bin.cjs` / the hub standalone build. All
**queries** are drizzle; only the boot DDL is literal SQL. `SqliteStore` applies its DDL + `PRAGMA
journal_mode=WAL` / `busy_timeout` lazily on first open, so it is always migrated before use.

**Tests.** `sqlite-store.test.ts` runs the existing `runStoreConformance` suite against a
`SqliteStore` on a `:memory:` DB (and one on-disk case for persistence), so it stays docker/network
free and joins Memory in the default `pnpm --filter @agentbox/relay test` run. Postgres keeps its
opt-in `AGENTBOX_TEST_DATABASE_URL` gate, run here against a disposable `postgres:16`. Boot smoke:
`AGENTBOX_HUB_PROFILE=hetzner` with the sqlite store — register a box + park a prompt row, restart
the process, assert both survive.

### Phase 1 — what actually shipped

Everything above landed as planned. What the implementation added to it:

- **`node:sqlite` is loaded through `createRequire`, not `await import()`.** It is a *prefix-only*
  builtin, so it is absent from `module.builtinModules` — and vite 5 / vite-node decide "is this a
  builtin?" from exactly that list, strip the `node:`, and try to load a package called `sqlite` from
  disk. A plain dynamic import breaks every vitest run that touches the store, and no vitest config
  hook fixes it (vite-node externalizes builtins by its own list, so `server.deps.external` and a
  `resolveId` plugin both miss). `createRequire` hands the load to Node's own resolver, which is the
  only one that gets prefix-only builtins right; tsup/esbuild were never the problem. Revisit when the
  repo moves to vite 6 / vitest 3.
- **Bundle posture (verified on the built artifacts, not assumed).** `relay/dist/bin.cjs` — the bin
  baked into every box image — contains **neither store** (0 references, byte-identical size to
  before). In the CLI, drizzle lands in lazily-reachable chunks (`sqlite-proxy-*.js`,
  `node-postgres-*.js`) that `index.js` does not import: `pg` and `node:sqlite` are never on the
  laptop's load path, and CLI startup is unchanged. drizzle-orm itself is bundled (pure JS, no hard
  deps), so no new runtime dependency ships to users.
- **Store gained an optional `migrate?()`** so `makeStore()` callers can migrate without casting;
  `SqliteStore` also applies its schema lazily on first open, so it cannot be used un-migrated.
- **Postgres test fixture fix (pre-existing bug, not the port):** its `TRUNCATE` omitted
  `create_jobs`, and the queue case re-uses fixed job ids with `ON CONFLICT DO NOTHING` — so it only
  passed against a virgin database and failed on the second run. `create_jobs` is now truncated too.

**Verification (all green, from inside the box):**

| check | result |
| --- | --- |
| `SqliteStore` on the store conformance suite (+ an on-disk restart case) | 11/11 |
| `pnpm --filter @agentbox/relay test` | 298 passed, 1 skipped (the opt-in pg suite) |
| Postgres conformance vs a disposable `postgres:16` (`AGENTBOX_TEST_DATABASE_URL=…`) | 10/10, twice in a row (re-runnable) |
| `pnpm build` / `pnpm typecheck` (repo root) / relay lint | green (18 + 31 tasks) |
| Boot smoke (below) | 13/13 |

**Boot smoke** (script kept out of the repo — it drives two real processes): boots the actual
`apps/hub/server.ts` with `AGENTBOX_HUB_PROFILE=hetzner`, `AGENTBOX_HUB_HOST=0.0.0.0`, a throwaway
`HOME` and **no `POSTGRES_URL`**, so it must pick SQLite. Asserts: `/healthz` ok with zero Postgres;
better-auth creates `auth.db` on the sqlite dialect ("auth ready"); a box registered over
`/admin/register-box` plus an event it posts with its bearer token are both in the store; after
SIGTERM + reboot the box, its token, and the event counts are all still there. Then a **poll-mode
relay over the same `store.db`** (the shape phase 3's control box runs): the box *the hub registered*
authenticates against it (one store, two processes), its `/rpc` parks a prompt row, and after a
restart that row is still pending and still answerable via `/admin/prompts/answer`. A variant with
`POSTGRES_URL` set confirms the same hub picks `PostgresStore` and persists across a restart too.

**Concurrency constraint confirmed:** SQLite is single-writer, so phase 3's create worker must run
in the hub *process* (an interval loop), not as a second container against the same file. WAL +
`busy_timeout=5000` are set, and the smoke above shows two processes *can* share the file — but that
is the approval/registry read path, not a second writer competing on the queue.

## Phase 2 — Custody store on the control box (agent creds, SSH keys, secrets/envs)

**Why second:** everything phase 3's worker seeds into a new box, and everything phase 4
downloads back to the PC, needs a place to live on the control box first.

**Work:**

1. **A `CustodyStore` seam with a filesystem implementation** (future: blob storage — keep the
   interface path-and-bytes shaped so swapping the backend is mechanical). Root:
   `~/.agentbox/hub/custody/` on the control box, `0700` dirs / `0600` files:
   - `agents/<claude|codex|opencode>/…` — the same credential file set the cloud create path
     already seeds from the host's `~/.agentbox` backups (reuse that manifest; don't invent a
     second list).
   - `projects/<project>/…` — per-project secrets/env files (`secrets.env`, `.env*` the user
     opts in), keyed by the project's repo slug.
   - `boxes/<boxId>/ssh/…` — per-box SSH key material (hetzner/DO boxes), uploaded by whichever
     host minted it.
   - A per-entry **content-hash manifest** so re-uploads are skipped when nothing changed
     (established convention: hash-based change detection, not timestamps).
2. **Relay-core endpoints**, admin-bearer gated, fail-closed, on `core/handler.ts`:
   `PUT/GET/DELETE /admin/custody/<scope>/<path>` (base64 JSON or tar for directory sets) plus
   a manifest/list endpoint. Values never logged; no box-token access to custody in this phase
   (boxes keep receiving creds via the worker's seed step — the gate stays at the host/hub
   boundary).
3. **CLI surface** (on the existing `agentbox control-plane` command; naming can settle in the
   M1 rename later): `credentials push` (host agent-cred backup set → custody),
   `secrets push [--project]`, and a generic `custody pull <scope>` used by phase 4. Wire
   `push` to run opportunistically after `agentbox <agent> login` refreshes a credential
   (hash-skip makes this cheap).

**Verify:** round-trip each scope over HTTPS against a local hub (`hetzner` profile): push the
real host Claude backup set, list, pull to a temp dir, byte-compare; unchanged re-push is a
no-op (hash hit); on-disk modes are 0600/0700; endpoints 401 without the admin bearer;
`pnpm --filter @agentbox/relay test` green.

## Phase 3 — The Hetzner deploy ships the full hub + resident create worker

**Why third:** with SQLite (no db container) and custody (creds available VPS-side), the deploy
can finally ship the real thing.

**Work:**

1. **Deploy the hub, not the plane.** Rework the Hetzner deploy
   (`control-plane-deploy.ts` + `apps/hub/Dockerfile`/compose) so the app service runs
   `server.ts` (the standalone build — `build:standalone` — same artifact `agentbox hub`
   spawns) with `AGENTBOX_HUB_PROFILE=hetzner`, `AGENTBOX_HUB_HOST=0.0.0.0`, SQLite store, and a
   persistent volume for `~/.agentbox` (store.db, auth.db, custody, box SSH keys, logs).
   Compose becomes **app + Caddy** (Postgres dropped). Keep: per-deploy firewall (`:22`
   host-only, `:80/:443` open), scp'd secret `.env` (admin token, `BETTER_AUTH_SECRET`, admin
   email/password, GitHub-App creds), Caddy + sslip.io HTTPS, `deploy.json` record. The
   admin-bearer API and better-auth UI gating both stay on (the hub is now
   internet-reachable-by-design).
2. **Resident worker, in-process.** After `startRelayDaemon`, the hub process runs the
   create-queue consumer on an interval: `drainCreateJobs(store, createBox, hostname)` — the
   SQLite single-writer constraint from phase 1 makes in-process the correct shape (no second
   container contending on the db file). Gate it on a `AGENTBOX_HUB_WORKER=on` env so the
   localhost profile is unaffected. The existing `agentbox control-plane worker` command stays
   for dev/laptop use.
3. **Worker inputs on the VPS:**
   - The image already builds from the repo root (workspace deps available); confirm `git` and
     the provider SDK wiring (`providerForCreate`) work in-image.
   - **Provider credentials**: the deploy scp's the needed entries from the host's
     `~/.agentbox/secrets.env` (start with `HCLOUD_TOKEN` + E2B; extend as needed) into the
     VPS `~/.agentbox` volume. (Custody `secrets push` can supersede this later.)
   - **Agent credentials**: the worker's `provider.create()` seeds from the VPS
     `~/.agentbox` backups — point that path at the custody store's `agents/` scope, so a
     `credentials push` from the PC (phase 2) is what makes hub-created boxes logged-in.
   - **SSH keys**: hetzner/DO boxes created by the worker mint keys into the VPS
     `~/.agentbox/boxes/<id>/ssh/` — mirror them into custody `boxes/<id>/ssh/` so phase 4 can
     download them.
4. **Firewall shape for dual reachability.** A hetzner box created *by the VPS* auto-locks its
   firewall to the **VPS's** egress IP; the PC then can't SSH direct (phase 4's requirement).
   Extend the box-firewall rules for control-plane-topology creates to include both the creating
   host's IP and the registered PC egress IP (an admin-supplied/persisted extra CIDR on the hub;
   re-syncable, same fail-loud multi-probe posture as today).
5. **Enqueue from the PC**: `POST /remote/boxes` already exists; add the thin CLI path
   (`agentbox create --provider e2b --via-hub` or equivalent flag — exact spelling decided in
   the phase) that enqueues instead of creating locally, and surface job progress from
   `GET /remote/boxes/:id` (the hub UI create modal points at the same queue).

**Verify (end-to-end, live):** `agentbox control-plane setup --deploy hetzner` on a fresh VPS →
`https://<ip>.sslip.io/healthz` green and the **web UI login works from a phone**; push agent
creds from the PC (phase 2); enqueue a create from the PC CLI *and* one from the hub UI; the
in-VPS worker claims both, creates real cloud boxes (e2b + hetzner), each box completes a real
logged-in `claude -p` turn (box *usable*, not just ready — established convention) and an
`agentbox-ctl git push` on `agentbox/*` verified via `git ls-remote`; approvals raised by a box
are answerable from the phone UI; VPS reboot → hub + worker come back (compose
`restart: unless-stopped`) with registry/queue intact (SQLite volume). Destroy leaves no orphans.

## Phase 4 — The PC operates through the control box

**Why last:** it consumes everything above — the PC becomes a *peer* that syncs custody material
with the control box and defers shared state to it, while keeping its direct connections.

**Work:**

1. **Retarget the shared state** (the backlog's deferred "Phase 4b laptop wiring"): when
   `relay.controlPlaneUrl` is set, the PC's relay/CLI read+write registry, status, events,
   prompts, and the create queue through the control box (`RemoteStore` / the admin API) so PC,
   hub UI, and mobile see one world. Decide per subsystem what stays local (docker boxes remain
   loopback-relay only — `docker` topology is never a control-plane target; autopause/queue for
   cloud boxes moves to the hub). `agentbox relay status` + the local hub UI show the configured
   control box and link to it rather than pretending to be the brain.
2. **Direct connections keep working, fed by custody downloads:**
   - `agentbox hub pull <box>` (or `custody pull boxes/<id>`): download a hub-created box's SSH
     key set into the PC's `~/.agentbox/boxes/<id>/ssh/` so `attach` / port forwards / `cp` /
     `download` work exactly as for a PC-created box. Requires the phase-3 dual-IP firewall.
   - The reverse: a PC-created cloud box's SSH key + registration are pushed up (create-time,
     when a control box is configured) so the hub/worker/mobile can also reach and manage it.
3. **File and credential flows, split by direction:**
   - **PC → control box:** agent credentials (`credentials push`, re-run after `agentbox claude
     login` refresh — the 401-on-startup failure mode), project secrets/envs
     (`secrets push`), SSH keys of PC-created boxes.
   - **Control box → PC:** box SSH keys, extracted/refreshed agent credentials
     (`Provider.extractAgentCredentials` output landing in custody gets pulled back into the
     host's `~/.agentbox` backups), project secrets if edited via the hub.
   - **PC ↔ box direct:** `cp`/`download`/attach stay direct SSH/SDK when the PC can reach the
     box; they are *not* proxied through the control box in this phase (the plane still rejects
     host-local RPCs — unchanged).
4. **Approvals + queue UX:** a prompt raised by any box is answerable from the PC CLI/tray *and*
   the hub UI (poll-mode rows on the control box; the tray keeps talking to the local hub, which
   now proxies/links). Queued agent runs (`-i`) against control-plane boxes enqueue on the hub.

**Verify (the goal scenario, live):** create box A from the PC and box B from the phone (hub
UI); from the PC, `attach` to B over SSH after `hub pull` (key + firewall); from the phone,
watch A's status and answer one of A's push approvals; **turn the PC off** — B keeps its agent
run going, pushes on `agentbox/*` (ls-remote check); PC back on → `agentbox list` shows both
boxes with correct state sourced from the control box; a refreshed Claude credential pushed from
the PC is what a subsequently-created hub box logs in with. Docker boxes remain fully local and
unaffected throughout (`pnpm --filter @agentbox/relay test` + a local docker smoke).

---

## Cross-phase notes

- **Docs in sync every phase** (project rule): `apps/web/content/docs/` (`control-plane.mdx` is
  currently unpublished/experimental — re-publish when phase 3 lands and the flow is real),
  `docs/host-relay.md`, `docs/cloud-providers.md`, and this file's checkboxes/status.
- The M1 **rename to `hub`** (CLI verbs, `relay.controlPlaneUrl` key) is *not* one of these
  phases; do it after phase 3 when the surface is proven, as its own clean rename (unreleased —
  no aliases).
- `pnpm typecheck` before every push; relay conformance suites are the regression net for
  phases 1–2; live cloud verification (usable-box bar: a real `claude -p` turn + ls-remote-checked
  push) for phases 3–4.

---

## Backlog

Findings and follow-ups discovered while implementing, kept out of the phase they were found in.

- **The daemon's background loops and the hub backend still read in-memory state, not the `Store`
  (phase 3 blocker).** `startRelayServer` only falls back to `MemoryStore` — inject any other store
  and the handlers write to it, but the `BoxRegistry` / `EventBuffer` / `BoxStatusStore` instances on
  the handle stay empty. The autopause loop, the cloud-keepalive loop, the queue loop, and
  `createHubBackend` (`handle.statusStore.get(id)`, `handle.prompts`) all read those objects. On the
  localhost profile nothing changes (MemoryStore *is* those objects), but on the control box
  (hetzner + SQLite) a box's live status reaches `store.setStatus` and no further: autopause would
  never fire and the hub UI would show no agent status. Phase 3 must route those consumers through
  the `Store` (or have the durable stores write through to the in-process caches). Phase 1 does not
  regress anything here — it just makes the gap load-bearing for the first time.
- **Prompt and create-job rows are never deleted.** Neither durable store prunes answered prompts or
  finished jobs (events are ring-trimmed; prompts/jobs are not). On the laptop that memory is
  process-lifetime; on an always-on control box the tables only grow. Add a retention sweep (and use
  the `expires_at` column already on the row) when the worker becomes resident in phase 3.
- **`listStatuses()` is off-interface.** Both durable stores implement it and the hub's
  `postgres-source.ts` calls it on the concrete class. Promote it to `Store` when phase 4 retargets
  the PC's shared state, so the hub can read statuses without knowing the backend.
- **DDL is still literal SQL.** All *queries* are drizzle, but `PG_SCHEMA_SQL` / `SQLITE_SCHEMA_SQL`
  are hand-written `CREATE TABLE IF NOT EXISTS` strings, because drizzle only emits DDL through
  drizzle-kit migration *folders*, which do not survive tsup bundling into `bin.cjs` / the hub
  standalone build. They are colocated with the schema, but nothing enforces that they match it — a
  drift test (or a build-time `drizzle-kit generate` inlined as a string) would.
- **`node:sqlite` is loaded via `createRequire`** because vite 5 / vite-node cannot resolve
  prefix-only builtins (details in the phase 1 notes). Swap it back to `await import('node:sqlite')`
  once the repo is on vite 6 / vitest 3.
- **Event trimming is a `DELETE` per append** in both durable stores (unchanged from the pre-drizzle
  Postgres store). Fine at current volume; batch it if the control box gets chatty.
