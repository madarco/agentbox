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
- **Phase 7.1–7.3 — the `ProviderSync` facade (docker half).** Done on branch
  `feat/sync-layer-phase7` (off `feat/sync-layer`, PRs into it).
  - **7.1 (contracts, zero behaviour):** `core/src/sync/provider-sync.ts` — the GROUPED
    `ProviderSync` interface (`resyncWorkspace`/`seedAgentConfig`/`seedCredentials`/
    `extractCredentials`/`seedGitIdentity`/`seedEnvFiles`/`applyCarry`) + `CarryApplyResult`.
    Hoisted the pure `SyncContext` interface into `core` (Tier-1 contract; sandbox-core
    re-exports it, `makeSyncContext` stays). `Provider.sync?(box)` added; `resyncWorkspace?`
    widened with `onLog?`. Factored docker's 5 host-side resync ports into a shared
    `makeHostGitPorts()` in the sandbox-core git concern (host git is provider-neutral —
    the reuse point cloud resync 7.5 needs).
  - **7.2 (dockerSync facade + wiring):** `sandbox-docker/src/sync/docker-sync.ts`
    `makeDockerSync(handle)` — one method per op, thin delegations to the existing docker
    fns. Handle carries the resolved per-tool specs (create-path). `dockerProvider` gains
    `sync(box)` + `resyncWorkspace(box, onLog)` (reproduces `resyncBox`'s short-circuit).
    CLI `resync-start.ts` now routes through `providerForBox(box).resyncWorkspace` (dropped
    the `provider==='docker'` string gate). `seedGitIdentity`/`extractCredentials` are
    documented docker no-ops. New `docker-sync.test.ts` (12, delegation).
  - **7.3 (rewire create.ts):** the inline agent-config seed block + env/carry/checkpoint-
    resync now walk `makeDockerSync(...)`; specs resolved once (also drive the mounts).
  - **SMOKE PASSED (docker, this session):** real-box `create --with-env` seeds the claude
    volume + `.env` + `/workspace` on `agentbox/<name>`; session-start resync merges a host
    commit (merge commit with **both parents surviving**), keeps the box version on the
    README conflict + reports it, copies the untracked host file, host uncommitted overlay
    skipped, idempotent on re-run. Covers the docker half of the 7.2/7.3 owed smoke.
  - **7.4 (cloudSync facade + rewire cloud create):** `sandbox-cloud/src/sync/cloud-sync.ts`
    `makeCloudSync(backend, handle, opts)`. seedCredentials = refreshAgentCredentialsBackup +
    seedAgentVolumesIfFresh; seedAgentConfig = ensureAgentHomeDirsOwned + ensureCodexAgentsOverride
    + seedOpencodeModelState + seedClaudeJsonAtCreate + seedDynamicConfig; seedGitIdentity/
    seedEnvFiles(uploadEnvFiles)/applyCarry(render+uploadCarryPaths)/extractCredentials. Handle
    carries the credential-volume `agents`. createCloudProvider gains `sync(box)`;
    extractAgentCredentials delegates to the facade. Non-inBoxClone create() walks sync.* in the
    identical order. cloud-sync.test.ts (8).
  - **7.5 (NET-NEW cloud live-box resync — own PR):** `sandbox-cloud/src/workspace-resync.ts`
    `resyncCloudWorkspace` — pre-fetch host commits (shared-ancestor `^P` bundle, target only when
    the host advanced) into private in-box refs, then run `resyncWorkspace` UNCHANGED with cloud
    ports (resolveHostRef→in-box target ref/box-branch fallback; createHostStash→bundled stash SHA;
    host ports = makeHostGitPorts; box ports via backend.exec/uploadFile; untracked probe as root on
    vercel/e2b to dodge the sudo-u `$()/while` re-parse hang). **Never reset --hard.** CloudBoxFields
    += hostSeeded (gate) + workspaceBranch; createCloudProvider.resyncWorkspace(box) gates + re-derives
    worktrees via detectGitRepos. CLI carry-resync gated to docker. workspace-resync.test.ts (3).
  - **SMOKE (this session):** **Vercel** create seeds the full facade; a live-box resync (in-box
    commit + host commit + host uncommitted + untracked) produced a MERGE COMMIT with BOTH PARENTS
    surviving, kept the box version on the README conflict, copied the untracked host file, and re-ran
    idempotently (no new merge). **Hetzner** create-facade seeds verified, but its resync is blocked
    by an external transient Cloudflare 403 during the base-snapshot rebuild (shipped snapshot predates
    the in-box `bootstrap` cmd). The resync path is provider-neutral (same backend.exec/uploadFile
    ports), so Vercel's pass — including the harder root-probe path — covers it; re-run the Hetzner
    half once `prepare --provider hetzner --force` succeeds.
  - **7.6a (dry-run) — DONE:** `AGENTBOX_SYNC_DRYRUN=1` → `makeDockerSync`/`makeCloudSync` return
    `dryRunProviderSync(label)` (core), a print-only facade: each op logs `[sync dry-run]
    <provider>.<op>(…)` via `ctx.onLog` and returns a benign default WITHOUT executing. Unit-tested.
  - **7.6b (stage-producer relocation + `staticPaths[].exclude` fill) — DONE** (branch
    `feat/sync-7.6b-static-colocation` off `feat/sync-layer-phase10`). Reframed as a **co-location**
    task (owner steer "all sync operations in the sync/ folder"): the host-config staging module was
    the last sync operation sitting in the wrong package. `host-stage.ts` was **pure host-fs and
    consumed only by cloud** (vercel/hetzner/daytona `prepare` + cloud `agent-credentials.ts`) — docker
    never called it (it seeds via `ensure*Volume`). So the **whole module moved verbatim** to
    `sandbox-core/src/sync/host-stage.ts` (kept the name — not split per-tool; the module is one
    cohesive static+creds+state producer), with its pure helpers `claude-hooks-filter.ts` +
    `codex-config.ts` (dependency direction forces them into core; `smol-toml` added to sandbox-core).
    Cloud consumers now import the stagers from `@agentbox/sandbox-core` (docker index drops the
    re-export, keeps the claude-path trio + Stage types re-exported from core for back-compat). The
    two helper tests moved to `sandbox-core/test/`. **`staticPaths[].exclude` now has a consumer:** the
    hardcoded `CLAUDE_RUNTIME_EXCLUDES`/`CODEX_RSYNC_EXCLUDES`/`OPENCODE_DATA_EXCLUDES` consts were
    deleted; the producers derive their excludes from `resolveAgentSpec(id).staticPaths[0].exclude`
    (claude/codex filled; opencode reconciled to add `auth.json`+`snapshot`). The emitted `rsync
    --exclude=` args are byte-identical (order preserved; broken-symlink excludes still appended
    per-run). `registry.test.ts` locks all three exclude sets — the registry is now authoritative.
    `CREDENTIALS_BACKUP_FILE` in the staging module now resolves from the registry (the docker-owned
    backup consts remain for docker's own credential sync — the `[minor cleanup]` backlog item is
    reduced, not fully retired). **Gate GREEN:** build/typecheck/lint + package tests (core 60 / sandbox-core 130 /
    docker 270 / cloud 101 / relay 252 / cli 668). **SMOKE OWED before push:** `prepare` +
    create-inherits across `{vercel,hetzner,daytona}×{claude,codex}` + docker create sanity (docker
    consumes the moved `claude-hooks-filter`/`codex-config` helpers). Hetzner `prepare` may still be
    Cloudflare-403-blocked; vercel+daytona cover the provider-neutral path.
  - **R1–R4 (co-location relocation) — DONE + smoke-passed.** The facade named every op; this moved
    the op *bodies* physically under `sync/` so the sync layer is discoverable in one place (owner's
    steer: "all sync operations should happen in the sync/ folder"). Behaviour-preserving pure moves +
    import repointing; external packages import via the package index only, so the public API is
    unchanged (`tsc` is exhaustive over the moves). **R1:** 10 cloud sync files → `sandbox-cloud/src/
    sync/`. **R2:** 9 docker sync-only files → `sandbox-docker/src/sync/`. **R3:** the per-tool modules
    → `sandbox-docker/src/sync/agents/{claude,codex,opencode,skills}.ts` (whole-module moves — the
    verified-clean sync/launch coupling meant the cohesive launch/attach code rides along rather than
    risking an interleaved split of 1400–1600-line files). NOT done (documented non-unifications): the
    two cloud seed-collapses onto `SyncTransport` (its generic `applyTarball` can't express the daytona
    FUSE-`cp` / ephemeral `sudo -u` / staged `cp -a`-merge extracts), and dedup of the duplicated pure
    helpers (owner: two methods is fine). **SMOKE:** all package tests green (sandbox-core 89 / cloud 99
    / docker 310 / cli 668); docker create+resync (both-parent merge, box-wins, untracked, idempotent);
    vercel re-prepare (validates the moved stage producers bake a working snapshot) + create (full
    facade seed) + credential inheritance (box inherits host claude/codex logins) + resync. Hetzner uses
    the identical relocated cloud code; its re-prepare stayed externally Cloudflare-403-blocked.

- **Phase 8 — naming reconciliation.** Deleted the two now-delegating inline name shims
  (`agentBinaryName` in `apps/cli/src/commands/_run-queued-job.ts`, `agentKindFor` in
  `_cloud-agent-create.ts`) and inlined the `agent-kind.ts` adapter at their call sites
  (`toSyncKind(job.agent)` for the canonical `recordLastAgent` write + the `attach` argv;
  `toQueueKind(args.mode)` for the frozen launcher-registry feed). Routed the two `BoxRecord.lastAgent`
  reads in `recover.ts` through `normalizeLastAgent` (read-time back-compat: a legacy/forked record
  holding the wire `'claude-code'` now resolves to canonical `'claude'` instead of silently missing the
  `only === 'claude'` restore branch). No data migration — writes were already canonical; the record
  type stays `'claude'|'codex'|'opencode'`. New restore-agent-sessions test covers the legacy
  `lastAgent='claude-code'` → claude-restore path. **Owner steer ("use claude-code everywhere"):** the
  wire-domain `job.agent === 'claude-code'` dispatch branches and the always-Claude subcommand's
  `agent: 'claude-code'` / `buildPromptArgs('claude-code', …)` literals were deliberately left as the
  wire spelling (see Deferred backlog) — so no relay/queue/`build-prompt-args`/`assert-creds` test
  literals shifted, and relay tests stay green.

- **Phase 9 — relay delegation + git-refs unification.** Extracted the git branch/refspec/
  remote/upstream decisions — copy-pasted across the three git push-back paths — into pure
  `packages/core/src/sync/git-refs.ts` (`resolveRemote`, `resolveLandDest`, `landRefspec`,
  `upstreamRef`, `remoteTrackingRef`, `isResolvedBranch`, `sanitizeGitArgs`, `isScratchBranch` +
  `SCRATCH_BRANCH_PREFIX`), plus the canonical `GitRpcParams` wire type. In `core` (not
  `sandbox-core`) because `@agentbox/ctl` depends only on `core` — same pattern as `../replace.ts`.
  Co-located the download decisions in `packages/core/src/sync/files.ts` (`DownloadKind`,
  `parseDownloadKind`, `resolveHostPath`) — the two download handlers keep their divergent
  transports (docker re-shells the host CLI; cloud calls `pullCloudDirContents`, workspace-only);
  only the decisions moved. Routed `server.ts` / `host-actions.ts` (`runGitRpc`/`runDownloadRpc`)
  / `core/handler.ts` through the shared decisions and folded all six live
  `branch.startsWith('agentbox/')` predicates to the undefined-safe `isScratchBranch`; `ctl`'s
  `leaseAndPush` adopted `resolveRemote` (kept its weaker `!branch` check — see Deferred backlog).
  Behavior-preserving by construction (only boolean/string expressions changed). New
  `core/test/git-refs.test.ts` + `core/test/files.test.ts` are the primary guard (relay unit
  coverage of these strings is thin); relay/ctl parity nets stay green.

- **Phase 10 — control-plane wiring (topology + direct lease-push).** Closed the box-side gaps
  that left the plane's fully-wired lease path inert. Added pure `resolveSyncTopology(provider,
  controlPlaneUrl)` (`core/src/sync/topology.ts`) + `CreateBoxRequest.controlPlaneUrl` +
  `CloudBoxFields.{topology,controlPlaneUrl}` (persisted so resume re-threads). Threaded
  `cfg.effective.relay.controlPlaneUrl` from `create.ts` → `cloud-provider.create` →
  `kickCloudBootstrap`, which now (via the extracted pure `buildBootstrapEnv`) exports
  `AGENTBOX_CONTROL_PLANE_URL` for the daemon and writes `AGENTBOX_GIT_LEASE=1` into
  `/etc/agentbox/box.env` (the login-shell `git push` reads it there — the daemon's env isn't
  inherited). **The one-liner under-specified the mechanism:** the flag is inert without also
  flipping the in-box daemon — a `mode:'box'` relay parks `git.lease-token` on `/bridge` where no
  drainer handles it. So the ctl daemon (pure `selectInBoxTransport`) now runs a *forwarder to the
  plane* for a control-plane cloud box (reaching the plane's direct lease handler), writing the
  0600 relay-env file in that branch too. And a control-plane box registers on the *plane* (with
  its origin URL, which `leaseTokenResult` mints from) via `registerBoxWithPlane`, not the laptop
  loopback. Entirely inert unless `controlPlaneUrl` is configured; classic-cloud + docker
  byte-unchanged. **Scoped to the laptop `create` path** (see Deferred for the plane worker).
  Guards: `core/test/topology.test.ts`, `sandbox-cloud/test/bootstrap-env.test.ts`,
  `ctl/test/in-box-transport.test.ts`.

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
- **Phase 7 — the `ProviderSync` facade + driver.** Spine is the co-located
  `ProviderSync` interface (`core/src/sync/provider-sync.ts`): every sync op named once
  (`seedWorkspace`/`resyncWorkspace`/`seedEnvFiles`/`applyCarry`/`seedStaticConfig`/
  `seedSkills`/`seedDynamicConfig`/`seedCredentials`/`extractCredentials`), implemented
  **once per provider** as a co-located object (`dockerSync`; `makeCloudSync(backend)`
  overridable per-method) whose methods are thin delegations to the existing concerns.
  Goal is auditability + co-location as much as reuse — see
  [`sync-architecture.md`](./sync-architecture.md) §"Co-location: the ProviderSync facade".
  The imperative `create.ts` / `cloud-provider.ts` sequences then read as an ordered walk
  over `provider.sync.*` (a data-driven `SEED_PIPELINE` may still iterate the facade, order
  preserved). Also here: move the per-tool static-config stage producers to
  `sync/agents/<tool>/stage.ts` + fill in the claude/codex `staticPaths[].exclude`
  (`CLAUDE_RUNTIME_EXCLUDES`, `CODEX_RSYNC_EXCLUDES`); the deferred cloud credential/dynamic
  *seed* collapses land in `cloudSync`; add the `AGENTBOX_SYNC_DRYRUN` passthrough.
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
- **[non-canonicalization — owner steer "use claude-code everywhere"] Wire-domain dispatch
  branches (Phase 8).** The six `job.agent === 'claude-code'` branches in `_run-queued-job.ts`
  and the always-Claude `claude` subcommand's `agent: 'claude-code'` /
  `buildPromptArgs('claude-code', …)` literals were left at the frozen wire spelling rather than
  resolved once via `toSyncKind` and branched on canonical `'claude'`. `job.agent` is the frozen
  `QueueAgentKind`, so the comparisons are type-safe; keeping them avoids churning the queue worker
  and — deliberately — avoids shifting the `build-prompt-args` / `cloud-attach` / `assert-creds`
  test literals. Recorded here so the un-canonicalized branches aren't mistaken later for an
  oversight; revisit only if the owner reverses the steer.
- **[owed] Git push-back smoke matrix (Phase 9).** The git-refs extraction is guarded by pure
  unit tests, but the cloud `runGitRpc` refspec/upstream path has no relay unit coverage. Before
  push, run `{local,vercel,hetzner}×{claude,codex}`: `agentbox-ctl git push` (assert the branch
  pushes and, for a non-`agentbox/` branch, the box's `origin/<branch>` remote-tracking ref +
  upstream are set — the `remoteTrackingRef`/`upstreamRef` paths); `git push --host-only [--as X]
  [--force]` (the `landRefspec` self-fetch/bundle land); `git pull` (fetch-via-relay + in-box
  merge); `agentbox download` workspace on a cloud box (`parseDownloadKind`/`resolveHostPath`); a
  scratch-branch push still skips the prompt/upstream while another branch still prompts
  (`isScratchBranch` gate unchanged); and the `AGENTBOX_GIT_LEASE=1` control-plane lease push.
- **[non-unification — later create-smoke-gated phase] Scratch-branch producers (Phase 9).** The
  `agentbox/${name}` producer sites (`sandbox-docker/src/create.ts` ~500/563 incl. sub-worktree
  variants, `sandbox-cloud/src/cloud-provider.ts` ~279/1268) still hardcode the prefix rather than
  build from `SCRATCH_BRANCH_PREFIX`. They're create-path in provider packages; adopting the
  constant needs create smoke. The constant is exported now; a later create-smoke-gated phase
  adopts it.
- **[non-unification — cloud-only, single-site] Cloud-bundle fetch refspecs (Phase 9).**
  `host-actions.ts`'s `+refs/heads/*:refs/remotes/origin/*` / `--all` bundle refspecs stay inline —
  single-site, cloud-mechanism, no docker analog. Likewise the download *transport* (CLI re-shell
  vs `pullCloudDirContents`) and the cloud workspace-only gate stay site-local; only the pure
  decisions were co-located in `sync/files.ts`.
- **[non-change — would alter a push path] ctl `isResolvedBranch` harmonization (Phase 9).**
  `leaseAndPush` keeps its weaker `!branch` check; adopting `isResolvedBranch` there would add a
  `=== 'HEAD'` rejection on the `AGENTBOX_GIT_LEASE` control-plane push path — a behavior change,
  deliberately not made.
- **[owed] Control-plane smoke matrix (Phase 10).** The whole feature is untested end-to-end by
  units. Before push: deploy the plane, `control-plane set-url`, create a `{vercel,hetzner}` box on
  an App-installed repo, and verify `box.env` has `AGENTBOX_GIT_LEASE=1`, the daemon logs
  `forwarder → <plane>` (not `mode=box`), an `agentbox/*` push leases + lands direct on GitHub, a
  non-scratch push poll-gates, status/events render, and a stop/start resume preserves the flip +
  re-registers. Plus the negative (no `controlPlaneUrl` → classic `mode:'box'`, unchanged) and a
  docker sanity pass.
- **[deferred per owner steer — laptop-only Phase 10] Plane server-side create worker.**
  `makeControlPlaneCreateBox` (`apps/cli/src/control-plane/create-box.ts`) + the worker in
  `control-plane.ts` still `provider.create` with no control-plane signal, so a plane-created box
  gets a `mode:'box'` relay with no poller and its pushes hang. It needs the same threading + an
  **in-plane** store registration with `originUrl` (direct store access, not the HTTPS admin API
  the laptop path uses). Deferred so the laptop path proves the mechanism first.
- **[not needed to function] Top-level `BoxRecord.topology`.** Phase 10 persists topology only on
  `CloudBoxFields` (cloud is the only topology-bearing surface; docker is implicitly `'docker'`).
  A uniform top-level field could be added if a non-cloud consumer ever needs it.
