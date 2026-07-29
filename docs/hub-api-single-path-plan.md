# One path: every CLI box operation goes through `/api/v1`

Status: planned. Each step is self-contained and meant to be executed in its own box.
Tick a step here when it lands.

## Context

The CLI is the execution engine and the hub is a second, parallel implementation of the same
operations. `apps/hub/lib/hub-backend.ts` re-implements lifecycle, git, services and create over
the same packages the CLI calls inline — and the two have already drifted, as its own comments
admit (*"Mirrors the CLI dashboard's resumeBox"*, *"Unlike CLI `agentbox start` this does not
restore agent tmux sessions"*, *"Mirror POST /admin/prompts/answer's block branch"*).

Worse, "thin" is currently a property of the **remote** hub only:
`resolveHubApiTarget` (`apps/cli/src/commands/control-plane.ts:1074`) hard-requires
`relay.controlPlaneUrl` **and** `AGENTBOX_HUB_API_KEY`, so every `/api/v1` client path in the
CLI is remote-only by construction. A local hub is not a server the CLI talks to; it is a
second client of the same `~/.agentbox` state. That is why enabling a remote hub flips only a
handful of operations, and why there are three wires — `/api/v1` (tray, web, `hub boxes`),
`/admin/*` + `/remote/*` (CLI, boxes), and inline — instead of one.

**Goal:** the CLI calls `/api/v1` for every box and fleet operation, against a local hub and a
remote hub alike. Same path, same request/response interface, same client code — the behavioral
difference lives *inside* the route/backend method. "Enable remote hub" then becomes a base-URL
swap and nothing else.

### Where each capability runs today

`inline` = the CLI drives the provider itself. `hub` = the CLI is a client.

| Capability | Local hub | Remote hub | Step |
|---|---|---|---|
| `prepare` / bake | inline | hub — `/api/v1` | 1 |
| approvals | inline (loopback `/admin/prompts`) | hub — `/api/v1` (+ `/admin` for the footer) | 2 |
| custody (creds / secrets / seed push) | n/a | hub — `/admin/custody` | 10 |
| `hub boxes <lifecycle>` | n/a | hub — `/api/v1` | 5 |
| `create` | inline | hub — `/remote/boxes` | 8 |
| queue / jobs | inline (file queue) | hub — `/remote/boxes` | 8 |
| `ls` / `list` | inline (`readState`) | inline + merge `/admin/store` | 3 |
| destroy · prune | inline | inline + `/admin` reap | 5, 9 |
| adopt / box resolution | n/a | `/admin/store` + custody | 4 |
| `<provider> login` | inline → `secrets.env` | inline → `secrets.env` | 1 |
| start · stop · pause · unpause | inline | inline | 5 |
| git push/pull/checkout | inline (host relay) | inline (box leases token) | 6 |
| services · rename · url · screen | inline | inline | 7 |
| shell · attach · cp · download · code · open | inline | inline | out of scope |
| logs · checkpoint · agent state | inline | inline | 9 |

### Design rules (apply to every step)

1. **One client.** `HubApiClient` (`apps/cli/src/control-plane/hub-api-client.ts`) for
   everything. No command grows an `if (remote)` branch.
2. **Same path + interface local ⇄ remote.** Any divergence is handled server-side. The
   precedent already exists: `hub-backend.ts:create` resolves the project and forks internally —
   a real workspace goes to the file queue, no workspace goes to `createViaControlPlane`.
3. **One implementation.** `hub-backend.ts` becomes the only implementation; the CLI keeps no
   inline provider code for a converted command. Where a shared core already exists
   (`packages/sandbox-core/src/box-git.ts` — `boxGitPush/Pull/Checkout/NewBranch/PushHost`,
   `boxServicesStatusRaw`, `boxRestartService`), it stays the shared core and *both* sides stay
   thin over it. Those conversions are caller-swaps, not rewrites.
4. **AgentBox is unreleased.** Delete cleanly — no aliases, no deprecation logs.
5. Each step must leave `main` green and the CLI usable in both modes.

### Explicitly out of scope

The **IO plane stays direct**: `shell`, `attach`, `cp`, `download*`, `code`, `open`, `url`,
`screen`, `drive` keep talking to the provider/box from the laptop. Two consequences, both
intentional:

- **Local adoption for cloud boxes stays.** The CLI still materializes a local `BoxRecord` so
  the direct IO path can resolve a box. Step 4 keeps it, but re-sources it from `/api/v1`.
- **`secrets.env` stays on both machines.** The PC needs provider credentials for direct SDK IO
  (e2b/vercel/daytona), so a provider login writes locally *and* pushes to the hub.

Also deferred: the eventual gateway that would let the IO plane move too (a uniform tunnel with
hub-side SSH termination for the SDK-only providers), and with it the removal of `secrets.env`
and adoption from the PC.

---

## Step 0 — Foundation: make the local hub an API target ✅ done

The blocking prerequisite. Nothing else can be converted until `HubApiClient` works in both modes.

**Landed.** `resolveHubApiTarget` now delegates to `resolveHubTarget` (it was as predicted:
`resolveHubTarget` already resolved remote / exposed-loopback / local, and the local hub's
`proxy.ts` accepts `~/.agentbox/hub/token` as `Authorization: Bearer`). A local target that isn't
running is auto-started via `ensureHub` (one spinner). `withHubClient()`
(`apps/cli/src/control-plane/with-hub.ts`) is the single entry point later steps wrap an op in — it
resolves the client, runs the `GET /api/v1/health` version gate (`apiVersion` ∈
`SUPPORTED_HUB_API_VERSIONS = ['v1']`), and maps `HubApiError` codes to stable exit codes +
actionable messages. The `hub boxes` group is the first converted caller (the canonical example).
Verified end-to-end: `agentbox hub boxes list` against a local hub with no control box (empty and
non-empty), and the remote-shaped path via `hub expose` (200 with the API key, 401 without).

**Notes for later steps:**
- **Module cycle.** `hub.ts` and `control-plane.ts` sit in a cycle (`hub.ts` consumes
  `controlPlaneSubcommands` at load). So `resolveHubApiTarget` imports `resolveHubTarget` **lazily**
  (`await import('./hub.js')`), and `withHubClient` imports `resolveHubApiTarget` lazily too. Keep
  those edges lazy when converting commands, or `controlPlaneSubcommands` reads undefined at eval.
- **Conversion shape.** A converted command is `await withHubClient(opts, async (client) => { … })`.
  A command that special-cases an error code (e.g. `not_found` → info, not error) catches it
  **inside** the callback before it reaches the mapper.
- **Exit codes** (for scripts / later steps): `not_found`=2, `unauthorized`=3, `invalid_request`=4,
  `conflict`=5, `backend_unavailable`=6, everything else (incl. `internal`) =1.

- `resolveHubApiTarget` delegates to `resolveHubTarget` (`apps/cli/src/commands/hub.ts:73`),
  which already resolves remote (`relay.controlPlaneUrl` + `AGENTBOX_HUB_API_KEY`), the
  `hub expose` loopback case, **and** local (`getHubStatus()` → `127.0.0.1:<port>` +
  `~/.agentbox/hub/token`). The local hub's `proxy.ts` already accepts that token as
  `Authorization: Bearer`, so `HubApiClient` itself needs no change — this is mostly deleting a
  duplicate resolver.
- Auto-start the local hub when the target resolves local and it isn't running (`ensureHub`).
  One spinner, one clear failure message.
- Add `withHubClient()` in `apps/cli/src/control-plane/` mapping `HubApiError` codes to CLI exit
  codes + actionable messages, so every later step is a mechanical conversion.
- Version gate: `GET /api/v1/health` already reports `apiVersion` — refuse an unsupported hub
  with a clear upgrade hint rather than failing on a missing field later.

**Files:** `commands/control-plane.ts` (`resolveHubApiTarget`, `resolveHubApiClient`),
`commands/hub.ts`, new `control-plane/with-hub.ts`.
**Verify:** unit tests for target resolution in all three shapes; `agentbox hub boxes list`
works against a local hub with no control box configured (today it errors).

---

## Step 1 — Providers: `login` + `prepare`

- `agentbox <provider> login` → `POST /api/v1/providers/:id/credentials` (the route exists and
  validates against the cloud before persisting). **Also keep writing the local `secrets.env`**
  via the existing per-provider `credentials.ts` → `writeManagedSecrets`, since the direct IO
  plane still needs it. Two writes, one command — comment it as intentional and temporary,
  pointing at the IO-plane follow-on.
- `prepare`: delete the remote-only routing in `control-plane/route-prepare.ts`. Always
  `POST /api/v1/providers/:id/prepare` + `streamJobLog` + poll `getJob` for the verdict (a
  dropped stream must not read as a successful bake).
- Provider listing / `doctor` provider rows read `GET /api/v1/providers?freshness=1`.

**Files:** `commands/prepare.ts`, `control-plane/route-prepare.ts` (delete),
`control-plane/hub-prepare.ts`, the per-provider `credentials.ts` call sites, `commands/doctor.ts`.
**Verify:** `agentbox e2b login` then `agentbox prepare --provider e2b` against a **local** hub;
confirm the bake runs hub-side and `~/.agentbox/e2b-prepared.json` lands on the hub's machine.

---

## Step 2 — Approvals

- `agentbox agent approvals|approve` and `hub approvals` → `/api/v1/approvals` and
  `/api/v1/approvals/:id/answer` in both modes. Drop the CLI's loopback `/admin/prompts` client.
- Keep `resolveBoxPromptSource`'s job (find *which* hub owns the box — it reads
  `box.cloud.controlPlaneUrl` first so a box stays reachable after a config change) but let it
  return a `HubApiClient` rather than an admin client.
