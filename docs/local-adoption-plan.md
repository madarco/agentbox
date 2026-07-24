# Local adoption — the PC as a thin client of the control box

**Status: all four phases IMPLEMENTED + live-verified end to end against a freshly
deployed control box (2026-07-17), including the laptop-off push. See "Live
verification status" at the end for what is proven and what is not.**

This is the plan of record for closing the *local-adoption gap* described in
[`control-box-plan.md`](./control-box-plan.md) (phase-4 backlog): once a control box is enabled,
the local `agentbox *` commands must see and drive the state that lives on the control box —
boxes created from the web UI, per-box SSH keys, project seed material, and bake state.

## Direction (decided)

When a control box is enabled (`relay.controlPlaneUrl` set), **the PC becomes a thin client**:
the control box keeps everything and is the source of truth for cloud boxes; only local docker
boxes remain purely local. Confirmed product choices:

- **Auto-adopt on any by-name miss** — every command that resolves a box by name (`attach`, `cp`,
  `download`, `url`, `screen`, `destroy`, `claude <name>`, …) transparently adopts a hub-created
  box when the name isn't in local state. This also means a hub box can be destroyed by name from
  the PC.
- **Seed material stored plaintext in custody** — same trust model as the existing custody store
  (0600 files on the user's own VPS, which already holds agent OAuth creds, SSH keys, and
  `secrets.env`). Envelope encryption remains a separate whole-store backlog item.
- **Hub creates always use the latest pushed seed** — the job log records the seed's age and the
  repo commit it was captured at; no confirmation gate.

With no `controlPlaneUrl` configured, everything behaves exactly as today — the offline/local
path never regresses.

## Source-of-truth split

| State | Source of truth | PC-local copy |
|---|---|---|
| Cloud boxes (any origin) | Control box `boxes` table (`Store`) — PC creates already register via `registerBoxWithPlane` (`packages/sandbox-cloud/src/cloud-provider.ts`) | `state.json` `BoxRecord` = materialized cache, created/refreshed by **adoption**; needed for attach material (SSH paths, tokens, `projectRoot` mapping) and offline fallback |
| Local docker boxes | `state.json` (unchanged) | — |
| Per-box SSH keys | Custody `boxes/<sandboxId>/ssh/` | `~/.agentbox/boxes/<sandboxId>/ssh/`, pulled on demand |
| Project seed (untracked tar + env/secrets) | Custody `projects/<slug>/seed/` | the working tree itself |
| Bake state | Custody `prepared/<provider>.json` | `~/.agentbox/<provider>-prepared.json`, fingerprint-gated |

The repo itself never needs a custody copy: the control-box worker already clones with a leased
GitHub-App token (`packages/relay/src/create-worker.ts`: `leaseRemoteUrl` → `cloneRepo`).

The full thin-client end-state (dropping local cloud `BoxRecord`s entirely) is deliberately out
of scope — the cache-record model below is the stepping stone; revisit once adoption is proven.

---

## Phase 1 — Registration enrichment + adoption module (`hub adopt`)

The hub's `BoxRegistration` today can't rebuild a full local `BoxRecord` (no VPS IP/host, image,
agent, project link).

1. `packages/relay/src/types.ts` — add optional fields to `BoxRegistration`: `publicHost` (VPS
   IP for SSH providers), `image`, `webPort`, `agent`, `projectSlug` (the custody
   `projects/<slug>` key). No store migration: sqlite persists the registration as a JSON `data`
   blob (`sqlite-store.ts`).
2. `packages/core/src/cloud-backend.ts` — add `CloudHandle.publicHost?`; populate in the hetzner
   and digitalocean backends (they already know the server IP for the ssh target).
3. `packages/sandbox-cloud/src/plane-register.ts` — extend `RegisterBoxWithPlaneArgs` + POST
   body; pass the new fields at the create-time call (`cloud-provider.ts` ~:1051) and the
   resume re-register (~:472-481). Hoist the project slugger from
   `apps/cli/src/commands/control-plane.ts` (~:511) into a shared helper in
   `packages/sandbox-core`.
