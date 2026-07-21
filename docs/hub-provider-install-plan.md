# Install providers & bake images from the Hub (API-first)

## Context

Box **creation** is already self-serve from the hub: `POST /api/v1/boxes` → a file-queue job
→ a detached CLI worker (`_run-queued-job`) → `createBox()`, streamed to the UI over an SSE
job-log channel. Both the web UI and the tray already render a provider picker fed by
`GET /api/v1/providers` (`{ id, label, configured, reason }`), but that list is **read-only**:
unconfigured cloud providers are shown disabled, and `reason` literally tells the user to open a
terminal and run `agentbox <p> login` then `agentbox prepare --provider <p>`.

We want to remove that terminal round-trip: let users **set a provider's credentials and bake its
base image** directly from the hub, the same way they create boxes. This doc gives the
**dependency / blocker matrix** first (the crux — e.g. the "Vercel needs the Vercel CLI" concern),
then the implementation plan.

> **Update (2026-07):** `?freshness=1` now reports **real docker freshness** too
> (`evaluateDockerBaseFreshness` in `@agentbox/sandbox-docker` — a read-only mirror of
> `ensureImage`'s rebuild predicate; docker stays `configured: true`). The tray and the web
> create modal consume it for a **two-phase create**: an `unprepared`/`stale` base runs the
> prepare job first ("Building base image…", streamed) and chains into the create on
> `end: done`; a stale *cloud* base asks Rebuild vs Use-Existing (mirrors the CLI wizard).

**Decisions taken (user):**
- Full scope = credential **login** *and* image **bake**; **all five** providers.
- **All credentials are plain API-key / token fields** — a uniform "paste your key(s)" form per
  provider. We do **not** implement vercel's interactive browser-login mode; vercel uses its token
  fields like everyone else.
- **API-only. The web layer does no work.** Every operation is a REST endpoint under `/api/v1/**`;
  the hub web UI is a **pure HTTP client** (`fetch('/api/v1/...')`, like the existing `LoginBanner`
  and the git/services read panels), **not** a Next `'use server'` action reaching
  `globalThis.__AGENTBOX_HUB_BACKEND`. This is deliberate: it keeps the frontend detachable so the
  hub/control-plane can run **remotely** with no code change. Tray reuses the same REST API later.
- **Bake progress streams live**, exactly like create-box's job-log SSE.

---

## Part A — Dependency & blocker analysis

"Installing a provider" is two operations with very different profiles: **credential-set** (fast,
synchronous) and **bake/prepare** (long-running, needs a job + streaming).

### A1. Credential-set — the current blocker is the TTY gate, not the shape

Every provider credential is just key/token fields written to `~/.agentbox/secrets.env` (0600).
There is **no browser/PKCE round-trip** for any cloud provider (unlike Claude login), so
credential-set can be a **synchronous POST** that validates then writes — no worker, no job.

Current blocker: each `ensure*Credentials()` is `@clack/prompts`-interactive and **early-returns
on `!process.stdin.isTTY`**, and the `secrets.env` writer (`writeManaged`/`MANAGED_KEYS`) is a
**private, per-provider-duplicated** function. So credentials cannot be set headlessly today.

| Provider | Env keys (secrets.env) | Validation call | Writer today |
|---|---|---|---|
| docker | none | — | — |
| e2b | `E2B_API_KEY` | presence (`hasUsableCredentials`) | private `writeManaged` (`credentials.ts`) |
| daytona | `DAYTONA_API_KEY` (± `DAYTONA_ORGANIZATION_ID`) | `new Daytona().list()` | private `persistCredentials` |
| hetzner | `HCLOUD_TOKEN` (± `HCLOUD_ENDPOINT`) | `client.listLocations()` | private `persistCredentials` |
| vercel | `VERCEL_TOKEN` (± `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`) | `getUser(token)` (token mode) | private `writeManaged` |

- **B4 (headless credential setter):** add, per provider, a non-interactive `setCredentials(fields)`
  that **validates** (reuse each `validateCredentials`) then writes via a **shared**
  `writeManagedSecrets(keys, record)` extracted into `@agentbox/sandbox-core` (dedupes the 4
  private copies). Expose it through a new optional `setCredentials?` slot on the
  `ProviderModule` interface (`packages/sandbox-core/src/doctor.ts`, next to the existing
  `ensureCredentials?`/`readCredStatus?`), which the hub backend already resolves via its
  `IMPORTERS` map (`hub-backend.ts:72`).
- **B5 (secrets over HTTP):** the form POSTs live cloud tokens to the hub. Gated by the hub
  bearer/session, but powerful. Mitigations: **host-topology only** (never the shared Postgres
  plane); never echo values back (status returns only `hasCredentials` + a masked hint); write
  0600; keep out of logs and out of any job manifest; loopback origin (`credentials:'same-origin'`).

### A2. Bake / `prepare` — headless-capable, but `runPrepare` is unusable as-is

`provider.prepare(opts)` already takes an **`onLog(line)` sink** (`PrepareOptions`, core provider.ts)
and returns `{ snapshotName? }` — the clean streaming + result hook. But the CLI's
`runPrepare()` wrapper is **hostile to a REST caller**: it `process.exit(1)` on errors, prints a
TTY-gated Daytona cost notice, **swallows `onLog` into a clack spinner** (`sp.message`), and
discards `snapshotName`. So the worker must call **`provider.prepare({ onLog })` directly**, not
`runPrepare`, then pin the result itself (via `@agentbox/config`) and write prepared-state.

**What each bake needs at bake time** (the real dependency matrix; corrects the "Vercel needs the
Vercel CLI" premise):

| Provider | Build location | Host binary required | Cloud token | prepared-state |
|---|---|---|---|---|
| **docker** | **local** BuildKit build/pull of `agentbox/box:dev` | **`docker` daemon + CLI** | none | `docker-prepared.json` |
| **daytona** | **server-side SDK** (`snapshot.create({image},{onLogs})`) | **none** | `DAYTONA_API_KEY` | `daytona-prepared.json` |
| **e2b** | **server-side SDK** (`Template.build(…,{onBuildLogs})`) | **none** | `E2B_API_KEY` | `e2b-prepared.json` |
| **vercel** | **server-side SDK** (`Sandbox.create` → `sb.snapshot`) | **none for bake** | `VERCEL_TOKEN` (+team/project) | `vercel-prepared.json` |
| **hetzner** | **temp VPS** (boot `cx23` → ssh install → `create_image`) | **`ssh` + `scp`** + outbound SSH + egress-IP reachability | `HCLOUD_TOKEN` | `hetzner-prepared.json` |

> **Vercel clarification:** the `sandbox`/`sbx` CLI is **not** needed to bake — the snapshot is
> built server-side via `@vercel/sandbox`. That CLI is only used for the interactive browser-login
> auth mode (out of scope) and attach. So no provider needs a separately-installed cloud CLI to bake.

Blockers:
- **B1 (docker daemon):** docker bake needs a reachable daemon on the hub host → precheck, not a hang.
- **B2 (hetzner host binaries):** needs `ssh`/`scp` + outbound SSH → precheck.
- **B3 (topology):** hub **mutations only run on the in-process host backend** (localhost /
  hetzner-embedded); the Postgres/serverless plane is read-only (writes 503). This is *correct* —
  bake is inherently a host op (docker/ssh + writes host `~/.agentbox`). The endpoints must return a
  clear 503 there, not attempt it.
- **B8 (duration):** bakes are minutes (hetzner boots a VPS; daytona cold ~7 min) → must be a
  background job with streamed logs, never a blocking request.

### A3. Job-model gaps (the bake job isn't a box)

The queue currently has **no `kind`** — job type is implied by booleans (`noAgent`, `setupWizard`),
and every job ends by creating a **box** (`boxId`, surfaced as a synthetic `creating` box via
`mapJobToBox` in `getData`). A bake produces an *artifact*, not a box.
- **B6 (don't surface bake as a box):** introduce a real `kind: 'create' | 'prepare'` discriminator
  on `QueueJob` and skip `kind==='prepare'` in `mapJobToBox`/`getData`.
- **B7 (concurrency lane):** the scheduler gates on running-box and working-agent counts; a bake
  occupies neither. Exclude `kind==='prepare'` from those counts (and from
  `countInFlightCreateJobs`) so bakes and creates don't starve each other; give prepare its own
  small ceiling.

### A4. Out of scope / follow-ups
- **B9 (plugin providers):** `agentbox plugin add` needs a global `npm install` + trust confirm —
  can't be done safely from the web. CLI-only.
- **B10 (tray):** tray reuses the same REST routes in a later pass; its `BoxSource` + `CLAUDE.md`
  contract get updated then.

---

## Part B — Implementation plan (Hub API + web)

The **REST routes are the single surface** — web, tray, remote clients, CLI all go through them.
Keep all provider/SDK code behind `globalThis.__AGENTBOX_HUB_BACKEND` so it never enters Next's bundle.

### Phase 1 — Headless credential setters (packages)  [B4, B5]
- Extract a shared `writeManagedSecrets(keys, record)` into `@agentbox/sandbox-core` (atomic
  temp+rename, 0600, `MANAGED_KEYS` strip-and-append) and refactor the four private
  `writeManaged`/`persistCredentials` onto it.
- Add optional `setCredentials?(fields): Promise<{ ok; error?; hasCredentials }>` to
  `ProviderModule` (`packages/sandbox-core/src/doctor.ts`).
- Implement `setCredentials` per provider in each `packages/sandbox-{e2b,daytona,hetzner,vercel}/…`:
  take the field(s), run the existing `validateCredentials`, write via the shared helper — no
  prompts, no TTY gate. Export a value-free `readCredStatus()` status everywhere (e2b already has one).

### Phase 2 — A `prepare` job kind (relay queue + CLI worker)  [B6, B7, B8, A2]
- Add `kind?: 'create' | 'prepare'` to `QueueJob` (`packages/relay/src/queue.ts`), default `'create'`.
  A prepare job carries `{ providerName, force?, claudeInstall? }` instead of agent/create fields.
- Scheduler: exclude `kind==='prepare'` from `defaultCountRunningBoxes`, the working-agent gate,
  and `countInFlightCreateJobs`; add a small dedicated prepare ceiling. `mapJobToBox`/`getData`
  skip prepare jobs (they are provider status, not boxes).
- `defaultSpawnWorker` branches on `kind` → spawn a new hidden worker
  `apps/cli/src/commands/_run-queued-prepare.ts` (registered in `apps/cli/src/index.ts`), modeled on
  `_run-queued-job.ts`, with stdout/stderr → the job `logPath` (same tail the SSE reads).
- The worker calls **`provider.prepare({ hostWorkspace, force, claudeInstall, onLog })` directly**
  (via the same `IMPORTERS`/registry resolution), writing every `onLog` line to `logPath` so the
  existing per-job SSE streams live progress with **no new transport** — parity with create-box.
  On success it pins the returned `snapshotName` (config key via `@agentbox/config`) and confirms
  prepared-state; marks the job `done`/`failed`. **Do not route through `runPrepare`.**

### Phase 3 — HubBackend methods + REST routes (the only surface)  [B1, B2, B3, B5]
- `apps/hub/lib/boxes/backend-types.ts` — add to `HubBackend`:
  - `setProviderCredentials(id, fields): Promise<ActionResult>` → dispatch via `IMPORTERS` to the
    Phase-1 `setCredentials`; docker → no-op ok.
  - `prepareProvider(id, opts?): Promise<CreateBoxResult>` → **prechecks** (docker daemon reachable
    [B1]; `ssh`/`scp` present for hetzner [B2]; credentials present for the target) → clear error if
    unmet, else `enqueueQueueJob({ kind:'prepare', providerName, force?, claudeInstall? })` +
    `pokeQueue()`, returning `{ jobId }`.
  - Extend `listProviders()` (`hub-backend.ts:307`) so each `ProviderOption` also reports
    `hasCredentials` (from `readCredStatus`) and, when a bake is in flight, its `jobId`.
- REST routes (parallel to `boxes/[id]/[action]/route.ts`; `nodejs` + `force-dynamic`; bearer-gated;
  `ok()`/`fail()` envelope; validate in `api/v1/lib/validate.ts`):
  - `POST /api/v1/providers/{id}/credentials` → `setProviderCredentials` (host-topology only → 503
    on the Postgres path [B3]). **Never echo secrets back.**
  - `POST /api/v1/providers/{id}/prepare` → `{ jobId }` (202). Progress via the existing
    `GET /api/v1/jobs/{id}` + `GET /api/v1/jobs/{id}/logs` (SSE).
  - Extend `GET /api/v1/providers` items with `hasCredentials` + in-flight `jobId`.
- Add all routes to the hand-maintained OpenAPI (`api/v1/lib/openapi.ts`).

### Phase 4 — Hub web "Providers" settings UI (pure REST client)  [stream parity]
- New **`Providers`** card/section on `apps/hub/app/(dashboard)/settings/page.tsx` after the GitHub
  App section, mirroring its `SectionLabel` + `Card` layout. Per provider: baked/credential status,
  a **credentials form** (key/token `Input`s per provider; docker shows none), a **"Bake image"**
  button, and inline precheck warnings (docker daemon down / ssh missing) surfaced from the endpoint.
- New **client** component `settings/components/provider-actions.tsx` that talks to the REST API
  **directly via `fetch('/api/v1/providers/{id}/credentials', {POST,json})` and `.../prepare`** —
  **no server actions, no backend global.** Copy `LoginBanner`'s exact pattern
  (`job-log-stream.tsx:98`): POST JSON, parse the `{ error: { message } }` envelope, inline error
  state, `credentials:'same-origin'`.
- **Stream the bake like create-box:** reuse `boxes/components/job-log-stream.tsx` on the returned
  `jobId`, but point it at the **v1** SSE `GET /api/v1/jobs/{id}/logs` (the create modal currently
  uses the internal `/api/jobs/...` twin — parametrize `JobLogStream`'s endpoint, or add a thin v1
  variant, so a remote frontend works unchanged). Provider flips to "configured" on the SSE `end`.
- The prepare worker MUST emit `log` events over that same v1 SSE (each `provider.prepare` `onLog`
  line → `logPath` → SSE `log`). This one channel is what lets **both** the web stream **and** the
  tray's calibrated progress bar (below) work unchanged — no bake-specific transport.
- Reuse existing primitives (`components/ui/{card,input,button,alert,badge,label}`, `SectionLabel`).
  There's no shared toast (it's local to `git-actions.tsx`) — use inline `Alert`/error text like
  `LoginBanner`, or lift the toast stack if wanted.
- Once a bake succeeds, `GET /api/v1/providers` reports `configured:true` and the create-box picker
  enables that provider automatically — no extra wiring.
- **Note:** this intentionally diverges from the older `createBoxAction` server-action path; the new
  provider surface sets the API-only precedent (create can migrate later).

### Phase 5 — Docs
- `apps/web/content/docs/**`: document setting credentials + baking from the hub, and the
  host-topology-only limitation. Update the CLI reference only if flags change (they shouldn't).
- Note the tray follow-up (B10) in the tray `CLAUDE.md` when that pass happens — not built here.

### Follow-up (not in this pass) — Tray (streamed bake with the same semi-fake progress bar)
The tray already streams **create** with a calibrated progress bar, and prepare must match it. Today
`CreateBoxPanel` morphs its form into a progress card (`enterProgress`) that: opens
`JobLogStreamClient` on `GET /api/v1/jobs/{id}/logs` (Bearer SSE, parses `log`/`end`/`login`), and
per streamed `log` line nudges a `ProgressBar` by `min(0.8, 0.8·logCount/expectedSteps)` — capped at
80% until `end`, snapping to 100% on success — where `ProgressSteps.expected(for:)` is a
per-provider **measured create log-line count** (docker 52, daytona 1900, hetzner 41, vercel 33,
e2b 34). The 80% cap + done-snap absorb estimate error, so calibration only affects pacing.

For prepare, reuse the **same** `JobLogStreamClient` and `ProgressBar` verbatim (the v1 job-log SSE
already carries the bake's `log` events, per Phase 4), morphing a Providers panel into the same
progress card. The only new piece is a **bake-calibrated** step table (a `PrepareProgressSteps`
alongside `ProgressSteps`, measured from a real `prepare` per provider — bakes are far more verbose
than creates: docker BuildKit output, daytona/e2b/vercel server-side build logs, hetzner's VPS
install). Also add `setProviderCredentials`/`prepareProvider` to the tray `BoxSource` protocol,
implement in `HubClient.swift` against the new REST routes, and update the tray `CLAUDE.md`.

---

## Critical files

- **credentials (Phase 1):** new shared `writeManagedSecrets` in
  `packages/sandbox-core/src/…`, `ProviderModule.setCredentials?` in
  `packages/sandbox-core/src/doctor.ts`, per-provider setter in
  `packages/sandbox-{e2b,daytona,hetzner,vercel}/src/credentials.ts` (+ index re-exports).
- **queue/worker (Phase 2):** `packages/relay/src/queue.ts` (`QueueJob.kind`, scheduler counts,
  `defaultSpawnWorker`), new `apps/cli/src/commands/_run-queued-prepare.ts`, `apps/cli/src/index.ts`.
  Reference `apps/cli/src/commands/_run-queued-job.ts` (worker shape) and
  `apps/cli/src/commands/prepare.ts` (what to bypass in `runPrepare`).
- **prepare seam:** `packages/core/src/provider.ts` (`PrepareOptions.onLog`/`PrepareResult`),
  per-provider `packages/sandbox-*/src/prepare.ts` (already exported).
- **hub backend/REST (Phase 3):** `apps/hub/lib/hub-backend.ts` (`IMPORTERS`, `isProviderConfigured`,
  `listProviders`), `apps/hub/lib/boxes/backend-types.ts`, `apps/hub/lib/boxes/types.ts`
  (`ProviderOption`), new `apps/hub/app/(dashboard)/api/v1/providers/[id]/{credentials,prepare}/route.ts`,
  `api/v1/providers/route.ts`, `api/v1/lib/{validate,openapi,envelope}.ts`.
- **hub web (Phase 4):** `apps/hub/app/(dashboard)/settings/page.tsx` + new
  `settings/components/provider-actions.tsx`; reuse `boxes/components/job-log-stream.tsx`
  (parametrized to the v1 SSE) and the `LoginBanner` fetch pattern. No new server actions in
  `apps/hub/lib/boxes/actions.ts`.

## Verification (end-to-end)

Rebuild the hub standalone + restart (the hub is a persistent daemon serving the standalone build):
```
pnpm --filter @agentbox/hub build:standalone
AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
```
Then on the localhost host topology:
1. **Credentials (headless setter):** `POST /api/v1/providers/e2b/credentials` with a real
   `E2B_API_KEY`; confirm `~/.agentbox/secrets.env` gains the key (0600), `GET /api/v1/providers`
   flips e2b to `hasCredentials:true`, and the response **never echoes the token**. Try an invalid
   token for daytona/hetzner and confirm the validation error surfaces (not a silent write).
2. **Bake with live streaming:** `POST /api/v1/providers/e2b/prepare` → `{ jobId }`;
   `GET /api/v1/jobs/{id}/logs` streams **real provider build lines as they happen** (verify the
   `provider.prepare(onLog)`→logPath path works — not a final blob), ending with `end`; on done,
   `~/.agentbox/e2b-prepared.json` has a `base` and the provider shows `configured:true`. Repeat for
   docker (no-token, local daemon).
3. **Prechecks:** stop Docker → `providers/docker/prepare` returns a clear "daemon unreachable"
   error, not a hang [B1]; on a host without `ssh`, hetzner prepare reports the missing binary [B2].
4. **Web UI (client-only):** open the settings Providers card, paste e2b creds, click "Bake image",
   watch the streamed log, confirm the create-box picker enables e2b afterward — and verify in the
   Network tab that the page drives everything through `/api/v1/providers/...` and
   `/api/v1/jobs/.../logs` (no server-action POST to the page route), so a remote frontend behaves
   identically.
5. **Topology guard:** the two POST routes return a clear 503 on the read-only Postgres path [B3].
6. **No box leakage:** an in-flight prepare job does **not** appear as a `creating` box in the
   dashboard list [B6], and does not consume a box/working slot [B7].
