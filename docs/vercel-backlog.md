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
   **Plan (host — must run on a real host, not a nested box):**
   - *Why nested doesn't work:* a vercel box's `CloudBoxPoller` runs wherever the
     `agentbox` CLI runs; from inside a docker agentbox the relay/git creds chain is
     doubly-nested and the vercel box's bridge can't cleanly reach the laptop's git
     identity. Run this from the laptop host.
   - The public-URL plumbing is already validated: `sandbox.domain(8788)` is a
     stable public HTTPS+WS endpoint (the #17 expose work + the bridge both rely on
     it; preview URLs proved stable across stop/start in P0 #5). So the transport
     the poller needs is known-good.
   - Runbook: `agentbox create --provider vercel` from a repo with a pushable
     origin → `agentbox shell <box>` → commit in `/workspace` → `agentbox-ctl git
     push` → on the host confirm `git ls-remote origin agentbox/<box>` shows the
     commit → then `agentbox-ctl git pull` and a `gh pr` op. `scripts/vercel-live-e2e.sh`
     gates this behind `E2E_RELAY=1`.
   - Note: `agentbox-ctl git push` via the host relay has been exercised
     continuously on the **docker** provider (the relay's git-RPC path is the same
     `git.push`/`git.fetch` handler); what's unconfirmed is specifically the
     vercel box → `domain(8788)` bridge → host poller → `git.push` chain end-to-end.
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

7. [x] **VNC on AL2023.** Root-caused live: every piece was actually present
   (Xvnc, vncpasswd, websockify, noVNC) and Xvnc bound 5901 fine — the only bug
   was `agentbox-vnc-start` hardcoding `--web=/usr/share/novnc` while the AL2023
   bake git-clones noVNC to `/usr/local/share/novnc`. websockify runs
   `os.chdir(--web)` at startup, so the missing dir raised FileNotFoundError and
   it never bound 6080. Fixed the (shared) script to resolve the noVNC dir from
   `[/usr/share/novnc, /usr/local/share/novnc]` (Debian/Ubuntu first → docker +
   hetzner unaffected). Verified live on a snapshot box: 6080 binds, `vnc.html`
   returns HTTP 200, web root `/usr/local/share/novnc`. The script is in the
   prepare context fingerprint, so the next `agentbox prepare` auto-rebakes.
   (Minor follow-up: `autocutsel` isn't in the AL2023 bake, so VNC clipboard
   sync is degraded there — the script already tolerates its absence.)
8. **Attach is laggy.** The `send-keys`/`capture-pane` pump is real but
   higher-latency than a PTY and repaints the whole pane (cursor position not
   preserved). **Upgrade:** a ttyd / WebSocket terminal over `sandbox.domain(port)`
   (WebSocket works through the domain proxy — noVNC relies on it) — needs a ttyd
   binary in the snapshot + a ws client in `attach-helper.ts`, and the 4th port.
   **Plan (host — heavy, needs a re-bake):**
   - Bake `ttyd` into the base snapshot: add an install step to
     `packages/sandbox-vercel/scripts/provision.sh` (no AL2023 dnf package — grab a
     static x86_64 binary from the ttyd releases, or build; drop at
     `/usr/local/bin/ttyd`, `chmod 755`). This changes the prepare context
     fingerprint, so `agentbox prepare --provider vercel` auto-rebakes (no `--force`).
   - Expose a ttyd port. The 4-port cap math is now: base `[6080, 8788]` + up to 2
     `expose` ports (see #17, done). Reserve one slot for ttyd, e.g. add a 3rd base
     port `7681` (ttyd default) to `VERCEL_EXPOSED_PORTS` in `backend.ts`
     (`buildExposedPorts` already caps at `VERCEL_MAX_PORTS=4`). Note this leaves
     only 1 free slot for `expose` — document the trade-off.
   - In-box launch: a small `agentbox-ttyd-start` helper (run via the cloud
     lifecycle, like `vnc-launch.ts` runs `agentbox-vnc-start`) that does
     `ttyd -p 7681 -i 0.0.0.0 --writable tmux new -A -s <session>`.
   - Rewrite the attach: `build-attach.ts` / `attach-helper.ts` currently spawn the
     SDK send-keys/capture-pane pump. Replace with a WebSocket client to
     `wss://<sandbox.domain(7681)>/ws` bridging the local PTY (ttyd speaks a simple
     binary ws protocol: client sends `'0'+data` for stdin, `'1'+JSON` for resize;
     server sends `'0'+data` for output). Keep the send-keys path as a fallback.
   - Verify live: attach to a box, confirm low-latency keystrokes + correct cursor
     positioning (vs. the current full-pane repaint).
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
    **Plan (host):**
    - `packages/sandbox-vercel/src/prepared-state.ts` currently stores only
      `{ schema, base: { snapshotId, contextSha256, ... } }`. Add a
      `projects?: Record<string, { snapshotId, workspaceSha?, createdAt }>` tier
      keyed by `hashProjectPath(projectRoot)` (the same hash `@agentbox/config`
      already exports and that the cloud-checkpoint store uses).
    - On `create --provider vercel`: after a successful first create for a project,
      capture a project snapshot (the box post-workspace-seed + cred-seed) and
      record it under `projects[<hash>]`. On the next create for the same project,
      boot from that snapshot and **skip** `seedCloudWorkspace` + agent-cred seeding
      (the snapshot already carries them) — mirror how `cloud-provider.create`
      already skips the seed when `snapshotName` is set.
    - Mirror the daytona/hetzner implementation — grep `projects[` /
      `projectDirSegment` in `packages/sandbox-daytona` + `packages/sandbox-hetzner`
      for the established shape (invalidation on `contextSha`/cli-stamp change, and
      a freshness policy so a stale project snapshot is rebuilt).
    - Verify: two sequential `create`s for the same workspace — the second should
      skip the workspace seed (watch the create log for "skipping workspace seed")
      and be materially faster.
15. [x] **`agentbox prune --provider vercel`.** Done — generalized the daytona-only
    `pruneDaytona` into a provider-agnostic `pruneCloud` over a
    `CLOUD_PRUNE_PROVIDERS` list, so `--provider vercel` (and `hetzner`, also
    previously unwired) now enumerate orphan sandboxes via `backend.list()` and
    offer to delete the ones absent from `state.json`. `apps/cli/src/commands/prune.ts`.
16. **`Sandbox.fork()` — won't build (SDK fork is strictly weaker than
    checkpoint + create).** Investigated 2026-05-29; decision: shelved, no code.
    The proposal was a faster Vercel-native "branch from a running box" than
    snapshot + create. Reading the SDK kills the premise.
    **Finding.** `Sandbox.fork` in `@vercel/sandbox@2.0.1`
    (`dist/sandbox.js:347-386`) is, in full:
    ```js
    const source = await Sandbox.get({ name: sourceSandbox, resume: false }); // does NOT touch the source
    const snapshotId = source.currentSnapshotId;                              // the LAST existing snapshot
    return Sandbox.create({ ...copiedConfig, ...overrides,
      source: snapshotId ? { type: 'snapshot', snapshotId } : undefined,
      runtime: snapshotId ? undefined : source.runtime });
    ```
    It reads the source's **last existing snapshot** and creates from it. It does
    **not** take a fresh snapshot, **not** capture memory, and **not** read the live
    filesystem. The `.d.ts` phrase "inherits the source's current filesystem
    snapshot" is technically true but misleading — "current snapshot" means *last*
    snapshot, not live FS.
    **Why that makes it useless here**, given Vercel's snapshot model (persistent
    boxes only snapshot on *stop*; while running `currentSnapshotId ===
    sourceSnapshotId`, the base — see the destroy-guard in
    `packages/sandbox-vercel/test/backend.test.ts` and the
    `project-vercel-snapshot-lifecycle` finding):
    - Forking a running, never-stopped box yields the **base snapshot** — none of
      the agent's work. Surprising and dangerous.
    - Capturing the source's *current* work requires snapshotting it first, which on
      Vercel **stops the VM** — at which point `agentbox checkpoint create` +
      `agentbox create --snapshot <ref>` (already implemented, all four providers)
      does exactly the same thing.
    So fork collapses to "create from the source's last snapshot," strictly weaker
    than the existing path. The only thing that would justify a new box→box
    primitive — branching a *live*, mid-flight agent (process + memory) without
    disturbing the source — is not offered by the Vercel platform (cold,
    VM-stopping snapshots only).
    **Revisit condition.** Only worth building if a provider ships **live / memory
    snapshots** (fork the running VM's RAM, source untouched). Until then the
    box→box workflow we actually want (start from a previous version → self-update
    via `agentbox.yaml` → agent re-branches from main) is served by checkpoints +
    `create`. Platform-side write-up: [`docs/vercel-sandbox-findings.md`](./vercel-sandbox-findings.md).
17. [x] **Per-service `expose` ports.** Done — the cloud scaffold already minted a
    preview URL per `services.*.expose.port`, but on Vercel a URL only routes to a
    port declared at `Sandbox.create({ ports })`, and only `[6080, 8788]` were
    declared, so those URLs 404'd. Now the cloud provider reads the expose ports
    before provision and threads them via `CloudProvisionRequest.exposePorts`; the
    vercel backend's `buildExposedPorts` merges the non-privileged ones (Vercel
    400s on <1024) onto the base set, capped at Vercel's 4-port limit (so up to 2
    service ports). daytona/hetzner ignore the field (one WebProxy routes all
    ports). Verified live: provisioning with `expose 3000` declares
    `[6080, 8788, 3000]` and the public `domain(3000)` URL routes to an in-box
    service. Unit-tested (`buildExposedPorts`: privileged-drop, dedupe, 4-cap).
    Port 80 (the in-box WebProxy) still can't be exposed on Vercel — services must
    listen on a non-privileged port to get a preview URL.
