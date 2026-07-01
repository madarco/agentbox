# Sync-layer refactor — progress & continuation

Branch: `feat/sync-layer` (off `feat/control-plane-create`; PR targets that, not `main`).
Full design: the approved plan (`we-need-to-abstract-rippling-clover`). This file tracks
execution state so the branch is self-documenting for resumption. For the steady-state
architecture (the seams, the four override mechanisms, how to add a provider), see
[`sync-architecture.md`](./sync-architecture.md).

## Goal (recap)
One well-defined, **bidirectional** sync layer, organized by concern (git / env / files /
credentials / skills / dynamic) with per-tool logic isolated, behind a single
`SyncTransport` seam — collapsing the docker/cloud + per-tool duplication, and preserving /
unblocking the 3-way control-plane relay work.

Two-tier layout (dependency-graph-driven): **pure contracts** in `packages/core/src/sync/`;
**fs/execa impl** in `packages/sandbox-core/src/sync/`; transports in the provider packages.

## Done (committed, verified: build + typecheck + lint + tests green)

- **Phase 1 — Tier-1 contracts + name adapter.** `packages/core/src/sync/`:
  `transport.ts` (`SyncTransport` + `TransportCaps`/`PushOptions`/`VolumeHostSource`),
  `types.ts` (topology/direction/concern + reserved `SyncState`), `agent-kind.ts`
  (`toSyncKind`/`toQueueKind`/`normalizeLastAgent`), `reconciler.ts`. `Provider.syncTransport?`
  added. Two ad-hoc name shims migrated to the adapter. (core 27 tests; relay 252 intact.)
- **Phase 0 — parity net.** `packages/sandbox-core/src/sync/recording-transport.ts` —
  `RecordingSyncTransport` records a concern's exact ordered transport calls (each concern is
  a pure fn of `(ctx, transport)`), the golden-test net for every later phase. (Reframed from
  a fragile full-`create()` snapshot.)
- **Phase 2 — registry.** `packages/sandbox-core/src/sync/registry.ts` + `agents/types.ts`:
  `AGENT_SYNC_SPECS` (data-only: paths, credentials, forwarded env keys, caps; opencode's
  3-XDG-dir layout as data) + `resolveAgentSpec(id|alias)`.
- **Phase 3 — SyncTransport (docker+cloud) + env concern.** `core` gained `applyTarball`
  (unified host→box primitive). `DockerSyncTransport` (docker CLI wrappers, container-only,
  works at create) + `CloudSyncTransport` (CloudBackend wrappers). `sync/concerns/env.ts`
  unifies docker `copyHostEnvFilesToBox` + cloud `uploadEnvFiles` (both now thin wrappers
  injecting their transport); env helpers re-exported from sandbox-docker for existing
  importers. `SyncContext` added. **Validated on a real docker box**: a gitignored
  secrets.toml/.env.gitignored (git-ignored in-box → not from the git seed) landed in
  /workspace owned vscode:vscode via the refactored path.
- **Phase 4a — carry concern (`planCarryEntry`).** `sandbox-core/src/sync/concerns/files.ts`:
  pure `planCarryEntry(entry)` computes the shared host→box carry decisions
  (`~/`→`/home/vscode`, file-vs-dir, exclude, uid/mode defaults, rename-needed,
  parent-chain-needed). Docker `copyOneEntry` + cloud `uploadOneEntry` now consume it and
  keep their *apply* mechanisms byte-identical (docker streamTarPipe + `docker exec
  --user 0:0`; cloud staged-tar + one combined bash command — never split, per the Vercel
  hang note). Unified the two providers' drifted parent-chain predicate on docker's
  (skip-the-no-op) form — identical in effect, strictly safer for Vercel. Net −29 lines.
  New `carry-plan.test.ts` (10); cloud `carry.test.ts` (8) unchanged + green.
