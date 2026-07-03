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
- [x] **2. Hub reads registry** (`apps/hub/lib/hub-backend.ts`): `listProjects()`
  unions `listProjectsConfigured()` with box-derived roots; self-heal registers box
  roots; unify project id on `hashProjectPath`.
- [x] **3. Shared enqueue core in `@agentbox/relay`.** Refinement: relocating
  `submitQueueJob` wholesale would cycle (it needs `ensureRelay` from
  sandbox-docker, which depends on relay). Instead extracted the **pure**
  `enqueueQueueJob(input)` (manifest build + `writeJob`, no transport) into
  `queue.ts`; CLI `submitQueueJob` now wraps it (+ `ensureRelay`/poke). Reused the
  existing `loadQueue()` instead of adding `listJobs()`.
- [x] **4. Hub `create` + `addProject` backend methods** (`backend-types.ts`,
  `hub-backend.ts`, `actions.ts`): `create` resolves workspace from the registry
  **by projectId** → `enqueueQueueJob` + `handle.pokeQueue()`; in-flight jobs
  surface as synthetic `creating`/`error` boxes in `getData()`. Added
  `handle.pokeQueue()` to the relay handle for in-process scheduler kicks.
- [x] **5. `onStatusChange → hubNotifier`** wired in `daemon.ts` (Phase A bit).
- [x] **6. Per-job log SSE** (`apps/hub/app/(dashboard)/api/jobs/[id]/logs/route.ts`)
  tails the job log via `backend.getJob(id)` (path + status) with plain `fs` so
  the route never bundles the relay toolchain; emits `log`/`end` events; ends on
  terminal status. Gated by `proxy.ts`.
- [x] **7. Server actions + UI**: `createBoxAction`/`addProjectAction`
  (`actions.ts`); re-enabled the buttons; `CreateBoxButton`+modal, `JobLogStream`,
  `AddProjectButton`+modal. typecheck + lint + `next build` clean.