- **The attach footer is the hard part.** `apps/cli/src/wrapped-pty/prompt-client.ts` subscribes
  to `GET <hub>/admin/prompts/stream` with `AGENTBOX_RELAY_ADMIN_TOKEN` and answers on
  `POST /admin/prompts/answer`. It cannot simply move to `/api/events`, which carries **refetch
  signals only** (`data: {}`) — the footer needs the `prompt-ask` payload. So this step must add
  a payload-carrying prompt stream under `/api/v1` (`prompt-ask` / `prompt-resolved` /
  `notice-set` / `notice-clear`), keyed by the API key. Until then the footer is the one client
  still holding an admin token, and the `no-token` degradation (silent footer + one-time note)
  stays.
- While here: `AGENTBOX_GIT_PUSH_NO_SUB` auto-denies with no SSE subscriber — confirm a
  laptop-closed approval still parks correctly with the hub as the durable subscriber.

**Files:** `commands/agent.ts`, `commands/control-plane.ts` (`approvalsSub`),
`control-plane/box-plane.ts`, `wrapped-pty/prompt-client.ts`, new v1 stream route.
**Verify:** trigger an in-box `git push` needing approval; answer it from the attach footer, from
`agentbox agent approvals`, and from the web UI — each answer must clear the other two.

---