- **Phase 4b — dynamic concern (close cloud→docker leak).** Moved the claude path trio
  (`encodeClaudeProjectsKey`/`BOX_CLAUDE_PROJECT_DIR`/`resolveClaudeMemoryDir`) into
  `sync/agents/claude/paths.ts` and the workflows+memory manifest logic
  (`buildHostSyncManifest`/`computeSyncDelta`/`stageDynamicSyncTarball` + types + `BOX_*`
  consts) into `sync/concerns/dynamic.ts`. `sandbox-docker`'s `host-stage.ts` +
  `dynamic-sync.ts` are now thin re-export shims (existing importers untouched); cloud
  `dynamic-sync.ts` imports from `@agentbox/sandbox-core` — **leak gone**. Docker create
  never consumed the manifest fns (it seeds workflows/memory via the `~/.claude` volume
  rsync), so this is cloud-runtime + test only. Docker `dynamic-sync.test.ts` (12) still
  green through the shims (cross-package guard). `seedDynamicConfig`'s cloud exec/upload
  orchestration unchanged (its transport unification belongs with Phase 7).
- **Phase 4c — skills concern (`~/.agents` seed behind the transport seam).** Moved the
  pure host-side symlink pre-scan (`findUnsyncableSymlinks` + `isUnder`) into
  `sync/host-links.ts` (re-exported from docker `claude.ts` for its test/importers) and
  added `sync/concerns/skills.ts:seedAgentsVolume(transport, …)` — computes the
  unsyncable-symlink `--exclude`s host-side and drives the docker rsync-helper container
  through `transport.seedVolumeFromHost`. Added `VolumeHostSource.copyUnsafeLinks` to the
  core contract + honored it in `DockerSyncTransport`. Docker `ensureAgentsVolume` is now a
  thin wrapper (ensureVolume + `created` detection, then delegate the seed); its
  best-effort no-host-dir writable-chown is preserved (sync failures still propagate). Net
  −100 lines. New `skills-concern.test.ts` (5) golden-tests the emitted `seedVolumeFromHost`
  op; docker `find-unsyncable-symlinks.test.ts` (6) still green through the re-export.
  **Box→host pull deliberately NOT unified:** `pullClaudeExtras`/`pullCodexConfig`/
  `pullOpencodeConfig` are intrinsically docker-volume-specific (helper container over
  `${volume}:/src:ro` + bespoke per-tool inventory/merge) with NO polymorphic caller — each
  `download-<tool>` CLI command is a tool-specific entry point. Forcing a `spec.pull`
  abstraction now would be speculative + risky (same "don't force a unification" call as
  carry's apply mechanism). Left for a real consumer (the Phase 7 driver, or a future
  download-all/resync path).
