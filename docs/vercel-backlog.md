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
  `~/.agentbox/secrets.env` only (project `.env`/`.env.local` are not harvested,
  matching daytona/hetzner).
- [x] **Phase 2 — `CloudBackend`.** provision/get/list/start/stop/pause/resume/
  destroy/state/exec/uploadFile/downloadFile/listFiles/previewUrl/
  signedPreviewUrl + snapshot helpers, all mapped to `@vercel/sandbox` 2.x.
- [x] **Phase 3 — prepare + provision.sh.** Base-snapshot bake with context
  fingerprinting + skip-fast; AL2023 installer (dnf, vscode user, ctl/vnc/shims,
  Claude native installer, codex/opencode).
- [x] **Phase 4 — attach.** `buildVercelAttach` drives the Vercel `sandbox` CLI's
  real PTY (`sbx exec -i … -- sudo -u vscode -H bash -lc '<tmux attach>'`). (Was a
  custom `attach-helper.js` send-keys/capture-pane bridge — replaced; see #8.)
- [x] **Phase 5 — checkpoints.** Provider-level `checkpoint` override storing the
  Vercel snapshot **id** in the cloud-checkpoint manifest (Vercel snapshots are
  id-addressed, not name-addressed).
- [x] **Phase 6 — unit tests.** env-loader, credentials, prepared-state,
  backend (mocked SDK), build-attach. `pnpm build && lint && typecheck && test`
  all green.
- [x] **Phase 7 — "Sign in with Vercel" (CLI-login) auth.** A third, default
  `agentbox vercel login` mode that drives the official Vercel `sandbox`/`sbx`
  CLI (`npm i -g sandbox`) through its browser OAuth, then reuses the CLI's own
  credentials for our SDK calls — no token to paste, and no 12h OIDC friction.
  - Token is **never copied to `secrets.env`**: only the marker
    `VERCEL_AUTH_SOURCE=cli` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` are cached.
    `resolveCredentials()` reads the live `vca_` access token straight from the
    Vercel CLI store (`auth.json`) every call (`cli-store.ts`), so the CLI is the
    single self-refreshing source of truth.
  - `ensureFreshCredentials()` (sdk.ts, called at the top of every backend op +
    prepare + attach-helper) detects a near-expiry token (120s skew) and triggers
    the CLI's own lazy refresh by running `sbx list` (`sbx-cli.ts`), then re-reads
    the rotated token. In-process single-flight collapses concurrent ops.
  - Project resolution: the OAuth token is team-scoped with no project, so after
    login we list the team's projects (`vercel-rest.ts`) and the user picks one
    (clack select, pre-selecting `agentbox`/`vercel-sandbox-default-project`, with
    a create-new option) — cached as `VERCEL_PROJECT_ID`.
  - Store path resolver is platform-aware (macOS `~/Library/Application Support`,
    Linux `$XDG_DATA_HOME`/`~/.local/share`, Windows `%APPDATA%`) with an
    `AGENTBOX_VERCEL_CLI_DIR` override for tests.
  - **PoC-validated 2026-05-29**: `sbx` refreshes a *stale* token fully
    non-interactively (no browser); the `vca_` token works as a Bearer against
    `api.vercel.com` and the SDK; `GET/POST /v9/projects` accept it. New unit
    tests: `cli-store`, `cli-auth` (resolve + ensureFreshCredentials), `vercel-rest`.
  - PAT-trio and OIDC modes are unchanged, so headless/CI is unaffected.
  - **Live-verified end-to-end 2026-05-29.** `agentbox vercel login` → browser
    OAuth → project pick wrote only the marker + team + project to `secrets.env`
    (no token); `--status` showed the live token (expires in 8h) from the CLI
    store. `prepare` skip-fast confirmed the base snapshot via a real API call on
    the new auth; `create` booted a box (`provision`/`exec`/`uploadFile` all on
    the live token) and `destroy` tore it down — all without a stored token.

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
4. [x] **Relay round-trip.** **Confirmed live 2026-05-29** by ground truth (not a
   wrapper exit code). On box `relayv1`: an in-box `agentbox-ctl git push` of commit
   `7f8eea5d` traveled vercel box → in-box bridge on `sandbox.domain(8788)` → host
   `CloudBoxPoller` → `runGitRpc` (git-bundle pull-back + host `git push origin`),
   and `git ls-remote origin refs/heads/agentbox/relayv1` returned **`7f8eea5d`** —
   the commit reached GitHub. The relay log shows `rpc box=40ebb05d method=git.push`.
   The push was driven via `backend.exec` (real exit code), not the attach pump.
   Getting here required fixing several real issues found live (see "Bugs found live
   2026-05-29" below): secrets.env-only credentials, the missing attach-helper chunk
   in the staged runtime, the #19 PATH/shim ordering, **and a stale host-relay
   process** — the running relay predated vercel support, so `resolveCloudBackend`
   returned `no host executor for cloud backend 'vercel'`; `ensureRelay` only
   reclaims a relay when `cliEntry===false`, not when it lacks a provider executor,
   so it silently reused the old one. Killing it (next `agentbox` call respawns a
   capable relay) fixed it — see the follow-up item below to make this self-healing.
   Notes on the earlier **false positive**: the original `vercel-live-e2e.sh` Phase D
   trusted the `agentbox shell … git push` exit code, but on vercel `shell` is the
   laggy send-keys/capture-pane attach pump whose exit code reflects the wrapper, not
   the in-box command — it reported PASS while nothing reached origin. Phase D now
   gates on `git ls-remote` (the probe branch is absent before, present after); it
   also needs the `VERCEL_TOKEN` trio in env (it predates CLI-login auth, so under
   `VERCEL_AUTH_SOURCE=cli` drive the round-trip via the CLI/`backend.exec` directly).
   **Original plan (host — must run on a real host, not a nested box):**
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

#### Bugs found live 2026-05-29 (fixed — during the #4 relay round-trip pass)

- **Vercel creds in `.env.local` were invisible to the host CLI.** The env-loader
  harvested only `VERCEL_OIDC_TOKEN` from `.env.local` and read the access-token
  trio solely from `~/.agentbox/secrets.env`, so a trio sitting in `.env.local`
  left `prepare`/`create` failing with "Vercel credentials not configured." Fixed
  by dropping `.env.local` reading entirely — Vercel creds now come **only** from
  the shell env or `~/.agentbox/secrets.env`, matching the daytona/hetzner loader
  (project `.env`/`.env.local` belong to the app, not the host CLI). The
  access-token trio is now the primary `agentbox vercel login` path.
- **`agentbox shell` on a vercel box died `ERR_MODULE_NOT_FOUND`.** The staged
  `runtime/vercel/attach-helper.js` (a tsup entry) imports a shared
  `./chunk-<hash>.js`, but `stage-runtime.mjs` copied only `attach-helper.js`, not
  the chunk — and the hash changes every build so it can't be listed statically.
  This broke the attach path the e2e uses to run the in-box `agentbox-ctl git
  push`, failing Phase D before the relay was even exercised. Fixed by walking the
  import graph from the staged `attach-helper.js` and staging every chunk it
  (transitively) pulls in.
- **#19 — relay shims lost PATH on AL2023.** `/opt/git/bin` precedes
  `/usr/local/bin` on Vercel's base, so the relay-routing `git`/`gh` shims were
  inert for agent-typed commands. Fixed in `provision.sh`'s login-shell shim
  (`/etc/profile.d/agentbox.sh`) by force-prepending `/usr/local/bin`. Baked into
  the base snapshot (provision.sh is in the prepare context fingerprint).

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
8. [x] **Attach is laggy.** Done — replaced the `send-keys`/`capture-pane` pump
   with the official Vercel `sandbox` CLI's real PTY. `buildVercelAttach` now emits
   `sbx exec --sudo [-i] --project <p> --scope <team> <name> -- sudo -u vscode -H
   bash -lc '<inner>'` (interactive `-i` for shell/agent; non-interactive for
   detached pre-start + logs, which stream live), with the token passed via the
   child env `VERCEL_AUTH_TOKEN` (added `AttachSpec.env`, threaded through the host
   PTY wrapper + the three spawn sites). `<inner>` reuses the shared cloud
   `renderInnerCommand` (same tmux ensure + footer-aware config + `exec tmux
   attach` as hetzner/daytona). The custom `attach-helper.ts` bridge + its
   stage-runtime chunk staging are **deleted**. `sbx` is ensured at
   `agentbox vercel login` (all modes). The ttyd/WebSocket upgrade below is
   obsolete — `sbx exec` gives the real PTY with no re-bake and no extra port.
   PoC-validated 2026-05-29 (default user `vercel-sandbox` → `--sudo` + `sudo -u
   vscode`; live streaming; env-token auth; tmux-as-vscode) and live e2e (detached
   pre-start creates a reattachable `agent` session). Interactive typing/resize/
   detach is the remaining manual TTY check.
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
14. ~~**Per-project snapshot tier** (`projects[<hash>]` in `prepared-state.ts`).~~
    **Closed — redundant.** The per-project snapshot tier already exists: it's
    the `agentbox checkpoint create --set-default` + `box.defaultCheckpointVercel`
    flow (validated live in P0 #6). On a repeat `create`,
    `resolveDefaultCheckpoint(cfg, 'vercel')` → `req.checkpointRef` →
    `resolveCloudCheckpoint` → `backend.provision({ snapshot })` boots from the
    project snapshot and `cloud-provider.ts` logs "skipping workspace seed —
    snapshot already contains /workspace"; the supervisor restarts services from
    `agentbox.yaml`. The cloud-checkpoint store is already keyed by
    `hashProjectPath(projectRoot)`, so it *is* per-project. See
    `docs/cloud-create-flow.md` §"base vs project snapshot".
    - **Auto-capture is already handled** by the `/agentbox-setup` skill, which
      runs `agentbox-ctl checkpoint --name setup --replace --set-default` at the
      end of setup (`apps/cli/share/agentbox-setup/SKILL.md`) — cross-provider, so
      no core `afterFirstCreate` hook is needed.
    - The proposed `projects[<hash>]` prepared-state map would be a *second*
      per-project snapshot registry duplicating the checkpoint store. It was
      modelled on a never-wired Hetzner `projects` field (since removed). Not
      building it.
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