4. New `apps/cli/src/control-plane/hub-adopt.ts` (modeled on `hub-pull.ts` for testability):
   `adoptHubBox({admin, custody, ref}) → BoxRecord`:
   - match `ref` against hub `listBoxes()` (name / boxId / sandboxId);
   - build the `BoxRecord`: `provider = reg.backend`, `container = 'cloud:'+sandboxId`,
     `cloud = {backend, sandboxId, image, webPort, lastState, topology:'control-plane',
     controlPlaneUrl}`, fresh relay/bridge tokens (same as `recover.ts` `adoptUnknownBox`),
     `lastAgent = reg.agent`, branch from `reg.worktrees`, `ssh` from `publicHost` for SSH
     providers;
   - project mapping: normalize `reg.originUrl` and match against the cwd project's origin
     remote, then other state boxes' origins → set `projectRoot` **and rewrite
     `gitWorktrees[].hostMainRepo` to the local clone** (completes the deferred
     hostMainRepo-rewrite half of the phase-4 guard item); no match → record without
     `projectRoot` (shows under `ls -g` only);
   - pull SSH keys via the existing `pullBoxSshKeys` (`hub-pull.ts`) into
     `boxSshDirForProvider(...)` whenever custody `boxes/<sandboxId>/ssh` is non-empty (no
     provider hardcoding). vercel/e2b mint no keys — SDK attach works from the record + the
     locally configured provider API key; if the key is absent, fail with a message naming the
     missing env var;
   - `recordBox(record)`. Adoption is idempotent: re-adopting refreshes the cached record.
5. `apps/cli/src/commands/hub.ts` — `hub adopt <box>` subcommand beside `hub pull` (which keeps
   its keys-only behavior).
6. `apps/cli/src/commands/recover.ts` — before both `hetznerKeyMissing` hard-fails (~:108-113
   and ~:226-231), if `controlPlaneUrl` is set, attempt a custody key pull and re-check; only
   then fail (message notes custody was tried).
7. Unit tests (temp HOME, fake registrations/custody) mirroring the `hub-pull` tests: record
   reconstruction, origin matching, hostMainRepo rewrite, idempotent re-adopt.

**Verify (live):** create a box from the control-box web UI; on the PC `agentbox hub adopt
<name>` → shows in `ls -g`; `attach` works for a hetzner box (keys auto-pulled) and an e2b or
vercel box (SDK); adopt again from within a PC checkout of the same repo → `projectRoot` set,
plain `ls` shows it, in-box `agentbox-ctl git push` lands on the rewritten `hostMainRepo`.

## Phase 2 — Thin-client listing + auto-adopt on by-name miss

1. `apps/cli/src/commands/list.ts` (the `scopedBoxes` seam): when `controlPlaneUrl` is set,
   cloud rows come **from the control box** (`ControlPlaneAdminClient.listBoxes()` +
   `listStatuses()` over the existing `/admin/store` RPC), merged with local docker rows from
   `listBoxes()`. Local cloud `BoxRecord`s only enrich hub rows (projectRoot, adopted marker)
   and serve as offline fallback. Dedupe by `sandboxId`. Hard timeout (~1500 ms, hardcoded
   first) + a successful-listing cache at `~/.agentbox/hub-boxes-cache.json`; on timeout/offline
   render cached rows with an age note, else local-only. A local cloud record with **no** hub
   registration renders as `orphan (not in control box)` — surfaced, never auto-pruned.
   Project-scoped `ls` filters hub rows by matching `originUrl`; `--json`/`--cmux` carry the
   merged set plus a `source: 'hub' | 'local'` tag.
2. `apps/cli/src/box-ref.ts` — auto-adopt hook at the `kind === 'none'` path in
   `resolveBoxOrExit`: non-numeric explicit ref + `controlPlaneUrl` set → try `adoptHubBox(ref)`
   (timeout-guarded, network errors swallowed) before throwing `BoxNotFoundError`; log
   `adopted <name> from control box`. One hook covers every by-name command.
3. Unit tests: merge/dedupe/timeout-fallback/orphan tagging with a fake admin client.

**Verify (live):** hub-created box visible in `ls -g` (tagged); network off → `ls -g` still
instant from cache; `agentbox attach <hub-box>` with no prior adopt auto-adopts and attaches;
destroy a box on the hub → gone from `ls -g`, its stale local record shows as orphan.

