# Control plane — build-out status

> **Rename in flight:** "control-plane" is being renamed to **Control Hub** (`agentbox hub`) — see
> [`control-plane-roadmap.md`](./control-plane-roadmap.md) (milestone M1). This backlog stays as the
> historical record of what shipped under the old name; the code/CLI/config still say `control-plane`
> until the M1 rename lands.

Status of the **control plane**: a portable service that holds the centralized
concerns for boxes — git credentials (GitHub-App token leasing), permission
state, the box registry/events — so boxes keep pushing / opening PRs while the
user's laptop is off. Maintained live during implementation (per project
convention).

Plan of record: `~/.claude/plans/design-a-new-approach-synthetic-bee.md`.

## The pivot (vs the first attempt)

The first attempt ran the relay on a **dedicated always-on VPS** with a
long-lived fine-grained PAT. It worked but (1) billed a never-sleeping VPS for
something mostly idle, and (2) pushed by reaching back into the box over the
cloud SDK to make + download a git bundle — the part that resists a
stateless/serverless deployment.

The current design is **one portable control plane** — the `@agentbox/relay`
core wrapped as a single **Next.js + Postgres app** (`apps/control-plane`). The
same code deploys to **Vercel** (managed) or self-hosts on a **VPS** (Postgres +
`next start`, via docker-compose). It is stateless per request (all state in
Postgres) and does no host execution. Git auth is **GitHub-App leasing**: it
mints 1-hour, single-repo installation tokens and leases them to boxes, which
push to GitHub directly — no bundle transfer, no SDK reach-back. That dedicated
always-on VPS (with its stored PAT) is removed. The laptop loopback relay
(`agentbox-relay serve`) is unchanged and shares the same core.

## Architecture

```
cloud box  --(forwarder, https)-->  control plane (Next.js + Postgres)
   |  POST /events (per-box bearer)        |  Store (boxes/events/status/prompts)
   |  POST /rpc git.lease-token            |  GitHub App -> 1h repo-scoped token
   |  GET  /rpc/status/:id (poll)          |  /admin/* (admin bearer, fail-closed)
laptop CLI --(register/answer, admin bearer)
box --(push directly with leased token)--> GitHub
```

- **Store seam** (`packages/relay/src/store/`) — every relay handler talks to an
  async `Store`. `MemoryStore` (laptop + tests, wraps the historical in-memory
  structures), `PostgresStore` (hosted plane). `pg` is lazy-imported + bundler-
  external, so the laptop relay/CLI carry no pg.
- **Poll-based approvals** (`permission.ts`) — `promptMode` is `block` on the
  laptop (in-process wait, unchanged) and `poll` on the hosted plane (parks a
  prompt row; the box polls `/rpc/status/:id`; the approved action runs there).
- **GitHub-App leasing** (`github-app.ts`, `lease.ts`) — `git.lease-token` gated
  like push (`agentbox/*` auto, else approval); repo resolved from the box's
  REGISTERED `originUrl`, never box params. In-box `git push` leases + pushes
  directly when `AGENTBOX_GIT_LEASE=1` (token in the remote URL for the push
  only, scrubbed after).
- **Hosted-plane handler** (`core/handler.ts`) — framework-agnostic
  `handleRelayRequest(GenericRequest) -> RelayResponse`; the Next.js app
  (`apps/control-plane`) is a thin Web-Request adapter over it. Rejects
  host-local RPCs (cp/download/checkpoint/docker git.push) — no host on the plane.

## Phase status

- [x] **Phase 0 — Store seam (MemoryStore).** Async `Store` over boxes/events/
  status; handlers route through it; zero behavior change. Conformance suite.
- [x] **Phase 1 — PostgresStore.** `pg` (lazy + external), `makeStore()`,
  `migrate()`; conformance green vs live `postgres:16`. Laptop/CLI verified pg-free.
- [x] **Phase 2 — Poll-based approvals.** Prompt mailbox in both stores;
  `promptMode`; `202 {promptId}` + `GET /rpc/status/:id`; ctl polls transparently.
- [x] **Phase 3 — GitHub-App leasing + remove dedicated control-box.**
  `github-app.ts`, `git.lease-token`, in-box lease/push; deleted the
  `agentbox control-box` command + `sandbox-hetzner/control-box.ts`. The
  `relay.controlPlaneUrl` key stays (now points at the hosted plane). The relay's
  legacy `--control-box` admin-bearer mode + its stored-PAT bundle-push
  (`pushBundleWithPat`/`pushBundleToRemote`) were later removed once the hosted
  plane + App leasing fully superseded them (see Cleanup below).
