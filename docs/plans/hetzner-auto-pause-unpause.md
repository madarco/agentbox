# Implement auto pause/unpause for Hetzner

## Context

The host relay already auto-pauses **idle Docker boxes** when more than
`autopause.maxRunningBoxes` are running (`packages/relay/src/autopause.ts`), and
the Docker attach flow auto-unpauses a paused box on `agentbox claude`/`shell`.
Hetzner boxes get neither: a Hetzner VPS bills ~€4/mo while running, so an idle
box left attached costs money indefinitely, and nothing brings it back when you
re-attach.

The backend primitives already exist — `hetznerBackend.pause(h)` powers the VPS
off and `resume(h)` powers it on and waits for `running`
(`packages/sandbox-hetzner/src/backend.ts:432-472`). What's missing is the
**host orchestration**: the relay's autopause loop skips any box without a
`containerName` (cloud boxes have none), and the cloud attach path never checks
for a paused box. This change wires Hetzner boxes into both halves.

**Scope (per user):** Hetzner only — Daytona keeps today's behavior (never
auto-paused). Reuse the existing global `autopause.*` config (no new keys).

## Half 1 — Auto-pause idle Hetzner boxes (relay loop)

File: `packages/relay/src/autopause.ts`

The pure selector `selectBoxesToPause()` is already provider-agnostic and needs
**no change** — it reasons over `running`, `claudeState`, `idleMs`, `createdAt`.
The cloud box's `claude.state`/`updatedAt` already reach the relay's
`statusStore` via the `CloudBoxPoller`, so the idle facts are populated the same
way as Docker. Only the **state probe** and the **pause dispatch** are
Docker-specific today.

Changes to the `tick()` loop (lines 122-177):

1. Stop skipping cloud boxes. Replace the `if (!reg.containerName) continue;`
   guard (line 125) with a branch:
   - **Docker** (`reg.containerName` present): unchanged — `inspectStatus(containerName)`.
   - **Hetzner** (`reg.kind === 'cloud' && reg.backend === 'hetzner'`): probe via
     the new injectable `inspectCloudState(reg)`; everything else
     (`claudeState`, `idleMs`, `createdAt`) is read identically. Any other
     cloud backend (`daytona`) is still skipped.
2. Carry `kind`/`backend` on `BoxScanEntry` so the pause step can dispatch.
3. In the pause loop (lines 145-177), dispatch by kind:
   - Docker → existing `pause(containerName)` (`docker pause`).
   - Hetzner → new injectable `pauseCloud(reg)`.
   Keep the existing per-box try/catch + `autopause` event emission (reuse the
   same event shape; `containerName` field carries the box name/sandboxId for
   cloud so the dashboard renders it).

New injectable deps on `AutopauseLoopDeps` (mirroring the existing
`inspectStatus`/`pause` test-injection pattern), defaulting to real impls:

- `inspectCloudState?: (reg) => Promise<ContainerState>` — resolves the backend
  and maps `backend.state(handle)` (`'running' | 'paused' | ...`) onto the
  loop's `ContainerState`.
- `pauseCloud?: (reg) => Promise<void>` — resolves the backend and calls
  `backend.pause(handle)`.

Real implementations reuse the existing relay plumbing in
`packages/relay/src/host-actions.ts`:
- `resolveCloudBackend(reg.backend)` (already exported, line 93) → `CloudBackend`.
- Box → `sandboxId`: reuse the `lookupCloudBox(boxId)` logic (currently private,
  `host-actions.ts:405-416`; uses `findBox`/`readState` from
  `@agentbox/sandbox-core`). **Export `lookupCloudBox`** from `host-actions.ts`
  and import it in `autopause.ts`, rather than duplicating the `state.json`
  lookup. Build `handle = { sandboxId: lookup.cloudSandboxId }`.

Cost note: this adds one Hetzner `getServer` API call per Hetzner box per tick
(60s). Negligible for the handful of cloud boxes a user runs. Docker and Hetzner
boxes share the single `maxRunningBoxes` cap and longest-idle-first selection —
a deliberate simplification (one global cap), worth a one-line comment.

## Half 2 — Auto-unpause Hetzner box on attach

A paused Hetzner box is a powered-off VPS. Re-attaching must power it on and wait
for SSH before building the attach command (`backend.start()` already polls until
`running`; the SSH ControlMaster transparently reopens on the next `exec` —
verified in `ssh-tunnel.ts`).