## Phase 3 — Seed-material custody push + worker consumption

Custody layout: `projects/<slug>/seed/untracked.tar.gz`, `projects/<slug>/seed/env/<name>` (each
staged env/secret file the cloud create would seed), `projects/<slug>/seed/manifest.json`
(`{originUrl, baseBranch, repoHeadSha, files:[{path,sha256,bytes}], createdAt}`). The existing
`projects/<slug>/secrets.env` push is unchanged.

1. `packages/sandbox-cloud/src/sync/workspace-seed.ts` — expose the already-built untracked tar
   (currently module-private `maybeBuildUntrackedTar`) and the staged env-file set on
   `SeedCloudWorkspaceResult`, so the push reuses them instead of rebuilding.
2. New `packages/sandbox-cloud/src/custody-seed.ts` — `pushProjectSeedToCustody` (manifest +
   sha256 hash-skip like the credential push; size gate), called **best-effort** from the
   `cloud-provider.ts` create path in the same `controlPlaneUrl` block as
   `registerBoxWithPlane`/`pushBoxSshToCustody`. Never fails the create.
3. `apps/cli/src/commands/control-plane.ts` — `project push [--force]`: build + push the same
   seed set from the cwd without creating a box (register a project's seed on the hub before any
   PC create).
4. `packages/relay/src/create-worker.ts` — optional `fetchSeedMaterial` dep in `CreateBoxDeps`:
   after clone, overlay `untracked.tar.gz` (**clone wins on path conflicts** — files tracked
   since the push keep the repo version) and write env files; log the seed's
   `createdAt`/`repoHeadSha` into the job log so staleness is visible. The hub wires the dep to
   its local custody store directly (it *is* the custody host — no HTTP).
5. Body cap: custody payloads are base64-JSON (~33% inflation); add a `relay.custodyMaxBodyBytes`
   config key (default 32 MiB) enforced in `packages/relay/src/custody/routes.ts`; the client
   warns and skips the tar (still pushing env + manifest) on overflow.
6. Tests: seed round-trip (temp dirs, fake custody), worker overlay conflict rule, hash-skip.

**Verify (live):** PC `agentbox claude` on a project with untracked files + `.env`
(controlPlaneUrl set) → `projects/<slug>/seed/*` appears in custody; web-UI create of that
project → the box workspace contains the untracked files and env; re-run the PC create with
nothing changed → hash match, zero uploads.

## Phase 4 — Shared bake state (`prepared/<provider>.json`)

Conflict policy is mechanical: **fingerprint-match wins** — a custody record is adopted only if
its `base.contextSha256` equals the locally computed fingerprint; a mismatch is a stale bake,
ignored, and the normal re-bake proceeds.

1. `packages/relay/src/custody/store.ts` — add `'prepared'` to `CUSTODY_SCOPES`.
2. New `packages/sandbox-cloud/src/prepared-sync.ts` — `pushPreparedToCustody(provider)` /
   `pullPreparedFromCustody(provider)`; the pull writes via `writePreparedStateRaw` only on
   fingerprint match. Treat a 400 from an older hub (scope unknown) like a 404 — silent skip.
3. Hook points: after a successful `agentbox prepare` → push; at the baked-or-not gate (the
   `contextSha256` comparison in `packages/core/src/provider.ts`) → on local missing/stale,
   attempt a pull before deciding to bake. Both best-effort and offline-safe — the network fetch
   happens only where the alternative is a multi-minute bake, so no TTL/caching is needed.
4. Hub side: the worker's prepare path uses the same helpers against its local custody store
   (covers control-box bakes → PC *and* PC bakes → control box). Fold in the existing deploy
   backlog item: `hub deploy` seeds custody `prepared/` from the PC's local
   `*-prepared.json` files.
5. Tests: match-adopt, mismatch-ignore, offline fall-through.

**Verify (live):** bake e2b on the control box; delete the local `~/.agentbox/e2b-prepared.json`;
PC `agentbox claude --provider e2b` → no re-bake, log notes the adopted base. Then PC
`agentbox prepare --provider hetzner` → custody `prepared/hetzner.json` updated; a hub web-UI
hetzner create uses it without baking.