18. [x] **`networkPolicy` egress locking.** Done — added `box.vercelNetworkPolicy`
    config (`allow-all` default / `deny-all` / comma-separated domain allowlist),
    threaded config → `providerOptions` (vercel-only) → `CloudProvisionRequest.networkPolicy`
    → `Sandbox.create({ networkPolicy })`. `parseNetworkPolicy` maps the string to
    the SDK shape (pass-through literals; else `{ allow: [...] }`). daytona/hetzner
    ignore it (hetzner locks egress via its own firewall). Verified live: a
    `deny-all` box can't reach `example.com`; an `example.com`-allowlist box
    reaches `example.com` but not `api.github.com`. Unit-tested `parseNetworkPolicy`.
    `extendTimeout` is **deferred** (niche: session length is already set at create
    via `box.vercelTimeoutMs`, and persistent mode auto-resumes — mid-session
    extension has no clean CLI home yet).
19. **gh/git relay shims don't win PATH on Vercel AL2023.** Found 2026-05-29 while
    verifying the git-shim-ordering fix: in a booted vercel box `command -v git`
    resolves to **`/opt/git/bin/git`**, not `/usr/local/bin/git` — Vercel's base
    prepends `/opt/git/bin` ahead of `/usr/local/bin`. So the relay-routing shims
    `provision.sh` installs at `/usr/local/bin/{git,gh}` are inert at runtime: an
    agent that types `git push` / `gh pr ...` inside the box hits the real
    binaries (no host creds) instead of routing through the relay. (The
    relay-driven path — `agentbox-ctl git push`, the host poller — is unaffected;
    it calls `ctl` directly, not via the `git` shim. So this is about
    *agent-initiated* git/gh, and is closely tied to #4.)
    **Plan (host):**
    - Make `/usr/local/bin` win for the agent's shells. The login-shell shim
      `/etc/profile.d/agentbox.sh` (provision.sh step "login-shell shim") is the
      natural place — prepend `/usr/local/bin` ahead of `/opt/git/bin` in PATH
      there. Agent sessions run through a login shell (tmux), so this covers them;
      confirm it also covers non-login `exec` paths if any rely on the shim.
    - Alternative/back-stop: also drop the shims into `/opt/git/bin/{git,gh}` (or
      symlink) so they win regardless of PATH order — but that dir is Vercel's, so
      prefer the PATH fix.
    - Verify live: in a booted box `command -v git` → `/usr/local/bin/git` and
      `git push` with no relay errors out via the shim (not real git).
    - Note: docker/hetzner are unaffected (their base PATH puts `/usr/local/bin`
      first); this is Vercel-base-specific.
