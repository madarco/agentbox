# Vercel provider — build-out status

Status of the `@agentbox/sandbox-vercel` backend (Vercel Sandbox — Firecracker
microVMs + snapshots). Same `CloudBackend` shape as Daytona/Hetzner, composed by
`@agentbox/sandbox-cloud`'s `createCloudProvider`. Maintained live during
implementation (per the project convention), not as end-of-PR cleanup.

## Why Vercel is shaped differently

- **No custom image.** Vercel Sandbox is Amazon Linux 2023 only; there's no
  Dockerfile build. The base environment is a **Vercel snapshot** baked once by
  `agentbox prepare --provider vercel` (boot fresh node24 → run `provision.sh`
  → `sandbox.snapshot()`), exactly the hetzner-style one-time prerequisite.
- **No nested containers** (validated 2026-05-18, memory
  `project-vercel-sandbox-no-containers`): seccomp blocks `clone`/`unshare`, no
  `CAP_SYS_ADMIN`. The provider sets `launchDockerd: false`; in-box `docker` is
  unavailable by design.
- **No SSH.** `sandbox.domain(port)` is an HTTPS(+WebSocket) proxy only. There's
  no `attachArgv`; attach goes through a custom SDK-streaming helper.
- **Persistent by default.** Stopping a sandbox auto-snapshots; the next
  `Sandbox.get({ resume: true })` resumes from it. That maps cleanly to
  pause/resume — `pause == stop`, `resume == start`.
- **Hard limits:** region `iad1` only, 32 GB fixed ephemeral disk, 2048 MB RAM
  per vCPU (coupled), **≤4 exposed ports** (we use 80 / 6080 / 8788, one free),
  45 min (Hobby) / 5 hr (Pro+) max session.

## Phase status

- [x] **Phase 0 — package scaffold.** `packages/sandbox-vercel` (tsup/tsconfig/
  vitest), `@vercel/sandbox` dep, registry + argv-prefix + CLI registration,
  config `ProviderKind`/`defaultCheckpointVercel`, relay `resolveCloudBackend`.
- [x] **Phase 1 — credentials + SDK loader.** OIDC (`VERCEL_OIDC_TOKEN`) and
  access-token trio (`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`);
  `agentbox vercel login` + `--status`; env auto-load from
  `~/.agentbox/secrets.env` and `.env.local`.
- [x] **Phase 2 — `CloudBackend`.** provision/get/list/start/stop/pause/resume/
  destroy/state/exec/uploadFile/downloadFile/listFiles/previewUrl/
  signedPreviewUrl + snapshot helpers, all mapped to `@vercel/sandbox` 2.x.
- [x] **Phase 3 — prepare + provision.sh.** Base-snapshot bake with context
  fingerprinting + skip-fast; AL2023 installer (dnf, vscode user, ctl/vnc/shims,
  Claude native installer, codex/opencode).
- [x] **Phase 4 — attach.** `buildVercelAttach` + `attach-helper.js` tmux bridge
  (send-keys / capture-pane pump over the SDK).
- [x] **Phase 5 — checkpoints.** Provider-level `checkpoint` override storing the
  Vercel snapshot **id** in the cloud-checkpoint manifest (Vercel snapshots are
  id-addressed, not name-addressed).
- [x] **Phase 6 — unit tests.** env-loader, credentials, prepared-state,
  backend (mocked SDK), build-attach. `pnpm build && lint && typecheck && test`
  all green.

## What's still missing