---

## Compat / conventions

- AgentBox is unreleased — no aliases or deprecations. New `BoxRegistration` fields are
  optional; old rows degrade gracefully (missing `publicHost` → resolve via the provider SDK
  once keys exist).
- Adopted records intentionally omit `cloud.hostSeeded` (they are in-box clones), so the
  session-start live-resync correctly skips them.
- Docs in the same change as each phase: this file's status lines, `control-box-plan.md`
  backlog pointers, and the public [`deployed-hub.mdx`](../apps/web/content/docs/deployed-hub.mdx)
  (+ CLI reference) for `hub adopt`, `hub project push`, `relay.custodyMaxBodyBytes`,
  and the thin-client `ls` behavior. Tray app: the `/api/v1/boxes` payload gains nothing
  breaking, but check the `source` tag if it gets exposed there.
- `pnpm typecheck` before pushing; the relay and hub are persistent daemons — rebuild + restart
  before verifying (see CLAUDE.md → hub restart with `AGENTBOX_HUB_BIN`).

## Live verification status

Verified live during implementation (against the deployed control box at
`relay.controlPlaneUrl`, and against a real relay daemon):

- **Phase 2** — `ls -g` with the control box reachable (~0.7s) and unreachable
  (1.9s, cached/degraded note, no hang). This caught a real bug: `AbortSignal`
  rejects a `fetch` promise but undici keeps the connecting socket until its own
  10s connectTimeout, so `ls` printed instantly and then held the shell ~9s.
  Fixed by probing reachability with a socket we own and destroy.
- **Phase 3** — `hub project push` to the live control box: seed
  landed under `projects/<slug>/seed/`, and a re-push of an unchanged tree
  uploaded only the manifest. This caught a second real bug: `tar -z` stamps the
  current time into the gzip header, so an unchanged tree hashed differently
  every run and re-uploaded the seed's largest blob. Fixed by gzipping via zlib
  (MTIME=0). Smoke data was cleaned off the control box afterwards.
- **Phase 4** — against a real `startRelayDaemon`: the `prepared/` scope
  round-trips, an unknown scope is still rejected (400), and a 4 MB seed tar
  passes the custody-scoped body cap (the 1 MiB relay cap would reject it).
  Note: the **currently deployed** control box answers 400 for `prepared/` — it
  predates the scope, which is exactly the back-compat case the pull treats as
  "nothing shared". It needs a redeploy to serve the new scope.

### Full goal-scenario run (2026-07-17)

A **fresh control box** was deployed from this branch onto a real Hetzner VPS
(`hub deploy hetzner --ref feat/local-adoption`) and the scenario run
end to end against it with an **e2b** box. All infrastructure was torn down after
(server + firewall + sandbox + the proof branch), and the PC's
`relay.controlPlaneUrl` / `deploy.json` restored to their previous control box.

Proven live:

- **Deploy + phase 4** — the new box serves the `prepared/` scope (the older one
  400s it), rejects unknown scopes, and the deploy **auto-seeded the PC's bake
  records** (`daytona`, `digitalocean`, `e2b`, `hetzner`, `vercel`) into custody.
- **Phase 1** — a PC create registered with the full adoption material
  (`image`, `webPort`, `projectSlug`; `agent` correctly absent for a plain
  `create`, `publicHost` correctly absent for e2b).
- **Phase 2** — with the local record deleted, `ls -g` fetched the control box's
  registry and rendered the box as `on hub`; `agentbox url <name>` then
  **auto-adopted** it ("adopted adopt-smoke from the control box") and opened the
  real URL. `agentbox shell <name> -- …` ran a command in the box through the
  adopted record.
- **Phase 1 project matching** — adopting from inside the box's own clone linked
  `projectRoot`, allocated `projectIndex`, and **rewrote `hostMainRepo`** to the
  local repo; project-scoped `ls` then listed it.