- **Phase 5 — credentials concern (pure guards + box→host extract).** Moved the pure
  credential guards into `sync/concerns/credentials.ts`: `isRealAgentCredential` (now
  registry-driven via a new `credential.realShape` spec field — claude=`claude-oauth`
  requires a non-empty `claudeAiOauth.refreshToken`, codex/opencode=`nonempty-json`),
  `hostClaudeBackupExpired` (the expiry gate), `hostBackupHasCredentials`, and the
  seed-once marker `SEED_MARKER` (`.agentbox-seeded-at`). Docker `claude-credentials.ts`
  re-exports the three guards (shim — every docker importer/test **and** the `assert-creds`
  CLI mock untouched, cross-package parity for the move); cloud imports the guards + marker
  from `@agentbox/sandbox-core` instead of through docker (leak closed). Added
  `extractCredentials(transport)` — the box→host pull expressed against
  `SyncTransport.readText` (registry-driven box paths + host backups + the guard); cloud's
  `extractCloudAgentCredentials` is now a thin `CloudSyncTransport`-injecting wrapper
  (`readText` is byte-identical to the old inline extract: `cat <p> 2>/dev/null` + noRetry
  → null on exit≠0). New `credentials-concern.test.ts` (15) mirrors the docker guard cases
  (double-parity) + golden-tests the emitted `readText` ops; docker `claude-credentials.test.ts`
  + cloud `agent-credentials.test.ts` (9, the extract wrapper) still green.
  **Deliberately NOT moved (same "don't force a unification" call as carry/skills):** the
  docker throwaway-root helper-container sync (`syncClaudeCredentials`/`SYNC_SCRIPT`/
  `volumeClaudeCredentials`/`extractVolumeAuthToBackup`) — it predates any running box (so
  it has no `SyncTransport` analog; the transport is box-bound) and has no polymorphic
  caller; its `ISOLATE` seed-only gate is a docker-volume security property. The cloud
  *seed* orchestration (`seedCredentialsOne`'s marker/force gate + `uploadFile` +
  volume-vs-ephemeral extract split) also stays in cloud — its transport-seam collapse
  folds into the Phase 7 driver (phasing note #2). **SMOKE STILL OWED:** the box→host
  extract now flows through `CloudSyncTransport.readText` on `checkpoint create
  --set-default` (best-effort, box→host only — no create-path blast radius), but Phase 5
  stays on the login→destroy→recreate→inherited matrix per the gate before any push.
- **Phase 6 — git resync behind `WorkspaceResyncPorts` (docker-preserving).** Moved the
  box-wins untracked-overlay classifier (`classifyUntrackedOverlay` + `NON_REGULAR_TOKEN`)
  and the full resync orchestration (`resyncWorkspace`) into `sync/concerns/git.ts` — the
  concrete `box-wins-content-hash` policy the reconciler contract anticipated. Defined the
  `WorkspaceResyncPorts` contract in `core/src/sync/workspace.ts` (host-git probes +
  box-git exec + the stdin-streaming box untracked-probe + tar-apply — the ops the
  stateless `SyncTransport.exec` can't express). Docker `resyncWorkspaceFromHost` is now a
  thin wrapper building `makeDockerResyncPorts(container)` whose methods reproduce the
  pre-refactor host-git/`docker exec` commands **byte-for-byte** (behavior-preserving by
  construction — the orchestration moved verbatim, only its I/O calls became `ports.*`). New
  `git-concern.test.ts` (4, mirrors the docker classify cases — double-parity) +
  `git-resync.test.ts` (4, golden-tests the orchestration against a scripted fake ports: the
  overlay/classify path, a clean merge, a merge conflict kept box-side, and the
  unresolvable-ref skip). Docker `classify-untracked-overlay.test.ts` still green through
  the re-export; cli/cloud/relay consumers of the resync result unchanged. **Cloud left
  unwired** (the "Phase 2" gap stays open — the seam is ready for it) and **workspace *seed*
  not moved** (docker worktree add + `mount --bind` replay has no cloud analog — cloud
  clones — a deliberate non-unification). **SMOKE OWED:** docker session-start resync moved
  onto the seam (runs on every down→up transition, mutates worktrees) — needs the docker
  half of the matrix before push, even though it's behavior-preserving.

## Refinements to the plan's phasing (decided during execution)
1. **Transports co-develop with their first concern (Phase 3), not in a vacuum.** Docker
   `copyOneEntry` and cloud `uploadOneEntry` *are* the push primitives; the transport
   `pushTree`/`pushFile`/`applyTarball` surface is best finalized against the env/carry
   concerns that consume it, with `RecordingSyncTransport` + existing `scan-host-env-files`/
   `carry` tests as parity nets.
2. **The docker `create.ts:623-763` + cloud `cloud-provider.ts:705-819` orchestration
   collapse folds into the driver phase (Phase 7)**, after concerns exist and are proven —
   safer than a one-off partial collapse in Phase 2.

## Remaining (behavior-moving; each must keep existing provider tests green and be
## smoke-tested {local,vercel,hetzner}×{claude,codex} before pushing)

- **Phase 4 is complete** (carry + dynamic + skills, all above in Done). One piece was
  **deliberately deferred, not skipped:** the box→host per-tool pull (`pullClaudeExtras`/
  `pullCodexConfig`/`pullOpencodeConfig`) stays docker-volume-specific — no polymorphic
  caller exists to unify, and the fns are intrinsically docker (helper container over the
  config volume). It folds naturally into the Phase 7 driver or a future download-all/resync
  consumer; a `spec.pull` abstraction without a consumer would be speculative.
  - **transport fix already landed (Phase 3):** `DockerSyncTransport.applyTarball` always
    pins `--user <uid>:<uid>` (incl. `0:0` for root) — the carry `uid:0` path needs it; env
    (`uid:1000`) is unchanged.
  - **SMOKE MATRIX STILL OWED before any push:** Phase 4b (dynamic) and 4c (skills) move
    real create-path behavior (cloud dynamic seed import surface; docker `~/.agents` volume
    seed via the transport helper container, incl. the non-recursive→recursive chown on the
    no-host-`~/.agents` fallback). Run `{local,vercel,hetzner}×{claude,codex}` per the gate
    below before pushing this branch.
- **Phase 5 — credentials concern.** Pure guards + the box→host `extractCredentials` are
  **done** (in Done above): expiry gate (`hostClaudeBackupExpired`), seed-once marker
  (`SEED_MARKER`), and the `isRealAgentCredential` guard are now core/registry data
  (`credential.realShape`). **Remaining (folds into Phase 7 driver):** the *seed*
  orchestration — cloud `seedCredentialsOne` (marker/force gate + `uploadFile` +
  volume-vs-ephemeral extract split) collapses onto the transport there; the docker
  helper-container claude sync (`syncClaudeCredentials`/`SYNC_SCRIPT`, incl. the `ISOLATE`
  seed-only gate) stays provider-specific (no box-bound `SyncTransport` analog, no
  polymorphic caller — a deliberate non-unification). Highest-risk: the seed collapse needs
  the real-box login→destroy→recreate→inherited smoke both directions on docker + volume +
  ephemeral cloud, with extra assertions.
- **Phase 6 — git resync/seed + box-facts.** The resync half is **done** (in Done above:
  classify + `resyncWorkspace` behind `WorkspaceResyncPorts`, docker-preserving). **Remaining:**
  (a) **wire `CloudSyncTransport` into resync to close the cloud "Phase 2" gap"** — implement
  a cloud `WorkspaceResyncPorts` (box-side ports on `CloudSyncTransport`, host-git ports reused
  from docker's) + `Provider.resyncWorkspace` for cloud + drop the docker-only gate at
  `apps/cli/src/lib/resync-start.ts`; net-new behavior on live cloud working dirs — needs the
  full {vercel,hetzner}×{claude,codex} smoke. (b) workspace *seed* migration (deferred — docker
  worktree/bind-mount seed has no cloud analog). (c) box-facts (the generated
  `/etc/claude-code/CLAUDE.md` fold) — the last provider-mirrored create-step not behind a seam.
  Leave the `inBoxClone` control-plane branch untouched throughout.
- **Phase 7 — data-driven driver.** `sync/driver.ts` `SEED_PIPELINE` + `seed()`; replace the
  imperative sequences in `create.ts`/`cloud-provider.ts` (order preserved). Move the
  per-tool static-config stage producers to `sync/agents/<tool>/stage.ts` + fill in the
  claude/codex `staticPaths[].exclude` (`CLAUDE_RUNTIME_EXCLUDES`, `CODEX_RSYNC_EXCLUDES`).
  Add the `AGENTBOX_SYNC_DRYRUN` passthrough (prints the transport sequence) here.
- **Phase 8 — naming reconciliation.** Route all reads/writes through `agent-kind.ts`; delete
  the (now-delegating) inline shims. Only phase that may change a snapshot; relay tests stay
  green; no data migration (read-time normalization only).
- **Phase 9 — relay delegation + git-refs unification.** Extract the triplicated
  branch/refspec/upstream logic (`server.ts:1420`, `host-actions.ts:1122`, `ctl/git.ts:129`)
  into pure `core/src/sync/git-refs.ts` (shared by relay-host + ctl-box — this is why they're
  in `core`). Point `runGitRpc`/`runDownloadRpc`/`handleGitRpc` at shared `sync/git`+`sync/files`.
  Relay gating/token/poll unchanged.
- **Phase 10 — close the two wiring gaps.** Thread `relay.controlPlaneUrl` →
  `CreateBoxRequest` → box forwarder-upstream (`cloud-provider.ts:583-594`,
  `bootstrap-launch.ts:52-78`) + persist topology on `BoxRecord`; set `AGENTBOX_GIT_LEASE=1`
  in-box when the relay is the plane (in-box daemon `ctl/commands/daemon.ts`).

## Per-phase gate
`pnpm build && pnpm typecheck && pnpm lint`, then package tests (core, sandbox-core,
sandbox-docker, sandbox-cloud, relay, cli). Before pushing: the real-box smoke matrix
(`docs/sync-layer-refactor.md` §Remaining notes) across {local,vercel,hetzner}×{claude,codex}.

## Deferred backlog
Granular items **deferred within an otherwise-complete phase** (distinct from the whole
future phases in §Remaining). Tracked here so a deliberate deferral / non-unification can't
be mistaken for an oversight. Each notes *why* and *where it lands*.

- **[owed] Smoke matrix before push (Phases 4b, 4c, 5).** The only thing blocking a push.
  Phase 4b (cloud dynamic seed import surface), 4c (docker `~/.agents` volume seed through
  the transport helper container, incl. the no-host-dir chown fallback), and 5 (box→host
  credential extract now via `CloudSyncTransport.readText` on `checkpoint --set-default`)
  all moved real create/checkpoint-path behavior. Run `{local,vercel,hetzner}×{claude,codex}`
  — for Phase 5 specifically the login→destroy→recreate→inherited both-directions matrix.
- **[→ Phase 7 driver] Box→host per-tool pull (Phase 4c).** `pullClaudeExtras` /
  `pullCodexConfig` / `pullOpencodeConfig` stay docker-volume-specific — no polymorphic
  caller (each `download-<tool>` CLI command is its own entry point); a `spec.pull`
  abstraction without a consumer would be speculative. Lands with the driver or a future
  download-all/resync consumer.
- **[→ Phase 7 driver] Cloud dynamic-seed orchestration (Phase 4b).** `seedDynamicConfig`'s
  cloud exec/upload sequence isn't yet on the transport seam (only the manifest *logic*
  moved to core). Its transport unification belongs with the driver.
- **[→ Phase 7 driver] Cloud credential *seed* orchestration (Phase 5).** `seedCredentialsOne`
  (marker/force gate + `uploadFile` + the volume-vs-ephemeral extract split) collapses onto
  the transport in the driver phase. Highest-risk piece — needs the login→destroy→recreate→
  inherited smoke.
- **[non-unification — revisit only on a real consumer] Docker helper-container credential
  sync (Phase 5).** `syncClaudeCredentials` / `SYNC_SCRIPT` / `volumeClaudeCredentials` /
  `extractVolumeAuthToBackup` — throwaway root container that predates any running box, so
  it has no box-bound `SyncTransport` analog, and no polymorphic caller. The `ISOLATE`
  seed-only gate is a docker-volume security property. Same "don't force a unification" call
  as carry's apply mechanism and skills' box→host pull. Keep provider-specific unless a real
  cross-provider consumer appears.
- **[minor cleanup] Backup-file constants still docker-owned (Phase 5).**
  `CREDENTIALS_BACKUP_FILE` / `CODEX_*` / `OPENCODE_CREDENTIALS_BACKUP_FILE` remain docker
  consts that mirror the registry's `credential.hostBackup` (drift-guarded by the registry
  test). Could become registry-derived re-exports to shrink the drift surface; low value,
  low risk, no rush.
- **[owed] Docker session-start resync smoke (Phase 6).** `resyncWorkspaceFromHost` moved
  onto the `WorkspaceResyncPorts` seam (behavior-preserving by construction — the docker
  ports reproduce the exact commands). It runs on every docker down→up transition and
  mutates worktrees, so the docker half of the matrix is owed before push despite the
  unit-level parity.
- **[next Phase 6 step] Cloud live-box resync (close the "Phase 2" gap).** Implement a cloud
  `WorkspaceResyncPorts` (box-side ports on `CloudSyncTransport`; host-git ports identical to
  docker's — factor those out to share) + `Provider.resyncWorkspace` for cloud + drop the
  docker-only gate at `apps/cli/src/lib/resync-start.ts`. Net-new behavior on live cloud
  working directories → needs the full {vercel,hetzner}×{claude,codex} smoke; kept out of the
  docker-preserving pass on purpose. Must stay behind the non-`inBoxClone` branch.
- **[non-unification — revisit only on a real consumer] Workspace *seed* (Phase 6).**
  `seedWorkspace` (docker `git worktree add` + `mount --bind` replay of host stash/untracked)
  stays docker-specific — cloud clones in-box instead (no worktree/bind-mount analog), so
  there is no shared shape to extract. Leave until a real cross-provider seed consumer exists.
- **[→ later] box-facts behind a seam (Phase 6).** The generated `/etc/claude-code/CLAUDE.md`
  system-prompt fold (docker `codex.ts` + cloud `codex-agents-override.ts`) is the last
  provider-mirrored create-step not behind the sync seam; low urgency, folds with the driver.