- [x] **8. Verification** — logic + full local E2E passed; `docs/hub-webui-plan.md`
  Phase 6 added.
  - ✓ registry round-trip + `enqueueQueueJob`→`loadQueue` manifest (isolated `$HOME`).
  - ✓ typecheck + lint + `next build` clean (config/relay/cli/hub).
  - ✓ **Local E2E on a real hub (8787, rebuilt CLI worker):**
    - **docker × claude** and **docker × codex** (queue path): box built → `running`,
      detached `<agent>` tmux session, agent process running, **never attached**,
      job flipped `done` with `boxId` written back.
    - **docker × claude via the browser UI** (real `addProjectAction` +
      `createBoxAction` → `backend.create`): New-project modal registered a folder;
      Create-box modal streamed the live build log; dashboard showed the box
      `creating` → `running`; **full sync layer ran** (synced claude/codex/agents/
      opencode config + skills + credentials — untouched); ground-truth detached
      `claude` tmux, no attach.
    - Zero-box registry projects render in the dashboard; `/api/jobs/[id]/logs`
      SSE streamed `log`→`end`.
  - ✓ **Cloud (shared enqueue core, via CLI `-i` queue path):** all four providers
    (**daytona, hetzner, vercel, e2b**) provisioned a box and started the detached
    agent — my `enqueueQueueJob` refactor works cross-provider. hetzner/vercel/e2b
    passed the post-start auth verify (`done`); **daytona** flipped `failed` only
    because claude's creds were rejected *inside that daytona box*
    (`verifyDetachedSession` — a snapshot/creds env issue, not a code bug: the box
    created + detached session started fine). All cloud boxes destroyed after.
    (Cloud-from-hub UI is still deferred in v1 — this validated the core, not the
    hub's docker-only `create`.)

> **Sync layer preserved:** hub create goes through `enqueueQueueJob` →
> `_run-queued-job` → `createBox()`, the same path the CLI uses — download/upload
> of files/skills/git is untouched (no reimplementation of create).

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

## Phase D — Hub public REST API (`/api/v1`) — first cut DONE
The public API lives as a **versioned `/api/v1/*` route group on the hub** (Next
routes under `apps/hub/app/(dashboard)/api/v1/`), served on the relay port via the
existing `uiHandler` seam — deliberately **not** an extension of the relay's internal
`/admin`+`/rpc` if-ladder (that stays loopback-internal, with exit-code-coupled
statuses and no schema). One consistent envelope: success returns the resource
directly; errors always `{ error: { code, message, details? } }` with a correct HTTP
status. Thin facade over the already-shipped backend seam — no new box logic.
- [x] **Tier-1 in-process routes:** `GET /boxes`, `GET /boxes/:id`,
  `POST /boxes/:id/{pause,resume,stop,destroy}`, `GET|POST /projects`,
  `GET /approvals`, `POST /approvals/:id/answer`. Reads go through
  `getDashboardData()` (in-process → Postgres → empty), so the read contract is
  **topology-agnostic** already; mutations use `globalThis.__AGENTBOX_HUB_BACKEND`
  (503 on the Postgres path — hosted writes are the follow-up below).
- [x] **Tier-2 job routes:** `POST /boxes` (create → `202 {jobId}` via
  `enqueueQueueJob`), `GET /jobs/:id`, `GET /jobs/:id/logs` (SSE, shared tail in
  `lib/job-log-stream.ts` with the internal modal route).
- [x] **Auth:** `proxy.ts` gates `/api/v1/*` — accepts `Authorization: Bearer
  <AGENTBOX_HUB_TOKEN>` (or the same-origin cookie) in token mode, the better-auth
  session in password mode, and always answers **JSON 401** (never a `/signin`
  redirect a non-browser client can't follow). `/health`, `/openapi.json`, `/docs`
  are public.
- [x] **OpenAPI 3.1 + docs:** hand-authored spec at `GET /api/v1/openapi.json`
  (no zod dep added — the repo has no zod convention; validation is hand-rolled
  `typeof` guards in `api/v1/lib/validate.ts`, matching the codebase), Scalar docs at
  `GET /api/v1/docs`.
- **Deferred to Phase D-next:** `/providers` list, `POST /prepare` (bake) +
  `POST /providers/:name/install`, and the structured `GET /jobs/:id/events` /
  `POST /jobs/:id/answer` interaction stream (needs Phases A–C). Dedicated API-key
  management + hosted-plane **writes** land with the hosted-remote phase below.

## Phase D.1 — Box git + service operations (detail page + API + CLI) — DONE
Beyond create/lifecycle: common box ops on the detail page, `/api/v1`, and the CLI.
- [x] Shared provider-agnostic `@agentbox/sandbox-core/box-git.ts` (checkout, new-branch,
  push, pull, push-host, service status/restart argv). Token minting injected → no relay
  import (cycle-safe). CLI `git.ts` refactored onto it; new `agentbox git branch` +
  `agentbox services [list|restart]`.
- [x] Hub backend methods (`gitCheckout/gitNewBranch/gitPush/gitPull/gitPushHost/getGit/
  getServices/restartService`) + server actions + REST routes
  (`/boxes/{id}/git`, `/boxes/{id}/git/{op}`, `/boxes/{id}/services`,
  `/boxes/{id}/services/restart`) + OpenAPI + `git-actions.tsx`/`services-panel.tsx`.
- [x] Docker E2E green (CLI ground-truth + REST envelopes + UI render). See
  `docs/hub-webui-plan.md` Phase 8. Deferred: hosted/Postgres write path (503).

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
- _2026-07-03_ — first vertical slice landed (items 1–7): config registry, relay
  `enqueueQueueJob` core + `pokeQueue`/`onStatusChange`, hub `create`/`addProject`
  backend + registry-backed projects + `creating`-box synthesis, per-job log SSE,
  and the create-box/add-project UI. Verified logic + hub boot (item 8);
  Docker create→running E2E remains as the pre-push smoke test. **Not pushed** —
  awaiting the {local,vercel,hetzner}×{claude,codex} smoke matrix.
- _2026-07-03_ — **smoke passed**: docker×{claude,codex} via queue + full browser
  E2E (add-project + create-box through the real server actions → creating→running,
  sync layer intact, detached no-attach). **Cloud**: daytona/hetzner/vercel/e2b all
  provisioned + started the detached agent via the shared enqueue core
  (hetzner/vercel/e2b `done`; daytona failed only on in-box claude auth verify —
  env, not code). All boxes destroyed; artifacts cleaned; hub restored on 8787.
  Pushing + PR into `feat/control-plane-create`.
