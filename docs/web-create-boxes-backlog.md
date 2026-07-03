# Web/API box management — implementation backlog

> Living tracker for driving box **management** (create / bake / provider-install)
> from the hub web UI, a public API, and a future macOS app, without duplicating
> the CLI. Full design + rationale: the approved plan
> (`~/.claude/plans/lovely-moseying-dongarra.md`). Keep this doc live — check items
> off as they land, and record deferred/non-obvious decisions in the Deferred
> backlog at the bottom.

- **Branch:** `feat/web-create-boxes` → PR into `feat/control-plane-create`.
- **Delivery:** smoke-test {local, vercel, hetzner} × {claude, codex} before push.

## Architecture (one-liner)

CLI = single execution engine; the relay/plane (over the **Store seam**) = the
interaction broker; every frontend (CLI, web, API, macOS) is a thin HTTP client.
Long/interactive ops run as **relay jobs that spawn the CLI worker**; prompts +
links + progress ride the relay's existing mailbox/link/event channels (poll-mode
`PromptRow` via the Store, so it works both on the laptop relay and a hosted plane).

---

## First vertical slice — "Create boxes from the hub" (local relay, docker)

Ships the end-to-end create-from-web path using the queue as-is (log-file
streaming), before the full `--protocol json` interaction bus.

- [x] **1. Project registry** (`packages/config`): export `registerProject(absPath)`
  + `ProjectEntry`; call it on CLI create. (wraps `touchProjectMeta`, `write.ts:321`)
- [ ] **2. Hub reads registry** (`apps/hub/lib/hub-backend.ts`): `listProjects()`
  unions `listProjectsConfigured()` with box-derived roots; self-heal registers box
  roots; unify project id on `hashProjectPath`.
- [x] **3. Shared enqueue core in `@agentbox/relay`.** Refinement: relocating
  `submitQueueJob` wholesale would cycle (it needs `ensureRelay` from
  sandbox-docker, which depends on relay). Instead extracted the **pure**
  `enqueueQueueJob(input)` (manifest build + `writeJob`, no transport) into
  `queue.ts`; CLI `submitQueueJob` now wraps it (+ `ensureRelay`/poke). Reused the
  existing `loadQueue()` instead of adding `listJobs()`.
- [ ] **4. Hub `create` + `addProject` backend methods** (`backend-types.ts`,
  `hub-backend.ts`): `create` resolves workspace from the registry **by projectId**;
  surface in-flight jobs as synthetic `creating` boxes in `getData()`.
- [ ] **5. `onStatusChange → hubNotifier`** wired in `daemon.ts` (Phase A bit).
- [ ] **6. Per-job log SSE** (`apps/hub/app/(dashboard)/api/jobs/[id]/logs/route.ts`)
  tailing `queueLogPath(id)`; gated by `proxy.ts`.
- [ ] **7. Server actions + UI**: `createBoxAction`/`addProjectAction`
  (`actions.ts`); re-enable the buttons; create-box modal + `JobLogStream` +
  add-project modal.
- [ ] **8. Docs + verification**: run the E2E slice check; update
  `docs/hub-webui-plan.md`.

---

## Phase A — Generalize mailbox + job interaction bus (`packages/relay`)
- [ ] `origin: {kind:'box'|'job', id}` on `PendingPrompts.add` + `PendingApproval`;
  `boxFor` → `originFor` (+ compat accessor).
- [ ] Job event channel: per-job structured event log + notify; loopback routes
  `POST /admin/jobs/:id/event`, `POST /admin/jobs/:id/prompt` (reuse `/rpc/status/:id`).
- [ ] `startQueueLoop({ onStatusChange })` → `hubNotifier.notify()`.
- [ ] Export `listJobs()`, relocated `submitQueueJob`.

## Phase B — CLI `Interaction` port + `--protocol json` (`apps/cli`)
- [ ] `Interaction` interface (`prompt`/`confirm`/`pickFiles`/`openLink`/`progress`)
  + TTY impl (extract clack) + Protocol impl (HTTP to Phase-A routes).
- [ ] Thread through `runCarryGate` / `maybeRunSetupWizard` / `maybePromptPortless`
  + provider-auth link opens; select via `--protocol json` (default TTY).

## Phase C — Relay-managed management jobs (`_run-queued-job.ts`)
- [ ] Dispatch on job `kind`: `create-box` (existing), `prepare`/`bake`
  (`runPrepare`), `provider-install`. Run core lib in-worker with `--protocol json`.

## Phase D — Relay / hub HTTP API surface
- [ ] Tier-1 in-process routes (`/boxes`, `/boxes/:id/{pause,resume,stop,destroy}`,
  `/providers`).
- [ ] Tier-2/3 job routes (`POST /boxes|/prepare|/providers/:name/install`,
  `GET /jobs/:id/events`, `POST /jobs/:id/answer`). Document as the public API.

## Phase E — Web UI + docs
- [ ] Generalized prompt/link surface (extend Approvals for job origin + links).
- [ ] Management views (bake, provider install) streaming `/jobs/:id/events`.
- [ ] Docs: `hub-webui-plan.md`, public API reference, `apps/web/content/docs/**`.

## Hosted control-plane parity (later, Store-seam based)
- [ ] Interaction bus over poll-mode `PromptRow` via the Store on the plane.
- [ ] Unify job model: `POST /boxes` enqueues into local queue OR Postgres
  `create_jobs`; frontends poll/stream identically.
- [ ] Fix `answerApprovalAction` to route via `POST /admin/prompts/answer` →
  `store.answerPrompt` (works on serverless Vercel; mirrors the Postgres read path).

---

## Deferred / non-obvious decisions
- **Agent required in the slice** — the queue path is agent-oriented
  (`QueueAgentKind` has no `none`); no-agent/plain-box create arrives with Phase C.
- **Cloud-provider create from the UI** deferred — protocol is provider-neutral but
  the UI must add carry/size/checkpoint surfaces first; slice is docker/localhost.
- **Create semantics differ by topology** — local = docker box from a host folder;
  hosted = cloud box cloned from a repo URL. Shared plumbing, different request shape.
- **Security** — `createBoxAction` takes a **projectId** (backend resolves the path
  from the registry); arbitrary-path creation only via the validated `addProject`.

## Progress log
- _2026-07-03_ — branch `feat/web-create-boxes` cut off `feat/control-plane-create`;
  backlog created; starting slice item 1 (project registry).