Add a shared helper, e.g. `ensureCloudBoxRunning(box)` in
`apps/cli/src/provider/` (new small module, or co-located in `_cloud-attach.ts`):

```
const provider = await providerForBox(box);
const state = await provider.probeState(box);   // 'running' | 'paused' | 'stopped' | ...
if (state === 'paused') await provider.resume(box);
else if (state === 'stopped') await provider.start(box);
```

Gate to Hetzner (`box.provider === 'hetzner'`) to honor the chosen scope; the
helper is otherwise provider-agnostic and trivially generalizes later. Surface a
clack spinner message ("resuming box") like the Docker path does.

Call sites (all already resolve the provider just before attaching):
- `apps/cli/src/commands/_cloud-attach.ts` → top of `cloudAgentAttach()`
  (line 84). This single insertion covers `claude`/`codex`/`opencode` **attach
  and start** (all six call sites route through `cloudAgentAttach`).
- `apps/cli/src/commands/shell.ts` → cloud branch (line 225), before
  `provider.buildAttach`.

This mirrors the Docker `unpauseBox`/`startBox` checks in
`claude.ts` and `shell.ts`'s `ensureBoxRunning`.

## Poller behavior while paused (no code change, verify)

When a Hetzner box is paused, its `CloudBoxPoller` will hit connection failures
(VPS off → forward gone). The poller is best-effort and keeps retrying with
its existing recovery hook (`refreshCloudPreviewUrl`); once the box is resumed on
attach, the next poll recovers. Confirm during verification that this does not
busy-loop or crash the relay (it shouldn't — failures are caught). No pause/stop
of the poller is needed for v1.

## Files to change

- `packages/relay/src/autopause.ts` — generalize `tick()` probe + pause dispatch; add `inspectCloudState`/`pauseCloud` injectables; extend `BoxScanEntry` with `kind`/`backend`.
- `packages/relay/src/host-actions.ts` — export `lookupCloudBox`.
- `apps/cli/src/provider/` (new helper) + call sites `_cloud-attach.ts`, `shell.ts` — auto-resume on attach.

## Tests

- `packages/relay/test/autopause.test.ts` — add cases: a Hetzner `BoxScanEntry`
  (idle past threshold, over cap) is selected and routed through `pauseCloud`
  (inject a fake); a Hetzner box still `running` (claude not idle) is not paused;
  a `daytona` cloud box is skipped. Keep tests pure (inject `inspectCloudState`/
  `pauseCloud`/`loadConfig`; no network).

## Verification (manual e2e)

Prereqs: `HCLOUD_TOKEN` in `~/.agentbox/secrets.env`, a baked Hetzner snapshot
(`~/.agentbox/hetzner-prepared.json`).

1. Build: `pnpm -w build` (or per-package tsup).
2. Create a Hetzner box:
   `node apps/cli/dist/index.js create -y -n hpause --provider hetzner &`,
   tail `~/.agentbox/logs/create.log` until ready.
3. Force aggressive autopause for the test:
   `agentbox config set --global autopause.maxRunningBoxes 0`
   `agentbox config set --global autopause.idleMinutes 1`
   (relay re-reads config each tick — no restart needed).
4. Ensure the box reports `claude.state: idle` (attach claude briefly, let it go
   idle, detach). Watch the relay log for
   `autopause: paused box <id> (...) after ~Nm idle`.
5. Confirm the VPS is off via the Hetzner API:
   `curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers/<id> | jq .server.status`
   → `off`. Also `agentbox list` shows the box `paused`.
6. Re-attach: `agentbox claude hpause`. Expect the "resuming box" spinner, the
   VPS powers back on (status `running`), SSH reconnects, and the agent attaches.
7. Restore config defaults; `agentbox destroy hpause -y` and confirm no orphan
   server/firewall/snapshot via the Hetzner API.
8. Unit: `pnpm --filter @agentbox/relay test`, `pnpm lint`.

## Docs

Update `docs/hertzner_backlog.md` (the "True zero-cost pause" follow-up note
stays — this is poweroff-pause auto-orchestration, not delete-and-respawn) and
the pause section of `docs/cloud-providers.md` to record that Hetzner boxes now
participate in relay autopause and auto-resume on attach.