## Step 3 — Listing (`ls` / `list`)

- Enrich `HubApiBox` (`apps/hub/lib/boxes/types.ts` + `hub-api-client.ts`) with the fields the
  merge and adoption paths need today: `sandboxId`, `originUrl`, `publicHost`, `image`,
  `previewUrls`, `webPort`, `lastAgent`, `branch`, `topology`. This is what currently forces
  `ls -g` onto `/admin/store`.
- `agentbox list` reads `GET /api/v1/boxes` **only** — one listing, no merge. The local hub
  already maps docker boxes into the same shape (`mapBox`).
- Delete `control-plane/hub-list.ts`'s `/admin/store` path, `hub-merge.ts`, `list-merged.ts`.
  Keep `~/.agentbox/hub-boxes-cache.json` as the offline fallback, re-keyed on the API payload.
- Note that `~/.agentbox/boxes/<seg>/status.json` is written by whichever relay a box reports to
  — on a remote hub that is the control box's disk. That is exactly why the listing has to come
  from the API and not the local file.

**Files:** `apps/hub/lib/boxes/types.ts`, `hub-api-client.ts`, `commands/list.ts`,
`control-plane/{hub-list,hub-merge,list-merged}.ts`.
**Verify:** `agentbox ls` and `ls -g` produce identical output before/after on a control box with
a mix of docker + cloud + in-flight `job:` boxes; stop the hub and confirm the offline cache
still prints.

---

## Step 4 — Box resolution (adoption kept, re-sourced)

- Add `GET /api/v1/boxes?ref=<id|name|index>` — server-side resolution mirroring `findBox`
  (`packages/sandbox-core/src/state.ts:310`), including project-index refs and the
  ambiguous-match case.
- `resolveBoxOrExit` (`apps/cli/src/box-ref.ts:71,164`) resolves through that route, then —
  because the IO plane is still direct — **materializes/refreshes the local record** via
  `registrationToBoxRecord` (`packages/relay/src/registration-to-record.ts`) and keeps the
  per-box SSH key pull (`downloadBoxSshKeys`).
