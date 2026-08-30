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
`drive` keep talking to the provider/box from the laptop. Two consequences, both
intentional:

> **`screen` has since moved behind the API on every provider** (it was originally
> hub-served for docker only). `GET /api/v1/boxes/:id/vnc` mints the viewer URL —
> a cloud box's signed preview URL expires, so it cannot ride the box payload and
> must be resolved per click. The provider-direct path survives only for
> `--loopback`, which by definition means "this machine", and as the fallback when
> no hub owns the box.

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

## Step 1 — Providers: `login` + `prepare` ✅ done

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

**Landed.** `prepare` always bakes through the hub now: `runPrepare` → `runPrepareViaHub` →
`bakeViaHub` (`control-plane/hub-prepare.ts`) does `POST /api/v1/providers/:id/prepare` +
`streamJobLog` + polls `getJob` for the terminal verdict (a dropped SSE stream never reads as a
successful bake — the poll is the source of truth). `control-plane/route-prepare.ts` (the old
remote-only router) and its two tests (`route-prepare.test.ts`, `prepare-location.test.ts`) are
deleted. Login publishes the credential to the hub via a one-slot hook in `@agentbox/sandbox-core`
(`credential-publish.ts`, unit-tested) that the CLI installs at startup (`index.ts` →
`publish-credentials.ts` → `HubApiClient.setProviderCredentials`) — **while still writing the local
`secrets.env`**, the deliberate + temporary dual write (the IO plane is direct, so the PC needs the
credential for `cp`/`attach` on SDK providers). `doctor` and `prepare --status` read the control
box's inventory from `GET /api/v1/providers?freshness=1` (`renderControlBoxProviders`), gated to a
genuinely-remote hub. **Verified end-to-end** against a local hub: `prepare --provider docker` ran
the bake in the hub's queue worker (`docker lane 1/1`), pulled + tagged `agentbox/box:dev`, and wrote
`~/.agentbox/docker-prepared.json` on the hub's machine; the co-located path reported `prepared
docker` with no custody round-trip. `POST /api/v1/providers/e2b/credentials` validated (`{ok:true}`)
and rejected an empty key (`invalid_request`).

**Notes for later steps:**

- **Routing flags vs bake inputs — only the two routing flags were removed; the bake inputs travel
  through the widened route contract.** `--local` / `--via-hub` chose *where* to bake and are
  meaningless under "prepare always goes through `/api/v1`", so they are gone. `--build` / `--size` /
  `--location` / `--name` are *inputs to the bake itself*, so per the plan's design rule (same path,
  same interface, behavior difference inside the route) the contract was **widened** to carry them
  rather than dropping user-facing capability. The full path now threads them end-to-end:
  `prepare` flags → `HubApiClient.prepareProvider` body → `parseProviderPrepare`
  (`api/v1/.../prepare/route.ts` validation) → `prepareProvider` (hub-backend) → `enqueuePrepareJob`
  → `QueueJobPrepare` (`packages/relay/src/queue.ts`) → the worker
  `apps/cli/src/commands/_run-queued-prepare.ts`, which passes them into `provider.prepare`. When a
  flag is **absent**, the worker fills it from the hub's own effective config —
  `resolveBoxSize` (`box.size<Provider>`), `resolveDaytonaClass` (`box.daytonaClass`),
  `resolvePrepareLocation` (`box.hetznerLocation` / `box.digitaloceanRegion` / `box.daytonaRegion`, a
  new peer helper in `@agentbox/config`), `box.daytonaVmBaseImage`, and `box.imageRegistry` (now for
  docker **and** daytona; the worker previously resolved it for docker only, which would have starved
  a daytona `linux-vm` bake). `--build` maps to `allowPull: false`. **The queue files
  (`queue.ts`, `_run-queued-prepare.ts`) are nominally Step 8's, but the maintainer authorized editing
  them here** to fix this rather than ship a capability regression, since nothing was running in
  parallel. Config-fallback semantics: a remote control-box bake uses the *control box's* config pins
  for anything you don't pass explicitly (it owns its snapshots), consistent with how the worker
  already treats `box.claudeInstall` / `box.imageRegistry`. Public docs (`cli.mdx`, `daytona.mdx`,
  `e2b.mdx`, `hetzner.mdx`, `deployed-hub.mdx`) document the flags as working in both modes.
- **The choice is WHICH HUB, not hub-vs-inline — Steps 5 and 8 will hit this same fork.** When
  "always go through `/api/v1`" deletes an inline path, the cases the inline path used to handle
  (`cloud.viaHub=false`, a local-only provider, a control box that can't reach a resource) do **not**
  come back as an inline escape hatch — that would reintroduce the second implementation the whole
  effort exists to delete. They come back as **target selection**: the same one client + one route,
  pointed at the **local hub** instead of the remote control box. `resolveHubTarget` /
  `resolveHubApiTarget` / `resolveHubApiClient` now take **`preferLocal`** — that is the reusable
  "which hub" knob. `prepare`'s selector is the pure, unit-tested
  `resolvePrepareTargetKind` (`commands/prepare.ts`, `test/prepare-target.test.ts`): local wins when
  the hub is co-located, `cloud.viaHub=false` (the config **key** survives the flag removal — my
  earlier "`--local`/`--via-hub` are safe to delete" was about the FLAGS only), the provider is
  `docker` (its base is a local image), or a `remote-docker` alias the control box doesn't know but
  the local hub does (was a Bugbot **High** — a control-box `POST /hosts/:alias/bake` would 404;
  it now falls back to the local hub, same route, different base URL). Choosing local **is** the
  `coLocated` signal (its artifact lands here → no custody round-trip). **Step 5 (lifecycle) and
  Step 8 (create) must reuse `preferLocal` for the equivalent forks (`cloud.viaHub`, docker/
  remote-docker, an unreachable resource) rather than resurrecting a direct-provider path.**
- **`preferLocal` means "prefer the LOOPBACK target", NOT "jump to the plain local hub token"
  (Bugbot **Medium**, and the identical trap for any future "use the local hub" shortcut).** A
  `hub expose`-d machine's hub is on THIS machine yet runs the **password profile** — its `/api/v1`
  authenticates with `AGENTBOX_HUB_API_KEY` over loopback, not the plain `~/.agentbox/hub/token`. So
  `preferLocal` must reuse the Step-0 ladder verbatim: `localExposedLoopbackUrl()` **first** (mode
  `remote` + API key over loopback), and only when the machine is **not** exposed fall through to the
  plain local hub + hub token. It skips **only** the configured *remote* control-plane URL. A first
  cut that short-circuited straight to `getHubStatus()` + the local token 401'd on an exposed machine
  — exactly the trap Step 0's own notes warn about ("token presence is not liveness; the exposed case
  is remote-shaped-but-local"). `hubIsCoLocated()` already got this right (it checks
  `localExposedLoopbackUrl()`); `preferLocal` needed the same. Guarded by
  `test/hub-target-prefer-local.test.ts`. **Any later step adding a local-hub shortcut must keep the
  exposed/loopback branch ahead of the plain-token branch.**
- **The login → hub credential push is best-effort, quiet, and non-spawning.**
  `publish-credentials.ts` resolves the hub target with `{ quiet: true }` (no print, and — crucially
  — no local-hub auto-start: a login must not start a daemon as a side effect), `hostReachable`-probes
  before the POST, and never throws (the local `secrets.env` write is the guaranteed outcome). Only
  the **interactive** `ensureXCredentials` publishes — never the headless `setCredentials` the hub
  itself drives, or the POST would loop back into the hub. When a control box is configured but the
  push fails, it warns (the push isn't cosmetic there — the control box needs the credential to build
  cloud boxes); a pure-local user with a stopped hub gets no noise. The dual write is temporary; it
  goes away when the IO plane moves behind the hub (see "Explicitly out of scope").
- **Co-location is decided by `hubIsCoLocated()`** (`commands/prepare.ts`): `resolveHubTarget().mode
  === 'local'` OR `localExposedLoopbackUrl()` is non-null (a `hub expose`d machine is `mode: 'remote'`
  yet co-located). Co-located → `bakeViaHub({ coLocated: true })` skips the custody round-trip (the
  worker already wrote the prepared-state to this machine); genuinely remote → adopt the record back
  from custody. `doctor` / `prepare --status` reuse the same gate so a co-located hub never mislabels
  its own local rows as a "control box".
- **Docker prepare under a remote hub still routes to the control box** (the general hub-routing).
  Making `docker` / `remote-docker` bake locally even when a control box is configured — because their
  base is a local image, not a control-box snapshot — is **Step 12** (docker off under a remote hub),
  not this step. `bakeViaHub` already special-cases `remoteHost` (a `docker:<alias>` host bake goes to
  `/hosts/:alias/bake` and needs no adoption), but plain `docker` follows the standard route.
- **`bakeViaHub` surfaces failures as a thrown `Error`, not via the exit-code carry.** A hub-side
  precheck failure (no credentials there, docker down) comes back as an `HubApiError` whose `.message`
  is surfaced verbatim; a failed job throws so the command's top-level handler prints it. It does not
  need Step 6's `error.details.exitCode` carry (that is for faithful box-command exit codes on git
  ops). If a later step wants `prepare` to exit with a provider-specific code, wire the carry in then.
- **`prepare --name` was NOT actually missing** (a follow-up PR checked, base `feat/cli_api_consolidation`).
  A prior review flagged the `-n, --name` flag as never re-added after Step 1 widened the contract, but
  the flag is present (`commands/prepare.ts`) and threaded end-to-end (`opts.name` → `runPrepare` →
  `runPrepareViaHub` → `bakeViaHub` → `HubApiClient.prepareProvider({name})` → request body → `QueueJobPrepare`).
  The follow-up added `packages/relay/test/queue-prepare-name.test.ts` asserting `enqueuePrepareJob({name})`
  lands `prepare.name` on the persisted job manifest (a Daytona bake can't run in a unit test), and
  otherwise made no change here.

---

## Step 2 — Approvals ✅ done

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

**Landed.** All three approval clients speak `/api/v1` now, keyed by the hub API key (or the local
hub token) — the CLI holds **no** admin-token client for approvals. `agent approvals`/`approve` go
through `HubApiClient.listApprovals`/`answerApproval` (`hub approvals` already did). The **attach
footer** moved off `/admin/prompts/stream` onto a new payload-carrying `/api/v1` route,
`GET /api/v1/boxes/:id/prompts/stream` — a Next route that reaches the relay handle's in-process
`PromptSubscribers`/`PendingPrompts`/`BoxNotices` through a new `globalThis.__AGENTBOX_HUB_PROMPTS`
seam (set by `server.ts`, keeping `@agentbox/relay` out of Next's bundle). It emits the same
`prompt-ask`/`prompt-resolved`/`notice-set`/`notice-clear` events the old admin stream did, gated by
proxy.ts exactly like the rest of `/api/v1`; `subscribePrompts`/`postAnswer` (`prompt-client.ts`)
now hit it and `POST /api/v1/approvals/:id/answer` with the API key. `resolveBoxPromptSource`
(`box-plane.ts`) returns a `HubApiClient` + raw `{ baseUrl, apiKey }` (the low-level SSE needs the
latter), resolving `cloud.controlPlaneUrl` first (survives a config change) then the local hub for a
docker/no-plane box. **Verified end-to-end** on a **pure-local docker box**: a parked host-action
approval answered from (a) the footer's `POST /api/v1/approvals/:id/answer`, (b) `agentbox agent
approve`, and (c) the hub web UI (real browser click) — each fired `prompt-resolved` to the footer
stream and cleared `agent approvals`, and the box unblocked (the action landed, ground truth). The
in-box `git push` itself reached the hub and landed (`git ls-remote`).

**Notes for later steps:**

- **The footer + `agent approvals` now REQUIRE the full hub** (not a bare relay): the payload stream
  is a Next `/api/v1` route, which a bare `agentbox relay` doesn't serve. `resolveBoxPromptSource`
  auto-starts the local hub (`ensureHub`) for a docker/local box; `attachRelayOptions` degrades to a
  no-op footer if that fails (attach never breaks). This is the intended end-state ("the hub is the
  target").
- **The localhost hub now binds `0.0.0.0` (was `127.0.0.1`) — a required consequence of the above,
  and a real security surface to keep in mind.** Because the footer now depends on the hub, a docker
  box must reach the hub's embedded relay at `host.docker.internal:8787` for **every** box-initiated
  RPC (git push, `cp`, the prompt stream) — the bare relay it replaces already bound `0.0.0.0` for
  exactly this reason (`relay.ts`), so the hub had to match it or docker box→host RPC 502s. The bind
  host is now **decoupled from the profile**: `server.ts` defaults `AGENTBOX_HUB_PROFILE` to
  `localhost` independently of the bind (previously `host === 127.0.0.1 ? localhost : hetzner`), and
  `hub.ts` sets `HOST = '0.0.0.0'`. **Security invariants verified (empirically, against a wide-bound
  localhost hub):** `/admin/*` stays **loopback-only by peer address** — `adminGateAllows` fail-closes
  a non-loopback caller when no admin token is set, and the localhost hub sets none (a request from
  the container got `403 admin endpoints are loopback-only`, loopback got `200`); the Web UI and
  `/api/v1` stay Bearer/token-gated with **only** `/api/v1/{health,openapi.json,docs}` public (all
  others + `/api/events` + `/` → `401` without a token). So the net-new LAN surface vs. the bare relay
  is the token-gated UI + `/api/v1`, not the relay wire. **Step 12 (docker-free remote hub) must keep
  this invariant** if it ever runs the localhost hub loopback-only again.
- **Subscriber counting + the durable floor (the "laptop-closed" answer).** The host-action no-sub
  gate (`host-actions.ts`, for **git.push / gh.pr / vercel+hetzner checkpoint** — NOT `cp`/`download`,
  which always park) moved from `subscribers.forBox(id).length` to `subscribers.count(id)`, which sums
  raw SSE writers **+ callback listeners** (the footer is a callback listener now, via the seam — a
  `forBox().length` check would no longer see it and would silently auto-**deny**) **+ a process-wide
  durable floor**. `server.ts` calls `setDurableFloor(1)` **only on the password profile** (a control
  box): its always-on Web UI + `/api/v1/approvals` are a durable place to answer, so a laptop-closed
  git.push **parks** instead of auto-denying. A plain localhost hub keeps floor 0 (the user is
  present; an unattended local box shouldn't wedge). Unit-tested in `prompts.test.ts`. A docker box
  can't e2e this gate — its scratch-branch push auto-approves — so the floor's live proof is the unit
  test + the password-profile gate. **Interaction to know:** because the floor keeps `count() > 0`,
  a control box always takes the has-subscriber (park) branch, so the `AGENTBOX_GIT_PUSH_NO_SUB`
  (and `AGENTBOX_GH_NO_SUB`) `allow`/`deny` env knobs are **inert there** — parking is the point, and
  true autonomous auto-approve is the per-box `box.autoApproveHostActions` opt-in (checked earlier in
  `askPrompt`, before the subscriber count), not the env knob. The knobs still apply on a plain
  localhost hub (floor 0).
- **Parked prompts have NO TTL — the box waits INDEFINITELY (a decision worth stating, not fixed
  here).** The normal has-subscriber/durable-subscriber `askPrompt` call sites (git.push:1449,
  gh.pr:523/594, cp:1002, download:1064) pass **no `ttlMs`**, so the parked in-box RPC blocks until
  someone answers — forever if nobody does. Only the `*_NO_SUB=prompt` fallbacks (516/590/1442) get a
  5-min TTL, and the optional `browser.open` mirror offer is TTL'd. Consequence on a control box: with
  the durable floor a git.push nobody ever answers stalls that box silently and forever. **If a later
  step wants a bound, add a `ttlMs` to the block-mode gates** (resolving to `defaultAnswer` + a
  `notice`), rather than relying on the no-sub fallback that the floor now bypasses.
- **`cancelled` was widened into the v1 contract, not dropped.** `agentbox agent approve --cancel`
  marks a dismissal distinctly from a plain deny in the audit trail. `POST /api/v1/approvals/:id/answer`
  now accepts `{ answer, cancelled?: boolean }` (`parseAnswer` → `backend.answerApproval(id, answer,
  cancelled)` → `prompts.resolve(id, answer, cancelled)`); `HubApiClient.answerApproval` + the footer's
  `postAnswer` thread it. Same "widen the contract, don't delete capability" rule as Step 1.
- **`resolveBoxPlane` (admin-token, for `reap.ts`) was kept intact** — Step 2 added a parallel
  `resolveBoxHubTarget` (hub API key) for the prompt source rather than repurposing it, so the destroy
  reap path is untouched.
- **`dashboard.ts` + `compositor.ts` were touched (out of Step 2's stated set) only to follow the
  rename** (`relayBaseUrl`/`relaySourceFor`/`authToken` → `hubBaseUrl`/`hubSourceFor`/`apiKey`) — the
  dashboard TUI's footer rides the same `subscribePrompts`/`postAnswer`, so it migrated to `/api/v1`
  with the attach footer. Its per-box resolve is `quiet` (no autostart spinner mid-TUI); the dashboard
  ensures the local hub once before entering the compositor.

**Files:** `commands/agent.ts`, `control-plane/box-plane.ts`, `control-plane/hub-api-client.ts`,
`wrapped-pty/{prompt-client,run}.ts`, `commands/dashboard.ts`, `dashboard/compositor.ts`,
new `apps/hub/app/(dashboard)/api/v1/boxes/[id]/prompts/stream/route.ts`, `apps/hub/server.ts`,
`apps/hub/global.d.ts`, `apps/hub/lib/{hub-backend,boxes/backend-types}.ts`,
`api/v1/{approvals/[id]/answer/route,lib/validate,lib/openapi}.ts`,
`packages/relay/src/{prompts,host-actions}.ts`, `packages/sandbox-docker/src/hub.ts`.
(`commands/control-plane.ts`'s `approvalsSub` was already on `/api/v1` from an earlier step — untouched.)

---

## Step 3 — Listing (`ls` / `list`) ✅ done

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

**Landed.** `agentbox list` now reads `GET /api/v1/boxes` only (via `fetchBoxListing`), renders
straight off `HubApiBox`, and has no merge path. `hub-merge.ts` / `list-merged.ts` were **kept**
(not deleted) because `dashboard.ts` still consumes `listBoxesMerged`/`MergedBox` at runtime — see
the deferred-deletion note below. The `/admin/store` branch is gone from `list`'s path; the offline
cache (`~/.agentbox/hub-boxes-cache.json`) is re-keyed onto the API `{ boxes }` payload.

**Notes for later steps:**

- **Enriched Box payload — the field map Steps 4 & 7 build on.** `HubApiBox` (client:
  `hub-api-client.ts`; server view model: `apps/hub/lib/boxes/types.ts` `Box`) now carries, in
  addition to the pre-existing display fields, an **adoption/reconstruction block** populated on
  cloud rows only (all `undefined` for docker + synthetic `job:` rows): `sandboxId`, `originUrl`,
  `publicHost`, `image`, `webPort`, `previewUrls: Record<number,string>`, `lastAgent`, `topology`,
  plus `branch` and `shellCount`. These are the non-secret inputs `registrationToBoxRecord`
  (`packages/relay/src/registration-to-record.ts`) needs when Step 4 rebuilds a `BoxRecord` from
  the payload alone.
- **What is deliberately NOT on the payload (Step 4 must re-mint / fall back):**
  - **Secrets are never serialized** — the relay/bridge/preview **tokens** and the concrete
    `previewUrl` (as opposed to the `previewUrls` port map) are re-minted host-side via `freshToken`
    in `registrationToBoxRecord`. Do not try to carry them on the Box; adoption already re-mints.
  - **`sanctionedBranch`** is not a distinct payload field; `registrationToBoxRecord` falls back to
    `branch` (`workspaceBranch`) when it is absent, which is correct for every box we create.
- **`--live` is now server-side (`GET /api/v1/boxes?live=1`).** Mirrors the `GET /api/v1/providers?freshness=1`
  opt-in-expensive pattern: on the in-process host topology it runs an authoritative
  `provider.probeState(box)` per **cloud** box (docker skipped) with a 4s per-box timeout, best-effort,
  before mapping. The Postgres/plane topology ignores `live` (no credentials there). Rationale: a
  cloud box's persisted `lastState` can lie (a platform-side stop is invisible), and the hub is now
  the only place holding provider credentials — so the flag had to move server-side rather than be
  dropped. **Follow-up (hub-side, not blocking a step):** `applyLiveCloudStates` only probes boxes
  that come through `mapBox(ListedBox)` (the in-process host backend). Registered-only boxes mapped
  by `mapRegistrationToBox` are not live-probed today; wiring a probe there is a hub follow-up once
  Step 4's resolution route exists.
- **Thin-client project scope needs `originUrl` at registration (Bugbot #281, High).** Project-scoped
  `ls` (no `-g`) matches a box to the cwd's repo by two keys: `projectRoot === root` (same-machine
  folder match) and, cross-machine, repo identity (`originUrl`). The client predicate `boxInProject`
  (`list.ts`) scopes by `originUrl` when a box's `projectRoot` names **no local directory** (an
  `existsSync` probe) — that path is a remote hub's own, so folder matching would drop it. The old
  `projectRoot === undefined`-gated origin branch silently dropped every control-box-created box from
  a thin client's scoped view. The filesystem probe (not the hub URL/mode) is deliberate: it is the
  only signal that disambiguates the two loopback cases — our own `hub expose` (same machine, boxes
  have real local projectRoots → folder scope) vs a genuinely remote hub reached over an SSH tunnel to
  `127.0.0.1` (foreign projectRoots → origin scope). `mapBox` now threads each box's registration
  `originUrl` onto the payload (previously cloud-only). **Residual, genuinely cross-step:**
  `registerBoxWithRelay` (`packages/sandbox-docker/src/create.ts`, and the cloud create paths) does
  **not** send `originUrl` today, so only `--via-hub` creates (which pass `repoUrl`) carry it; a plain
  docker/direct-cloud box still has no origin to scope by. Capturing `originUrl` at registration for
  **every** provider is a provider-create-flow change outside Step 3's file set — fold it into
  **Step 4** (thin-client box resolution/adoption), where cross-machine box identity is the core
  concern. The `list.ts` + `mapBox` pieces here are correct and inert until then.
- **Deferred deletion (was in this step's brief, punted with sign-off).** `hub-merge.ts`,
  `list-merged.ts`, and `hub-list.ts`'s `fetchHubListing` (the `/admin/store` **admin** listing, not
  the `ls` path) survive because `dashboard.ts` (the IO-plane TUI, out of Step 3's file set) still
  imports them at runtime. Converting `dashboard.ts` onto `/api/v1` and then deleting these three is
  **Step 7/11 cleanup**. To avoid a cache-schema collision in the meantime, `fetchHubListing`'s cache
  was repointed to `~/.agentbox/hub-registrations-cache.json` (the `{ registrations }` schema),
  leaving `hub-boxes-cache.json` exclusively the new `{ boxes }` API cache.

---

## Step 4 — Box resolution (adoption kept, re-sourced) ✅ done

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
- **Capture `originUrl` at box registration for every provider** (`registerBoxWithRelay` in
  `packages/sandbox-docker/src/create.ts` + the cloud create paths). Today only `--via-hub` creates
  send it, so Step 3's thin-client project scoping is inert for plain docker/direct-cloud boxes (see
  Step 3 note). This is the registration-side half of cross-machine box identity, so it belongs here.

**Files:** `apps/hub/app/(dashboard)/api/v1/boxes/route.ts`, `apps/hub/lib/boxes/resolve.ts` (new),
`apps/cli/src/control-plane/{auto-adopt,hub-adopt,hub-pull,hub-api-client}.ts`, `commands/hub.ts`,
`packages/sandbox-docker/src/create.ts` + `packages/sandbox-cloud/src/cloud-provider.ts` for
`originUrl` capture. Deleted `control-plane/match-ref.ts`.
**Verify:** on a control box, `agentbox shell <hub-created-box>` works first try with no explicit
adopt, for one SSH provider (hetzner) and one SDK provider (e2b).

**Landed.** `GET /api/v1/boxes?ref=<id|name|index>` resolves server-side via the pure
`resolveBoxRefView` (`apps/hub/lib/boxes/resolve.ts`) — `findBox` precedence on the topology-agnostic
`Box` view (exact id → unique id prefix → name → displayName → sandbox id / `cloud:<id>`), plus the
numeric project-index arm when `?project=` is given. It returns the **match set** as `{ boxes }` (0 =
none, 1 = unique, >1 = ambiguous prefix), so ambiguity is expressed rather than arbitrarily narrowed.
`HubApiClient.resolveBox(ref, project?)` is the client. **Resolution stays local-first**:
`resolveBoxOrExit` (`box-ref.ts`) is unchanged — it still runs the local `resolveBoxRef` and only on a
local miss calls `tryAutoAdopt`, which is what got re-sourced (from the `/admin/store` +
`matchRegistration` wire onto `resolveBox`). `adoptHubBox`/`pullBoxSshKeys` now take an
already-resolved `HubApiBox` and materialize it via the shared `registrationToBoxRecord`
(`hubBoxToRegistration` bridges the payload → `BoxRegistration`); the per-box SSH-key pull stays on
custody. `hub adopt`/`hub pull` resolve through `/api/v1` too. `originUrl` is now captured at
registration for docker (`create.ts`) and the classic-cloud create/resume paths (`cloud-provider.ts`),
the registration-side half of Step 3's cross-machine project scoping. **Verified end-to-end** against
a remote-shaped loopback hub (`relay.controlPlaneUrl` → `127.0.0.1`, `AGENTBOX_HUB_API_KEY`): a
registered-only e2b box resolved through the route and `agentbox url <name>` adopted it with no
explicit `hub adopt` — the materialized `BoxRecord` landed in `state.json` (topology `control-plane`)
and was **project-linked via its `originUrl`** to a local clone. Unit tests cover the resolver
(all match kinds incl. ambiguous + index), `adoptHubBox` (every provider shape, project linkage,
idempotency, no-custody), and `pullBoxSshKeys`.

### Notes for later steps

- **Local-first was kept; the plan's "resolveBoxOrExit resolves through that route" is realized as
  a fallback.** `box-ref.ts`'s logic is unchanged: the local `resolveBoxRef` still handles autopick /
  index / ambiguous offline (that is how the direct IO plane resolves a *materialized* record), and
  only a local **miss** hits the route via `tryAutoAdopt`. Routing every resolve through the hub would
  add a network dependency + latency to every box-arg command even for local boxes. Steps 5/7 (which
  also take a `[box]` arg) should keep resolving locally and reuse `resolveBoxOrExit` — the box is
  already materialized by the time a lifecycle/services op runs.
- **The fallback gate is `resolveHubTarget().mode === 'remote'`** (a configured control box, or a
  `hub expose`-d loopback), reusing Step 1's exposed-loopback-first ladder — never a second resolver.
  A plain local hub (`mode: 'local'`) is deliberately **skipped**, so a typo on a laptop with no
  control box never round-trips or auto-starts a daemon (matches the old `resolveCustodyTarget`
  gating). **Edge, believed unreachable in practice but stated so a later reader need not re-derive
  it:** a registered-only box that exists in a *plain local hub's* store but not in `state.json` would
  not be found by name, because the fallback is skipped in local mode. This does not happen in
  practice — a hub-UI create on a local hub writes the same machine's `state.json`, and a *foreign*
  machine registering a box requires `hub expose` (which is `mode: 'remote'`). If a future feature can
  produce a registered-only box on a plain local hub, this gate must widen to "a live local hub with
  registered boxes" without reintroducing typo-time auto-start.
- **SSH keys still ride the custody (`/admin`) surface** (`downloadBoxSshKeys` via `CustodyClient`).
  Step 4 re-sourced only the *resolution*; moving the SSH-key pull onto `/api/v1/custody` is **Step
  10**. `adoptHubBox`'s `custody` arg is optional — a thin client with an API key but no admin token
  adopts the record (and `url` works), and an SSH provider is flagged `sshKeysMissing` rather than
  failing opaquely later.
- **`originUrl` capture touched Step 8's create files (`create.ts`, `cloud-provider.ts`).** Kept to
  the `originUrl:` argument alone (a best-effort `git remote get-url origin` read) so Step 8 rebases
  cleanly. The control-plane cloud path (`registerBoxWithPlane`) already sent it; only docker + the two
  classic-cloud `registerBoxWithRelay` calls were missing it.
- **`matchRegistration` (`control-plane/match-ref.ts`) is deleted** — ref matching is server-side now.
  `_cloud-agent-via-hub.ts` (Step 8's file) and `recover.ts` were updated to the new signatures:
  the former resolves the just-created box via `resolveBox` before adopting; the latter calls
  `downloadBoxSshKeys` directly (it already holds the local record's provider + sandbox id).
- **Env caveat for e2e (not a code gap):** the memory-heavy Next standalone hub intermittently stalls
  its `/api/v1/boxes` route (which calls `docker ps` through `getData`) under this dev VM's memory
  pressure, while `/health` stays green. Retry once warm; it is unrelated to the resolution code.

---

## Step 5 — Lifecycle ✅ done

- `start`, `stop`, `pause`, `unpause`, `destroy`, `screen` → `POST /api/v1/boxes/:id/<action>`.
  The routes exist and are exercised today only by `hub boxes <action>`.
- Delete the `hub boxes start|stop|pause|resume|rm` subcommands — the top-level commands now do
  the same thing in both modes.
- `destroy`: the route already does provider destroy **plus** store/custody reap
  (`hub-backend.ts:1537`), so drop the CLI's separate `reapOnControlBox` call.
- Reconcile the drift the hub backend documents: decide whether `start` restores agent tmux
  sessions (CLI does, hub doesn't) and make the route the single answer.

**Files:** `commands/{start,stop,pause,unpause,destroy}.ts`, `commands/control-plane.ts`,
`control-plane/hub-api-client.ts`, `apps/hub/lib/hub-backend.ts`, `apps/hub/lib/boxes/backend-types.ts`,
`apps/hub/app/(dashboard)/api/v1/boxes/[id]/[action]/route.ts`,
`packages/sandbox-docker/src/docker-provider.ts`.
**Verify:** full lifecycle round-trip on docker via local hub and on e2b via control box;
`destroy` leaves no orphan registration (`agentbox hub boxes list`) and no orphan sandbox.

**Landed.** The five lifecycle commands (`start`, `stop`, `pause`, `unpause`, `destroy`) now go
through `withHubClient` → `client.lifecycle/destroy` (`POST /api/v1/boxes/:id/<action>`), so they run
identically against a local hub and a remote control box — one server-side implementation. `unpause`
maps to the hub's `resume` action. The `hub boxes start|stop|pause|resume|rm` group is deleted;
`hub boxes list` stays as the PC's admin view. `destroy` drops the CLI's `reapOnControlBox` (the route
reaps store/custody itself). **`screen` was delivered by Step 7** (it landed first and owns
`commands/screen.ts` + the VNC URL resolution); it routes `screen`'s lifecycle through
`client.lifecycle('start')` on the docker payload path rather than a `screen` route, and keeps the
in-box browser prep client-side as box IO. On rebase onto Step 7 I therefore dropped my `screen`
changes (a `client.screen()` method + a hub-side `screen` auto-online) to avoid a redundant second
implementation — Step 7's is the single answer. **Verified end-to-end** against a **local hub** with
hard ground truth: a docker box round-tripped pause→`paused`, unpause→`running`, stop→`exited`,
start→`running` (each confirmed via `docker inspect`), and `destroy` removed the container, left **no**
`hub boxes list` registration, and dropped the local record. A real **e2b cloud box** (created
directly, driven through the same local hub) round-tripped pause→archived, unpause/stop/start
(SDK-verified `LIVE`), and `destroy` left **no orphan sandbox** (verified via the e2b SDK's own
`Sandbox.list()`), no registration, and no local record.

### The drift reconciliation (start / session-restore)

The hub backend confessed a drift: *"Unlike CLI `agentbox start` this does not restore agent tmux
sessions (restoreAgentSessions is CLI-only)."* **Decision: the route is the single answer for the
box's *compute* lifecycle, and restoring the agent session is NOT part of it — it is box IO.**
`restoreAgentSessions` reads the box's per-box session pointers and relaunches a detached tmux over
`provider.exec` — the same exec/attach plane the plan keeps client-side and explicitly out of scope.
So the route brings the box up/down, and the CLI layers `restoreAgentSessions` on *after* the route
returns, exactly as it layers its own-machine `autoWriteSshConfig`. The "restoreAgentSessions is
CLI-only" comment stops being a drift confession and becomes a stated architectural boundary (updated
in `hub-backend.ts` + `backend-types.ts`). A hub-UI/tray start therefore brings the box up and the
agent resumes on next attach — unchanged, and now correct-by-design rather than an accident.

### Notes for later steps

- **The client-side IO follow-up needs no fresh record — cloud exec re-resolves from `sandboxId`.**
  Moving `provider.start` into the route means the CLI no longer gets the refreshed `BoxRecord` that
  `provider.start` used to return. This is fine: every cloud IO path re-resolves its connection from
  the stable `sandboxId` at call time (hetzner `ensureLiveTarget`, e2b/vercel via the SDK), and
  `autoWriteSshConfig` re-resolves from the provider (not the record's stored IP). So `start`/`unpause`
  run their client-side `autoWriteSshConfig` + `restoreAgentSessions` against the pre-call record
  safely. Steps 7+ converting other post-lifecycle IO can rely on the same property rather than
  threading a refreshed record back through the route.
- **`preferLocal` was NOT needed here (unlike Steps 5-note-in-Step-1 anticipated).** Step 1's note
  said "Step 5 must reuse `preferLocal` for the `cloud.viaHub` / docker / unreachable-resource fork."
  In practice lifecycle has no such fork: a box already exists (it was created somewhere), so the
  right hub is simply *the hub that owns it*, which `resolveHubApiTarget` already resolves (local when
  no control box; the control box when configured). There is no "where should this run" decision to
  make the way `prepare`/`create` have. So the lifecycle commands use plain `withHubClient({})`. If a
  future multi-hub topology makes "which hub owns this box" ambiguous, revisit — but today it isn't.
- **`--keep-snapshot` travels on the destroy body (route widened, not flag dropped).** Per the plan's
  "widen the request rather than drop a flag" rule, `destroy`'s `--keep-snapshot` now threads
  `HubApiClient.destroy(id, { keepSnapshot })` → `POST /boxes/:id/destroy` body → `parseKeepSnapshot`
  in the `[action]` route → `HubBackend.destroy(id, { keepSnapshot })` → `provider.destroy(box, {
  keepSnapshot })`. **This surfaced a latent bug: `dockerProvider.destroy` ignored its `opts` entirely**
  (`destroyBox(box.id)` with no options), so `--keep-snapshot` was silently a no-op even before this
  step for any path routing through the provider. Fixed here (`docker-provider.ts`). The other
  lifecycle commands take no data-carrying flags, so no other route needed widening.
- **`reap.ts` was NOT deleted (the plan's "delete if nothing else imports it" resolved to "keep").**
  `reapOnControlBox` is still imported by `dashboard.ts` (the IO-plane TUI, out of this step's file
  set — Step 7/11 cleanup) and `reapSandboxesOnControlBox` by `prune.ts` (Step 9). Only `destroy.ts`'s
  call was removed. Whoever converts `dashboard.ts` off its inline destroy+reap (Step 7/11) and
  `prune`'s reap (Step 9) can delete `reap.ts` then.
- **ONE ownership predicate: `boxOwningHubIsLocal(box)` (`control-plane/with-hub.ts`) — use it, never
  a fresh `provider === 'docker'` check.** A lifecycle/destroy op can only be served by the hub that
  OWNS the box, and getting this wrong sends the op to a hub that never registered it (→ `not_found`,
  which the inline path never hit — so the hub-routing introduces the regression if unguarded). The
  predicate returns local-owned for **`docker`** (a local container) **and `remote-docker`** (a
  container on another engine, but registered with the LOCAL relay — the local hub drives it over SSH;
  Bugbot flagged the first cut that keyed on `docker` alone and mis-routed remote-docker). Cloud is
  owned by the configured hub. This lives in one place so a future provider is classified once and the
  predicate can't drift across the five call sites. **Later steps / earlier converted steps:** any
  code choosing "which hub" or "does this box have a real container" for a box op should call this
  helper — do not write a new `provider === 'docker'`; if an earlier step has one, fold it in here.
  (Note the SSH-config follow-up is a *different* gate — "reached over SSH", which is
  `!== 'docker'`/self-gating in `autoWriteSshConfig` — not ownership; don't conflate them.)
- **All five box ops route via `withOwningHub(box, op)` — uniform owner-first + other-hub retry.**
  `WithHubOptions` gained `preferLocal` (reusing Step 0's exposed-loopback-first ladder — the same knob
  `prepare` uses); `withOwningHub` wraps it: it runs `op` against the owning hub (via `withHubClient`,
  so version-gated + error-mapped), and on `not_found` retries the OTHER distinct hub (`runOpOnOtherHub`).
  `start`/`stop`/`pause`/`unpause` and `destroy` all use it, so "destroy works but stop doesn't" can't
  happen. On `not-found` from every hub the four lifecycle commands report via `reportBoxNotOnAnyHub`
  (exit 2); `destroy` is the exception — it keeps the record (see next).
- **The other-hub retry surfaces REAL errors — it does NOT swallow them (Bugbot Medium — fixed).**
  `runOpOnOtherHub` distinguishes three outcomes rather than a bare `catch → false`: `'ok'` (the retry
  hub did it), `'not-found'` (the retry hub genuinely doesn't own the box, OR it was
  unreachable/unresolvable — neither is proof of ownership, so the caller keeps the record / refuses),
  and `'error'` (a real `HubApiError` — conflict / auth / backend / internal — which it **reports**
  with the mapped exit code and the caller aborts). The first cut mapped *every* retry failure to "not
  found on any hub", masking a genuine conflict/auth/provider error as a missing box; only `not_found`
  and transport failures now collapse to `'not-found'`.
- **Destroy must NEVER drop the local record on a bare `not_found` (Bugbot High — fixed).** The laptop
  keeps an adopted `BoxRecord` + ssh alias for the direct IO plane; the route only cleans the **hub's**
  copy. My first cut treated any `not_found` as "already reaped" and dropped the local record — but
  `not_found` also means "this hub never owned the box", and there you have deleted the only handle to a
  possibly-still-running container/VM (silent success + state deletion is strictly worse than a clear
  failure). Via `withOwningHub` the record is dropped ONLY when some hub actually **reaped** the box; if
  no hub owns it, destroy **fails** (exit 2), keeps the record, and names `agentbox destroy <box>
  --force` as the deliberate way to drop a stale record. The pure decision `decideDestroy(outcome,
  force)` is unit-tested (`test/destroy-decision.test.ts`) — invariant "drop iff reaped or force";
  `boxOwningHubIsLocal` is unit-tested in `test/with-hub.test.ts`. **Reproduction gap:** the `not_found`
  refusal needs a *remote* hub — a co-located local hub shares `state.json`, so it always finds a box
  the CLI resolved and can't `not_found` it. Verified by the unit tests + code review; the common reap
  paths (docker + a real e2b box, ground-truth via `docker inspect` / the e2b SDK) are e2e-green. Later
  steps that move an *adopting/reaping* op behind the hub must reuse `withOwningHub` (or mirror its
  owner-first + never-drop-on-not_found discipline).
- **The hub's destroy `{ ok: true }` now means "provider teardown CONFIRMED", not "registration reaped"
  (Bugbot High — fixed, `hub-backend.ts`).** The old backend returned `{ ok: true }` whenever it reaped
  the Store registration, *even if `provider.destroy` failed* (no creds on the control box, provider
  unresolvable) — so the CLI's `ok → reaped → removeBoxRecord` dropped the only record of a **live**
  sandbox. The destroy method was restructured to three honest outcomes: box not found → reap any
  dangling registration but return `not found` (unconfirmed teardown; the CLI retries/refuses, keeps the
  record); `provider.destroy` **fails** → do NOT reap (keep the box visible + retryable) and return the
  error (the CLI aborts + keeps the record); `provider.destroy` **succeeds** → reap + `{ ok: true }`
  (the CLI drops the record). So `ok ⟺ the resource is actually gone`. **Live-validated:** with the
  hub's `E2B_API_KEY` broken, `agentbox destroy` on a real e2b box surfaced the provider error, **kept
  the local record, and left the sandbox running** (SDK-confirmed); restoring the key and re-running
  destroyed the sandbox + dropped the record. A hub-UI/tray destroy of a box the control box can't
  tear down now shows that error instead of silently orphaning the sandbox — more honest, and only the
  abnormal no-creds path changes.
- **The tmux-session-restore split (confirmed correct by the maintainer).** Route owns the box's
  compute lifecycle; the CLI restores the agent session *after* (box IO, direct plane); docker
  `unpause` needs NO restore because the cgroup thaw preserves the tmux session, while a cloud resume
  reboots the sandbox and kills it (so cloud unpause + start do restore). Keep this reasoning.
- **`screen` ended up entirely Step 7's, not split.** The plan listed `screen`'s lifecycle here and
  its URL resolution in Step 7. In practice Step 7 landed first and implemented the whole command in
  one coherent shape: the docker payload path brings the box online with `client.lifecycle('start')`
  (via a `getBox` state check) and keeps the in-box browser prep client-side as box IO; cloud stays on
  the provider path. There was no clean seam to insert a separate `screen` route/action without a
  redundant second implementation, so on rebase I dropped my `screen` pieces (`client.screen()` + a
  hub-side `screen` auto-online) and deferred to Step 7's. The generic `POST /boxes/:id/:action` route
  still validates `screen` for the hub UI/tray's VNC-prep call (unchanged, VNC-prep-only). If that
  UI/tray path ever wants auto-online too, add it to the hub `screen` action then.
- **`box.container` is `cloud:<sandboxId>` for cloud boxes — don't print it as a label.** A generalized
  `box.container ?? box.name` prints the ugly `cloud:ifrq…` for cloud rows (caught live on an e2b
  unpause). The lifecycle commands guard the container label by `provider === 'docker'`; any later
  command printing a box label should do the same (docker → `container`, else → `name`).
- **`destroy` lost the docker volume/snapshot accounting output.** The old inline docker path printed
  `✓ container removed / volumes removed / snapshot removed` from `destroyBox`'s detailed return; the
  route returns only `{ ok }`, so destroy now prints a single `destroyed <label>` line. Acceptable per
  the single-implementation goal; if the accounting is wanted back, the route/`ActionResult` would need
  to carry it.

**Not live-validated (documented gap, not a code gap): the `mode: 'remote'` transport via a
`hub expose`d control box.** `hub setup --deploy local` (which mints the API key + password profile)
requires a real GitHub token for the control box's own git credential, and this dev box only has the
agentbox `gh` relay shim (no real token, no github.com credential helper) — the same blocker Step 6
documented. The remote-mode client path is nonetheless exercised: it is the **identical**
`withHubClient` → `resolveHubApiTarget` wrapper Step 6 already validated end-to-end in `mode: 'remote'`
(controlPlaneUrl + `AGENTBOX_HUB_API_KEY` over loopback) for git ops on this same base branch. The
only lifecycle-specific remote-mode behavior — destroy's local-record cleanup — is a plain local state
op (`removeBoxRecord` + `syncAgentboxSshConfig`) that is a safe no-op when co-located; worth a
confirming pass against a real Hetzner control box when one is stood up.

---

## Step 6 — Git ✅ done

- `agentbox git push|pull|checkout|branch|push --host-only` → `POST /api/v1/boxes/:id/git/:op`
  (routes existed, unused by the CLI; now the CLI's path via `withHubClient` + `client.git`).
- `packages/sandbox-core/src/box-git.ts` stays the shared implementation — only the *caller*
  moved. The CLI stopped minting host-initiated tokens for these ops; the hub mints them via
  `hubGitDeps` (`hub-backend.ts`).
- `push --host-only` is definitionally host-checkout-bound: on a hub whose box has no host
  working copy it fails with the existing clear error (exit 64), not a cryptic `git -C` failure.

**Files:** `commands/git.ts`, `hub-api-client.ts` (`HubApiError.details` added), `with-hub.ts`
(exit-code carry), plus server-side parity: `hub-backend.ts` (`sanctionBranch` +
`gitOp` exit-code), `backend-types.ts`, `validate.ts` (`args`), `envelope.ts`,
`api/v1/boxes/[id]/git/[op]/route.ts`.
**Verified end-to-end (docker box, ground truth via `git ls-remote` on a local bare remote):**
- **Local mode:** `git push`, `git branch <box> foo` + push, and `git checkout` all land the
  branch on the remote. Sanctioning moved server-side is proven directly: `git checkout <box>
  <branch>` triggers a hub-backend re-register (`sanctionBranch`), after which an *in-box* push
  (no host token) to that branch auto-approves (no pending approval) and lands — the CLI never
  touches the relay registry.
- **Remote mode** (CLI pointed at the same hub as a `mode: 'remote'` target — `controlPlaneUrl`
  + `AGENTBOX_HUB_API_KEY`): `git push` lands on the remote, and — the case the correction is
  about — `git push <box> --host-only` **SUCCEEDS** even in remote mode, because the machine IS
  the host with the checkout. A `resolveHubTarget().mode` pre-check would have wrongly refused it;
  the code has none.
- **Exit-code carry:** a git failure surfaced the box command's real exit code faithfully
  (observed **128** for a host-only run whose host workspace was removed) rather than the coarse
  code→exit table's `conflict`=5 — proving `error.details.exitCode` round-trips through the
  `withHubClient` mapper for any value, including >6.

**Not reproducible in the dev sandbox (documented gap, not a code gap):** the *clean* exit-**64**
`--host-only is unavailable … no working copy` message comes from the cloud `runGitRpc` path,
which needs a **control-box-created cloud box** (empty registered `workspacePath`). That requires
`gh auth` for the control-plane git credential (absent here) and a machine where the fallback
`/workspace` doesn't exist. Exit 64 is unchanged existing code sitting behind the carry proven
above (128); a docker box's artificially-absent workspace takes the docker `git -C` path (exit
128), not the cloud 64 guard. Worth a follow-up check against a real Hetzner control box.

### Notes for later steps

- **Sanctioning moved server-side.** The host-sanctioned-branch record (so a later in-box agent
  push isn't prompted) now lives in the hub backend (`sanctionBranch` in `hub-backend.ts`),
  driven by `gitCheckout`/`gitNewBranch`. The CLI no longer touches `registerBoxWithRelay` /
  `mutateState` for git — steps converting other mutating ops should keep that pattern (mutate
  host/relay state in the hub backend, not the CLI).
- **Exit-code carry.** Git error envelopes now carry the box command's own exit code in
  `error.details.exitCode`; `HubApiError` exposes it as `details`, and `with-hub.ts`'s
  `exitCodeForHubError` honors it (falling back to the Step-0 code→exit table). Any later step
  that must surface a faithful box exit code — or an exit outside the 1–6 table (e.g. 64) —
  should reuse this carry rather than the code→exit table alone.
- **Host-only keys on the real condition, not transport mode.** `push --host-only` must NOT
  pre-check `resolveHubTarget().mode`: a `hub expose`d machine is `mode: 'remote'` yet IS the
  host with the checkout. The server's `runGitRpc` host-only branch already returns exit 64 on a
  genuinely-absent `workspacePath`; let the request through in all modes and surface that verdict.
- **`fetch`, `status`, and the `pr` group stay INLINE** and still mint their own host-initiated
  tokens — no `/api/v1` route exists for them yet. Converging them needs new routes in a later
  step (a `git/fetch` op, and a `gh pr` surface).

---

## Step 7 — Services, rename, url/screen ✅ done

- `services` / `services restart` → `GET|POST /api/v1/boxes/:id/services*`.
- `status <box> --set-name`/`--clear-name` → `POST /api/v1/boxes/:id/rename`.
- `url`/`screen` read the endpoint URL off the enriched Box payload (Step 3) for **docker**
  instead of probing the provider; cloud keeps the provider path (see the signed-URL note).
- Shared core (`boxServicesStatusRaw`, `boxRestartService`) is untouched — caller moves only.

**Files:** `commands/{services,status,url,screen}.ts`, `control-plane/hub-api-client.ts`.

**Landed.** `services list`/`services restart` and `status --set-name`/`--clear-name` now go
through the hub's public `/api/v1` (`withHubClient` + `client.getServices`/`restartService`/
`rename`), so they work identically against a local hub and a remote control box — the hub runs
the box's `provider.exec` (services) and does the same `setBoxDisplayName` (rename) the CLI used to
call inline. A **paused/stopped** box's `services` now falls back to the hub's persisted snapshot,
so it finally agrees with `status` (the old inline path errored "could not reach the supervisor").
`url`/`screen` resolve the box's URL off the enriched payload's `webUrl`/`vncUrl` (via `getBox`),
starting the box first **only when it isn't running** (a one-line notice to **stderr** keeps
`--print` pipeable) so a stale preview URL isn't served. Three new `HubApiClient` methods
(`getServices`, `restartService`, `rename`) mirror the routes; unit-tested in
`test/hub-api-client.test.ts`. **Verified end-to-end** on a docker box with a declared `expose:`
service, in **both** modes (local hub, and `hub expose`d remote-shaped loopback + `AGENTBOX_HUB_API_KEY`):
`services` agrees with `status` **running** (live) and **paused** (persisted snapshot, pushed via
`POST /events`); `services restart <svc>`/all/`<unknown>`→exit 5; `url --print` returns the payload
URL (curl'd **HTTP 200**) and `--loopback` the provider loopback URL; `screen --print` returns the
payload noVNC URL + runs the in-box browser prep; `--set-name`/`--clear-name` rename and the new
label resolves by name. Cloud `url`/`screen` validated via the (unchanged) provider path.

### Notes for later steps

- **Branches: nothing was added, by design.** `GET /api/v1/boxes/:id/branches` and
  `/projects/:id/branches` are **web-UI-only** consumers (`apps/hub/.../boxes/components/git-actions.tsx`).
  The CLI has **no branch picker** — `--from-branch` is a flag, not a picker — so there is no CLI
  surface to convert. Adding `HubApiClient` methods with no caller would be dead code; a later step
  (or the tray) that needs them can add them in one line then. **Do not re-add a "convert branches"
  bullet.**
- **For Step 8 (create): `--from-branch` host-validation is wrong under a remote hub.**
  `apps/cli/src/lib/from-branch.ts` (`resolveFromBranch` / `resolveBranchSelection`, called from
  `create`/`claude`/`codex`/`opencode`) validates the ref against the **host checkout** with
  `git fetch`/`rev-parse`. Under a remote hub the PC may have **no copy of the repo**, so that
  validation is both **redundant and incorrect** — `CreateBoxInput.fromBranch` is already documented
  as validated by the backend before enqueuing (`apps/hub/lib/boxes/backend-types.ts`). Fold the
  fix into Step 8 (it owns `create`); Step 7 did **not** touch it.
- **`url`/`screen` read the payload for DOCKER only; cloud stays on the provider path — deliberately.**
  A cloud box's payload `webUrl`/`vncUrl` is the **non-signed** `backend.previewUrl` (a header-token
  URL for Daytona that a browser can't open from a click; cloud has no `vnc` endpoint at all), while
  `provider.resolveUrl` mints a browser-safe **signed** URL and is the live refresh. That refresh
  genuinely needs the provider (or a server-side mint), so — exactly as the Step-3 caveat predicted —
  cloud keeps `resolveViaProvider`. Both commands gate the payload path on `provider === 'docker'`.
  A future step that wants cloud `url` off the payload must add a **server-side** signed-URL field to
  the Box payload (a hub-backend change out of Step 7's file set), not a client-side provider probe.
- **`url`/`screen` auto-start is now conditional + stderr.** They start a non-running box (the
  historical behavior — the command is documented as "auto-unpause/start"), but only when the payload
  `state` is not `running`, and the "started it" notice goes to **stderr** so `--print` stdout stays
  clean. Documented in `apps/web/content/docs/cli.mdx`. If a later step prefers `--print` to *refuse*
  on a stopped box rather than auto-start, that is a defensible change — this step kept auto-start.
- **`services restart` output is the route's aggregate.** Restart-all is handled server-side
  (empty `name`); the old per-service `  svc  ok` breakdown is gone (the route returns one
  `BoxOpResult`). Restoring per-service results would need a route/backend widening (out of this
  step's file set). A failed restart surfaces as a `conflict` (exit 5) via the `withHubClient` mapper.
- **`services --json` shape changed** from `StatusReply` (`{services,tasks,ports}`) to the route's
  `ServicesResult` (`{source,services,tasks,ports}`) — a superset with a `source` discriminant; the
  per-service fields are the compact `ServiceView` (persisted rows have `pid:null`, `restarts:0`).

---

## Step 8 — Create, queue and jobs ✅ done

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

**Landed.** Every CLI create goes through `POST /api/v1/boxes` + streams `GET /api/v1/jobs/:id/logs`
now — no inline `provider.create()` in `create.ts`. `resolveCreateTarget`
(`control-plane/create-target.ts`) picks WHICH HUB (reusing Step 1's `preferLocal` ladder +
`remoteHubConfigured`/`cloud.viaHub`/`isHubRoutableProvider`/`--via-hub`/`--local`): **local** →
send `projectId` (`hashProjectPath(root)`) → the hub's file-queue fork → `_run-queued-job`;
**remote control box** → push the project seed to custody first, then send `repoUrl` → the
control-plane clone queue. Both keep the `202 {jobId}` contract. The launchers' via-hub helpers
(`_cloud-agent-via-hub.ts`) moved onto `client.createBox` + the shared streamer with **unchanged
signatures**, so `claude.ts`/`codex.ts`/`opencode.ts` are untouched. `queue list` and `hub jobs`
read the unified `GET /api/v1/jobs`. `hub-enqueue.ts` + `hub-jobs.ts` are deleted. **Verified
end-to-end** on a local hub (see the notes for the acceptance run).

### Notes for later steps

- **`route-create.ts` was KEPT, not deleted (deferred to Step 11).** The brief said retire it, but
  `claude.ts`/`codex.ts`/`opencode.ts` still import `resolveCreateRouting` from it for their
  hub/local decision, and the confirmed scope for this step was "convert the via-hub HELPERS only,
  don't edit the launcher command files." Deleting `route-create.ts` now would force a launcher edit
  (import swap) → out of scope + a merge-conflict risk. `create.ts` no longer imports it. **Step 11
  (or whoever converts the launchers) deletes `route-create.ts` then**, swapping the launchers onto
  `create-target.ts`'s `resolveCreateTarget`. There is minor duplication between the two selectors in
  the meantime — deliberate.
- **The foreground lane is a THIRD scheduler lane (`queue.ts`), peer to the prepare lane.** An
  interactive `agentbox create` must never sit `queued` behind background `-i` jobs, so
  `create.ts` sends `foreground: true` on the create body → `CreateBoxInput.foreground` →
  `enqueueQueueJob({ foreground: true })` → `QueueJob.foreground`. `selectNextRunnable` /
  `selectNextRunnableByWorking` **skip** foreground jobs (like they skip `kind:'prepare'`), and a new
  `selectNextRunnableForeground` + a `startQueueLoop` tick block start every queued foreground create
  **ungated** by `queue.maxConcurrent`. Its box still counts in `countRunning()` once live (honest
  occupancy) — it's just never *blocked*. Unit-tested (`packages/relay/test/queue.test.ts`), and the
  `-i`/web-UI paths deliberately stay gated (they don't set the flag). Any later step adding another
  interactive create surface should set `foreground` too.
- **`CreateBoxInput` was widened to carry EVERY create flag (`CreateBoxOpts`), audited one-by-one.**
  Dropping a flag to fit the queue shape is the Step-1 defect. The full set now threads
  `create.ts` → `HubApiClient.createBox` body → `parseCreateBox` → `hub-backend.create` →
  `QueueJobCreateOpts` → `_run-queued-job` → `provider.create`/`createBox`. New `QueueJobCreateOpts`
  fields (were silently dropped on the file-queue path before): `build`, `imageRegistry`, `envFiles`,
  `credentialSync`, `bundleDepth`, `useBranch`, `gitPushMode`, `size`, `location`, `inbound`,
  `remoteHost`. `_run-queued-job`'s `runCloudJob` now **prefers `createOpts` over config** for
  size/location/inbound (it read config-only before, dropping the CLI flags). A later step touching
  create inputs must keep this chain complete.
- **`agentArgs` drop FIXED end-to-end (+ regression test).** `controlPlaneCreateRequest` and the
  `/remote/boxes` POST handler silently discarded `agentArgs`, so a hub-routed `claude -i` lost its
  processed args (skip-permissions etc.). `ControlPlaneCreateInput`/`CreateJobRequest` now carry it;
  `apps/hub/test/control-plane-create.test.ts` asserts the round-trip. (The `/remote/boxes` server
  handler still drops it, but the CLI no longer uses that route — it's box→hub-internal now; Step 11
  can prune it.)
- **`startAgent` semantics: default-on for a named agent, `startAgent:false` = a COLD box.** The
  web-UI "create a box" wants the agent running (`controlPlaneCreateRequest` defaults `startAgent`
  true when `!noAgent`); the foreground `createCloudBoxViaHubAndAdopt` sends `startAgent:false` so the
  worker builds a cold box and the PC adopts + attaches (the agent launches on attach). `agentbox
  create` sends `agent:'none'`.
- **`--from-branch` host-validation fix is STRUCTURAL, not a `from-branch.ts` knob.** Step 7's finding
  (validating a ref against the host checkout is wrong under a remote hub) is fixed for `create` by
  the early return: the remote path passes `fromBranch` straight through (the backend/clone validates
  it), and `resolveBranchSelection` (host `git fetch`/`rev-parse`) runs **only** on the local path,
  where the host genuinely has the repo. No `validateAgainstHost` knob was added — it would be dead
  code (the launchers, which also validate, weren't touched). **A later step converting the launchers
  should skip host branch-validation on their remote path the same way.**
- **The seed push is unconditional on the create path (the `.env`/untracked fix) — reused, not moved.**
  `pushCreateSeed` (`create-target.ts`) calls the existing `pushProjectSeedToCustody`
  (`/admin/custody`, hash-skipped, best-effort — never fails the create) whenever a create routes to a
  remote control box (the clone path). It is NOT gated on `--via-hub` anymore, so a default cloud
  create and the agent-launcher hub path both push seed now (they didn't before → boxes missed
  `.env`). The local file-queue path needs no seed push — the worker builds from the local tree, which
  already carries untracked-not-ignored files (a gitignored `.env` needs `--with-env`, unchanged).
  Custody stays on `/admin` here; moving it to `/api/v1/custody` is Step 10.
- **The jobs view (`JobView`/`JobListItem`/`HubApiJob`) gained `error`/`provider`/`name`/`agent`/
  `createdAt`.** `error` (a failed job's `reason`/`result.error`) is what lets the CLI create path
  report a failure faithfully rather than a silent "done". `getJob` and the new `listJobs()` backend
  method + `GET /api/v1/jobs` route surface them.
- **`queue list` targets the LOCAL hub (`preferLocal`), `hub jobs` the configured hub.** "One queue
  VIEW" = one route/shape (`/api/v1/jobs`), two targets — the same split as list-boxes. A laptop's
  own background `-i` queue shows in `queue list`; a control box's create queue shows in `hub jobs`.
  The old `queue list` merge (local table + a "control box" block) is gone. `queue
  cancel`/`show`/`clear`/`wait-for` stay local (they manage local manifests).
- **git-LFS was already handled (`cloneRepoWithLfs`, #249) — nothing added.** The clone-side worker
  already clones with `GIT_LFS_SKIP_SMUDGE=1` then `git lfs pull` over the leased authed-HTTPS
  endpoint. Verified present; the brief's "give the hub's clone its own LFS credentials" is satisfied
  by that existing code (the leased token authenticates the LFS pull). No change.
- **Env caveat for e2e (not a code gap):** the acceptance's `.env`-arrives check is proven on the
  co-located paths (local hub + `hub expose`d), where files arrive via the file-queue tree seed. The
  seed-push overlay is only load-bearing on a genuinely-remote control box + cloud provider, which
  needs a real deploy — exercised by the logic + unit tests here, consistent with prior steps' gh-shim
  blocker.

---

## Step 9 — Fleet gaps: checkpoint, prune, agent state, logs ✅ done

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

**Landed.** Five routes over new `HubBackend` methods (modeled on `getServices`):
`POST /boxes/:id/checkpoint` (`createCheckpoint`), `GET|DELETE /checkpoints` (`listCheckpoints`
/`removeCheckpoint`), `POST /prune` (`pruneFleet`), `GET /boxes/:id/agent` (`getAgentState`),
`GET /boxes/:id/logs` (`boxLogSnapshot` for a JSON tail, `boxLogAttach` + the new
`box-log-stream.ts` for `-f` SSE). The CLI `checkpoint create`/`ls`/`rm`, `prune`, `agent
state`/`wait-for`/`get-plan-question`, and `logs` are converted onto them. **Verified end-to-end**
on a docker box: `checkpoint create` produced `agentbox-ckpt-…:warm` (ground truth
`docker image ls`), a box booted from it, and `prune -y` + `prune --all -y` reaped an orphan
record/volumes/box-dir while **the checkpoint image survived** (the acceptance). `checkpoint
ls`/`ls -g`/`set-default`/`rm` (incl. the dangling-default-key sweep), `agent state`/`--json`, and
`logs --daemon` (snapshot + `-f` with a clean SIGINT teardown) all exercised. Also validated with
the CLI pointed at the same hub as a `mode:'remote'` target (`relay.controlPlaneUrl` +
`AGENTBOX_HUB_API_KEY`): `checkpoint create`/`agent state`/`logs` on a **docker** box still route
to the LOCAL owning hub via `withOwningHub` (they do NOT 404), `checkpoint ls` hits the configured
target with the API key, and `prune --provider e2b` routes to the configured hub.

### Notes for later steps

- **Box-scoped ops use `withOwningHub` (Step 5's), NOT plain `withHubClient({})`.** `checkpoint
  create`, `agent state`/`wait-for`/`get-plan-question`, and `logs` all resolve the box locally
  (`resolveBoxOrExit`) then run through `withOwningHub(box, op)` so a **docker box under a configured
  remote hub** hits its LOCAL owning hub (and the `not_found`-retries-the-other-hub covers the edge)
  — exactly the Bugbot defect Step 5 fixed. Do not regress this to `withHubClient({})` for any
  box-scoped op.
- **`prune` is FLEET-scoped, so it routes by the provider argument, not `withOwningHub`.** It reuses
  the same predicate: `preferLocal = boxOwningHubIsLocal({ provider: opts.provider ?? 'docker' })` —
  docker + remote-docker → the local hub, a true cloud provider (daytona/hetzner/vercel/e2b/
  digitalocean) → the configured hub. The confirm stays client-side via a `dryRun` preview
  round-trip. **The reap moved server-side**: `POST /prune`'s cloud path deletes the orphan sandbox
  then `reapStoreState(handle, boxId)`s its registration directly, so the CLI's
  `reapSandboxesOnControlBox` was deleted (`reapOnControlBox` stays — `dashboard.ts` uses it).
- **~~KNOWN FOLLOW-UP for Step 11's routing sweep~~ ✅ FIXED (follow-up PR, base `feat/cli_api_consolidation`).**
  Step 7's `services` / `services restart` / `url` / `screen` / `status --set-name` (rename)
  (`commands/{services,status,url,screen}.ts`) shipped on plain `withHubClient({})`, carrying the SAME
  latent `not_found` bug for a **docker box under a configured remote hub** that Step 5 fixed for
  lifecycle. All five are box-scoped and were repointed onto `withOwningHub(box, op)` — no fresh
  `provider === 'docker'` checks; `url`/`screen` capture the payload URL via a closure variable (the op
  returns `void`) and fall through to the provider path on `null`/`not-found`. **Verified end-to-end**:
  with `relay.controlPlaneUrl` pointing at a separate non-owning control box and a docker box present,
  the pre-fix binary failed (`url`/`status --set-name` → `not_found` exit 2, `services` → unreachable
  exit 1) and the fixed binary succeeds (routes to the local owning hub); plain local-hub mode
  unregressed. Genuinely project/fleet-scoped calls (Step 9's `checkpoint ls`, `prune --provider`)
  stayed on `withHubClient({})`.
- **`checkpoint ls`/`rm`/`set-default` are PROJECT-scoped, so they use `withHubClient({ preferLocal:
  true })`, not `withOwningHub`** (there is no box). `preferLocal` is the same hub docker `create`
  writes to (its image is local) AND the only store whose path-hash matches: checkpoint stores are
  keyed by `hash(absolute project root)`, which only resolves on the local filesystem — a remote
  control box hashes a different path, so listing by this machine's root there finds nothing anyway.
  On a co-located hub (local or `hub expose`d) `preferLocal` IS the one hub. Cloud checkpoints created
  on a genuinely-remote control box aren't listable from a thin laptop by path — a real cross-machine
  limitation of path-hash-keyed stores (would need origin-keyed checkpoint stores; out of scope). This
  was Bugbot #1 (High): `ls`/`rm` on `withHubClient({})` (configured hub) missed docker checkpoints
  `create` had just written locally.
- **`checkpoint set-default` stays a LOCAL project-config write** (not in this step's route list —
  it's a config mutation and there is no `/api/v1/config` surface). It validates the ref against the
  hub's `GET /checkpoints` listing (so it agrees with `ls`/`rm`) but writes `setConfigValue('project',
  …)` on this machine. For a **co-located** hub (local or `hub expose`d — both acceptance modes) the
  hub's store/config IS this machine's, so it's fully correct; setting a default for a **genuinely
  remote** project isn't reachable this way (would need a config route). Its in-callback "not found"
  reports via `log.error` + exit code, NOT a thrown `Error` — a plain throw inside a `withHubClient`
  callback is rendered by the mapper as a "can't reach the hub" transport failure.
- **`logs` reuses only job-log-stream's SSE FRAMING, not its file-tail core.** Service logs come from
  a child process the hub spawns INTO the box (a `docker exec` for docker, the provider attach argv
  for cloud), so `streamJobLog`'s "tail a hub-local file" body doesn't apply. The shared framing
  (`sseFrame` / `SSE_HEADERS` / `HEARTBEAT_MS`) was extracted from `job-log-stream.ts` and reused by
  the new `box-log-stream.ts`. Non-follow is a plain JSON `{ output }`; only `-f` is SSE. On `-f`
  Ctrl-C the CLI hard-exits (130) and `streamBoxLog` swallows the abort as a clean stop — undici does
  not reliably end a streamed body read on signal-abort, so a hard exit is deliberate (the old
  docker-exec follow hard-exited too).
- **OpenAPI:** the five new routes are documented in `apps/web/content/docs/cli.mdx` but NOT yet in
  `api/v1/lib/openapi.ts` — that's Step 14's job (it owns the OpenAPI extension). New routes to add:
  `boxes/:id/checkpoint`, `checkpoints`, `prune`, `boxes/:id/agent`, `boxes/:id/logs`.
- **Env caveat for e2e (not a code gap):** the genuine deployed-profile expose (`hub setup --deploy
  local`) is blocked in-box by the `gh` shim, which won't surface a raw GitHub token for the git-lease
  credential — so the deployed-profile auth was exercised via the `mode:'remote'` config above rather
  than a real `hub expose`. The routing/backend code is auth-mode-agnostic (the hub proxy owns auth),
  and `withOwningHub`/`preferLocal` is Step 5's already-tested shared code.

---

## Step 10 — Custody onto `/api/v1` ✅ done

- `hub credentials push|pull`, `hub secrets push`, `hub custody list|pull|rm` and the project seed
  push move from `/admin/custody/*` to `/api/v1/custody/*` (the GET manifest already exists; add
  the write verbs with the same metadata-only contract — paths, hashes, sizes, never bytes).
- Keeps the tray and web able to drive custody, and removes the CLI's last routine `/admin` use.

**Files:** `control-plane/custody-client.ts`, `commands/control-plane.ts`,
`packages/relay/src/custody/routes.ts`, new v1 route.
**Verify:** `agentbox hub credentials push` then `pull` round-trips against a local hub and a
control box; `hub custody list` shows hashes only.

**Landed.** All the CLI's custody client calls speak `/api/v1/custody` now — the CLI holds **no**
routine `/admin/custody` client call. `CustodyClient` (`control-plane/custody-client.ts`) was
rewired to `/api/v1/custody` with `{ url, apiKey, adminToken? }`, gained `delete()`, and parses the
v1 envelope into `HubApiError`. A new resolver `resolveCustodyApiTarget` (URL + hub API key via
`resolveHubApiTarget`, plus the best-effort admin token from the setup-written env) replaces
`resolveCustodyTarget` at every custody-client call site: `hub credentials push|pull`, `hub secrets
push`, `hub project push`, `hub custody list|pull|rm`, `syncAgentCredentials`, the `hub worker` seed
fetch, `credentials.ts`'s login-time push, and the SSH-key adoption pull (`hub adopt`/`hub pull`,
`auto-adopt.ts`, `recover.ts`, `_cloud-agent-via-hub.ts`). `custody rm` now uses `CustodyClient.delete`
(was a raw `/admin` fetch). The project seed push (`pushProjectSeedToCustody`, sandbox-cloud) was
made transport-agnostic via an injected `SeedCustodySink`: the CLI `hub project push` injects a
`/api/v1` sink; the **create path keeps its `/admin` sink** (`adminCustodySink`, cloud-provider.ts) —
it is the internal registration flow that holds the admin token, and Step 11 keeps `/admin` for
box→hub/internal traffic. **Verified end-to-end** on a local hub (token profile): `credentials push`
→ `custody list` (metadata only, curl-confirmed **no `data` field**) → `credentials pull` +
`custody pull --dest` round-tripped with **byte-for-byte matching** ground truth, and the store
landed at `~/.agentbox/hub/custody/`. On a password-profile hub (spawned standalone): a byte-read
with the API key alone is **`401` refused**, with the admin token it returns the value; list/PUT
return metadata only; no-auth is `401`. The CLI's remote-shaped path (`--url` + `AGENTBOX_HUB_API_KEY`
+ `AGENTBOX_RELAY_ADMIN_TOKEN`) round-tripped push → list → pull → rm against that hub, and a
**thin client** (API key, no admin token) was refused on pull.

### Notes for later steps

- **The custody byte-read is a TWO-TIER contract — the one route in `/api/v1` that returns a value,
  and it FAILS CLOSED.** `list` / `PUT` / `DELETE` authorize with the hub API key (proxy gate) and
  their responses are **metadata only** (path/size/sha256/mode/updatedAt, plus `changed` on PUT —
  never a stored value). The byte-read `GET /api/v1/custody/<path>` returns bytes and so needs a
  **second, non-distributed credential**: on the **password profile** (a real/exposed control box)
  the admin token in `X-Agentbox-Admin-Token`, else `401`. This is deliberate because custody holds
  agent creds, `.env` files and **per-box SSH private keys** — the highest-value target in the API —
  and the hub API key travels to the tray/web/thin clients. The decision is the pure, unit-tested
  `custodyByteReadAuthorized` (`apps/hub/lib/custody-auth.ts`, `test/custody-auth.test.ts`) — **any
  later step touching this route MUST keep it fail-closed** (unset admin-token env, missing header,
  and mismatched header all refuse; there is no path that degrades to API-key-only). On the **token
  profile** (a plain local hub) the byte-read needs no admin token but is now **loopback-only** (see
  the emergent-Step-2+10 note below): the hub token is a machine-local secret, but the localhost hub
  binds `0.0.0.0`, so a non-loopback byte-read is refused even with a valid token. On `off` the whole
  API is open. `apps/web/content/docs/api.mdx` documents all of this.
- **EMERGENT Step 2 + Step 10 security fix (follow-up PR, base `feat/cli_api_consolidation`) — NOT a
  defect in either step alone.** Step 2 made the localhost hub bind `0.0.0.0` (docker boxes must reach
  the embedded relay at `host.docker.internal:8787`). Step 10 let the hub token alone authorize custody
  BYTE-READS on the token profile, on the premise that a local hub is a single trusted machine — true
  when the hub was loopback-only. Together they made custody byte-reads (agent creds, `.env`, per-box
  **SSH private keys**) LAN-reachable to anyone who obtains the hub token once — and the hub prints its
  URL with `?token=…`, so the token lands in scrollback/history. **Fix:** the token-profile byte-read is
  now **peer-gated to loopback**, exactly the way `/admin/*` is (`adminGateAllows`). `custodyByteReadAuthorized`
  gained an `isLoopback` arg (token profile returns it; password unchanged — admin token; `off`
  unchanged). The verdict rides a **trusted header** (`PEER_LOOPBACK_HEADER`, `apps/hub/lib/peer.ts`)
  that `server.ts`'s `uiHandler` stamps from the real socket peer **after stripping any client-supplied
  copy** (unspoofable, since the custom server owns the socket). The manifest/list route is unaffected
  (metadata only). Nothing legitimate breaks: the PC reads custody over loopback, docker boxes never
  byte-read custody (only `/rpc`), and a remote PC pulling from a control box is the password-profile
  admin-token path. Verified live: pre-fix a LAN-IP byte-read with the hub token returned the credential
  bytes; post-fix it is `401`, loopback still works, a forged peer header is still `401`. Tests in
  `test/custody-auth.test.ts` (kept the two-tier tests, added a non-loopback-refused case) + `test/peer.test.ts`.
- **Custody is now wired on EVERY hub, not just a control box** (`server.ts`: `new FsCustodyStore()`
  unconditionally, exposed via `globalThis.__AGENTBOX_HUB_CUSTODY`). This is what makes
  `/api/v1/custody` serve on a plain local hub (the "same path local ⇄ remote" rule; the acceptance
  needs a local `credentials push`/`pull` round-trip). The relay daemon's `/admin/custody` wire is
  **still admin-token-gated**, so a plain local hub (empty admin token) serves custody ONLY over its
  token-gated `/api/v1`, never the admin wire. The seam type in `global.d.ts` gained `put`/`delete`.
- **`CustodyClient` speaks EITHER surface, picked by the credential it holds — a custody op works
  with whichever credential is available and NEVER silently no-ops (Bugbot Medium — the important
  fix).** API key present → `/api/v1/custody` (the public surface; byte-read adds the admin-token
  header). Only the admin token present (no API key) → the **`/admin/custody` fallback**, whose admin
  bearer authorizes every verb incl. the byte-read. This is what lets a machine that ran `hub setup`
  but has no API key (e.g. a via-hub-create host — `createCloudBoxViaHubAndAdopt` says so in its own
  comment) STILL pull per-box SSH keys instead of skipping them (which would break `attach`/`cp` later
  with a confusing missing-key error far from the cause). The constructor **throws** when NEITHER
  credential is present — a custody op fails loudly at the source, never a quiet no-op. The two-tier
  `/api/v1` byte-read contract + its test are unchanged; the fallback is purely client-side.
  **Step 11 caveat:** this is a CLI→hub `/admin/custody` call, so the "no `/admin` client call in
  `apps/cli`" guard must either allow the custody admin-fallback or Step 11 removes it once the API
  key is guaranteed on every custody-driving machine.
- **`resolveCustodyApiTarget(urlFlag, { quiet?, remoteOnly? })` returns whatever credential is
  available** — `{ url, apiKey?, adminToken? }` — and `CustodyClient` picks the surface. It returns a
  target when EITHER credential is present; it returns `null` (a) silently when there is no control
  box (and, in default mode, no local hub) — a genuine no-op — or (b) with a LOUD error (suppressed
  only for `quiet` best-effort callers) when a control box IS configured but neither credential is
  present. Default mode also serves a plain local hub (its hub token is the API key; the acceptance's
  local `credentials push`/`pull` round-trip). `remoteOnly: true` refuses a local hub, for the
  automated control-box callers (`syncAgentCredentials`, `credentials.ts` login push, the `hub worker`
  seed fetch, all SSH-key adoption). `resolveCustodyTarget` (the old admin-only `/admin` resolver,
  `{ url, adminToken }`) was **kept** — still used by non-custody internal-wire callers (`hub jobs`,
  bake-sharing/`prepared-custody`, `registerBoxWithPlane`, the create-path `adminCustodySink`). Do not
  delete it until those move (Steps 8/9/11).
- **Writes need only ONE credential; a byte-read on `/api/v1` needs the admin token.** A thin client
  (API key, no admin token, no admin wire) can `push`/`list`/`rm` but not `pull` — SSH-key adoption
  from such a client adopts the record and flags `sshKeysMissing` (the exact graceful degradation
  Step 4 designed). A machine WITH the admin token always can `pull` (via `/api/v1` elevation when it
  also has the API key, or the `/admin` fallback when it doesn't).
- **`pushProjectSeedToCustody` takes a `SeedCustodySink` now, not `{ controlPlaneUrl, adminToken }`.**
  Two sink factories: `adminCustodySink` (`/admin`, for the create path) and, inline in the CLI, an
  `/api/v1` sink over `CustodyClient`. A `probe?: () => Promise<boolean>` arg lets the reachability
  probe be injected (tests; defaults to `hostReachable(probeUrl)`). Step 8 (create) will want the
  `/api/v1` sink here too once the create path itself moves onto `/api/v1` — the seam is ready.
- **Still touching `/admin/custody` (Step 11 must account for these):** the relay dispatcher
  `packages/relay/src/custody/routes.ts` (box→hub/internal) — unchanged; `adminCustodySink` in
  **sandbox-cloud** (the create-path seed push); and — new in this step — `CustodyClient`'s **admin
  fallback** when only the admin token is available (an `apps/cli` code path, though it fires only
  without an API key). So Step 11's "no `/admin/` client call in apps/cli" guard is NOT literally true
  for custody yet: either scope the guard to exclude the credential-gated fallback, or drop the
  fallback once every custody-driving machine is guaranteed to hold the API key.

---

## Step 11 — Retire the second implementation and the internal client wire ✅ done

The consolidation payoff.

- Delete the now-dead CLI modules: `control-plane/{hub-list,hub-merge,list-merged,hub-enqueue,
  route-create,route-prepare,reap}.ts` and `admin-client.ts`'s client-facing surface.
- `/admin/*` + `/remote/*` remain for **box→hub** and hub-internal traffic only.
- Add a guard test asserting `apps/cli` contains no client call to `/admin/` or `/remote/`.
- Sweep `hub-backend.ts` for the "mirrors the CLI" comments and delete them — there is one
  implementation now.

**Verify:** `pnpm test` + `pnpm typecheck`; the guard test fails if anyone reintroduces an
internal-wire client call.

**Landed.** The CLI holds **no client for the internal box/fleet wire** any more. Deleted:
`admin-client.ts` (`ControlPlaneAdminClient` — `/admin/store` + `/admin/prompts` +
`DELETE /remote/boxes`), `reap.ts` (its only consumer, `dashboard.ts`, now destroys through
`/api/v1`), `hub-list.ts`'s **legacy `/admin/store` half** (`fetchHubListing`/`HubListing` + its
cache; the `/api/v1` half — `fetchBoxListing`/`cacheAge`/`hostReachable` — stays, still used by
`list.ts`/`recover.ts`), and the dead `lib/wait/events.ts` (`waitForEvent`/`/admin/events`, no
callers). `hub-merge.ts` + `list-merged.ts` were replaced by a re-sourced dashboard-local merge
`dashboard/box-list.ts` (`listDashboardBoxes`/`mergeApiBoxes`), sourced from the SAME
`/api/v1/boxes` wire `ls` uses instead of the `/admin/store` registration listing. The guard test
`apps/cli/test/no-internal-wire-client.test.ts` scans `apps/cli/src` (comment-stripped) and fails
on any `/admin/`//`/remote/` path outside a tiny justified allowlist; proven to fail on a
temporarily-reintroduced `/admin/store` call, then reverted. `hub-backend.ts`'s
"mirrors the CLI's old X" second-implementation comments were swept. **`route-prepare.ts` and
`hub-enqueue.ts` were already deleted by Steps 1 and 8.** `pnpm test` (CLI 1115, hub 120) +
`pnpm typecheck` green.

### Notes for later steps

- **The custody `/admin/custody` fallback was ALLOWLISTED, not deleted (Step 10's known tension —
  resolved deliberately).** The two options were "allowlist the one custody path" or "make the
  `/api/v1` custody byte-read accept the admin token alone so the fallback can be deleted." I chose
  **allowlist**, because option 2 is infeasible: `/api/v1/custody` is gated by the **hub API key** at
  the proxy first, so a machine holding only the relay admin token (a `hub setup` host with no API
  key — e.g. a via-hub-create host) can't reach `/api/v1` at all; that is *why* the fallback speaks
  `/admin/custody`. Deleting it reintroduces Step 10's silent-skip bug (per-box SSH keys not pulled →
  `attach`/`cp` break later with a confusing missing-key error). The fallback fires **only** when no
  API key is present, and the byte-read is still fail-closed + loopback-peer-gated on the hub side
  (`custody-auth.ts`/`peer.ts`) — untouched. The guard's allowlist is a **(file → path-prefix)** map,
  so a *different* `/admin/...` added to `custody-client.ts` still fails; only `/admin/custody` is
  permitted there.
- **The guard's other two allowlist entries are NOT box/fleet client ops** (so they are legitimately
  not the wire this step retired): `lib/queue/submit.ts` `/admin/queue/enqueue` (a poke to THIS
  machine's local relay scheduler so a queued background `-i` job starts without waiting a tick — the
  manifest is on local disk regardless) and `control-plane/ensure-repo-installed.ts`
  `/admin/app/repo-installed` (a GitHub-App install probe in the git-leasing setup flow). Neither
  drives a box or the fleet. If a later step moves the local file-queue behind `/api/v1`, the first
  can go.
- **`route-create.ts` was KEPT deliberately — this is the ONE remaining inline create path, and it is
  narrow and intentional, not an oversight.** The agent launchers — one shared
  create body in `agents/command/create-action.ts` since the command factory —
  still run an **inline local `createBox`** for their
  **foreground** create path (both the `-i` background path and the foreground path call
  `resolveCreateRouting` from `route-create.ts` to choose hub-vs-local, then build locally on the
  local arm). `route-create.ts` holds **no `/admin`//`/remote` client call**, so the guard test — the
  real acceptance of this step — passes with it retained; deleting it would only be for tidiness.
  Finishing it is **not more plumbing**: converting the launchers' local foreground arm onto
  `/api/v1` means converting **create-then-attach**, i.e. deciding the create+attach IO boundary — and
  attach/IO is the plane the plan explicitly puts **out of scope** ("Explicitly out of scope"). Step 8
  deferred the launcher conversion for exactly this reason. So `route-create.ts` and the launchers'
  inline `createBox` survive until that boundary is designed; `commands/create.ts` itself already goes
  through `POST /api/v1/boxes` (Step 8) and does **not** import `route-create.ts`. There is minor,
  deliberate duplication between `route-create.ts`'s `resolveCreateRouting` and `create-target.ts`'s
  `resolveCreateTarget` in the meantime.
- **STEP 14 — the public docs must NOT overstate the consolidation.** Do **not** write "the CLI has
  zero inline create paths" or "every CLI command goes through `/api/v1`" without qualification. It is
  very close to true and the exception is narrow, but an unqualified guarantee misleads the next
  reader. Write it like this: *"Every CLI box and fleet operation goes through the hub's `/api/v1` —
  `create` (`agentbox create`), lifecycle, listing, git, approvals, checkpoints, prune, custody, and
  the agent launchers' `--via-hub`/control-box path all do. The one remaining exception is the agent
  launchers' (`claude`/`codex`/`opencode`) **local foreground create**, which still builds the box
  inline via `createBox`; converting it is coupled to moving the create+attach IO plane behind the hub
  (deliberately out of scope), so `route-create.ts` survives for it."* The guard test
  (`no-internal-wire-client.test.ts`) is the true invariant to cite: the CLI holds no client for the
  `/admin`//`/remote` wire — that is a stronger, accurate claim than "no inline create".
- **The dashboard destroy now routes cloud boxes through `withOwningHub` (Step 5's helper), NOT
  `resolveHubApiClient(undefined)`.** `commands/dashboard.ts`'s `destroyBoxAction` cloud branch calls
  `withOwningHub(record, (client) => client.destroy(record.id))`, then drops the local record on a
  reap (`removeBoxRecord`). The first cut used `resolveHubApiClient(undefined, { quiet })`, which
  resolves the hub from CURRENT CONFIG only — Bugbot (High, on this PR) caught that it re-introduces
  the exact Step-5 defect: a box created against a control box (or driven after a local config change)
  could hit the wrong hub, get `not_found`, and leave BOTH the cloud sandbox and its registration in
  place. `withOwningHub` routes owner-first and retries the OTHER distinct hub on `not_found`, which is
  what `agentbox destroy` (`commands/destroy.ts`) already does — so the dashboard and the CLI now
  destroy through the identical owner-first path. `client.destroy(id)` does provider teardown +
  store/custody reap server-side (one implementation, both modes), replacing the old inline
  `provider.destroy` + `/remote/boxes` reap. Docker boxes still use the inline `destroyBox` (a local
  container the local hub owns; no remote registration to reap). The dashboard's other lifecycle
  actions (pause/stop/resume) remain inline — they are IO-plane and out of scope; only destroy needed
  the reap and so moved. (`withOwningHub` prints via clack on a genuine hub error, which is rare and
  the compositor redraws over it; on success it is silent — the common path.)
- **`hub-list.ts` is now single-purpose** (the `/api/v1` `ls` listing); its `hub-boxes-cache.json`
  cache is the only one it writes. The separate `hub-registrations-cache.json` (Step 3's split for the
  legacy path) is no longer written — a stale file on old installs is harmless.

---

## Step 12 — Docker off under a remote hub ✅ done

- When `relay.controlPlaneUrl` is set: drop `docker` / `remote-docker` from provider pickers,
  `doctor`, `prepare` and `create`; filter docker boxes out of `ls`, with one clear message
  naming the config key that re-enables them. Add `hub.mode: 'auto' | 'thin' | 'local'` to
  `KEY_REGISTRY` (`packages/config/src/types.ts`) as that key — a config key, not an env var.
- Move `ensureHub` / `getHubStatus` / `HUB_TOKEN_FILE` out of `@agentbox/sandbox-docker` into
  `packages/sandbox-core`, so a docker-free host never imports docker machinery to start a hub.
- Sever `refreshAgentCredentialsBackup`'s docker-shared-volume reach-in from the cloud path.

**Verify:** with a control box configured, `create --provider docker` refuses with the named key,
docker boxes vanish from `ls`, and `agentbox hub start` works on a machine with no docker.

> **DO NOT undo the custody byte-read peer gate when revisiting hub binding here.** The localhost hub's
> `0.0.0.0` bind (Step 2) is load-bearing for docker boxes and stays, but it is exactly what makes the
> token-profile custody byte-read LAN-reachable — so `custodyByteReadAuthorized` peer-gates it to
> loopback via the `server.ts` `uiHandler` peer stamp (`apps/hub/lib/peer.ts`). See the emergent-Step-2+10
> note under Step 10. If this step narrows or changes the bind, keep the loopback gate: it is the only
> thing standing between a leaked hub token and every SSH private key custody holds.

**Landed.** One shared predicate — `dockerProvidersHidden(effective)` in
`control-plane/remote-hub.ts` (beside `remoteHubConfigured`) — drives every gating site:
`local` never hides (the escape hatch), `thin` always hides, `auto` hides iff a control box is
configured. `isDockerProvider(name)` covers **docker + remote-docker** (matching
`boxOwningHubIsLocal`), and `dockerHiddenMessage('create'|'prepare')` is the single re-enable
message naming `hub.mode=local`. Gated: `create` (and the `claude`/`codex`/`opencode` launchers —
they build boxes too, same false-coverage reason Step 13 widened its gate), `prepare` (`runPrepare`),
`doctor` (the unscoped enumeration in `runAllChecks`; a scoped `doctor -p docker` still runs so you
can diagnose), and the `install` provider picker (filtered + `initialValue` moved off docker). The
new `hub.mode: 'auto'|'thin'|'local'` config key lives in `KEY_REGISTRY` (`packages/config/src/types.ts`)
+ the JSON schema, defaulting to `auto`.

The hub lifecycle (`ensureHub`/`getHubStatus`/`stopHub`/`resolveHubServer`/`hubRuntimeEnv`/
`HUB_TOKEN_FILE`) moved from `@agentbox/sandbox-docker` to `@agentbox/sandbox-core`
(`hub-lifecycle.ts`); the shared process/`/healthz` probes moved with it into `hub-process.ts`
(re-exported from `relay.ts` for compat). The two docker-side niceties it used directly — Portless
and the docker build context — now come through a `hub-hooks.ts` seam the CLI fills at startup
(`setHubPortlessHooks(dockerHubPortlessHooks)` + `setHubDockerContext(BUILD_CONTEXT_DIR)`); the docker
Portless impl is `sandbox-docker/src/hub-portless.ts`. `refreshAgentCredentialsBackup`'s
docker-shared-volume reach-in is severed the same way: `credential-refresh.ts` seam in core,
`dockerCredentialRefresh` impl in sandbox-docker, registered by the CLI — `@agentbox/sandbox-cloud`
no longer imports docker for the refresh. **The `0.0.0.0` bind (invariant 1) is carried verbatim in
`hub-lifecycle.ts`; the custody peer gate (invariant 2) was not touched.**

**Verified end-to-end** (built CLI): with `relay.controlPlaneUrl` set, `create --provider docker`
and `prepare --provider docker` refuse naming `hub.mode=local`, and `doctor` drops the docker/
remote-docker rows; setting `hub.mode=local` reinstates all three (create proceeds past the gate into
the normal carry flow, doctor shows docker again). With `relay.controlPlaneUrl` **unset** (the
regression half), `doctor` shows docker, and `create --provider docker` routes through the local hub
queue and creates a real container exactly as before — the hub autostarted via the **moved**
`ensureHub` and resolved its Portless URL through the new seam, and the hub binds `0.0.0.0` (invariant
confirmed in the hub log). `hub restart`/`hub status` work off the sandbox-core lifecycle.

### Notes for later steps

- **`ls` keeps docker boxes LISTED but marked inactive — it does NOT drop them (deliberate, and the
  right call for the next reader).** Filtering docker boxes out entirely is "hidden-but-alive": a user
  who configures a control box while docker boxes are running would lose the only handle to them (they
  keep consuming resources), the same silent-skip failure class rejected in Step 5's destroy bug. So
  `list.ts` renders docker boxes with a dimmed `docker (inactive)` provider cell + a footer note naming
  `hub.mode=local`, and `destroy <name>` still resolves them (it resolves locally from `state.json`,
  never from the listing). In practice the marking only bites in the **co-located / `hub expose`** case
  where the hub's `/api/v1/boxes` runs `docker ps` on this machine; a genuinely remote VPS hub never
  lists local docker boxes at all (different hub), so there is nothing to mark there.
- **The gate is a CONFIG-KEY gate, evaluated on `effective.hub.mode` + `effective.relay.controlPlaneUrl`
  — never an env var.** Any later site that needs "is docker available here" must call
  `dockerProvidersHidden` / `isDockerProvider` from `control-plane/remote-hub.ts`, not re-derive a
  `provider === 'docker'` check (same discipline as `boxOwningHubIsLocal`).
- **The hub-lifecycle move is path-safe because the CLI bundles every `@agentbox/*` package
  (`noExternal`).** `resolveHubServer`/`resolveCliEntry` resolve candidates off `import.meta.url`, which
  is the CLI's own `dist/` regardless of which source package authored them, so moving them to
  sandbox-core changed nothing at runtime. Keep that property in mind before moving these to a package
  that is NOT inlined into the CLI.
- **`@agentbox/sandbox-core` still cannot import `@agentbox/relay`** (relay depends on core — cycle).
  RESOLVED: the port is now configurable (`relay.port`) and threaded through a single resolver,
  `relay-port.ts`'s `relayPort()`, rather than duplicated — `HUB_RELAY_PORT` is gone and the one
  remaining literal is that module's `FALLBACK_RELAY_PORT`.
- **Two more one-slot hooks now exist alongside `credential-publish.ts`** (`hub-hooks.ts`,
  `credential-refresh.ts`). The CLI registers all of them in `apps/cli/src/index.ts`. A docker-free
  build simply never registers the docker ones and the seams no-op — that is the whole point.

It exists as the alternative to a remote hub — a box holding a **copy** of your git credentials
so it can push with the laptop off, at the cost of those credentials living inside the box and
its snapshots. With a control box configured, token leasing (`git.lease-token` +
`packages/relay/src/github-app.ts`) does the same job without the copy, so the credential copy is
pure downside. Without a remote hub it stays exactly as it is today.

- Refuse `--dangerously-with-credentials` and `git.pushMode=direct` when `relay.controlPlaneUrl`
  is set, with a message naming leasing as the replacement — not a generic "unsupported". Same
  gate for `agentbox connect`'s post-create equivalent.
- Keep the existing guards intact: cloud-only, TTY-required (no `-y`/env bypass), incompatible
  with `-i` background runs. It is already refused with `--via-hub` (`agents/command/create-action.ts`)
  — that check becomes redundant once the broader gate lands, so fold it in rather than leaving
  two guards to drift.
- `git.pushMode` resolution (`auto` → lease when `relay.controlPlaneUrl` is set, else relay)
  needs no change; only the `direct` opt-in is gated.

**Files:** `apps/cli/src/lib/git-creds-gate.ts`, `commands/{create,opencode,connect}.ts`,
`packages/config/src/types.ts` (key doc for `git.pushMode`).
**Verify:** with a control box configured, `agentbox create --dangerously-with-credentials`
refuses and names leasing; unset `relay.controlPlaneUrl` and the same command still works
end-to-end. Check ground truth with `git ls-remote`.

**Landed.** One pure, shared gate — `directGitModeRefusal({ pushMode, hubInPlay })` in
`git-creds-gate.ts` (its existing home for the TTY + cloud-only guards) — returns a leasing-named
refusal when `pushMode === 'direct'` **and** a hub is in play, else `null`. Every entry to
`git.pushMode=direct` calls it: the four launchers `create` / `claude` / `codex` / `opencode` (via
`--dangerously-with-credentials`, which sets `git.pushMode=direct`, **or** the config key set
directly) and `connect --dangerously-git-credentials` (the post-create equivalent). `hubInPlay =
remoteHubConfigured(effective) || opts.viaHub` for the launchers, `remoteHubConfigured(effective)`
for `connect`. The old `--via-hub`-specific "ignored for --dangerously-with-credentials; building
locally" fallback was **folded in** and deleted in all three agent launchers (opencode: the whole
`hubIncompatible` term was that; claude/codex: the `|| pushMode === 'direct'` disjunct was removed,
leaving only `--resume` / `--plan`). Existing guards are untouched: docker-not-applicable (its own
message, kept ahead of the leasing gate so a docker box never gets the wrong message), TTY-required,
and `-i`-incompatible. `git.pushMode` resolution (`auto` → lease) was not touched.

**Verified end-to-end via the built CLI** (isolated `$HOME`, ground-truth by observed exit/behavior):
with `relay.controlPlaneUrl` set, `create/claude/codex/opencode --provider e2b
--dangerously-with-credentials` each refuse (exit 1) with the leasing message; the same refusal
fires from `git.pushMode=direct` set via **config** (no flag); `--via-hub
--dangerously-with-credentials` refuses even with `controlPlaneUrl` unset (fold-in); `docker`
+ direct still gets the "not applicable to docker" message, not the leasing one. With
`relay.controlPlaneUrl` **unset**, the gate is a proven no-op — the create flow proceeds into the
**unchanged** credential-copy path and reaches the real TTY-required creds gate (feature intact).

### Notes for later steps

- **Scope: gated all FOUR launchers, not the three the brief listed.** The brief's file set named
  `create` / `opencode` / `connect`, but `claude.ts` and `codex.ts` accept the same
  `--dangerously-with-credentials` flag and carried the identical docker guard + `hubIncompatible`
  direct-term. Gating only three would have left `agentbox claude --dangerously-with-credentials`
  copying a credential into a box under a control box — the exact exposure the gate exists to
  prevent, with a false appearance of coverage. The maintainer authorized the widening; no parallel
  step owns `claude.ts` / `codex.ts` (Step 5 = lifecycle, Step 2 = approvals, Step 8 = create), so
  there is no conflict. The check lives in **one** place (`directGitModeRefusal`) so the four
  launchers + `connect` can't drift.
- **No other entry to `direct` exists.** Swept for every path that can reach `git.pushMode=direct`:
  the flag (four launchers), the config key (read as `cfg.effective.git.pushMode` by those same
  launchers), and `connect --dangerously-git-credentials` — all gated. `exec-method.ts` / `update.ts`
  `'direct'` is an unrelated `ExecMethod`; `ensure-repo-installed.ts` only *reads* the resolved mode
  downstream (to skip the GitHub-App repo nag) and is not an enable-point.
- **`hubInPlay` folds in `--via-hub`, and it must stay `||`-ed with `opts.viaHub`.** A user can
  force the hub with `--via-hub`/`--url` even when `relay.controlPlaneUrl` is unset in config; a gate
  keyed on `controlPlaneUrl` alone would miss that and route a `direct` box to the hub worker (which
  can't thread the credential copy). The old per-launcher `--via-hub`+direct fallback existed for
  exactly this — folded into the one gate rather than left to drift.
- **`connect` loads config itself** (`loadEffectiveConfig(box.projectRoot ?? box.workspacePath ??
  process.cwd())`) since it previously read none, and gates on `relay.controlPlaneUrl` (not the box's
  own `cloud.controlPlaneUrl`) to match the plan's stated condition and the launchers.
- **Real cloud-push e2e (box actually pushes) was NOT re-run — deliberate.** That path
  (`resolveGitCredsCarry` → `provider.enableDirectGit` / seed → in-box `git push`) is **unchanged**
  by this step, and this dev box has no test repo with a pushable origin (`../agentbox-test-repo*`
  absent) and in-box push is relay-gated. Instead the no-regression side was proven by showing the
  gate is a clean no-op without a control box (the flow reaches the real credential gate). A later
  step touching the copy/seed path should still smoke a real `--dangerously-with-credentials` box +
  `git ls-remote`.

---

## Step 14 — Docs and tray ✅ done (tray = documented follow-up)

- Update `apps/web/content/docs/{api,deployed-hub,configuration,cli}.mdx` and
  `docs/{architecture,cloud-providers,hub-testing,create-and-checkpoints}.md` as each step lands
  — stale public docs are a bug, so do not batch this to the end.
- Extend `apps/hub/app/(dashboard)/api/v1/lib/openapi.ts` with every route added, plus the
  shipped-but-undocumented ones (`rename`, `open`, `open-targets`, `hosts`, `login-code`).
- The tray already shells `agentbox hub target --json` and speaks `/api/v1`; it needs the enriched
  Box payload from Step 3. Update `../agentbox-tray` and push straight to `main`.
- Fix the stale claim in `CLAUDE.md` that `/api/events` is cookie-only — Bearer works
  (`apps/hub/proxy.ts:20,76`).

**Landed (docs + OpenAPI).** OpenAPI (`api/v1/lib/openapi.ts`) now documents **every** route — the
8 that shipped without an entry (`GET /boxes/:id/agent`, `POST /boxes/:id/checkpoint`,
`GET /boxes/:id/logs`, `POST /boxes/:id/rename`, `GET|DELETE /checkpoints`, `POST /prune`,
`GET /jobs`, `POST /jobs/:id/login-code`), new `Checkpoints`/`Fleet` tags + their response schemas
(`CheckpointCreateResult`/`CheckpointListing`/`CheckpointRemoveResult`/`PruneResult`/`JobListItem`/
`AgentState`), the enriched `Job` (error/provider/name/agent/createdAt/login), and the Step-3 `Box`
adoption fields (`sandboxId`/`originUrl`/`publicHost`/`image`/`webPort`/`previewUrls`/`lastAgent`/
`topology`/`shellCount`). `rename`/`open`/`open-targets`/`hosts` were already present. A **new guard
test** `apps/hub/test/openapi-coverage.test.ts` diffs the App-Router route files against the document
in both directions (fails on an undocumented route AND a documented path with no route file) — the
"verification checklist" the openapi.ts header always claimed but never had. **Verified end-to-end**:
built the standalone hub, restarted it, and the served `GET /api/v1/openapi.json` lists all **37**
routes with a **perfect bijection** to the route files (0 missing, 0 stale), `GET /api/v1/docs`
renders, and `pnpm --filter @agentbox/web build` is green.

Public docs: `api.mdx` (all 9 endpoints + Checkpoints/Fleet groups + the accurate "one path, IO plane
excepted" framing), `deployed-hub.mdx` (a new **"What still needs your laptop"** section — the direct
IO plane, local adoption, `secrets.env` on both machines, the launcher-foreground-create exception,
the no-TTL parked-approval callout — plus corrected the stale `ls` merge/`on hub`/`orphan` description
to the single-`/api/v1/boxes` listing), `configuration.mdx` (added `git.pushMode`), `cli.mdx` (already
accurate — no overstatement). Internal docs: `architecture.md` (a new **"End state: one path through
`/api/v1`"** subsection with the four deliberate exceptions), `create-and-checkpoints.md` (create +
checkpoint now route through `/api/v1`, the mechanics moved *behind* the API), `cloud-providers.md`
(§4b custody/adoption/thin-client + a routing note on §6), `hub-testing.md` (why "both modes" is the
point + the coverage test). `CLAUDE.md` fixed: `/api/events` accepts Bearer (same gate as `/api/v1`);
the cookie is an *additional* same-origin credential, not a replacement (confirmed in `proxy.ts` —
`gateApi` handles both prefixes).

**Tray — NOT done, deliberate documented follow-up.** `../agentbox-tray` is a **host-side sibling
repo** and is not reachable from inside this AgentBox (`/workspace`'s parent has no `agentbox-tray`,
and the box has no path to it or to its `main`). Per the step brief ("if you cannot reach it, say so
plainly and leave the tray work as a documented follow-up rather than pretending it is done"), the
tray change is a **follow-up**. What it needs (actionable): the tray's Swift `Box` model
(`HubAPIBoxSource`) should decode the enriched Step-3 fields now present on `GET /api/v1/boxes` —
`sandboxId`, `originUrl`, `publicHost`, `image`, `webPort`, `previewUrls`, `lastAgent`, `topology`,
`shellCount` (all optional; docker/synthetic rows omit them) — to reconstruct/adopt and label cloud
boxes without a second wire. The hub API contract it already speaks is unchanged otherwise; the
`Box` schema in the served `openapi.json` is the authoritative field list. Commit + push straight to
`main` there (no PR flow), from a checkout that can reach the sibling repo.

---

## What this leaves on the laptop

With a remote hub configured and these steps landed, the laptop runs **no long-lived agentbox
process**: the local hub is never the target, and a hub-created box has `topology:
'control-plane'` so it forwards `/rpc` to the control box and never calls home. The control box
runs the poller, approvals, status store, keepalive and autopause.

Two consequences that follow from the control-plane topology and are worth stating plainly:

- **"The host" means the control box for anything box-initiated** — with `cp` now the exception.
  `download.workspace` still lands files on the VPS and `browser.open.mirror` is meaningless there,
  but `cp.toHost`/`cp.fromHost` are brokered back to the user's machine (and fall back to a custody
  cache when it is offline), because the VPS holds no checkout of the project — see
  [`plans/box-cp-host-reach-plan.md`](./plans/box-cp-host-reach-plan.md).
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
