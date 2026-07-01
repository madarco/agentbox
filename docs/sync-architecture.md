# Sync architecture

How AgentBox moves state between the host and a box — across Docker and the cloud
backends (Daytona, E2B, Vercel, Hetzner) — and how provider-specific behaviour is
expressed **without** a per-provider copy of the logic.

This is the steady-state reference. For *execution state* (which piece has been
migrated onto which seam, what smoke is owed), see
[`sync-layer-refactor.md`](./sync-layer-refactor.md).

---

## Thesis: separate the *what* from the *how*

The **what** — "seed the env files", "resync the workspace box-wins", "extract the
claude login" — is provider-neutral logic that lives **once**, as plain functions
in `@agentbox/sandbox-core`.

The **how** — `docker exec` vs an SSH exec vs a Daytona SDK upload — is a
**mechanism object injected into** those functions: a `SyncTransport`, a
`WorkspaceResyncPorts`, a `CloudBackend`.

A provider therefore never re-implements a concern. It supplies a mechanism (or a
capability flag, or a small override), and the shared concern runs on top. This is
composition, not class inheritance — see [The four override mechanisms](#the-four-override-mechanisms).

---

## The layering

```
┌─ Tier 1: CONTRACTS ─ @agentbox/core / src/sync/ ───────────────────────────┐
│  transport.ts   SyncTransport + TransportCaps + PushOptions                 │
│  workspace.ts   WorkspaceResyncPorts + ResyncWorktree + RepoResyncResult    │
│  reconciler.ts  ConflictPolicy + ConflictVerdict + Reconciler               │
│  types.ts       SyncTopology | SyncDirection | SyncConcern                  │
│  agent-kind.ts  claude/codex/opencode name normalization                   │
│  (also core/src/provider.ts: Provider · cloud-backend.ts: CloudBackend)     │
└────────────────────────────────────────────────────────────────────────────┘
                 ▲ pure interfaces + data types, no fs/exec
┌─ Tier 2: IMPL + CONCERNS ─ @agentbox/sandbox-core / src/sync/ ──────────────┐
│  registry.ts            AGENT_SYNC_SPECS  (per-tool data: paths/creds/caps) │
│  context.ts             SyncContext  (box name/id, host+box paths, onLog)   │
│  recording-transport.ts RecordingSyncTransport  (the golden-test double)    │
│  concerns/                                                                  │
│    env.ts         pushEnvFiles                                              │
│    files.ts       planCarryEntry            (host→box carry decisions)      │
│    skills.ts      seedAgentsVolume          (~/.agents)                     │
│    credentials.ts extractCredentials + isRealAgentCredential + guards       │
│    dynamic.ts     workflows/memory manifest sync                           │
│    git.ts         classifyUntrackedOverlay + resyncWorkspace                │
└────────────────────────────────────────────────────────────────────────────┘
                 ▲ functions of (ctx, transport|ports, spec) — provider-neutral
┌─ Tier 3: PROVIDERS + TRANSPORTS ───────────────────────────────────────────┐
│  @agentbox/sandbox-docker                @agentbox/sandbox-cloud            │
│    dockerProvider : Provider               createCloudProvider(backend)     │
│    DockerSyncTransport                       : Provider  ← ONE cloud default │
│    makeDockerResyncPorts                     CloudSyncTransport             │
│                                              makeCloudResyncPorts (planned) │
│                                                                             │
│  cloud backends (each a thin CloudBackend, reuse createCloudProvider):      │
│    sandbox-daytona · sandbox-e2b · sandbox-vercel · sandbox-hetzner         │
└────────────────────────────────────────────────────────────────────────────┘
```

**Dependency direction (no cycles):** `core` ← `sandbox-core` ← {`sandbox-docker`,
`sandbox-cloud`} ← {`sandbox-daytona`, `sandbox-e2b`, `sandbox-vercel`,
`sandbox-hetzner`}. `sandbox-core` never imports a provider. (`sandbox-cloud` still
imports a few host-stage/helper functions from `sandbox-docker`; that residual
coupling is being closed concern-by-concern as each moves into `sandbox-core`.)

---

## The seams (Tier 1 contracts)

### `Provider` — the top-level box abstraction
`core/src/provider.ts`. The CLI resolves a `Provider` from a box's `provider`
discriminator and calls it; it never talks to a backend directly. Two families:
`dockerProvider` (bespoke) and `createCloudProvider(backend)` (the shared cloud
scaffolding). Sync-relevant members are **optional** and feature-detected:

| Member | Who implements | Notes |
|---|---|---|
| `create(req)` | all | the imperative seed sequence (→ Phase 7 driver) |
| `resyncWorkspace?(box)` | docker (cloud: gap) | session-start workspace resync |
| `syncTransport?(box)` | as concerns migrate | builds the byte-mover for post-create ops |
| `extractAgentCredentials?(box)` | cloud only | box→host login capture on checkpoint |
| `checkpoint?`, `prepare?`, `repairReachability?` | varies | optional capabilities |

### `SyncTransport` — the byte-mover
`core/src/sync/transport.ts`. The single mechanism seam a concern drives for
host↔box moves. Implementations: `DockerSyncTransport` (docker CLI),
`CloudSyncTransport` (wraps any `CloudBackend`), `RecordingSyncTransport` (tests).

```
caps: TransportCaps
exec(cmd, {user,cwd,env,noRetry})         host→box:  applyTarball · pushTree · pushFile
readText(boxPath) → string | null         box→host:  pullTree · pullFile
ensureVolume?(name)   seedVolumeFromHost?(volume, sources)   ← persistent-volume seam
```

`TransportCaps` is how a concern branches on *class of mechanism* without knowing
the provider:

| cap | docker | daytona (volume) | vercel/hetzner/e2b (ephemeral) |
|---|---|---|---|
| `persistentVolumes` | ✅ | ✅ | ❌ |
| `helperContainer` (throwaway rsync container) | ✅ | ❌ | ❌ |
| `ephemeralFs` (creds re-pushed every create) | ❌ | ❌ | ✅ |

### `WorkspaceResyncPorts` — the resync mechanism
`core/src/sync/workspace.ts`. The resync needs ops the stateless
`SyncTransport.exec` can't express (host-side git probes; a stdin-streaming box
untracked-probe; a buffered tar-apply), so it has its own ports interface. Docker
supplies `makeDockerResyncPorts`; a cloud default (`makeCloudResyncPorts`) is
planned. The orchestration `resyncWorkspace(worktrees, ports)` is provider-neutral.

