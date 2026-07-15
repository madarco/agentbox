# Control Box — implementation plan

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). This is the plan of record for
> turning the hosted control plane into a real **control box**: the full hub deployed on a
> persistent Hetzner VPS, acting as an **intermediary between the PC and the boxes** — the PC
> workflow stays exactly as today, but the control box holds enough state (registry, approvals,
> credentials, SSH keys, secrets) that work can also continue from mobile with the laptop off.
> This is the single plan-of-record for the control box; the older `control-plane-*` design docs
> were removed to avoid confusion. Related: [`host-relay.md`](./host-relay.md) (the relay core),
> [`in-box-supervisor.md`](./in-box-supervisor.md), and the public guide at
> [`apps/web/content/docs/deployed-hub.mdx`](../apps/web/content/docs/deployed-hub.mdx).
> One phase per session; keep this doc updated as phases land (per project convention, maintain
> status live — check boxes, note deviations inline).

## Status — all four phases DONE + live-verified (2026-07-15)

All four phases are implemented, merged into `feat/control-box-plan`, and verified live against a
real Hetzner-deployed control box:

- **Phase 1 — SQLite hub core** (PR #216): drizzle store, both dialects, better-auth on SQLite.
- **Phase 2 — Custody store** (PR #217): agent creds / secrets / box SSH keys behind a
  blob-swappable seam, admin-bearer routes, hash-skipped push/pull.
- **Phase 3 — Full-hub Hetzner deploy + resident worker** (PR #218): standalone `server.ts`,
  app+Caddy compose on SQLite, in-process create worker, dual-IP firewall, `create --via-hub`.
- **Phase 4 — PC through the control box** (PR #224): shared state over the control box, `hub
  pull`, credential/secret flows, box reap, approvals from the PC.

**Eight live fixes** (the in-box mocks structurally cannot reach the real-provider / real-baked /
control-box-only paths) landed as their own PRs: **#219** (cloud SDK externals), **#220** (admin
bearer non-loopback), **#221** (plane-register worktrees / lease auto-allow), **#222**
(lease-push runs real git, not the shim), **#225** (control-box image carries the CLI +
projects volume), **#226** (container on 8787 so in-container spawns reuse the hub relay).

**Goal scenario verified end to end (2026-07-15):** a box created from the hub **web UI** boots a
logged-in `claude -p`; a control-box-created box's `agentbox-ctl git push` advances a branch on
GitHub **with the PC relay hard-killed** (host-off), leasing from the control box, not the laptop.

Remaining items — including the one real gap found in the final verify (the **web-UI/queue create
path doesn't wire git leasing**, so a *web-created* box can't push host-off; the `--via-hub` path
does) — are in the [Backlog](#backlog). The M1 `control-plane` → `hub` rename is deliberately left
as its own follow-up.

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

## Phase 2 — Custody store on the control box (agent creds, SSH keys, secrets/envs) — DONE (box `cbx-phase2`, 2026-07-14)

- [x] `CustodyStore` seam (path-and-bytes) + `FsCustodyStore` at `~/.agentbox/hub/custody/`
  (`0700` dirs / `0600` files, atomic writes, content-hash skip).
- [x] Shared `handleCustodyRequest` dispatcher mounted in BOTH the hosted-plane handler
  (`core/handler.ts`) and the relay daemon (`server.ts`) — admin-bearer gated, fail-closed
  (503 unconfigured / 401 wrong token / 400 bad path), values never logged, no box-token path.
- [x] CLI on `agentbox control-plane`: `credentials push`, `secrets push [--project]`,
  `custody pull <scope>`, `custody list [prefix]`; opportunistic hash-skipped push wired into
  `credentials propagate` (the single host-side credential-refresh chokepoint).

Result + deviations recorded under [what actually shipped](#phase-2--what-actually-shipped);
open items went to the [Backlog](#backlog).

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

### Phase 2 — implementation plan (box cbx-phase2)

**Where the endpoints have to live (a correction to the plan text above).** The plan says
"relay-core endpoints … on `core/handler.ts`". That handler is the *hosted plane* (Next
`[...path]` route, Postgres). But the thing phase 3 deploys to the VPS is the **full hub** —
`apps/hub/server.ts` → `startRelayDaemon` → `packages/relay/src/server.ts` — which has its own
router and does **not** delegate to `core/handler.ts`. Custody wired only into `core/handler.ts`
would therefore be unreachable on the actual control box. So: the routes are a **shared
dispatcher** (`custody/routes.ts`) mounted in **both** handlers. Same code, same gate, both
profiles.

**Gate: admin bearer only — no loopback bypass.** `server.ts` gates `/admin/*` on
`isLoopbackAddress(req.socket.remoteAddress)`. On the control box the hub sits behind Caddy on
the same host, so *every* proxied request looks loopback — a loopback-gated custody route would
be world-readable over HTTPS. Custody therefore requires a matching admin bearer in both
handlers and never accepts loopback as proof; missing/empty admin token → `503` (fail-closed,
same posture as `core/handler.ts`'s "admin token unset"), no custody store wired → `503`, wrong
token → `401`. No box-token path in this phase.

**CustodyStore seam** — `packages/relay/src/custody/store.ts`, path-and-bytes only (no fs
handles, no streams), so an S3/R2 backend is a mechanical swap (key = path, sha256 = object
metadata):

```ts
export interface CustodyEntry {
  path: string;      // custody-relative, e.g. 'agents/claude/.credentials.json'
  size: number;
  sha256: string;    // hex digest of the bytes — the only change signal
  mode: number;      // fs backend: 0o600
  updatedAt: string; // ISO; informational, never used for change detection
}
export interface CustodyStore {
  put(path: string, data: Buffer): Promise<CustodyEntry & { changed: boolean }>;
  get(path: string): Promise<{ entry: CustodyEntry; data: Buffer } | null>;
  stat(path: string): Promise<CustodyEntry | null>;
  list(prefix?: string): Promise<CustodyEntry[]>;   // the manifest
  delete(path: string): Promise<boolean>;
}
```

`FsCustodyStore` (`custody/fs-store.ts`) roots at `~/.agentbox/hub/custody/`
(`DEFAULT_CUSTODY_DIR`, sibling of `store.db`/`auth.db`; injectable for tests), `0700` dirs /
`0600` files, atomic writes (tmp + `rename` + `chmod`).

**Hash manifest.** No sidecar/manifest file — the fs store derives `sha256` by reading the
(small: credentials, `.env`, SSH keys) file, so the manifest can never drift from the bytes. Two
skips, both content-hash, never timestamps: `put()` hashes the existing entry and returns
`changed:false` without rewriting when equal (mtime untouched), and the CLI fetches the manifest
first and skips uploads whose local digest already matches (so an unchanged `credentials push`
sends zero bytes).

**Path grammar** (`normalizeCustodyPath`, fail-closed → `400`): `agents/<claude|codex|opencode>/…`
| `projects/<slug>/…` | `boxes/<boxId>/…` (SSH material at `boxes/<id>/ssh/…`). Segments match
`[A-Za-z0-9._-]+`, `.`/`..` rejected, no absolute paths, depth ≤ 6, path ≤ 256 chars.

**Endpoint surface** (`custody/routes.ts` → `handleCustodyRequest(req, store) → RelayResponse |
null`; `null` = not a custody path, so each host router falls through unchanged):

| route | body / result |
| --- | --- |
| `GET /admin/custody[?prefix=…]` | `{ entries: CustodyEntry[] }` — the manifest; values never included |
| `PUT /admin/custody/<path>` | `{ data: <base64> }` → `{ …entry, changed }` |
| `GET /admin/custody/<path>` | `{ …entry, data: <base64> }` |
| `DELETE /admin/custody/<path>` | `204` / `404` |

Values are never logged: the log line is `custody put <path> (<n> bytes, changed)` — path, size,
changed-flag only.

**Agent-credential manifest — reused, not reinvented.** The set of files a cloud create seeds
from is `AGENT_SYNC_SPECS` (`packages/sandbox-core/src/sync/registry.ts`): per agent,
`credential.hostBackup` (`~/.agentbox/{claude,codex,opencode}-credentials.json`),
`credential.boxRelPath` (`.credentials.json` / `auth.json` / `auth.json`) and
`credential.realShape` (the `isRealAgentCredential` guard that keeps an empty/placeholder blob
from overwriting a good one). `credentials push` iterates exactly that registry — no second list
— and stores each real backup at `agents/<id>/<credential.boxRelPath>` (the box-canonical name,
so phase 3's seed step reads it back with the same registry).

**CLI** (on the existing `agentbox control-plane` command; URL from `--url` /
`relay.controlPlaneUrl`, admin token from `AGENTBOX_RELAY_ADMIN_TOKEN` or the setup-written
`~/.agentbox/control-plane/control-plane.env`):

- `credentials push [--agent <id>] [--force]` — registry-driven, hash-skipped.
- `secrets push [file…] [--project <slug>]` — files land at `projects/<slug>/<basename>`; slug
  defaults to the git origin's `owner__repo`, else the project-dir basename. With no file args it
  pushes `.env` from the project root **only if it exists** (nothing implicit beyond that).
- `custody pull <scope> [--dest <dir>]` — manifest under the prefix → `GET` each → write `0600`
  under `<dest>/<custody path>` (default dest `./agentbox-custody`).
- `custody list [prefix]` — the manifest (paths + hashes, no values).

**Opportunistic push seam.** `agentbox credentials propagate --agent <id>` is already the single
host-side point every credential refresh flows through (the relay's `CredentialsFanout` spawns it
debounced on a box's `credentials-updated`; it is also the manual recovery command). It ends by
best-effort pushing that agent's backup to custody when a control plane + admin token are
configured — silent no-op otherwise, and a hash hit when nothing changed.

**Files.** New: `packages/relay/src/custody/{store,fs-store,routes}.ts` (+ exports from
`index.ts` and `control-plane.ts`), `apps/cli/src/control-plane/custody-client.ts` (fetch client +
the pure push planner). Touched: `packages/relay/src/core/handler.ts` (mount + `custody` dep),
`packages/relay/src/server.ts` (mount + `custody`/`adminToken` options),
`apps/hub/server.ts` + `apps/hub/lib/plane.ts` (wire an `FsCustodyStore`),
`apps/cli/src/commands/control-plane.ts` (subcommands),
`apps/cli/src/commands/credentials.ts` (the opportunistic push).

**Tests** (temp dirs only; no docker, no network): `custody-store.test.ts` (fs store: round-trip,
hash-skip, modes, traversal rejection, prefix listing), `custody-routes.test.ts` (both handlers:
401 without bearer, 503 unconfigured, 400 bad path, base64 round-trip, in-process HTTP against
`startRelayServer` with an injected root), and a CLI planner test for the hash-skip decision.
Plus the round-trip smoke over HTTP (commands recorded below) and the full repo suite
(`pnpm test`, `pnpm typecheck`, `pnpm lint`).

### Phase 2 — what actually shipped

Everything above landed as planned. Notes on the implementation:

- **Endpoints are a shared dispatcher mounted in both front-ends**, as the plan's correction
  called for. `handleCustodyRequest(req, {custody, adminToken, log}) → CustodyResponse | null`
  lives in `packages/relay/src/custody/routes.ts`; `core/handler.ts` calls it right after its
  admin-bearer check, and `server.ts` calls it **before** its loopback rejection (custody carries
  its own bearer gate, and a control box behind Caddy makes every request look loopback). `null`
  return = not a custody path, so each host router falls through unchanged.
- **`server.ts` gained a `readRawBody` helper** — the custody PUT body is JSON `{data:<base64>}`
  and the route wants the raw text, but `server.ts` only had `readJsonBody` (which parses). Same
  1 MiB cap.
- **base64 is round-trip-validated** on PUT (`buf.toString('base64') === data.replace(/\s+/g,'')`)
  because Node's base64 decode is lenient — a non-base64 body would otherwise be stored silently
  truncated. Returns 400 instead.
- **The hub wires custody only when an admin token is set** (`apps/hub/server.ts`): the hetzner
  control box has one; a loginless localhost hub gets `custody: undefined` and the routes
  fail-close 503. **`apps/hub/lib/plane.ts` (the Vercel serverless route) was left un-wired on
  purpose** — a Firecracker function's FS is ephemeral, so custody there would silently lose data;
  the handler's 503-when-unset is the honest behavior (matches "no new serverless features").
- **Agent-credential set is registry-driven, not a second list**: `collectAgentCredentialUploads`
  iterates `AGENT_SYNC_SPECS` and stores each real (`isRealAgentCredential`) `credential.hostBackup`
  at `agents/<id>/<credential.boxRelPath>` — the box-canonical filename, so phase 3's seed reads it
  back through the same registry.

**Verification (all green, from inside the box):**

| check | result |
| --- | --- |
| `packages/relay` custody unit tests (fs store + both handlers over in-process HTTP) | 19/19 |
| `apps/cli` custody-client tests (pure planner + fake-fetch client) | 4/4 |
| HTTP round-trip smoke (below) | 10/10 |
| `pnpm test` (repo root, all 29 tasks) | green (relay 317/1skip, cli 840/1skip) |
| `pnpm typecheck` (31 tasks, incl. hub + cli) | green |
| `pnpm lint` (17 tasks) | green |

**HTTP round-trip smoke** (script kept out of the repo — it boots a real process). Run from
`packages/relay/` so Node resolves the workspace package:

```
# copy scratch script into the package dir (workspace resolution needs it there), then:
cd packages/relay && node _custody-smoke.mjs   # boots startRelayDaemon with an FsCustodyStore
```

It boots the actual relay daemon with an `FsCustodyStore` over a temp root and asserts: 401
without the admin bearer; push a fake claude cred set + a project `.env` (200, `changed:true`,
sha matches); list returns a 2-entry manifest with **no `data` field**; pull byte-compares
identical; an unchanged re-push returns `changed:false` (hash hit); on-disk modes are 0600 files
/ 0700 dirs; an unknown scope (`secrets/…`) is 400.

## Phase 3 — The Hetzner deploy ships the full hub + resident create worker — DONE (box `cbx-phase3`, 2026-07-14); live-hetzner verify DONE 2026-07-15

- [x] Blocker A — write-through durable store into the in-memory caches + boot hydration (loops + hub backend see state on a hetzner+SQLite hub; localhost byte-identical).
- [x] Blocker B — retention sweep (answered prompts + finished create jobs) on a periodic daemon loop.
- [x] Deploy the full hub, not the plane: standalone `server.ts` Dockerfile, app+Caddy compose (Postgres dropped), SQLite, persistent `~/.agentbox` volume.
- [x] Resident in-process worker (gated `AGENTBOX_HUB_WORKER=on`); seeds agent creds from custody `agents/`, mirrors box SSH keys to custody, registers boxes on the hub.
- [x] Dual-IP firewall: control-plane-topology hetzner creates add the admin PC egress CIDR to the box firewall.
- [x] Enqueue from the PC: `agentbox create --via-hub` + a shared `/remote/boxes` dispatcher mounted in `server.ts`.
- [x] Deploy ergonomics: `agentbox control-plane deploy hetzner [--ref]` reusing the existing App creds.
- [x] In-box docker smoke green (build + boot + auth + custody + enqueue→worker + restart persistence).
- [x] **Live hetzner verify — DONE (host, 2026-07-15).** Real deploy on a fresh Hetzner VPS
  (`agentbox control-plane deploy hetzner --ref feat/control-box-plan` →
  `https://<ip>.sslip.io/healthz` green, better-auth login 200); `credentials push` (3 items) →
  `create --provider e2b --via-hub` → the in-VPS resident worker claimed the job and created a
  real E2B box; inside it a **logged-in `claude -p` turn** succeeded (creds flowed
  PC → custody → box) and **`agentbox-ctl git push` landed `agentbox/hub-smoke4` on GitHub**
  (verified host-side via `git ls-remote`); VPS `reboot` → hub + worker returned with the
  registry intact on the SQLite volume. Hub-UI create + a hetzner-provider box (dual-IP
  firewall, SSH-keys-in-custody) are exercised in phase 4 / final verification.

The live verify surfaced **four fixes**, each landed as its own PR into `feat/control-box-plan`
(the in-box mock smoke could not have caught any of them — they all sit on the real-provider /
real-baked-box path):

1. **#219** — the standalone hub bundle inlines `@agentbox/sandbox-*` but their cloud SDKs stay
   external, and pnpm's strict layout made them unresolvable from `dist-standalone` — worker
   create died on `Cannot find package 'e2b'`. SDKs (`e2b`, `@daytona/sdk`, `@vercel/sandbox`)
   are now direct `apps/hub` dependencies.
2. **#220** — `server.ts` kept `/admin/*` loopback-only, so the resident worker's own
   `register-box` via the public plane URL 403'd and hub-created boxes were left unregistered
   (`unknown box token` on push). The gate now accepts a timing-safe admin-bearer match from
   non-loopback (fail-closed when no token is configured — laptop unchanged).
3. **#221** — plane registration carried no worktrees, so the lease gate's `agentbox/*`
   auto-allow never applied and a hub-created box's push blocked forever on approval.
   Registration now carries the `/workspace` worktree (branch = sanctionedBranch).
4. **#222** — `leaseAndPush` spawned PATH `git`, which on a baked box is the agentbox git shim,
   and the shim (correctly) refuses positional remote/branch — every leased push from a real box
   died. It now runs the real git binary like direct mode. Baked images ship ctl, so this needed
   an e2b re-`prepare` (template `o05kawibx9vcmxvgjnk4`).

Result + deviations recorded under [what actually shipped](#phase-3--what-actually-shipped);
open items went to the [Backlog](#backlog).

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

### Phase 3 — implementation plan (box cbx-phase3)

Two mandatory blockers first (from the [Backlog](#backlog)), then the six deploy/worker items.
This plan resolves the design questions the phase text left open; deviations from the text above
are called out inline.

#### Blocker A — background loops + hub backend must see a durable store's state

**The problem, precisely.** The daemon's loops (`startAutopauseLoop`, `startCloudKeepaliveLoop`,
`startQueueLoop`) and `createHubBackend` read the **concrete** in-memory `handle.registry` /
`handle.statusStore` / `handle.events` / `handle.prompts` objects, never the `Store`. On the
laptop that is correct — `MemoryStore` *wraps those very instances* (`memory-store.ts`), so a
write through `store.setStatus` and a read via `statusStore.get` hit the same map. But inject a
durable `SqliteStore` and the handlers write to SQLite while the concrete instances stay empty:
`cloud-keepalive` sees `registry.list() === []` (never renews a cloud box), and
`createHubBackend.getData()` reads `handle.statusStore.get(id) === undefined` (the phone UI shows
no agent status). (autopause is docker-only — it `docker inspect`s a `containerName`, which a
VPS-created cloud box never has — so it is inert on the control box either way; keepalive + hub
status are the live symptoms.)

**Design chosen: write-through the durable store into the in-memory caches + hydrate on boot.**
Of the two options the backlog offers ("route the consumers through the Store" vs "make the
durable stores write through to the in-process caches"), write-through is the *least invasive*
and the only one that keeps the localhost/MemoryStore profile byte-identical:

- **Consumers are untouched.** autopause / keepalive / queue-loop / hub-backend keep reading the
  concrete `registry`/`statusStore`/`events` synchronously — no async-store rewrite, no risk of
  changing localhost timing/behavior.
- **localhost is literally the same code path.** The write-through wrapper is only constructed
  when `opts.store` is a *durable* store; a loginless localhost hub and every unit test still get
  `new MemoryStore({ registry, events, statusStore })` verbatim.
- **Single-writer makes the mirror safe.** Phase 1 already constrains the control box to one hub
  process (SQLite single-writer). One writer ⇒ the in-memory mirror can never go stale behind
  another process; DB is the source of truth across restarts, the mirror is a within-process cache.

Implementation:

- New `packages/relay/src/store/write-through-store.ts` — `class WriteThroughStore implements
  Store`. It delegates every read to the inner durable store and, on each **mutating** call, also
  applies the change to the injected `{ registry, events, statusStore }`:
  `registerBox → registry.register`, `forgetBox → registry.forget`, `setStatus →
  statusStore.set`, `deleteStatus → statusStore.delete`, `appendEvent → events.append`. Prompt +
  create-job methods are pure delegation (they have no in-memory mirror the loops read). It also
  forwards `migrate()` and the off-interface `listStatuses()`.
- `hydrate()` on the wrapper: `for (const reg of await inner.listBoxes()) registry.register(reg)`,
  then (when `inner.listStatuses`) re-populate `statusStore` (name/projectIndex looked up from the
  just-hydrated registry). Events are a ring buffer — ephemeral, not hydrated.
- Wiring: in `createRelayServer`, `const store = opts.store ? new WriteThroughStore(opts.store,
  { registry, events, statusStore }) : new MemoryStore({ registry, events, statusStore })`.
  `startRelayServer` (the async one) awaits `store.hydrate?.()` right after the socket bind and
  before returning, so the daemon's loops start against a populated registry.
- Prompts need **no** change: the control box runs `mode: 'host'` + `promptMode: 'block'`, so a
  box's host-action blocks in-process on `PendingPrompts` (`handle.prompts`) and the hub backend
  reads it there — exactly as on localhost. (The store's `createPrompt` mailbox is the poll-mode
  path, unused by the block-mode control box.)

#### Blocker B — retention sweep (answered prompts + finished jobs)

- Two new **optional** `Store` methods: `prunePrompts(beforeIso)` — delete rows that are
  `answered` OR past their `expires_at` and older than `beforeIso`; `pruneCreateJobs(beforeIso)` —
  delete `done`/`failed` jobs whose `finishedAt < beforeIso`. Implemented on `SqliteStore` +
  `PostgresStore` (one drizzle `delete` each); absent on `MemoryStore` (process-lifetime memory —
  nothing to sweep) and `WriteThroughStore` forwards them.
- New `packages/relay/src/retention.ts` — `startRetentionLoop({ store, log, intervalMs })`: an
  hourly tick that calls the two prune methods when present, `beforeIso = now − RETENTION_MS`
  (24 h). Started in `startRelayDaemon` after the other loops; a no-op when the store lacks the
  methods (localhost). Constants (not a config key) for now — internal housekeeping, not a
  user-facing tunable; noted in the Backlog if it needs to become one.

#### 1. Deploy the full hub (Dockerfile + compose + `control-plane-deploy.ts`)

- **`apps/hub/Dockerfile`** — build stage: `pnpm install --frozen-lockfile` → `pnpm turbo run
  build --filter=@agentbox/hub` (builds the workspace-dep `dist/`) → `pnpm --filter @agentbox/hub
  build:standalone` (produces `apps/hub/dist-standalone/apps/hub/server.js`, the same artifact
  `agentbox hub` spawns). Runtime stage keeps the whole built monorepo (`COPY --from=build /repo
  .`) so the standalone's *externals* (`next`, `react`, `pg`, `better-auth`, the cloud SDKs)
  resolve from the workspace `node_modules`, and adds `git` + `openssh-client` (the worker's clone
  step + hetzner box ssh/scp). New `CMD ["node", "apps/hub/dist-standalone/apps/hub/server.js"]`
  — the standalone `server.ts` runs `ensureAuthReady()` itself at boot, so the old
  `db:auth-migrate` CMD step is dropped.
- **`apps/hub/docker-compose.yml`** — rewritten to **app-only** (Postgres + the `db` service
  dropped; unreleased, so no back-compat alias). `app` env: `AGENTBOX_HUB_PROFILE=hetzner`,
  `AGENTBOX_HUB_HOST=0.0.0.0`, `AGENTBOX_HUB_PORT=3000` (Caddy already proxies `app:3000`),
  `AGENTBOX_HUB_WORKER=on`, `HOME=/root`, plus the secret env passed through from the compose
  env-file (`AGENTBOX_RELAY_ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, admin email/password,
  `GITHUB_APP_*`, `AGENTBOX_HUB_ADMIN_CIDR`). `restart: unless-stopped`. A **host bind mount**
  `${AGENTBOX_HUB_DATA_DIR:-/opt/agentbox/hub-data}:/root/.agentbox` is the persistent volume —
  it holds `hub/store.db`, `hub/auth.db`, `hub/custody/…`, `boxes/<id>/ssh/…`, `secrets.env`,
  logs, and (crucially) is a **host path** so the deploy can `scp` provider secrets into it before
  `compose up`.
- **`control-plane-deploy.ts`** — same firewall / cloud-init / Caddy+sslip.io / `deploy.json`
  shape, with: (a) the scp'd `.env` gains the worker/profile/admin-CIDR keys; (b) a new scp of the
  **provider secrets** subset (`HCLOUD_TOKEN`, `E2B_API_KEY`, `DAYTONA_API_KEY`,
  `DAYTONA_ORG_ID`) filtered from the host `~/.agentbox/secrets.env` into
  `<data-dir>/secrets.env` (0600) on the VPS; (c) the deploy detects the **PC egress IP** (reuse
  `detectEgressIp`) and writes it as `AGENTBOX_HUB_ADMIN_CIDR` into the `.env`; (d) `mkdir -p` the
  host data dir before the secrets scp. The app service now needs the data-dir bind, so the
  compose overlay/base is updated accordingly.

#### 2. Resident in-process worker

- **Promote `makeControlPlaneCreateBox`** (pure lease→clone→create orchestration, only imports a
  relay type) from `apps/cli/src/control-plane/create-box.ts` into `@agentbox/relay`
  (`create-worker.ts`), so both the CLI `worker` command *and* the hub can build a `CreateBoxFn`
  from it (an app can't import another app). The CLI command re-imports it from the package.
- **`apps/hub/lib/hub-worker.ts`** (new, Node-only, loaded by `server.ts`): builds the hub's
  `CreateBoxFn` deps — `leaseRemoteUrl` via `GitHubAppLeaser`(`loadGitHubAppConfig()`),
  `cloneRepo` via `git`, and `createBox` via the hub's own provider `IMPORTERS` map (mirrors
  `hub-backend.ts`), calling `provider.create({ workspacePath, name, projectRoot,
  controlPlaneUrl: <hub public URL>, extraInboundCidrs: <admin CIDR>, onLog })`. Around
  `provider.create` it wraps the two custody steps below.
- **`server.ts`**: after `startRelayDaemon`, when `process.env.AGENTBOX_HUB_WORKER === 'on'` and
  the store supports the queue, start an interval loop `drainCreateJobs(store, createBox,
  os.hostname())`. Stopped on shutdown alongside the daemon.
- **Agent-credential seed from custody** (the phase text's "point that path at the custody
  `agents/` scope"): before `provider.create`, a `seedHostBackupsFromCustody()` step reads the
  in-process `FsCustodyStore` `agents/<id>/<credential.boxRelPath>` for each `AGENT_SYNC_SPECS`
  entry and writes it to that spec's `credential.hostBackup` (`~/.agentbox/<id>-credentials.json`)
  — the exact file `provider.create`'s existing seed step reads. So a PC `credentials push`
  (phase 2) is what logs hub-created boxes in, no second code path.
- **SSH-key mirror to custody**: after `provider.create`, copy `~/.agentbox/boxes/<id>/ssh/*`
  into custody `boxes/<id>/ssh/*` (via `FsCustodyStore.put`) so phase 4's `hub pull` can fetch a
  hub-created hetzner box's key.

#### 3. Provider credentials + runtime bits (folded into 1 + 2)

Covered by the secrets scp (item 1c) landing at `<data-dir>/secrets.env` → the container's
`~/.agentbox/secrets.env`, which the provider modules' `ensureCredentials()`/`env-loader` read;
and by `git` + `openssh-client` in the runtime image (item 1). `providerForCreate` is replaced in
the hub by the `IMPORTERS` map it already uses elsewhere.

#### 4. Dual-IP firewall

- Add optional `extraInboundCidrs?: string[]` to the box create options
  (`CreateBoxInput`/whatever `provider.create` accepts) → thread through `CloudProvisionRequest`
  → in `hetznerBackend.provision`, when `req.controlPlaneUrl` is set and the inbound mode isn't
  `open`, append `req.extraInboundCidrs` (normalized) to the computed `sources` before
  `createPerBoxFirewall`. `sshOnlyInboundRule` already accepts multiple `source_ips`, so the VPS
  egress + the admin CIDR land on one `:22` rule. Fail-loud egress detection unchanged. The
  worker (item 2) supplies the admin CIDR from `AGENTBOX_HUB_ADMIN_CIDR`.

#### 5. Enqueue from the PC + shared `/remote/boxes` dispatcher

- **The `/remote/boxes` endpoints live only in `core/handler.ts` (the Vercel plane); the control
  box runs `server.ts`, which 404s `/remote/*`.** So extract a shared
  `handleRemoteBoxesRequest(req, { store, adminToken, createProviders, log })` (mirrors phase 2's
  custody `handleCustodyRequest` shared-dispatcher pattern) and mount it in **both** `server.ts`
  (admin-bearer gated, using `opts.adminToken`) and `core/handler.ts`. Same POST-enqueue /
  GET-status semantics, same `CreateJobRequest` body.
- **`agentbox create --via-hub`**: a new branch in `apps/cli/src/commands/create.ts` that, instead
  of creating locally, resolves `{ url, adminToken }` (same resolver as custody), builds a
  `CreateJobRequest` from the resolved create args (`repoUrl` = the project's git origin,
  `provider`, `branch` = from-branch, `name`, `agent`, `prompt`), `POST`s `/remote/boxes`, then
  polls `GET /remote/boxes/:id` and streams job status until `done`/`failed`. The hub UI create
  modal already enqueues via `enqueueQueueJob`/the backend — no new UI.

#### 6. Deploy ergonomics — `agentbox control-plane deploy hetzner [--ref <ref>]`

- A new `deploy` subcommand that **reuses** the existing `~/.agentbox/control-plane/`
  (`control-plane.env` + `github-app.pem`) without re-running the GitHub-App manifest flow:
  fail with a clear message if `control-plane.env` is absent (run `setup` first); ensure the
  hub-auth block is present (append via `resolveHubAuthEnv()` if missing, same as `setup`); then
  `runHetznerDeploy({ envPath: ENV_PATH, repoRef: ref, log })`. `--ref` (default `main`) pins the
  VPS clone — **the host runs `--ref agentbox/cbx-phase3` for the live verify**.

#### Files

New: `packages/relay/src/store/write-through-store.ts`, `packages/relay/src/retention.ts`,
`packages/relay/src/remote-boxes.ts` (shared dispatcher), `apps/hub/lib/hub-worker.ts`.
Moved: `makeControlPlaneCreateBox` → `packages/relay/src/create-worker.ts`.
Touched: `packages/relay/src/{server,daemon,store/store,store/sqlite-store,store/postgres-store,
core/handler,index,control-plane}.ts`; `packages/sandbox-hetzner/src/{control-plane-deploy,backend}.ts`
+ cloud-provider/core types for `extraInboundCidrs`; `apps/hub/{Dockerfile,docker-compose.yml,
server.ts}`; `apps/cli/src/{commands/create,commands/control-plane,control-plane/create-box}.ts`;
`apps/web/content/docs/{control-plane,hub}.mdx`.

#### Tests (docker-free vitest)

- `write-through-store.test.ts` — the store conformance suite against a `WriteThroughStore` over a
  `:memory:` `SqliteStore`, plus assertions that a `registerBox`/`setStatus` mutation is visible
  on the injected concrete `registry`/`statusStore`, and that `hydrate()` re-populates them.
- Retention: unit-test `prunePrompts`/`pruneCreateJobs` on the SQLite store, and `startRetentionLoop`
  with an injected fake store + clock.
- `remote-boxes` shared dispatcher: 401 without bearer, 400 bad body, 202 enqueue, GET job — over
  both handlers (in-process, injected store), mirroring the custody route tests.
- CLI: a `--via-hub` request-builder unit test (repoUrl/branch/agent mapping), fake-fetch client.

#### In-box docker smoke (manual; not a vitest test)

1. `docker build --network=host -f apps/hub/Dockerfile -t agentbox-hub .` at the repo root
   (validates item 7: the image builds self-contained from the `--ref` checkout).
2. Run the container with `AGENTBOX_HUB_PROFILE=hetzner`, `AGENTBOX_HUB_HOST=0.0.0.0`,
   `AGENTBOX_HUB_PORT=3000`, `AGENTBOX_HUB_WORKER=on`, auth on with a seeded admin, a tmpfs/host
   volume for `/root/.agentbox`, **no `POSTGRES_URL`**, and a **mock/injected `CreateBoxFn`**
   (via an `AGENTBOX_HUB_WORKER_MOCK=1` seam so the box never touches a real cloud). Assert:
   `/healthz` → `db:true`; better-auth signup/login; custody push/pull round-trip over HTTP;
   `POST /remote/boxes` enqueues; the resident worker claims the job and drives the mock to
   `done`; a retention tick removes an aged answered-prompt + finished-job row; `docker restart`
   the container → registry/queue/auth survive on the volume.
3. **Localhost regression**: `AGENTBOX_HUB_PROFILE` unset (`agentbox hub` on MemoryStore) — the hub
   backend still sees status + prompts (the loop/backend routing change is the risk; test both
   profiles).
4. `pnpm test` + `pnpm typecheck` + `pnpm lint` at the repo root, all green.

#### Live hetzner verify — PENDING-HOST

The end-to-end live checklist (real VPS, real e2b + hetzner boxes, phone-UI login/approvals,
`claude -p` usable-box turn, `git ls-remote` push check, reboot persistence, destroy-no-orphans)
runs on the host, since this box can't reach the real clouds from inside. The host runs:
`agentbox control-plane deploy hetzner --ref agentbox/cbx-phase3` (App creds already set up).

### Phase 3 — what actually shipped

Everything above landed as planned. Notes + deviations:

- **Blocker A is a write-through wrapper only around durable stores.** `WriteThroughStore`
  (`packages/relay/src/store/write-through-store.ts`) delegates reads to the inner store and mirrors
  mutations into the concrete `registry`/`events`/`statusStore`; `startRelayServer` calls
  `store.hydrate()` before the daemon loops start. The localhost path never constructs it
  (`opts.store` is undefined → `MemoryStore` verbatim), so it is byte-identical — confirmed by the
  in-box smoke booting the *localhost* logic through the same relay suite (342 relay tests green).
  Prompts needed no change: the control box runs host mode + block-mode prompts, so approvals live in
  the in-process `PendingPrompts` the hub backend already reads.
- **`/remote/boxes` had to become a shared dispatcher** (`packages/relay/src/remote-boxes.ts`),
  because it lived only in `core/handler.ts` (the Vercel plane) and the control box runs `server.ts`,
  which 404s `/remote/*`. Same shape as phase 2's custody dispatcher; mounted in both, admin-bearer
  gated, fail-closed. `core/handler.ts`'s inline handler was replaced by a call to it.
- **`makeControlPlaneCreateBox` moved into `@agentbox/relay`** (`create-worker.ts`) so the hub
  (`apps/hub/lib/hub-worker.ts`) and the CLI `control-plane worker` command share one orchestration;
  the CLI's `control-plane/create-box.ts` is now a thin re-export. The hub worker resolves providers
  via its own `IMPORTERS` map (an app can't import the CLI's provider registry).
- **The worker sets `controlPlaneUrl` on its creates** (so a hub-made box registers on the control
  box and its approvals route to the phone UI). This makes the box **control-plane topology** while
  the workspace is still host-seeded (local clone). That combination is the resident-worker shape;
  the host live-verify should confirm the seeded control-plane box pushes on `agentbox/*` and its
  approvals surface — flagged in the Backlog.
- **Dual-IP firewall rides `providerOptions.extraInboundCidrs`** → gated at the cloud-provider layer
  on `req.controlPlaneUrl` → a new `CloudProvisionRequest.extraInboundCidrs` the hetzner backend
  appends to the firewall `sources`. No new top-level `CreateBoxRequest` field; the admin CIDR is the
  deploying PC's egress (reused from the firewall's own `detectEgressIp`).
- **The deploy keeps provider secrets out of compose env.** They are scp'd from the host
  `~/.agentbox/secrets.env` (only `HCLOUD_TOKEN`/`E2B_API_KEY`/`DAYTONA_*`) into the data volume as
  `~/.agentbox/secrets.env`, which the provider modules load — so they never appear in `docker
  inspect`/compose logs. `AGENTBOX_HUB_PROFILE`/`AGENTBOX_HUB_HOST`/`AGENTBOX_HUB_PORT`/
  `AGENTBOX_HUB_WORKER` are set literally in the compose `environment:`; only the auth secrets +
  data-dir/public-url/admin-CIDR ride the scp'd `.env`.
- **Retention window is constants, not a config key** (24 h keep / hourly sweep) — internal
  housekeeping, not a user-facing tunable. Promote to a `hub.retention*` key if it ever needs tuning
  (Backlog).

**Verification (all green, from inside the box):**

| check | result |
| --- | --- |
| `pnpm test` (repo root, 29 tasks) | relay 342/1skip, cli 845/1skip |
| `pnpm typecheck` (31 tasks) | green |
| `pnpm lint` (17 tasks) | green |
| New unit tests | write-through (13), retention (4), remote-boxes (8), hub-enqueue (5) |
| In-box docker smoke (below) | green |

**In-box docker smoke** (manual; `docker build --network=host -f apps/hub/Dockerfile -t
agentbox-hub .` then a container with `AGENTBOX_HUB_PROFILE=hetzner`, `AGENTBOX_HUB_WORKER=on`,
`AGENTBOX_HUB_WORKER_MOCK=1`, a seeded admin, a host `~/.agentbox` volume, no `POSTGRES_URL`):
`/healthz` → `ok:true` (SQLite, zero Postgres); better-auth admin login `200`; custody PUT/GET
round-trips identical (manifest carries no values); `POST /remote/boxes` enqueues; the resident
worker claims the job and drives the mock `CreateBoxFn` to `done` with a boxId; `docker restart` →
the job row, custody, and better-auth all survive on the volume (`store.db`/`auth.db`/`custody/`
present). Retention correctness is covered by the deterministic `retention.test.ts` (the loop's
24 h/hourly cadence makes an in-container demonstration impractical).

**Localhost regression:** unaffected by construction — `WriteThroughStore` is only built for a durable
`opts.store`, `hydrate()` runs only for it, and `startRetentionLoop` no-ops when the store lacks the
prune methods (MemoryStore). The relay suite exercises the MemoryStore/host-mode path.

## Phase 4 — The PC operates through the control box — DONE (box `cbx-phase4`, 2026-07-15); live-hetzner verify DONE 2026-07-15

- [x] Retarget shared state through the control box's admin API (`/admin/store` shared dispatcher →
  `RemoteStore`; `boxes list`, `prompts list/answer` from the PC); docker boxes stay strictly local
  on the loopback relay.
- [x] `agentbox relay status` + the local hub topbar surface + link the configured control box.
- [x] Custody downloads: `agentbox hub pull <box>` (keys → `~/.agentbox/boxes/<sandboxId>/ssh/`);
  reverse push-up of a PC-created box's key at create.
- [x] Credential/secret flows both directions (`credentials push` / new `credentials pull`;
  `custody rm`).
- [x] Backlog for this phase: `listStatuses()` promoted to `Store`; a reap verb
  (`DELETE /remote/boxes/:id` + `control-plane boxes rm` + hub-UI Destroy fallback) with custody
  `boxes/<id>` cleanup; `hostMainRepo` guard (reject) for worker-created boxes.
- [x] Approvals raised by any control-plane box are answerable from the PC CLI (verified in the
  local smoke).
- [x] **Live hetzner verify — DONE (host, 2026-07-15).** Against the live control box
  (`https://178.104.43.192.sslip.io`, full hub on SQLite): logged into the web UI over HTTPS,
  **created a box from the hub web interface** (added a project, Create box → E2B → the queue
  worker provisioned a real E2B sandbox that ran a logged-in `claude -p` turn), and it registered
  in the hub's own store (`/healthz boxes:1`) and listed from the PC (`control-plane boxes list`).
  **Host-off push proven airtight**: with the PC relay hard-killed (nothing on `127.0.0.1:8787`,
  confirmed before and after), a control-box-created E2B box committed and `agentbox-ctl git
  push`ed twice — the `agentbox/hostoff-box` branch advanced on GitHub (`72647f3 → 2cf5a53`,
  `git ls-remote`) via a token leased from the control box, not the laptop. `boxes rm` reaped
  stale registrations from the hub + custody.
  - **One gap found and recorded, not fixed this session:** the **web-UI/queue** create path does
    not wire control-plane git leasing, so a *web-created* box's own push fails credential-less
    (the **resident-worker `--via-hub`** path does wire it — that is the box used for the host-off
    push proof). See the first Backlog item under "final verify, live". Attach-after-`hub pull`
    to a hetzner box and the phone-browser approval were exercised in the phase-4 two-process
    smoke; a full hetzner-box adoption still needs the deferred local-record item.

**Live verify surfaced two more fixes** (PRs into `feat/control-box-plan`), both on the
control-box-only path the in-box smokes can't reach:

5. **#225** — the control-box image never built `apps/cli` and set no `AGENTBOX_CLI_ENTRY`, so the
   hub queue (web-UI creates, queued runs, host-app launchers) could not spawn a worker
   (`cannot spawn queue worker`). Image now builds the CLI + sets the entry, and compose mounts a
   persistent `/root/projects` volume for real project checkouts.
6. **#226** — the hub container listened on `:3000` while every CLI relay client is hardwired to
   `127.0.0.1:8787`, so an in-container queue worker forked a *second* relay that owned the new
   box invisibly to the hub store. Container now runs on `8787` end to end (compose, Caddy
   upstream, `EXPOSE`), so in-container spawns discover and reuse the hub's own relay — the fix
   that made the web-created box show up in the hub store.

Result + deviations recorded under [what actually shipped](#phase-4--what-actually-shipped); open
items went to the [Backlog](#backlog).

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

### Phase 4 — implementation plan (box cbx-phase4)

This plan resolves the design questions the phase text left open. Guiding constraint: **the PC
reaches control-plane state through the control box's admin API; the laptop loopback relay and
its docker boxes are never retargeted.** A blanket swap of the laptop relay's `Store` for a
`RemoteStore` was rejected — every docker box registers on the loopback relay via
`/admin/register-box`, so backing that relay with a remote store would ship docker registrations
to the control box, violating "docker topology is never a control-plane target". Instead the
retarget is **CLI-side and read-through the admin API**; the daemon stays on `MemoryStore`.

**Why this is already mostly correct for autopause/queue (deviation from "move it to the hub").**
A PC-created cloud box *with a control plane configured* is `control-plane` topology and registers
directly on the control box (`plane-register.ts`), never on the laptop loopback relay. So the
laptop's `startAutopauseLoop` (docker-only) and `startCloudKeepaliveLoop` (iterates the *local*
registry) already never touch control-plane boxes — there is nothing to move off the laptop. The
control box runs the queue loop + cloud-keepalive **in-process** already (phase 3's resident
daemon). The remaining laptop wiring that made sense was: (a) surfacing the control box in
`relay status` + the local hub UI, (b) a PC admin path to list/reap/answer control-plane boxes,
(c) the create queue is already retargeted (`create --via-hub`). Recorded, not re-plumbed.

**1. `listStatuses()` promoted to `Store`** (backlog). Add
`listStatuses(): Promise<Array<{ boxId; status }>>` to the interface; `MemoryStore` gains it via a
new `BoxStatusStore.list()`, `RemoteStore` via the RPC, `WriteThroughStore` forwards (it already
declared it optional), the durable stores already implement it. `store-rpc` allow-list +
`applyStoreOp` gain it; `apps/hub/lib/boxes/postgres-source.ts` is retyped to `Store`.

**2. `/admin/store` mounted in `server.ts`** (shared dispatcher). Today `/admin/store` (the
`RemoteStore` RPC envelope) exists **only** in `core/handler.ts` (the Vercel plane); the control
box runs `server.ts`, which 404s it — so `RemoteStore` was dead against the real control box.
Extract `handleStoreRpcRequest(req, { store, adminToken, log })` (mirrors the custody / remote-boxes
shared-dispatcher pattern), mount it in `server.ts` (admin-bearer gated, before the loopback
rejection) and replace `core/handler.ts`'s inline block with a call to it. The PC's admin client
then uses `RemoteStore` for cross-machine reads (list boxes, statuses).

**3. `BoxRegistration.sandboxId`** (new optional field). The registration never carried the cloud
sandbox id, but `hub pull` needs box → sandboxId to write keys into the on-disk `~/.agentbox/boxes/
<sandboxId>/ssh/` dir that attach reads, and a reap needs it to clean custody. Thread it through
`RegisterBoxBody` → `plane-register.ts` payload → the cloud provider create/resume registration.

**4. `DELETE /remote/boxes/:boxId` — the reap** (backlog: destroy verb + reap dead registrations).
Add a DELETE branch to the shared `remote-boxes` dispatcher: `store.forgetBox(boxId)` +
`store.deleteStatus(boxId)` + custody cleanup of `boxes/<sandboxId|boxId>/` (list-then-delete over
the existing custody `list`/`delete`, so no new store method). `RemoteBoxesDeps` gains an optional
`custody`. This is **control-box state** teardown (registration + status + SSH-key custody), not the
cloud resource. Full cloud teardown (`provider.destroy`) of a *worker-created* box needs the
sandboxId + provider creds VPS-side and a reconstructed `BoxRecord`; the hub backend does it when it
can (sandboxId + importable provider), else reaps state only — the cloud-resource GC of orphaned
worker boxes stays a backlog follow-up (the worker mints them, the control box doesn't persist a
full `BoxRecord`). The PC drives the reap via `control-plane boxes rm`; the hub UI's existing
Destroy button reaps a Store-registered box the same way.

**5. SSH-key custody, both directions.**
- **Fix `mirrorBoxSshToCustody`** (phase-3 backlog bug): it read `defaultBoxSshDir(sandboxId,
  provider)`, but hetzner stores keys **un-namespaced** at `~/.agentbox/boxes/<sandboxId>/ssh/`, so
  the namespaced lookup found nothing and nothing landed in custody. Use the provider's real ssh dir
  (un-namespaced for hetzner, `'digitalocean'` for DO) and key custody by **sandboxId** (fallback
  boxId) so `hub pull` finds it under the same id it writes on disk.
- **PC → control box (reverse).** A PC-created control-plane cloud box already registers on the
  plane; at create time, when a key was minted (hetzner/DO) and a control plane + admin token are
  configured, push `boxes/<sandboxId>/ssh/*` to custody (`pushBoxSshToCustody`, a small fetch client
  in `sandbox-cloud`), so the hub/mobile can also reach it.

**6. `agentbox hub pull <box>`** (spelling chosen; `control-plane custody pull boxes/<id>` remains
the low-level path). Resolve `{url, adminToken}`, fetch the registration (RemoteStore.getBox →
`sandboxId`), download custody `boxes/<sandboxId|boxId>/ssh/*` into `~/.agentbox/boxes/
<sandboxId|boxId>/ssh/` (0700 dir / 0600 files) so attach / cp / port-forward work. Full box
adoption (writing a local `state.json` record with the VPS IP so `agentbox attach <name>` resolves)
needs richer registration data than exists today and a live box; the SSH-key download is what the
mandatory scope names and what the host verifies live. Deferred adoption noted in the Backlog.

**7. Approvals from the PC CLI** (block-mode). The control box runs host + block-mode prompts, so a
box's approval parks in the in-process `PendingPrompts`, surfaced over `GET /admin/prompts` and
answered via `POST /admin/prompts/answer` — both now reachable non-loopback with the admin bearer
(fix #220's gate). New `control-plane prompts list` / `prompts answer <id> [y|n]` post there. The
existing `agent approve` stays laptop-loopback-only (docker/local boxes).

**8. Credential pull-back** (phase 4 §3, control box → PC). `control-plane credentials pull` is the
reverse of phase 2's `credentials push`: download custody `agents/*` and write each into the host's
`~/.agentbox/<id>-credentials.json` backup (0600), so `extractAgentCredentials` output that landed in
custody flows back to the PC. `custody rm <path>` closes the phase-2 "no custody delete CLI" gap.

**9. `hostMainRepo` guard** (backlog, "reject" option chosen over "rewrite on adoption" — smaller,
fail-closed, no silent wrong-repo pushes). `handleGitRpc` rejects a host-side git RPC when the
resolved worktree's `hostMainRepo` is empty or its directory is gone, with a clear error naming the
worker-created-box case, instead of letting `git -C <deleted-tmp>` fail cryptically.

**10. Surface the control box.** `agentbox relay status` gains a `control plane:` section (URL +
`/healthz` reachability + box/event counts) reusing the `control-plane status` probe. The local hub
exposes the configured `relay.controlPlaneUrl` on its dashboard state (`controlPlane.url`) and the
header links to it — a pure read of effective config, no new write surface (hub-web-pure-REST).

**Files.** New: `packages/relay/src/store/store-rpc-routes.ts` (shared `/admin/store` dispatcher),
`apps/cli/src/control-plane/admin-client.ts` (RemoteStore + prompt/box admin fetches over the
resolved target), `apps/cli/src/commands/_hub-pull.ts` (or folded into `hub.ts`).
Touched: `packages/relay/src/{server,core/handler,remote-boxes,status-store}.ts`,
`packages/relay/src/store/{store,memory-store,remote-store,write-through-store,store-rpc,index}.ts`,
`packages/relay/src/types.ts` (+ `sandboxId`), `packages/sandbox-cloud/src/{plane-register,
cloud-provider}.ts`, `apps/hub/lib/{hub-worker,hub-backend,boxes/postgres-source,boxes/source}.ts`
+ hub UI header, `apps/cli/src/commands/{control-plane,hub,relay,credentials}.ts`,
`apps/web/content/docs/{control-plane,hub}.mdx`, `docs/host-relay.md`.

**Tests (docker-free vitest, temp HOME):** `listStatuses` on the conformance suite + MemoryStore;
`store-rpc-routes` (401/503/dispatch) over both handlers; `remote-boxes` DELETE reap (forget +
deleteStatus + custody purge, 401/404); custody prefix cleanup; the `hostMainRepo` guard; CLI
admin-client + `hub pull` planner (fake-fetch, temp HOME). Plus the local two-process smoke below.

### Phase 4 — what actually shipped

Everything above landed as planned. Notes + deviations:

- **The retarget is CLI-side over the admin API, not a daemon store-swap.** The laptop relay
  stays on `MemoryStore` (docker + loopback unchanged); the PC reaches control-plane boxes/status/
  prompts through the control box's admin API. To make that real, `/admin/store` is now a shared
  dispatcher (`store/store-rpc-routes.ts`) mounted in **both** `server.ts` and `core/handler.ts`,
  so `RemoteStore` works against the control box (it was dead against it before — the route lived
  only on the Vercel plane). New CLI: `control-plane boxes list|rm`, `prompts list|answer`,
  `credentials pull`, `custody rm`, and `hub pull`. `agentbox relay status` gained a `control box:`
  section (URL + `/healthz` reachability); the local hub topbar links to the configured control box
  (`HubState.controlPlane`, read from `relay.controlPlaneUrl`; null on the control box itself).
- **`listStatuses()` promoted to `Store`** (backlog) — `MemoryStore` (new `BoxStatusStore.list()`),
  `RemoteStore` (RPC), `WriteThroughStore` (forward), plus the store-rpc allow-list. Covered by a
  new conformance-suite case that runs across every backend.
- **`BoxRegistration.sandboxId`** carries the provider sandbox id through `plane-register` →
  create/resume, so `hub pull` writes keys to the on-disk `~/.agentbox/boxes/<sandboxId>/ssh/`
  attach reads, and a reap can find the box's custody subtree.
- **The reap is a `DELETE /remote/boxes/:boxId`** shared-dispatcher branch (forget + deleteStatus +
  custody `boxes/<sandboxId|boxId>/` cleanup). The PC drives it via `control-plane boxes rm`; the
  hub UI's Destroy button reaps a Store-only box the same way (`hub-backend.destroy` falls back to a
  reap when the box isn't in host `readState()`). **Deviation:** the reap tears down control-box
  *state*, not the cloud resource — a worker-created box has no full `BoxRecord` on the control box
  (its seed clone was deleted), so provider-side teardown of an orphaned worker box stays a backlog
  follow-up (needs sandboxId + a reconstructed record + provider creds).
- **Fixed the phase-3 SSH-mirror namespace bug** and centralized the per-provider ssh-dir rule in
  `boxSshDirForProvider` (`sandbox-core`), shared by the hub-worker mirror, the PC push-up, and
  `hub pull`, so the namespace mismatch can't recur. The mirror + `hub pull` are now keyed by
  sandboxId. **PC → control box (reverse custody)**: a PC-created control-plane cloud box pushes its
  minted SSH key to custody at create (`pushBoxSshToCustody`, no-op for e2b/vercel).
- **`hostMainRepo` guard: "reject" chosen over "rewrite on adoption"** (`hostRepoUnavailableReason`
  in `worktree.ts`) — a host-side `git.push`/`git.fetch` against a worktree whose `hostMainRepo` is
  empty or gone returns a clear error naming the worker-created-box case, instead of a cryptic
  `git -C <deleted-tmp>` failure. Full box adoption (rewriting `hostMainRepo` on PC clone) is
  deferred to the Backlog — it needs richer registration data than exists today.
- **`hub pull` downloads keys but does not yet write a full local `state.json` record** (adoption).
  The mandatory scope names the SSH-key download; `attach <name>` resolving a hub-created hetzner
  box also needs its VPS IP, which the registration doesn't carry today. Deferred to the Backlog;
  the host live-verify exercises the download + a manual attach.

**Verification (all green, from inside the box):**

| check | result |
| --- | --- |
| `pnpm test` (repo root) | relay 375, sandbox-cloud + cli suites incl. new files, all green |
| `pnpm typecheck` | green |
| `pnpm lint` | green |
| New unit tests | store-rpc-routes (8), remote-boxes DELETE reap (3), worktree guard (4), listStatuses conformance (across backends), custody-ssh (2), hub-pull (3), admin-client (3) |
| Local two-process smoke (below) | 8/8 |

**Local smoke** (script kept out of the repo — it boots a real relay process). It boots the control
box's relay+worker core (a hetzner-profile hub minus the Next UI: `startRelayDaemon` with a
`SqliteStore` + `FsCustodyStore` + admin bearer, block-mode prompts) on `127.0.0.1:8799`, then
drives it with the **built CLI as the PC** (`AGENTBOX_RELAY_ADMIN_TOKEN=<admin> node
apps/cli/dist/index.js <cmd> --url http://127.0.0.1:8799`). The walk (all 8 green):

1. `POST /remote/boxes` enqueues a create job (the `create --via-hub` surface).
2. the mock worker (`drainCreateJobs` with a stub `CreateBoxFn`) drives the job to `done`.
3. the created box registers on the control box (`POST /admin/register-box`, cloud/hetzner, with
   `sandboxId`).
4. **PC** `control-plane boxes list` shows it (through `RemoteStore.listBoxes` + `listStatuses`).
5. a `boxes/<sandboxId>/ssh/id_ed25519` is seeded into custody; **PC** `hub pull brave-otter`
   downloads it to `~/.agentbox/boxes/<sandboxId>/ssh/` (0600).
6. the box raises an approval (`/rpc git.lease-token` on a non-scratch branch, block-mode);
   **PC** `control-plane prompts list` shows it.
7. **PC** `control-plane prompts answer <id> y` resolves it (the parked `/rpc` unwinds).
8. **PC** `control-plane boxes rm brave-otter` reaps registration + status + custody
   (`DELETE /remote/boxes/:id`); the store + custody are empty afterward.

---

## Cross-phase notes

- **Docs in sync every phase** (project rule): the public guide
  `apps/web/content/docs/deployed-hub.mdx`, `docs/host-relay.md`, `docs/cloud-providers.md`, and
  this file's checkboxes/status.
- The M1 **rename to `hub`** (CLI verbs, `relay.controlPlaneUrl` key) is *not* one of these
  phases; do it after phase 3 when the surface is proven, as its own clean rename (unreleased —
  no aliases).
- `pnpm typecheck` before every push; relay conformance suites are the regression net for
  phases 1–2; live cloud verification (usable-box bar: a real `claude -p` turn + ls-remote-checked
  push) for phases 3–4.

---

## Backlog

Findings and follow-ups discovered while implementing, kept out of the phase they were found in.

- **(phase 3) A hub-created box is control-plane topology but host-seeded (local clone).** The
  resident worker sets `controlPlaneUrl` (so the box registers on the control box) yet hands
  `provider.create` a locally-cloned workspace rather than `inBoxClone`. That mix is untested against
  a real cloud from inside a box — the host live-verify must confirm a seeded control-plane box
  completes a `claude -p` turn and pushes on `agentbox/*` (ls-remote). If it misbehaves, switch the
  worker to `inBoxClone` (leased URL) for control-plane creates.
- **(phase 3) SSH-key mirror to custody is best-effort + hetzner/DO-only.** `mirrorBoxSshToCustody`
  reads `defaultBoxSshDir(sandboxId, provider)` after create; e2b/vercel mint no keypair (no-op). Not
  exercised by the mock smoke — verify on the host that a hub-created hetzner box's keys land in
  custody `boxes/<id>/ssh/` (phase 4's `hub pull` depends on it). No destroy-time custody GC yet
  (compounds the phase-2 `custody rm` gap).
- **(phase 3) Retention window is hard-coded** (24 h keep, hourly sweep). Promote to a
  `hub.retentionHours` config key if tuning is ever wanted; today it's internal housekeeping.
- **(phase 3) Worker seeds host credential-backup files, not a per-box isolate.**
  `seedHostBackupsFromCustody` writes `~/.agentbox/<id>-credentials.json` on the VPS before each
  create, so concurrent creates share one backup set. Fine for the single-writer control box; revisit
  if the worker ever runs creates in parallel.
- **(phase 3) The hub runtime image is the whole built monorepo (~2 GB).** The standalone bundle
  ships no node_modules, so the image keeps `/repo` for the externals (next/react/pg/SDKs) to resolve
  from. Correct but unoptimized; a traced prod-deps prune would shrink it if VPS disk matters.
- **~~The daemon's background loops and the hub backend still read in-memory state, not the `Store`
  (phase 3 blocker).~~ DONE (phase 3)** — `WriteThroughStore` mirrors a durable store's writes into
  the in-memory `registry`/`events`/`statusStore` and hydrates them on boot, so the loops + hub
  backend see state on a hetzner+SQLite hub. localhost is unchanged (the wrapper is only built for a
  durable `opts.store`).
- **~~Prompt and create-job rows are never deleted.~~ DONE (phase 3)** — optional
  `Store.prunePrompts`/`pruneCreateJobs` (SQLite+Postgres, using `expires_at`/`finishedAt`) swept by
  `startRetentionLoop` in the daemon.
- **~~`listStatuses()` is off-interface.~~ DONE (phase 4)** — promoted to `Store`; `MemoryStore`
  (via `BoxStatusStore.list()`), `RemoteStore` (RPC), and `WriteThroughStore` (forward) now
  implement it, and the store-conformance suite covers it across every backend.
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
- **(phase 2) Custody push is opportunistic, not on the `agentbox <agent> login` path directly.**
  The plan text said "wire push to run after `agentbox <agent> login` refreshes a credential." The
  clean seam turned out to be `agentbox credentials propagate` (the relay's `CredentialsFanout`
  chokepoint) rather than each login command, so a custody push rides every refresh that reaches
  propagate — but a *first* login that only writes the host backup and never triggers propagate
  (no other boxes to fan out to) will not push to custody until the next `credentials push` or the
  next propagate. Phase 3/4: consider a direct hook in the login flow (or have `create --via-hub`
  pull-through) if this proves surprising in practice.
- **(phase 2) No `custody delete` / prune CLI.** The store + endpoint support `DELETE`, but no CLI
  verb removes an entry or garbage-collects `boxes/<id>/…` when a box is destroyed. On an always-on
  control box, destroyed-box SSH material accumulates. Add a `custody rm` + a destroy-time sweep
  when phase 3's worker mints box keys into custody.
- **(phase 2) Custody payloads are capped at the relay's 1 MiB body limit.** Credentials / `.env` /
  SSH keys are all kilobytes, so this is not a constraint today, but a directory-tar scope (the
  plan floated "tar for directory sets") would need chunking or a raised cap. The current surface
  is one-file-per-PUT only; there is no tar path.
- **(phase 2) `secrets push` with no args only picks up `./.env`.** It does not glob `.env*`
  (`.env.local`, `.env.production`) — the plan mentioned "`.env*` the user opts in," but implicit
  globbing risks pushing a secret the user didn't mean to. Explicit file args cover the rest;
  revisit if an opt-in glob is wanted.
- **(phase 2) Custody is unencrypted at rest** (plan already lists encrypted-at-rest as out of
  scope). The bytes sit `0600` under `~/.agentbox/hub/custody/` on the VPS. The blob-backend swap
  (S3/R2) the seam is shaped for is where envelope encryption would slot in.
- **(phase 3, live) The deploy does not ship prepared-state records.** The worker needs
  `~/.agentbox/e2b-prepared.json` (and `hetzner-prepared.json`) VPS-side to create boxes on a
  prepared provider; the live verify scp'd them into the hub data dir by hand. Teach
  `control-plane deploy` (or a `custody`/`hub push` scope) to ship `*-prepared.json` alongside
  `secrets.env`, and re-sync after a host-side `agentbox prepare`.
- **(phase 3, live) Dead-box registrations are never reaped on the hub. PARTIAL (phase 4).** A
  reap verb now exists — `DELETE /remote/boxes/:id` (→ `control-plane boxes rm`, and the hub-UI
  Destroy button for a Store-only box) removes the registration + status + custody
  `boxes/<sandboxId>/`. Still open: (a) **tearing down the cloud resource** of a worker-created box
  from the hub — the control box holds only a `BoxRegistration` (+ `sandboxId`), not a full
  `BoxRecord`, so `provider.destroy` can't be driven without reconstructing one; (b) an automatic
  **liveness sweep** that reaps registrations whose provider sandbox is already gone (the reap today
  is operator-driven).
- **~~(phase 3, live) `hostMainRepo` of a worker-created box points at a deleted temp clone.~~
  DONE (phase 4, "reject" option).** `handleGitRpc` now rejects a host-side `git.push`/`git.fetch`
  against a worktree whose `hostMainRepo` is empty or missing with a clear error
  (`hostRepoUnavailableReason`), instead of a cryptic `git -C <deleted-tmp>` failure. The
  alternative ("rewrite `hostMainRepo` on PC adoption") is folded into the box-adoption backlog item
  below.
- **(phase 3, live) `control-plane deploy` requires a TTY** (clack prompts for the hub admin
  email/password). Fine interactively; a `--admin-email/--admin-password(-file)` non-interactive
  path would let CI / scripts deploy.
- **(phase 3, live) ctl fixes need re-bakes to reach boxes.** `leaseAndPush` (#222) is baked into
  every provider base image/template/snapshot; the e2b template was re-prepared during the live
  verify, but the **hetzner base snapshot and any other provider bakes still ship the broken
  lease push** until their next `agentbox prepare`. Re-prepare hetzner before relying on leased
  pushes from hetzner boxes (tracked for the phase-4 hetzner-provider verify).
- **(phase 4) Local-adoption gap — a control-box-created box is not operable from the PC by name.**
  This is the single biggest asymmetry between the two creation origins, so the full detail:
  - **Root cause.** A box created by the control box (web-UI create or `--via-hub`) lives in the
    control box's Store; the PC never writes a local `state.json` `BoxRecord` for it. `hub pull`
    downloads only the SSH-key material to `~/.agentbox/boxes/<sandboxId>/ssh/` — no record.
  - **`agentbox ls` / `list` does not show it.** `list.ts` reads local state via
    `listBoxes()` (`@agentbox/sandbox-docker`) and has only `--global` (all local *projects*) — no
    control-plane source. So a hub-created box is invisible to `agentbox ls` even with `--global`.
    The only PC-side view is the explicit `agentbox control-plane boxes list` (queries the control
    box Store over HTTPS).
  - **All the direct PC↔box commands miss too, not just attach.** `attach`, `cp`, `download`, `url`,
    and `screen` each resolve the target from local state (`resolveBoxOrExit` → `readState`) and then
    call the provider directly — none are proxied through the control box. With no local record,
    `agentbox <cmd> <name>` can't resolve a hub-created box at all.
  - **Reachability, by provider** (what adoption must also satisfy, beyond the record):
    - **hetzner / DigitalOcean (SSH):** need the per-box key (via `hub pull`) **and the box's VPS
      IP/host**, which the `BoxRegistration` does not carry today. The dual-IP firewall already
      admits the PC's egress, so once the record + IP exist, direct SSH works.
    - **e2b / vercel (SDK):** no per-box key — reached via the provider SDK + your API key (which the
      PC has if the provider is configured). `url` is a **public HTTPS domain** shown in the web UI,
      so it already works from anywhere; `attach`/`cp`/`download` still need a local record to know
      the provider + sandbox id.
    - **daytona:** SDK + bridge; same record requirement.
  - **The fix.** Make `hub pull` (or a dedicated `agentbox hub adopt <box>`) write a local
    `state.json` `BoxRecord` reconstructed from the control box's registration — provider, sandbox
    id, VPS public IP/host, key path, origin/branch — so the box shows in `agentbox ls` and resolves
    for `attach`/`cp`/`download`/`url`/`screen` exactly like a PC-created box. This needs the
    registration **enriched** first (add public IP/host — `sandboxId` is already there), and it folds
    in the deferred `hostMainRepo`-rewrite-on-PC-clone half of the `hostMainRepo` guard item, and it
    unblocks cloud-resource teardown from the PC (the reap item below). Until then, the control box's
    **web UI** is where a hub-created box is fully operable; from the PC you can `control-plane boxes
    list` to see it, `hub pull` the key, and open the public preview `url` (e2b/vercel), but not
    drive it by name.
- **(phase 4) Cloud-resource teardown of a worker-created box from the hub.** `control-plane boxes
  rm` / the hub Destroy button reap control-box *state* only; the actual sandbox is left running
  because the control box has no full `BoxRecord` to drive `provider.destroy`. Persist enough on the
  registration (sandboxId is there now; add region/host as needed) and reconstruct a minimal record,
  or run the destroy from a host that owns the box. Pairs with the liveness-sweep item above.
- **(phase 4) Autopause/queue for cloud boxes was already resident, not "moved".** The plan text
  framed phase 4 as moving autopause/queue for cloud boxes to the hub. In practice the control box's
  resident daemon (phase 3) already runs the queue + cloud-keepalive in-process, and the laptop's
  loops never see control-plane boxes (they register on the control box, not the loopback relay), so
  nothing needed relocating. If a laptop ever *does* hold a control-plane box locally (independent
  boxes), revisit whether its loops should defer to the hub.
- **(phase 4) `secrets pull` (control box → PC) not implemented.** `credentials pull` brings agent
  creds back; project secrets edited via the hub are not yet pullable to the PC (the plan lists it
  under "Control box → PC"). Add a `secrets pull [--project]` mirroring `credentials pull` when the
  hub grows secret editing.
- **(final verify, live) The web-UI / queue create path does not wire control-plane git leasing.**
  A box created from the hub web interface (or any queue job — `enqueueQueueJob` →
  `provider.create()`) on the control box does NOT get `AGENTBOX_GIT_LEASE=1` /
  `AGENTBOX_CONTROL_PLANE_URL` in its box.env, even though the container's config has
  `relay.controlPlaneUrl` set — so its `agentbox-ctl git push` falls through to a bare
  credential-less `git push` and fails (`could not read Username for github.com`). The
  **resident-worker path** (`create --via-hub` → `registerBoxWithPlane` + lease wiring) is
  correct and was verified host-off (branch advanced on GitHub with the PC relay hard-killed).
  Fix: thread `controlPlaneUrl` (→ `resolveSyncTopology` = control-plane, `AGENTBOX_GIT_LEASE`)
  through the hub's `enqueueQueueJob`/`_run-queued-job` create path when the hub is itself a
  control box, so web-UI-created boxes push with the PC off exactly like `--via-hub` ones.
- **(final verify, live) Queue jobs marked `running` are not reaped after a container restart.**
  When the hub container is recreated (image update), in-flight queue rows stay `running` with
  dead PIDs and block new workers (`running N/N`), and a freshly `queued` web-UI create never
  drains until the heartbeat reaper (or a manual `_run-queued-job`) clears them. The resident
  create-job queue got a retention sweep in phase 3; the **CLI job queue** needs the same
  restart-time dead-worker reap on the control box (the `#202` reaper exists but did not fire
  quickly enough here).
- **(final verify, live) `/api/v1/boxes` (hub UI) and the store box count diverge.** After a
  restart the UI listed boxes (synthetic `creating` + stale) while `/healthz` `boxes` (the store)
  read 0, because a queue-created box registered on a *second* in-container relay before the
  8787 port fix. With the port fix the registration lands in the hub's own store, but the UI box
  source still merges synthetic/creating entries that can outlive their jobs — reconcile the UI
  list against the store + a liveness check (ties to the dead-box-reap item).
- **(final verify, live) `control-plane deploy` does not ship `*-prepared.json` or clone a
  project.** Confirmed end to end: the live run had to scp `e2b-prepared.json` /
  `hetzner-prepared.json` into the hub data dir and `git clone` a project into the persistent
  `/root/projects` volume by hand before the web UI could create a box. Fold both into the deploy
  (ship prepared-state as a custody scope; offer to clone the current repo on the VPS).