- `auto-adopt.ts` collapses from a 4s-budgeted `/admin` round-trip with an `unreachable`
  tri-state into a plain cache refresh off the resolution call. `hub adopt` / `hub pull` stay but
  become API-based.

**Files:** `apps/hub/app/(dashboard)/api/v1/boxes/route.ts`, `apps/cli/src/box-ref.ts`,
`control-plane/{auto-adopt,hub-adopt,hub-pull}.ts`.
**Verify:** on a control box, `agentbox shell <hub-created-box>` works first try with no explicit
adopt, for one SSH provider (hetzner) and one SDK provider (e2b).

---

## Step 5 — Lifecycle

- `start`, `stop`, `pause`, `unpause`, `destroy`, `screen` → `POST /api/v1/boxes/:id/<action>`.
  The routes exist and are exercised today only by `hub boxes <action>`.
- Delete the `hub boxes start|stop|pause|resume|rm` subcommands — the top-level commands now do
  the same thing in both modes.
- `destroy`: the route already does provider destroy **plus** store/custody reap
  (`hub-backend.ts:1537`), so drop the CLI's separate `reapOnControlBox` call.
- Reconcile the drift the hub backend documents: decide whether `start` restores agent tmux
  sessions (CLI does, hub doesn't) and make the route the single answer.

**Files:** `commands/{start,stop,pause,unpause,destroy}.ts`, `commands/control-plane.ts`,
`control-plane/reap.ts` (delete), `apps/hub/lib/hub-backend.ts`.
**Verify:** full lifecycle round-trip on docker via local hub and on e2b via control box;
`destroy` leaves no orphan registration (`agentbox hub boxes list`) and no orphan sandbox.

---

## Step 6 — Git

- `agentbox git push|pull|checkout|branch|push --host-only` → `POST /api/v1/boxes/:id/git/:op`
  (routes exist, unused by the CLI).
- `packages/sandbox-core/src/box-git.ts` stays the shared implementation — only the *caller*
  moves. The CLI stops minting host-initiated tokens; the hub does it via `hubGitDeps`
  (`hub-backend.ts:1154`).
- `push --host-only` is definitionally host-checkout-bound: on a remote hub it must fail with the
  existing clear error (exit 64), not a cryptic `git -C` failure.

**Files:** `commands/git.ts`, `hub-api-client.ts` (`git()` already exists).
**Verify:** push from a box through a local hub and through a control box; check ground truth
with `git ls-remote`, not the exit code.

---

## Step 7 — Services, rename, branches, url

- `services` / `services restart` → `GET|POST /api/v1/boxes/:id/services*`.
- `status <box> --set-name` → `POST /api/v1/boxes/:id/rename`.
- Branch pickers → `GET /api/v1/boxes/:id/branches` and `/projects/:id/branches`.
- `url` reads the endpoint fields off the enriched Box payload (Step 3) instead of probing the
  provider; `screen`'s VNC URL likewise.
- Shared core (`boxServicesStatusRaw`, `boxRestartService`) is untouched — caller moves only.

**Files:** `commands/{services,status,url,screen}.ts`, `hub-api-client.ts`.
**Verify:** `agentbox services <box>` matches `agentbox status <box>` for a box with a declared
`expose:`, both paused and running.

---

## Step 8 — Create, queue and jobs

The biggest step; it collapses two queues into one client-facing route.

- `POST /api/v1/boxes` accepts `projectId` **or** `repoUrl`. Internally it keeps the fork that
  already exists in `hub-backend.ts:create`: a resolvable local workspace goes to the file queue
  (`enqueueQueueJob` → `_run-queued-job`), no workspace goes to the control-plane queue
  (`createViaControlPlane` → `create-worker.ts`). Same route, same response contract
  (`202 {jobId}`) — this *is* the "same interface, different behavior inside" pattern.
- **Always push seed material first** (`packages/sandbox-cloud/src/custody-seed.ts`, hash-skipped
  so an unchanged tree costs nothing). Today only `--via-hub` does, which is why a web-UI create
  can come up missing `.env`/untracked files.
- `create` / `claude` / `codex` / `opencode` become one path: seed push → `POST /api/v1/boxes` →
  stream `GET /api/v1/jobs/:id/logs`. Retire `control-plane/hub-enqueue.ts` and
  `control-plane/route-create.ts`.
- `queue` and `hub jobs` → `/api/v1/jobs`. One queue view.
- Keep the Claude login-code affordance (`POST /api/v1/jobs/:id/login-code`) — the one
  interactive create affordance that must survive.
- Fix while here: give the hub's clone its own git-LFS credentials, or LFS repos silently break
  (already observed on hub-create smokes).

**Files:** `commands/create.ts`, `commands/_cloud-agent-via-hub.ts`,
`control-plane/{hub-enqueue,route-create,hub-jobs}.ts`, `commands/queue.ts`,
`apps/hub/app/(dashboard)/api/v1/boxes/route.ts`, `apps/hub/lib/hub-backend.ts`.
**Verify:** `agentbox create -y -n smoke` against a local hub (docker) and a control box (e2b),
watching `~/.agentbox/logs/create.log`; confirm a `.env` present only in the working tree arrives
in the box in **both** cases.

---

## Step 9 — Fleet gaps: checkpoint, prune, agent state, logs

The remaining operations with no route at all. These are fleet-level, not IO, so they move now.

- `POST /api/v1/boxes/:id/checkpoint`, `GET|DELETE /api/v1/checkpoints?project=` over the
  existing `provider.checkpoint.*`.
- `POST /api/v1/prune` over `pruneBoxes` + the reap; `agentbox prune` drops its separate
  `reapSandboxesOnControlBox`.
- `GET /api/v1/boxes/:id/agent` — agent activity / session titles from the box status snapshot.
- `GET /api/v1/boxes/:id/logs` (SSE), reusing `apps/hub/lib/job-log-stream.ts`.

**Files:** new routes under `apps/hub/app/(dashboard)/api/v1/`, `apps/hub/lib/hub-backend.ts`,
`commands/{checkpoint,prune,agent,logs}.ts`.
**Verify:** create a checkpoint through the API, create a box from it, and confirm
`agentbox prune -y` leaves the checkpoint tag intact (it is a durable project asset).

---

## Step 10 — Custody onto `/api/v1`

- `hub credentials push|pull`, `hub secrets push`, `hub custody list|pull|rm` and the project seed
  push move from `/admin/custody/*` to `/api/v1/custody/*` (the GET manifest already exists; add
  the write verbs with the same metadata-only contract — paths, hashes, sizes, never bytes).
- Keeps the tray and web able to drive custody, and removes the CLI's last routine `/admin` use.

**Files:** `control-plane/custody-client.ts`, `commands/control-plane.ts`,
`packages/relay/src/custody/routes.ts`, new v1 route.
**Verify:** `agentbox hub credentials push` then `pull` round-trips against a local hub and a
control box; `hub custody list` shows hashes only.

---

## Step 11 — Retire the second implementation and the internal client wire

The consolidation payoff.

- Delete the now-dead CLI modules: `control-plane/{hub-list,hub-merge,list-merged,hub-enqueue,
  route-create,route-prepare,reap}.ts` and `admin-client.ts`'s client-facing surface.
- `/admin/*` + `/remote/*` remain for **box→hub** and hub-internal traffic only.
- Add a guard test asserting `apps/cli` contains no client call to `/admin/` or `/remote/`.
- Sweep `hub-backend.ts` for the "mirrors the CLI" comments and delete them — there is one
  implementation now.

**Verify:** `pnpm test` + `pnpm typecheck`; the guard test fails if anyone reintroduces an
internal-wire client call.

---

## Step 12 — Docker off under a remote hub

- When `relay.controlPlaneUrl` is set: drop `docker` / `remote-docker` from provider pickers,
  `doctor`, `prepare` and `create`; filter docker boxes out of `ls`, with one clear message
  naming the config key that re-enables them. Add `hub.mode: 'auto' | 'thin' | 'local'` to
  `KEY_REGISTRY` (`packages/config/src/types.ts`) as that key — a config key, not an env var.
- Move `ensureHub` / `getHubStatus` / `HUB_TOKEN_FILE` out of `@agentbox/sandbox-docker` into
  `packages/sandbox-core`, so a docker-free host never imports docker machinery to start a hub.
- Sever `refreshAgentCredentialsBackup`'s docker-shared-volume reach-in from the cloud path.

**Verify:** with a control box configured, `create --provider docker` refuses with the named key,
docker boxes vanish from `ls`, and `agentbox hub start` works on a machine with no docker.

---

## Step 13 — Gate `--dangerously-with-credentials` off under a remote hub

It exists as the alternative to a remote hub — a box holding a **copy** of your git credentials
so it can push with the laptop off, at the cost of those credentials living inside the box and
its snapshots. With a control box configured, token leasing (`git.lease-token` +
`packages/relay/src/github-app.ts`) does the same job without the copy, so the credential copy is
pure downside. Without a remote hub it stays exactly as it is today.

- Refuse `--dangerously-with-credentials` and `git.pushMode=direct` when `relay.controlPlaneUrl`
  is set, with a message naming leasing as the replacement — not a generic "unsupported". Same
  gate for `agentbox connect`'s post-create equivalent.
- Keep the existing guards intact: cloud-only, TTY-required (no `-y`/env bypass), incompatible
  with `-i` background runs. It is already refused with `--via-hub` (`commands/opencode.ts:745`)
  — that check becomes redundant once the broader gate lands, so fold it in rather than leaving
  two guards to drift.
- `git.pushMode` resolution (`auto` → lease when `relay.controlPlaneUrl` is set, else relay)
  needs no change; only the `direct` opt-in is gated.

**Files:** `apps/cli/src/lib/git-creds-gate.ts`, `commands/{create,opencode,connect}.ts`,
`packages/config/src/types.ts` (key doc for `git.pushMode`).
**Verify:** with a control box configured, `agentbox create --dangerously-with-credentials`
refuses and names leasing; unset `relay.controlPlaneUrl` and the same command still works
end-to-end. Check ground truth with `git ls-remote`.

---

## Step 14 — Docs and tray

- Update `apps/web/content/docs/{api,deployed-hub,configuration,cli}.mdx` and
  `docs/{architecture,cloud-providers,hub-testing,create-and-checkpoints}.md` as each step lands
  — stale public docs are a bug, so do not batch this to the end.
- Extend `apps/hub/app/(dashboard)/api/v1/lib/openapi.ts` with every route added, plus the
  shipped-but-undocumented ones (`rename`, `open`, `open-targets`, `hosts`, `login-code`).
- The tray already shells `agentbox hub target --json` and speaks `/api/v1`; it needs the enriched
  Box payload from Step 3. Update `../agentbox-tray` and push straight to `main`.
- Fix the stale claim in `CLAUDE.md` that `/api/events` is cookie-only — Bearer works
  (`apps/hub/proxy.ts:20,76`).

---

## What this leaves on the laptop

With a remote hub configured and these steps landed, the laptop runs **no long-lived agentbox
process**: the local hub is never the target, and a hub-created box has `topology:
'control-plane'` so it forwards `/rpc` to the control box and never calls home. The control box
runs the poller, approvals, status store, keepalive and autopause.

Two consequences that follow from the control-plane topology and are worth stating plainly:

- **"The host" means the control box for anything box-initiated.** An agent calling `cp.toHost`
  or `download.workspace` lands files on the VPS; `browser.open.mirror` is meaningless there.
- **`status.json` and credential fanout move with it** — the box reports to the control box's
  relay, so its status snapshot lives on that disk.

Durable local state reduces to: the hub URL + key, `~/.agentbox/projects/<hash>/meta.json` (the
checkout ↔ hub-project join plus seed hashes), the agent-credential backups, and — until the IO
plane moves — `secrets.env` and the adopted box records.

---

## Cross-cutting verification

Per [`hub-testing.md`](./hub-testing.md), cheapest first. Every step should be checked in **both**
modes — that is the whole point.

1. `pnpm test` then `pnpm typecheck` (tsup transpiles without typechecking; CI runs tsc).
2. **Local hub** — rebuild and restart it first or you are testing stale code:
   `pnpm --filter @agentbox/hub build:standalone`, then
   `AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart`
   (a bare `hub restart` respawns the stale staged bundle).
3. **`agentbox hub expose --tunnel cloudflare`** on this machine — exercises the real remote-hub
   code path (password profile, `AGENTBOX_HUB_API_KEY`, cloud boxes reaching back) in seconds,
   for free.
4. **A real control box** for the steps that touch create, custody and adoption.
5. Verify ground truth, not exit codes — `git ls-remote` after a push, `ls` in the box after a
   `cp`. Exit codes are unreliable on some providers.
6. Isolate `$HOME` for any test that touches `~/.agentbox` — `apps/cli` tests have no HOME
   isolation and will hit the real one.
