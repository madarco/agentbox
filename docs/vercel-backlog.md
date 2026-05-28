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

## Live-verify items (need a real `VERCEL_OIDC_TOKEN` — not yet run end-to-end)

The unit suite is pure (mocked SDK). These are the things that can only be
confirmed against the real platform; treat them as the first smoke-test pass:

1. **User mapping.** The Vercel default user is `vercel-sandbox`; agentbox
   standardizes on `vscode`. `provision.sh` creates `vscode` (auto uid, no bind
   mounts so the exact number is irrelevant) with passwordless sudo; `exec` runs
   as `vscode` via `root → sudo -u vscode`, and `uploadFile` chowns to vscode
   after `writeFiles` (which writes as `vercel-sandbox`). Confirm ownership +
   that the scaffold's `$HOME`/`$(id -un)` assumptions resolve to vscode.
2. **Attach latency.** The send-keys/capture-pane pump is real but higher-latency
   than a PTY stream and repaints the whole pane. **Upgrade path:** a ttyd /
   WebSocket terminal over `sandbox.domain(<port>)` (WebSocket works through the
   domain proxy — noVNC already relies on it). Would give a true terminal but
   needs a ttyd binary in the snapshot + a ws client in the helper.
3. **Snapshot vs sandbox delete.** `prepare` deliberately does NOT `delete()` the
   builder sandbox after `snapshot()`, in case delete cascades to the snapshot.
   Confirm whether a snapshot survives its source sandbox's deletion; if it does,
   add the builder cleanup to avoid leaving a stopped builder for Vercel to reap.
4. **VNC on AL2023.** `tigervnc-server` + `websockify` (pip) + noVNC (git clone)
   install is best-effort in `provision.sh`. Confirm `agentbox screen` works, or
   adjust the package set / `agentbox-vnc-start` for AL2023.
5. **Published-CLI helper staging.** `buildVercelAttach` resolves
   `attach-helper.js` next to its own dist (works in the monorepo). The
   standalone `@madarco/agentbox` bundle needs the helper staged into its runtime
   tree (`apps/cli/scripts/stage-runtime.mjs`) + a `runtime/vercel/` resolver
   path. Same applies to the `provision.sh` + ctl/shim assets in
   `runtime-assets.ts` (monorepo paths resolve; staging is TODO).

## Deferred (not v1)

- Per-project snapshot tier (the daytona/hetzner `projects[<hash>]` optimization
  that skips workspace/credential re-seeding on repeat creates).
- `agentbox prune --provider vercel` (the backend `list()` works; the prune
  command wiring isn't done).
- `Sandbox.fork()` as a faster "branch from a running box" primitive than
  snapshot+create.