- [x] **Phase 4 — Control-plane Next.js app (`apps/control-plane`).**
  `handleRelayRequest` core + lean `@agentbox/relay/control-plane` entry;
  catch-all route handler; PostgresStore + App leaser from env; docker-compose +
  Dockerfile + README + Vercel notes. Verified: `next build`, live HTTP smoke vs
  postgres:16 (fail-closed admin gate, register/events persisted, agentbox/*
  lease, host-local -> 501).
- [x] **Phase 4b — federation data layer (RemoteStore).** `store-rpc.ts`
  (`applyStoreOp` allow-list) + `POST /admin/store` + `RemoteStore`; conformance
  green. Remaining laptop wiring (autopause/queue over the store, docker
  cloud-only bypass, admin-CLI retarget) deferred.
- [x] **Phase 5 — Box creation from the plane.** The durable job queue
  (`create_jobs`, atomic `FOR UPDATE SKIP LOCKED` claim), `POST /remote/boxes`
  (202 {jobId}) + `GET /remote/boxes/:id`, the `drainCreateJobs` worker
  (injectable `CreateBoxFn`), and the `agentbox control-plane worker` command
  (`--once` / loop; auto-loads the setup-written App creds; PostgresStore +
  `GitHubAppLeaser` + `providerForCreate`). The worker's production `CreateBoxFn`
  is origin-clone seeding: lease an App token → `git clone` the repo to a local
  temp dir → scrub the remote back to the bare origin → hand the checkout to the
  normal `provider.create({ workspacePath })` → `rm -rf` the temp dir. **Full loop
  validated live** end to end (enqueue → atomic claim → lease → clone →
  `provider.create()` → job `done` with `result.boxId` — see below).
  - **Scope: cloud providers only** (matches §5 "the hosted plane creates cloud
    boxes only"). Cloud providers seed the sandbox from the checkout (git bundle),
    so the post-create temp-dir cleanup is safe. The **docker** provider is *not*
    a valid plane target: it bind-mounts the workspace's `.git` as the box's
    persistent backing, so the worker's `finally` cleanup deletes the live gitdir
    out from under the container (the seeded files survive; in-box `git` breaks).
    Docker boxes are created locally by `agentbox create`, never by the plane.
- [x] **Setup CLI — `agentbox control-plane`.** `setup` runs the GitHub App
  **manifest flow** (localhost callback → browser → code exchange) and writes the
  deploy env + admin token; `set-url` / `status`. Tested e2e against a fake GitHub.
- [x] **Phase 6 — Dashboard pages + docs sync.** A token-gated App-Router
  dashboard at `/` (`apps/control-plane/app/page.tsx` + `layout.tsx`): a pure
  client view that reuses the admin-bearer auth (token in `sessionStorage`, sent
  as the Bearer on every `/admin/*` fetch — no new server session), showing
  pending approvals (approve/deny via `/admin/prompts/answer`), the box registry,
  and recent events; polls every 4s. Coexists with the `/[...path]` API route
  handler (the catch-all is required, so `/` is free). Docs synced: new public
  `control-plane.mdx` reference page (+ nav entry, `agentbox control-plane` CLI
  commands in `cli.mdx`, `relay.controlPlaneUrl` row in `configuration.mdx`), a
  hosted-control-plane section in `docs/host-relay.md`, and the stale
  `agentbox control-box` command references removed from `config/types.ts` +
  `host-actions.ts`. (`cloud-providers.md` already had no control-box refs.)
- [x] **Cleanup — remove the legacy `--control-box` relay mode.** The dedicated
  control-box (a VPS running the relay binary with a stored PAT) was the v1
  approach; the hosted plane + App leasing replace it. Removed cleanly (AgentBox
  is unreleased): the `agentbox-relay serve --control-box` flag + boot mode
  (`bin.ts`); the `controlBox`/`adminToken`/`promptMode='poll'` branches in
  `server.ts` (the laptop relay is loopback-gated, `/remote/*` 404s here — box
  creation is the Next.js plane's surface); the `controlBox`/`githubToken` deps +
  the `pushBundleWithPat` PAT bundle-push and the gh `--repo`/cwd + git.fetch
  control-box branches in `host-actions.ts`; the now-dead `pushBundleToRemote` in
  `git-pat.ts` (its URL helpers `toAuthedHttpsUrl`/`parseGitRemote`/
  `repoSlugFromRemote` stay — leasing reuses them); and `control-box-admin.test.ts`.
  Kept: `relay.controlPlaneUrl` (points at the hosted plane) and the plane's own
  always-on admin-bearer gating in `core/handler.ts`. Relay suite green
  (224 tests), CLI typechecks.
- [x] **Turnkey setup — deploy + repo onboarding.** `control-plane setup` now
  autogenerates the App name (`agentbox-<rand>`), and after creating the App runs
  a **deploy step** (interactive `select` or `--deploy vercel|hetzner|none`),
  auto-`set-url`s + polls `/healthz`, and opens the App's repo-selection page.
  - **Vercel** (`deploy-vercel.ts`): shells the logged-in `vercel` CLI — link →
    `vercel integration add neon --non-interactive` (Postgres) → push env from
    `control-plane.env` → `deploy --prod`. Falls back to printed manual steps on
    failure.
  - **Hetzner** (`deployControlPlaneToHetzner` in `@agentbox/sandbox-hetzner` +
    `deploy-hetzner.ts`): stock Ubuntu `cx23`, cloud-init installs Docker + clones
    the public repo (`controlPlaneCloudInit`), firewall `:22` host-only + `:80/:443`
    open (`controlPlaneInboundRules`), secret `.env` + a Caddy compose overlay
    scp'd, `docker compose up -d --build`; HTTPS at `https://<ip>.sslip.io` via
    Caddy + Let's Encrypt; persists `~/.agentbox/control-plane/deploy.json`.
  - **`control-plane add`** authorizes the current repo on the App; the agent
    launchers (`claude`/`codex`/`opencode`) call a shared
    `ensureProjectRepoOnControlPlane` that checks install status (local App key
    or the new `GET /admin/app/repo-installed` / `GitHubAppLeaser.isRepoInstalled`)
    and prompts once per project when missing (`repos.json` ack; unattended only
    warns). Relay suite 228 green.

## Live validation (2026-06-16)

The plane is deployed and validated on real infrastructure:

- **Deploy:** `apps/control-plane` on **Vercel** (`madarcos-projects/agentbox-control-plane`,
  Root Directory `apps/control-plane`, monorepo built via turbo) + **Neon Postgres**
  (provisioned non-interactively via `vercel integration add neon`). Public URL
  `agentbox-control-plane-two.vercel.app`.
- **Verified live:** `/healthz` (tables auto-migrated on Neon), fail-closed admin
  gate (401/200), `register-box` + `/events` persisted to Neon.
- **Leasing live:** `git.lease-token` minted a real 1-hour GitHub-App installation
  token for `madarco/agentbox-test-repo` (App `agentbox-control-plane`, installed
  on the repo) with the authed remote URL.
- **Box-creation loop live (origin-clone, Hetzner):** a Hetzner `cx23` provisioned
  via cloud-init cloned `agentbox-test-repo` into `/workspace` using a plane-leased
  token (origin scrubbed back to the bare URL afterward), then was destroyed.
- **Full worker loop live (queue → worker → box):** `POST /remote/boxes` enqueued a
  job on Neon (`queued`); `agentbox control-plane worker --once --store <neon>`
  atomically claimed it (`claimedBy`/`startedAt`), leased a 1h App token for
  `madarco/agentbox-test-repo`, `git clone`d it locally, scrubbed the remote, ran
  `provider.create()` (seeded `/workspace` with the repo content), and marked the
  job `done` with `result.boxId` + `finishedAt`. Proves enqueue → atomic claim →
  lease → clone → `provider.create()` → completion end to end against the live
  Vercel+Neon plane. (Run with docker as a no-cost local target; see the Phase 5
  docker caveat — the box was destroyed afterward.)
- **Dashboard live:** the token-gated dashboard deployed to the same Vercel plane
  (`/` serves the admin-token form, `/healthz` + `/admin/registry` still answer
  200/401) — the page and the `/[...path]` API route coexist in the serverless env.
- **Hetzner deploy path live (2026-06-16):** `deployControlPlaneToHetzner` ran end
  to end against real Hetzner — firewall (`:22` host-only, `:80/:443` open), `cx23`
  VPS, cloud-init (Docker install + public-repo clone), secret `.env` + Caddy
  compose overlay scp'd, `docker compose` pulled postgres+caddy and invoked the app
  build. It exposed a pre-existing **self-host image build bug** (Vercel was
  unaffected — turbo there built deps in order): the `apps/control-plane/Dockerfile`
  built the relay before its workspace deps emitted `dist/`. Fixed to build via
  `turbo run build --filter=@agentbox/control-plane`, and added a root `.dockerignore`
  (host `node_modules` was being copied in, breaking native-dep arch). A clean-context
  `docker build` now goes 6/6 turbo tasks + `next build` green. VPS + firewall
  destroyed after the run. **Caveat:** a full live green (Caddy + Let's Encrypt cert
  on `<ip>.sslip.io` + `/healthz`) needs the Dockerfile fix on `origin` first (the
  VPS clones the public repo at `--ref`); validated locally pending that push.

- **Git-backed Vercel deploy live (2026-06-16):** `control-plane setup --deploy vercel` now
  builds the plane **from GitHub** via the Vercel REST API (no local upload), so it works from
  a global npm install. Live-validated: created a Git-connected project (`madarco/agentbox`,
  Root Directory `apps/control-plane`), auto-provisioned Neon, upserted the App env, and a
  `gitSource` production build of `feat/control-box` went READY at
  `https://agentbox-control-plane.vercel.app` — `/healthz`, the fail-closed admin gate, and the
  new `/admin/app/repo-installed` endpoint all answer. **Ownership constraint:** Vercel only
  connects a repo whose owner has the Vercel GitHub App; non-owners fork + `--repo <fork>`
  (Hetzner needs no ownership — it clones the public repo on the VPS). Replaced the old
  local-folder `vercel deploy` (monorepo-only, hit the Root-Directory bug).

- **Vercel deploy made ownership-free + boot-safe (2026-06-16):** `--deploy vercel` is now
  tiered — if the deployer doesn't own `--repo` it **auto-forks via `gh`** and deploys the fork
  (`github-fork.ts`); if Vercel still can't connect (its GitHub App not installed on the account),
  it falls back to the **Deploy Button** (`vercel.com/new/clone` — clone + App install + Postgres
  in-browser) and then finishes via the API (upsert secrets + redeploy), so there's no manual
  paste. The control plane also **boots with no secrets**: `lib/plane.ts` answers `/healthz` before
  building deps (reporting `configured:{db,app,admin}`) and `buildDeps` no longer throws on a
  missing admin token; the handler returns a graceful **503 (not 500)** for an unset admin token.
  Net: a bare deploy is reachable + never 500s, and the bare→set-secrets→redeploy sequence is
  always valid. (Hetzner stays ownership-free — it clones the public repo on the VPS.)

## Security notes

- **Token blast radius:** leased tokens are per-repo, minimal perms
  (`contents`+`pull_requests` write), 1h, never persisted (in-memory cache only).
  Compromise of one box yields at most a 1h single-repo token; the plane holds
  only the App private key.
- **Repo-scope != branch-scope:** an installation token can write any branch in
  the repo. The lease gate auto-allows only `agentbox/*` (decided with the user);
  any other branch needs approval. Branch protection on protected branches is the
  real backstop.
- **Lease gate == push gate**, and the repo is always re-derived from the
  registered origin, never box params.
- **Admin auth:** the hosted plane gates `/admin/*` + `/remote/*` on a
  constant-time admin-bearer, fail-closed (never loopback).

## Verify

- Unit: `pnpm --filter @agentbox/relay test` (Memory conformance, poll-prompt,
  github-app, control-plane-handler). Postgres conformance:
  `AGENTBOX_TEST_DATABASE_URL=... pnpm --filter @agentbox/relay test postgres-store`
  against a disposable `postgres:16`.
- Self-host: `apps/control-plane` -> `docker compose up --build` (or `next start`)
  with `POSTGRES_URL` + `AGENTBOX_RELAY_ADMIN_TOKEN`; `curl /healthz`, admin
  401/200, register a box, `git.lease-token`.
- Live App round-trip (pending a real GitHub App on a test repo): register a
  cloud box, push on `agentbox/*`, confirm via `git ls-remote`.