The code builds/lints/typechecks and the unit suite (pure, mocked SDK) is green.
Two live e2e passes ran **2026-05-28**, both with a `VERCEL_TOKEN` access-token
trio (`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`) — every dev OIDC token
kept arriving already-expired, so the access-token trio is the practical path for
anything long-running like `prepare`. The two passes (in-box, then re-validated
from the host repo via `scripts/vercel-live-e2e.sh`) confirmed prepare → create →
boot → pause/resume → checkpoint round-trip → destroy, and surfaced three real
bugs, all now fixed (see "Bugs found live" below). Only the relay round-trip (#4)
is still unconfirmed (it's interactive — needs a pushable origin). The list below
is the actionable backlog, roughly in priority order.

### P0 — first live smoke pass

Confirmed live 2026-05-28:

1. [x] **`prepare` / `provision.sh` completes on AL2023.** Bakes a base snapshot
   (~1.3 GB) in a few minutes; the snapshot comes back usable. claude / codex /
   opencode are all present in a booted box.
2. [x] **User mapping.** A booted box runs as `vscode` (uid 1001) with `/workspace`
   checked out on `agentbox/<box>`; `docker` is correctly unavailable
   (`launchDockerd:false`). vscode passwordless sudo now works (see bug #3).
3. [x] **Workspace seed.** The shallow-clone seed (`$SUDO rm/mkdir/chown` +
   tar-extract as vscode) lands `/workspace` on the box branch — gated on the
   sudoers fix (#3). Agent-credential / carry / env-file ownership beyond this was
   not separately audited but the box boots with the agent CLIs present.
4. [ ] **Relay round-trip.** Confirm the host `CloudBoxPoller` reaches the in-box
   relay over `sandbox.domain(8788)` and that `agentbox-ctl git push|pull` +
   `gh pr` work from inside a vercel box. (Still open — interactive; see runbook.)
5. [x] **Lifecycle semantics.** `stop` auto-snapshots (live status `running →
   stopping → stopped` in ~18 s); `start` resumes (`get({resume:true})`) with the
   same `/workspace` (marker survived); `destroy` preserves the base; the public
   `*.vercel.run` preview URL is stable across a stop/start (did not rotate).
6. [x] **Checkpoint round-trip.** `agentbox checkpoint create` snapshots, the
   manifest stores the Vercel snapshot **id**, and `create --snapshot <ref>` boots
   from it with the captured `/workspace` intact.

#### Bugs found live 2026-05-28 (fixed)

- **vscode had no working passwordless sudo → workspace seed failed.** Vercel's
  AL2023 base ships `/etc/sudoers` with **no `@includedir /etc/sudoers.d`** (and
  non-0440 perms), so provision.sh's `/etc/sudoers.d/90-agentbox-vscode` drop-in
  was silently ignored and `sudo -n` as vscode failed with "a password is
  required" — breaking the workspace-seed `$SUDO rm/mkdir/chown` (and it would
  break ctl-launch / carry too). provision.sh now appends the includedir,
  normalises `/etc/sudoers` to 0440, and `visudo -cf`-validates the result.
- **`destroy` nuked the shared base snapshot.** A box created from a snapshot has
  `currentSnapshotId === sourceSnapshotId` until it pauses/snapshots itself, so a
  naive "delete `currentSnapshotId` on destroy" deleted the shared base and broke
  every later `create` with a 410. `destroy` now purges only a box's *own*
  auto-snapshot (`snapId !== source && snapId !== base`). Covered by a unit test in
  `packages/sandbox-vercel/test/backend.test.ts`.
- **`prepare` skip-fast treated a deleted snapshot as present.** `Snapshot.get`
  resolves deleted/failed tombstones (`status: 'deleted'|'failed'`, `sizeBytes: 0`)
  instead of throwing, so "get didn't throw" wrongly meant "exists." The skip check
  now requires `status === 'created'` (`prepare.ts`).

The platform-side root causes (the AL2023 sudoers gap, the `Snapshot.get`
tombstone behavior, the `currentSnapshotId === sourceSnapshotId` aliasing, the
`list`/`get` inconsistency, and the headless-OIDC refresh failure) are written up
for the Vercel team in [`docs/vercel-sandbox-findings.md`](./vercel-sandbox-findings.md).

#### Running the remaining P0 checks

`scripts/vercel-live-e2e.sh` automates items #5 (pause/resume + `/workspace`
survival) and #6 (checkpoint round-trip), plus a regression for the destroy/base
guard. It must run from a context that holds a `VERCEL_TOKEN` trio — e.g. the host
repo checkout (with `pnpm build` run) or a box with the repo built, and the trio
in env. Pass `AGENTBOX_BIN="node <repo>/apps/cli/dist/index.js"` since the
published CLI can't do `--provider vercel` yet (backlog #9). It avoids the laggy
attach bridge: the `/workspace` marker travels over `agentbox cp` (the
relay-backed provider transfer), the snapshot id is read from the checkpoint
manifest, and **box state is read from the live Vercel SDK**
(`packages/sandbox-vercel/test/live-state.mjs`) — *not* `agentbox list`, which
reports cloud boxes as optimistically `running` with no live probe
(`sandbox-docker/src/lifecycle.ts`, "tracked for Phase 6").

```
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
  AGENTBOX_BIN="node $PWD/apps/cli/dist/index.js" bash scripts/vercel-live-e2e.sh
```

Item #4 (relay round-trip) is inherently interactive and needs a pushable origin
the host relay can reach, so it's opt-in (`E2E_RELAY=1`) and otherwise printed as
a manual runbook: `agentbox shell <box>` → commit in `/workspace` →
`agentbox-ctl git push` → confirm on the host that `git ls-remote origin
agentbox/<box>` shows the commit, then try `agentbox-ctl git pull` and a `gh pr`.

### P1 — known functional gaps

7. **VNC on AL2023 — confirmed broken.** The e2e showed the VNC daemon launch
   failing at create/start (`agentbox-vnc-start failed: websockify did not bind
   6080 within 5s`); the box continues (it's best-effort) but `agentbox screen`
   won't work. `tigervnc-server` + `websockify` (pip) + noVNC (git clone) /
   `agentbox-vnc-start` need fixing for AL2023 (the script was written for
   Debian/Ubuntu).
8. **Attach is laggy.** The `send-keys`/`capture-pane` pump is real but
   higher-latency than a PTY and repaints the whole pane (cursor position not
   preserved). **Upgrade:** a ttyd / WebSocket terminal over `sandbox.domain(port)`
   (WebSocket works through the domain proxy — noVNC relies on it) — needs a ttyd
   binary in the snapshot + a ws client in `attach-helper.ts`, and the 4th port.
9. [x] **Published-CLI asset staging.** Done — `stage-runtime.mjs` now stages a
   `runtime/vercel/` tree (attach-helper.js + provision.sh + ctl/shims + baked
   config) mirroring the candidates `runtime-assets.ts` already resolved, and
   `build-attach.ts`'s `resolveAttachHelperPath()` gained the `runtime/vercel/`
   (next-to-dist) candidate for the bundled CLI. Verified: all 11 runtime assets
   resolve from the staged tree with the monorepo fallback disabled.
10. [x] **Builder cleanup after `prepare`.** Done — verified live that a Vercel
    snapshot is independent of its source: after `snapshot({expiration:0})` →
    `builder.delete()`, the snapshot stays `status: 'created'` (256 MB) and boots
    a fresh sandbox. `prepare.ts` now deletes the builder (step 8) best-effort
    *after* persisting the snapshot id, so a delete failure never breaks the bake.
11. [x] **OIDC 12h expiry friction.** Done (doc) — `docs/cloud-providers.md` now
    has a "Which to use" note recommending the access-token trio for long ops
    (`prepare`, CI) since OIDC dev tokens expire ~12h with no headless refresh,
    and the `agentbox vercel login` prompt/labels say the same at the decision
    point. (Auto-refresh itself remains unbuilt — this is the documentation half.)
12. [x] **Per-provider vercel resource/timeout config.** Done — added
    `box.vercelVcpus` + `box.vercelTimeoutMs` (flat keys, matching the existing
    `box.defaultCheckpointVercel` convention rather than a one-off nested
    `box.vercel` object). Threaded config → `providerOptions` (vercel-only) →
    `cloud-provider` overrides → `CloudProvisionRequest.timeoutMs` + `resources.cpu`
    → `Sandbox.create({ resources: { vcpus }, timeout })`. Verified live:
    `vercelVcpus=4` yields `sandbox.vcpus === 4` (default 2). Region stays fixed
    `iad1` (Vercel constraint). Note: Vercel only accepts specific vcpu counts
    (1/2/4/8); an unsupported value (e.g. 3) fails create with a 400.

### P2 — deferred (parity niceties, not blocking)

13. [x] **`agentbox checkpoint list` aggregate view.** Done — `ls` now merges all
    four providers (docker + daytona + hetzner + vercel) via a `CLOUD_BACKENDS`
    loop, and `set-default` / `rm` are provider-complete too (set-default accepts
    `hetzner`/`vercel`; rm removes their snapshots and sweeps the
    `defaultCheckpointVercel` dangling pointer). `apps/cli/src/commands/checkpoint.ts`.
14. **Per-project snapshot tier** — the daytona/hetzner `projects[<hash>]`
    optimization that skips workspace/credential re-seeding on repeat creates for
    the same project. `prepared-state.ts` is single-tier (base only) today.
15. [x] **`agentbox prune --provider vercel`.** Done — generalized the daytona-only
    `pruneDaytona` into a provider-agnostic `pruneCloud` over a
    `CLOUD_PRUNE_PROVIDERS` list, so `--provider vercel` (and `hetzner`, also
    previously unwired) now enumerate orphan sandboxes via `backend.list()` and
    offer to delete the ones absent from `state.json`. `apps/cli/src/commands/prune.ts`.
16. **`Sandbox.fork()`** as a faster "branch from a running box" primitive than
    snapshot + create (Vercel-native, no host round-trip).
17. **4th port / per-service `expose`.** Only 3 of the 4 allowed ports are used
    (80/6080/8788); per-service `expose` URLs from `agentbox.yaml` beyond the
    WebProxy aren't surfaced (the scaffold tries, but we're near the port cap).
18. **`networkPolicy` / `extendTimeout`** are unused — could expose egress
    locking (a safety win, cf. the hetzner firewall) and longer single sessions.
