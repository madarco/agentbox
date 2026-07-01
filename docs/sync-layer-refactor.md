# Sync-layer refactor — progress & continuation

Branch: `feat/sync-layer` (off `feat/control-plane-create`; PR targets that, not `main`).
Full design: the approved plan (`we-need-to-abstract-rippling-clover`). This file tracks
execution state so the branch is self-documenting for resumption.

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

- **Phase 3 — transports + env concern (the vertical-slice PoC).**
  - `packages/core/src/sync/transport.ts`: consider adding `applyTarball(hostTarPath,
    boxDestDir, opts)` as the unified host→box primitive (`pushTree`/`pushFile` build on it;
    env/carry stage a filtered tarball then apply). Ground it in the two impls below.
  - `packages/sandbox-docker/src/sync-transport.ts` `DockerSyncTransport`: wrap
    `box-cp.ts` `uploadToBox`/`downloadFromBox`, `host-export.ts` tar-pipe/`pullToHost`,
    `docker exec cat` (readText), the `ensure*Volume` `docker run … rsync` (seedVolumeFromHost),
    volume create (ensureVolume). `caps={persistentVolumes:true,helperContainer:true,ephemeralFs:false}`.
  - `packages/sandbox-cloud/src/sync-transport.ts` `CloudSyncTransport`: wrap `CloudBackend`
    (`exec`/`uploadFile`/`downloadFile`), the FUSE `cp`-not-`tar` + vercel/e2b root carve-out.
    `caps.helperContainer=false`, `caps.ephemeralFs = typeof backend.ensureVolume!=='function'`.
  - `packages/sandbox-core/src/sync/context.ts` `SyncContext` (boxName/id, provider,
    hostWorkspace, projectRoot, boxWorkspace, hostHome, onLog).
  - `packages/sandbox-core/src/sync/concerns/env.ts`: `pushEnvFiles`/`pullEnvFiles`/
    `scanHostEnvFiles` (owns `DEFAULT_ENV_PATTERNS`, `buildHostEnvFindArgs`). Collapses
    docker `host-export.ts:copyHostEnvFilesToBox` + cloud `env-files.ts:uploadEnvFiles`; both
    become thin wrappers injecting their transport.
  - Tests: env-concern golden test via `RecordingSyncTransport`; keep `scan-host-env-files.test.ts`.
- **Phase 4 — carry + dynamic + skills concerns.** Concrete findings from the first pass:
  - **carry is the most provider-divergent concern — do NOT force a single transport
    unification.** docker `copyOneEntry` (`host-export.ts:729`) uses `streamTarPipe` (stdin,
    no temp file) + several separate `docker exec --user 0:0` calls (mkdir/extract/rename/
    chmod/chown/parent-chain). cloud `uploadOneEntry` (`carry.ts:86`) stages a temp tar,
    `uploadFile`s it, then runs ONE combined bash command, with a `wantsRoot` carve-out for
    vercel/e2b — and an explicit note that splitting/nesting that command reintroduces a
    Vercel `$(...)`/`while` hang. Safe approach: extract the shared *decision* logic
    (`~/`→`/home/vscode` expansion, file-vs-dir, exclude, uid/mode defaults, rename-needed,
    parent-chain-needed, the audit loop + missing-entry handling) into a pure
    `planCarryEntry(entry)` in `sync/concerns/files.ts`; keep each provider's *apply*
    mechanism as-is (it stays byte-identical + avoids the vercel hang). Modest dedup, zero
    risk. `renderCarryEntries` stays in `sandbox-core/carry-render.ts`.
  - **dynamic — killing the cloud→docker leak needs a claude-specific dependency chain
    moved first.** `docker/dynamic-sync.ts` is provider-neutral EXCEPT it imports
    `BOX_CLAUDE_PROJECT_DIR` (const), `resolveClaudeMemoryDir`, `encodeClaudeProjectsKey`
    from `host-stage.ts` (also used by `stageClaudeStaticForUpload`). Move that trio +
    the manifest logic (`buildHostSyncManifest`/`computeSyncDelta`/`stageDynamicSyncTarball`
    + types + `BOX_*` consts) into `sync/agents/claude/` (they're claude-specific) or
    `sync/manifest/`; re-export from `host-stage.ts` for its other consumers; then cloud
    `seedDynamicConfig` + a `concerns/dynamic.ts` import from sandbox-core (leak gone).
    NOTE: verify whether the docker create path has its own dynamic seed or if the manifest
    logic is cloud-only-consumed (it may be — docker seeds workflows/memory via the
    `~/.claude` volume rsync instead).
  - **transport fix already landed:** `DockerSyncTransport.applyTarball` now always pins
    `--user <uid>:<uid>` (incl. `0:0` for root) — the carry `uid:0` path needs it; env
    (`uid:1000`) is unchanged.
  - **skills:** `~/.agents` shared-volume seed (docker `ensureAgentsVolume` via
    `seedVolumeFromHost`) + cloud `stageAgentsStaticForUpload`; per-tool box→host pull via
    `spec.pull` (`pullClaudeExtras`/`pullCodexConfig`/`pullOpencodeConfig`).
- **Phase 5 — credentials concern.** `concerns/credentials.ts`
  (`seedCredentials`/`extractCredentials`/`refreshHostBackups`). Encode expiry gate
  (`hostClaudeBackupExpired`) + seed-once marker (`.agentbox-seeded-at`) + force rule +
  `isRealAgentCredential` guard as spec/caps fields. Highest-risk; extra assertions + real-box
  login→destroy→recreate→inherited smoke both directions on docker + volume + ephemeral cloud.
- **Phase 6 — git seed + resync + box-facts.** Move workspace seed + resync (verbatim
  box-wins `classifyUntrackedOverlay`) behind `WorkspaceResyncPorts`; **wire `CloudSyncTransport`
  into resync to close the cloud "Phase 2" gap**. Leave the `inBoxClone` control-plane branch
  untouched.
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
