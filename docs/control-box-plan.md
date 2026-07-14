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
