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
