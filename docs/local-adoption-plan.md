# Local adoption — the PC as a thin client of the control box

**Status: planned — no code written. One session per phase.**

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
   backlog item: `control-plane deploy` seeds custody `prepared/` from the PC's local
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
  (+ CLI reference) for `hub adopt`, `control-plane project push`, `relay.custodyMaxBodyBytes`,
  and the thin-client `ls` behavior. Tray app: the `/api/v1/boxes` payload gains nothing
  breaking, but check the `source` tag if it gets exposed there.
- `pnpm typecheck` before pushing; the relay and hub are persistent daemons — rebuild + restart
  before verifying (see CLAUDE.md → hub restart with `AGENTBOX_HUB_BIN`).

## Deferred (tracked elsewhere)

- Envelope encryption for custody at rest (whole-store item, pre-existing).
- Dropping local cloud `BoxRecord`s entirely (full thin-client end-state).
- Cloud-resource teardown initiated from the hub UI for worker-created boxes — separate
  `control-box-plan.md` backlog item; the Phase 1 registration enrichment (publicHost, image)
  unblocks it.