### `CloudBackend` — the cloud primitive surface
`core/src/cloud-backend.ts`. A thin per-cloud object of `provision`/`exec`/
`uploadFile`/`downloadFile`/`previewUrl`/… that `createCloudProvider` and
`CloudSyncTransport` compose over. Optional methods (`ensureVolume?`,
`refreshPreviewUrl?`, `repairReachability?`, `signedPreviewUrl?`, `snapshot?`,
`attachArgv?`) + capability fields (`webProxyPort?`) are how one cloud differs from
another. A new cloud is a ~one-file backend, not a new provider.

### `AGENT_SYNC_SPECS` — per-tool data
`sandbox-core/src/sync/registry.ts`. The claude/codex/opencode differences as
**data**, not branches: box/host/cloud credential paths, `realShape` (credential
guard), `staticPaths` (incl. opencode's 3-XDG-dir layout), `forwardedEnvKeys`,
`dockerVolume`, `boxRunEnv()`, resume/teleport/activity caps.

---

## The four override mechanisms

Provider-specific behaviour is expressed in four composable ways — reach for the
cheapest that works:

| # | Mechanism | A provider overrides by… | Example |
|---|---|---|---|
| 1 | **Capability data** | a different flag/value — **no code** | `webProxyPort` (vercel 8080 vs 80); `TransportCaps.ephemeralFs` picks marker-gated-volume vs push-every-create credential seed |
| 2 | **Optional interface method** | implementing it; the default scaffolding feature-detects & degrades | `CloudBackend.ensureVolume?` (`typeof … === 'function'`); `CloudBackend.repairReachability?` (Hetzner only); `Provider.extractAgentCredentials?` (cloud only) |
| 3 | **Injected transport / ports** | supplying a different mechanism object | docker `makeDockerResyncPorts` vs a cloud ports impl; one `CloudSyncTransport` serves all four clouds |
| 4 | **Documented carve-out** | a small `if (caps.x)` / `if (name==='vercel')` for a genuine one-off | the `wantsRoot` vercel/e2b carry branch; the Vercel `$(...)` combined-command hang |

**"Cloud default + override one method"** is mechanism #3 done with object spread —
no subclassing:

```ts
// one cloud default, works for every cloud via CloudSyncTransport
export function makeCloudResyncPorts(
  t: SyncTransport,
  overrides?: Partial<WorkspaceResyncPorts>,
): WorkspaceResyncPorts {
  const base: WorkspaceResyncPorts = { /* box ops via t.exec / t.applyTarball; host-git shared */ };
  return { ...base, ...overrides };
}

// a cloud that needs a different probe overrides exactly that one method:
makeCloudResyncPorts(transport, { probeUntrackedTokens: hetznerProbe });
```

### Why composition, not a class hierarchy
- **Testability** — every concern golden-tests against `RecordingSyncTransport` /
  a fake ports by recording the injected calls. A protected-method override on a
  base class isn't recordable that way; you'd lose the parity nets.
- **One concern serves N providers** — `resyncWorkspace` serves docker + (soon)
  four clouds with zero subclasses. Inheritance pushes toward one subclass per
  provider even when most are identical.
- **No fragile base class** — a base change silently alters every subclass;
  `{...base, ...overrides}` keeps each override explicit and local, and caps/spec
  overrides need no code at all.
- **Consistency** — `Provider`, `CloudBackend`, and `SyncTransport` are already
  optional-method + feature-detect interfaces; a class tree would be a fifth,
  divergent pattern.

---

## Concern map

Each concern is a function of `(ctx/plan, transport|ports, spec)`. The
provider-varying part is only the injected mechanism.

| Concern | Neutral logic (`sandbox-core`) | Mechanism | Docker | Cloud |
|---|---|---|---|---|
| **env** | `pushEnvFiles` (host `find`+`tar` pack) | `transport.applyTarball` | DockerSyncTransport | CloudSyncTransport |
| **files (carry)** | `planCarryEntry` (host→box decisions) | per-provider apply (kept byte-identical) | streamTarPipe + `exec --user 0:0` | staged-tar + one combined bash cmd |
| **skills** | `seedAgentsVolume` (`~/.agents`) | `transport.seedVolumeFromHost` | rsync helper container | baked into snapshot (n/a) |
| **credentials** | `extractCredentials`, `isRealAgentCredential`, expiry/backup guards | `transport.readText` (extract) | helper-container sync (separate) | `seedCredentialsOne` + caps |
| **dynamic** | workflows/memory manifest (`buildHostSyncManifest`, `computeSyncDelta`) | exec/upload | `~/.claude` volume rsync | staged tarball |
| **git (resync)** | `classifyUntrackedOverlay`, `resyncWorkspace` | `WorkspaceResyncPorts` | `makeDockerResyncPorts` | planned |

### Topology (a third axis)
`SyncTopology = 'docker' | 'cloud' | 'control-plane'`. The **control-plane** path
(`CreateBoxRequest.inBoxClone`) is a cloud box whose git flows via a hosted relay:
it skips host-side workspace seeding and clones in-box at bootstrap. Seed/resync
code branches on the presence of `inBoxClone` and must leave that path untouched.

---

## Deliberate non-unifications

Not everything should collapse to one shape. Where a mechanism is intrinsically
provider-specific **and** has no polymorphic caller, forcing it behind a seam is
speculative risk. Current calls (tracked in the refactor backlog):

- **Docker helper-container credential sync** (`syncClaudeCredentials`/`SYNC_SCRIPT`)
  — a throwaway root container that predates any running box, so there's no
  box-bound `SyncTransport` analog; its `ISOLATE` seed-only gate is a docker-volume
  security property. Stays in `sandbox-docker`.
- **Workspace *seed*** (docker `git worktree add` + `mount --bind` replay) — cloud
  clones in-box instead; there's no shared shape to extract.
- **Box→host per-tool config pull** (`pullClaudeExtras`/…) — each `download-<tool>`
  CLI command is its own entry point; no polymorphic caller yet.

The rule mirrors carry's "keep the apply mechanism byte-identical": unify the
*decision*, leave the *mechanism* where it genuinely differs.

---

## Testing model

- **`RecordingSyncTransport`** (`sandbox-core/src/sync/recording-transport.ts`) — a
  fake `SyncTransport` that records the ordered calls a concern emits. A concern's
  whole observable effect *is* that call sequence, so a refactor that changes what
  we emit fails the golden snapshot. `withVolumes:false` models an ephemeral cloud.
- **Fake ports** — same idea for `WorkspaceResyncPorts` (see
  `sandbox-core/test/git-resync.test.ts`): script the host/box results, assert the
  port-call sequence + the returned result.
- **Double-parity for moves** — when a pure function moves from a provider into a
  concern, the same test cases run on both sides (the provider keeps a re-export
  shim). See the credential guards and `classifyUntrackedOverlay`.
- **Drift guards** — `registry.test.ts` asserts the registry's per-tool data
  matches the known docker/cloud layout, so `AGENT_SYNC_SPECS` can't silently
  diverge from the constants it's the source of truth for.
- **Real-box smoke** — unit tests prove *emitted ops*, not real git/credential
  semantics on a live box. Behaviour-moving changes still owe the
  `{local,vercel,hetzner}×{claude,codex}` matrix before push (per the tracker gate).

---

## How-to

### Add a new cloud provider
1. Implement a `CloudBackend` (`core/src/cloud-backend.ts`): the required primitives
   (`provision`/`exec`/`uploadFile`/`downloadFile`/`previewUrl`/lifecycle) + only
   the optional methods your platform supports.
2. `createCloudProvider(yourBackend)` gives you a full `Provider` — seed, ctl
   launch, state, URL resolution, resync — for free.
3. Set capability fields for the one-offs (`webProxyPort`, whether you expose
   `ensureVolume`). `CloudSyncTransport` derives `TransportCaps` from your backend
   automatically. No concern code to write.

### Override one operation for one provider
- **A value differs** → set a capability field (mechanism #1).
- **An optional feature is (un)available** → implement/omit the optional method;
  the scaffolding feature-detects (mechanism #2).
- **The mechanism differs** → pass an override into the default factory:
  `makeCloudResyncPorts(t, { probeUntrackedTokens })` (mechanism #3).
- **A true one-off** → a small documented `if (caps.x)` in the concern (mechanism
  #4); prefer promoting it to a cap if a second provider ever needs it.

### Add a new concern
1. Write the neutral logic as a function of `(ctx, transport|ports, spec)` in
   `sandbox-core/src/sync/concerns/`.
2. Golden-test it against `RecordingSyncTransport`.
3. Have each provider inject its transport; add a `TransportCaps` flag only if the
   concern must branch on a class-of-mechanism difference.

---

## Status

Contracts + concerns for env, carry, skills, credentials (guards+extract),
dynamic, and git-resync are migrated; the cloud live-box resync and the
data-driven create **driver** (`SEED_PIPELINE`, which collapses the remaining
imperative `create.ts` / `cloud-provider.ts` sequences) are pending. Per-phase
execution state and the deferred backlog live in
[`sync-layer-refactor.md`](./sync-layer-refactor.md).