- **Phase 3** — the create pushed seed material to `projects/<slug>/seed/`
  (manifest only: the test repo's tree was clean).
- **Laptop-off** — with the host relay verified dead (nothing on :8787), an
  in-box `agentbox-ctl git push` landed commit `dcadad4` on GitHub via a leased
  token. Confirmed by `git ls-remote`, not by exit code.

Two real bugs this run found (both fixed on the branch):

1. **The create path never loaded the control-plane env**, so in an ordinary
   shell (where the operator hasn't sourced it) `AGENTBOX_RELAY_ADMIN_TOKEN` was
   unset and **every PC create silently skipped registration**: the box came up
   with `topology: control-plane` but the plane never heard of it, no seed was
   stored, and its push had no token to lease with. `providerForCreate` — the one
   choke point every create path shares — now loads it.
2. **The seeded bake records were never consulted at create.** The providers'
   baked-or-not gates are sync and read only local prepared-state, so a fresh
   control box failed every create with "run `agentbox prepare` first" while a
   perfectly good record sat in its custody. The hub worker now hydrates
   prepared-state from custody before create (same fingerprint-match-wins rule).

Still not exercised:

- **The web-UI create button itself.** The deployed hub's `/api/v1` is
  password-gated and entering a password is out of scope for an agent, so the
  hub-created box was produced via the resident worker instead. Note the web UI's
  queue (`/api/v1/boxes` → `enqueueQueueJob` → `_run-queued-job`) is a *different*
  path from `--via-hub` and has **no seed overlay wired** — see the backlog item
  below; it also predates this branch's lease wiring (`control-box-plan.md`).
- **hetzner-provider adoption** (the custody SSH-key pull half). e2b mints no
  keypair, so this run covered the record-only adopt path.

## Known limitation: a local name shadows a hub box

By-name resolution is local-first — the control box is asked only when the ref
misses locally. So a hub-only box whose **name** equals a local box's name can't
be driven by name: the local one wins, even though `ls` lists both.

This is deliberate. The alternative — asking the control box on every by-name hit
to check for a collision — puts a network round-trip in front of *every* command
for a case that needs the user to have picked the same explicit `--name` twice
(generated names don't collide). The shadowed box is still addressable by its
sandbox id or box id, which `hub adopt` / `hub pull` / auto-adopt all accept,
including unique prefixes.

Note the related pre-existing behavior: `findBox` resolves a name with a
first-match `find` and no ambiguity error, so two local records sharing a name
(e.g. `--name foo` in two projects) already resolve to whichever comes first.
Adoption doesn't change that; it just makes a same-named pair easier to create.

## Backlog (found by the live run)

- **Destroying a PC box doesn't reap its control-box registration.** `agentbox destroy`
  removes the local record and the cloud sandbox but leaves the box registered on the control
  box, so it lingers in the Store (and now, with the web-UI merge, in the dashboard) as a ghost.
  Destroy should also `DELETE /remote/boxes/:id` (the reap the hub Destroy button already does) when
  `controlPlaneUrl` is set. Pairs with the hub-side teardown item in `control-box-plan.md`.
- **The web UI shows PC-registered boxes but can't drive them yet.** `getData` now surfaces them
  (display), but start/stop/attach from the UI need the control box to reconstruct/drive a box it
  didn't create locally — the reverse of PC-side adoption. Follow-up.

- **The web-UI create queue has no seed overlay.** `--via-hub` and the resident
  worker go through `makeControlPlaneCreateBox`, which applies the project's
  custody seed. The web UI's own path (`POST /api/v1/boxes` → `enqueueQueueJob` →
  `_run-queued-job` → `provider.create`) does not, so a box created from the UI
  comes up without the project's untracked files / env. Wire `applyProjectSeed`
  into that path too (it already shares the blob-source seam). Pairs with the
  pre-existing `control-box-plan.md` item that the same path doesn't wire git
  leasing — both point at the web-UI queue being a second, thinner create path.
- **Adopting a hetzner box is unverified.** The record-only adopt (e2b) is
  proven; the custody SSH-key pull + `publicHost` half has unit tests only.

## Deferred (tracked elsewhere)

- Envelope encryption for custody at rest (whole-store item, pre-existing).
- Dropping local cloud `BoxRecord`s entirely (full thin-client end-state).
- Cloud-resource teardown initiated from the hub UI for worker-created boxes — separate
  `control-box-plan.md` backlog item; the Phase 1 registration enrichment (publicHost, image)
  unblocks it.
