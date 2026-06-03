# E2B provider — build-out backlog

> **Provider status: shipped.** Tasks 1–3 are all merged into `main`; E2B is
> a fully supported AgentBox cloud backend (`--provider e2b`) alongside
> docker / daytona / hetzner / vercel. Public docs live at
> [`/docs/e2b`](https://agent-box.sh/docs/e2b); the provider page
> (`apps/web/content/docs/e2b.mdx`), `CLAUDE.md`,
> `docs/cloud-providers.md` §3c, `docs/cloud-create-flow.md`, and the
> README are kept in sync with each change.
>
> The standout differentiator vs. Daytona / Hetzner / Vercel: E2B is the
> only AgentBox cloud whose `prepare` builds the base image **directly from
> a Dockerfile** via the SDK's `Template.build()`. The others all bake a
> one-time snapshot.

Status tracker for adding **E2B** (`--provider e2b`) as a fifth AgentBox backend,
alongside docker / daytona / hetzner / vercel.

E2B (https://e2b.dev) runs **Firecracker microVMs** with a TypeScript/Python SDK
(`e2b`). Shape-wise it is closest to **Vercel** (microVM per box, SDK comms, no
SSH, public preview hostnames, pause/resume persistence) and **Daytona** (snapshot
tiers). The Vercel provider (`packages/sandbox-vercel/`) is the structural
template for this work; read it first.

## How E2B maps onto the `CloudBackend` abstraction

| AgentBox concept            | E2B primitive |
|-----------------------------|---------------|
| provision a box             | `Sandbox.create(template, { timeout, metadata, envs, ... })` |
| resolve existing box        | `Sandbox.connect(sandboxId)` (auto-resumes if paused) |
| exec                        | `sandbox.commands.run(cmd, { cwd, envs, user, background })` |
| upload / download / ls      | `sandbox.files.write / read / list` |
| preview URL                 | `sandbox.getHost(port)` → `{port}-{sandboxId}.{domain}` (HTTPS) |
| pause / resume              | `sandbox.betaPause()` / `Sandbox.resume(id)` (persistence) |
| list (for prune)            | `Sandbox.list()` (paginator) |
| destroy                     | `sandbox.kill()` |
| session timeout             | `Sandbox.create({ timeout })` (seconds) + `setTimeout` |
| base image (prepare)        | **`e2b template build`** from a Dockerfile — E2B CAN build images from a Dockerfile (key difference from Vercel/Hetzner, which can't) |
| egress policy               | `allow_internet_access` / `network` create opts |
| credentials                 | `E2B_API_KEY` (in `.env.local` and `~/.agentbox/secrets.env`); optionally team id |

### Key open questions — answered in Task 1 (2026-06-02)

1. **Preview URL auth** — **PUBLIC by default.** `sandbox.getHost(port)` returns
   `{port}-{sandboxId}.e2b.app`, served over HTTPS with no token. Smoke-verified
   with a `python3 -m http.server 8080` in-box → host fetch returned HTTP 200
   without any header. Optional gate: `Sandbox.create({ network:
   { allowPublicTraffic: false } })` requires an `e2b-traffic-access-token`
   header (`sandbox.trafficAccessToken`). Task 1 leaves it public to match
   Vercel; revisit in Task 2/3 if the security model warrants gating.
2. **Checkpoint primitive** — **Deferred to Task 2.** E2B's `Sandbox.pause`/
   `Sandbox.connect` (auto-resume) is a single-resume cold-store, not a
   reusable immutable image. The reusable primitive is `Template.build()` from
   a Dockerfile — that lands in Task 2 alongside `agentbox prepare --provider
   e2b`. Task 1 ships a checkpoint stub that throws "not yet implemented for
   e2b (Task 2)".
3. **Privileged ports / port cap** — `getHost(port)` accepts any port; no
   documented cap. Task 1 sets `webProxyPort: 8080` to mirror Vercel and keep
   the in-box `AGENTBOX_WEB_PROXY_PORT` flag uniform across cloud backends.
   Re-test :80 in Task 2.
4. **Nested containers** — **Confirmed `launchDockerd: false`.** E2B is
   Firecracker, same family as Vercel.
5. **Default resources** — E2B `base` template ships node 20, sudo, git, tar
   on Debian 12. vCPU/RAM/disk are **template-level** (`Template.build({
   cpuCount, memoryMB })`), NOT per-create. Task 1's `defaultResources: { cpu:
   2, memory: 4, disk: 8 }` are advisory metadata for BoxRecord stats until
   Task 2's `prepare` bakes a sized custom template.

Additional empirical findings (smoke-tested 2026-06-02):

- **Default user is `user` (uid 1001), not `vscode`.** Task 1's `provision()`
  runs a one-shot in-box fixup script that creates a `vscode` user
  (auto-assigned uid — `1000` is taken by E2B's `code` group on `base`), grants
  passwordless sudo, and chowns `/workspace`, `/run/agentbox`, `/var/log/
  agentbox` so the rest of the cloud scaffold's hardcoded `vscode`
  references work. The vanilla `base` template otherwise has no agentbox-ctl,
  no /workspace, no vscode user.
- **`agentbox-ctl` runs from a single ~835 KB `packages/ctl/dist/bin.cjs`
  bundle.** Task 1 uploads it at create-time via `sb.files.write` (~1s),
  installs to `/usr/local/bin/agentbox-ctl` with `sudo cp+chmod`. No template
  bake needed for Task 1.
- **`Sandbox.getInfo` is the non-resuming static existence check.**
  `Sandbox.connect` auto-resumes a paused sandbox — `state()`/`get()` MUST use
  `getInfo` (not connect) so existence checks don't wake (and bill) a paused
  box. Only ops that need a live handle (exec, files, previewUrl, pause,
  destroy) call connect.
- **`Sandbox.pause` is the canonical pause API** — `betaPause` is deprecated.
- **`sb.commands.run` throws `CommandExitError` on non-zero exit.** The
  CloudBackend contract returns `{exitCode, stdout, stderr}`, so the e2b
  backend catches the error and converts it back to a result.
- **Carry needs the same vercel root carve-out.** Default exec runs as vscode,
  but vscode (uid 1000) cannot `chown` to other uids — the carry chain's
  `chown -R` errors out partway, the parent-chain loop never reaches its
  terminator. `packages/sandbox-cloud/src/carry.ts` now forces `user: 'root'`
  for both vercel AND e2b.

## Task breakdown (each task = one PR, merged before the next starts)

### Task 1 — Package scaffold + `CloudBackend` core  ·  status: DONE 2026-06-02
Goal: `agentbox create --provider e2b` produces a ready box end-to-end,
reusing the `createCloudProvider` scaffold.
- [x] `packages/sandbox-e2b/` package (package.json, tsup, tsconfig). Adds
      `e2b@^2.27.1`.
- [x] `env-loader.ts` + `credentials.ts` — loads/ensures `E2B_API_KEY` from
      `~/.agentbox/secrets.env`; `agentbox e2b login [--status]`.
- [x] `sdk.ts` — re-exports `Sandbox`, resolves the API key, gates with
      actionable error.
- [x] `backend.ts` — every `CloudBackend` method over the E2B SDK
      (provision, get, list, start/stop/pause/resume/destroy, state, exec,
      uploadFile/downloadFile/listFiles, previewUrl, signedPreviewUrl).
      `get`/`state` use `Sandbox.getInfo` (non-resuming) per the orchestrator's
      review; only exec/files/pause/destroy use `Sandbox.connect`.
- [x] `index.ts` — `createCloudProvider(e2bBackend, { defaultResources,
      launchDockerd: false })` + a checkpoint stub that throws
      "not yet implemented for e2b (Task 2)". Exports `e2bProvider`,
      `e2bBackend`, `ensureE2bCredentials`.
- [x] `cli.ts` — `agentbox e2b login [--status]`.
- [x] `runtime-assets.ts` — single-file resolver for `packages/ctl/dist/bin.cjs`,
      uploaded at create-time so the cloud scaffold's `launchCloudCtlDaemon`
      finds `/usr/local/bin/agentbox-ctl`. (Task 2 grows this to a full
      prepared-template bake.)
- [x] `test/env-loader.test.ts` — parser + lookup precedence unit tests.
- [x] Wired into `apps/cli`: `provider/registry.ts`,
      `provider/cloud-backend.ts`, `index.ts`, `help.ts`,
      `commands/{checkpoint,prune,install,prepare,dashboard,fork}.ts`,
      `lib/doctor-checks.ts`, `packages/relay/src/host-actions.ts`,
      `packages/sandbox-cloud/src/carry.ts` (root carve-out for the chown
      walk), `packages/config/src/types.ts` (`ProviderKind` + `box.provider`
      enum), `test/help.test.ts`.
- [x] Smoke: `agentbox create --provider e2b -y -n e2bsmoke -w
      /tmp/e2bsmoke-repo` reaches `box cloud:<id> ready` in ~15s.
      Backend-level smoke (`/tmp/e2b-smoke-checks.mjs`):
        - state → running
        - exec as vscode + as root → exit 0
        - file round-trip (uploadFile / downloadFile) → byte-exact
        - listFiles → `[{name,isDir}]`
        - previewUrl → `https://8080-<sbx>.e2b.app`; HTTP 200 with no token
        - pause → 'paused'; start (connect auto-resume) → 'running'; in-box
          file survives the cycle
        - list → both live sandboxes seen
        - destroy → SandboxNotFoundError on subsequent getInfo (cleanly gone)

### Task 2 — `prepare` (template build) + attach + checkpoints  ·  status: DONE 2026-06-03
Goal: provider parity with Vercel — `prepare` bakes a custom template, interactive
attach works, checkpoints capture/restore. ALL smoke steps verified end-to-end.
- [x] `prepare.ts` + `prepared-state.ts` — `agentbox prepare --provider e2b`
      bakes the base template via the SDK's `Template.build()` (driven from
      TypeScript, not an on-disk Dockerfile). Reuses the staged docker runtime
      assets through `runtime-assets.ts` (mirror of vercel's resolver). Records
      template id in `~/.agentbox/e2b-prepared.json`. Base-snapshot gate
      (`ensureE2bBaseTemplate`) lives inside `backend.provision`.
- [x] `build-attach.ts` + `attach-helper.ts` — SDK-streaming PTY bridge (no SSH).
      `buildE2bAttach` returns `['node', <helper>, '--sandbox-id', id, '--user',
      vscode]` with `E2B_API_KEY` + `AGENTBOX_E2B_INNER_CMD` in env. The helper
      `Sandbox.connect`s, opens `pty.create({ cols, rows, onData, ... })`,
      sendInputs the renderInnerCommand string (tmux ensure + attach), and
      bridges stdin / stdout / SIGWINCH.
- [x] `checkpoint` capability — `Sandbox.createSnapshot(sandboxId, { name })` is
      the reusable-snapshot primitive (was the missing piece in Task 1; same
      shape as Vercel — store snapshotId in the manifest, restore boots via
      `Sandbox.create({ template: <id> })`). `snapshotExists` uses
      `Template.exists(name)`.
- [x] `previewUrl` fix — drops `Sandbox.connect` (which would auto-resume a
      paused box), constructs the URL locally as
      `{port}-{sandboxId}.{E2B_DOMAIN ?? 'e2b.app'}`. Verified: `agentbox list`
      shows the URL of a paused box without waking it.
- [x] Per-provider config keys (`box.imageE2b`, `box.defaultCheckpointE2b`,
      `box.sizeE2b`) added so the prepare command pins the template id under
      the right key (avoids cross-provider collision).
- [x] CLI integration: `apps/cli/scripts/stage-runtime.mjs` stages
      `runtime/e2b/{scripts/build-template.sh, attach-helper.cjs, ctl.cjs,
      agentbox-*-shim, custom-system-CLAUDE.md, ...}`; `apps/cli/src/commands/
      prepare.ts` renders the e2b status block; `apps/cli/src/lib/doctor-checks.ts`
      adds the base-template probe.
- [x] Unit tests: `test/prepared-state.test.ts` (round-trip + gate),
      `test/build-attach.test.ts` (argv shape + env wiring).
- [x] Smoke end-to-end (2026-06-03):
        - `agentbox prepare --provider e2b -y` → built `agentbox-base:latest`
          (template id `o05kawibx9vcmxvgjnk4`); 2m18s build, pinned to
          `box.imageE2b` in project config + recorded in
          `~/.agentbox/e2b-prepared.json`.
        - `agentbox create --provider e2b -y -n e2bt2a -w /tmp/e2bsmoke-repo`
          → ready in ~10s (Task 1 was ~15s with the create-time fixup hop).
        - `agentbox shell e2bt2a` (via `script -q -c …`) → real `vscode@e2b:/workspace$`
          prompt; the host PTY bridges in/out cleanly. (drive harness shows a
          display quirk where tmux's framing buffer doesn't render into the
          headless terminal — separate issue tracked below; the underlying
          PTY bridge works.)
        - `agentbox stop e2bt2a` → state `paused`; `agentbox list --global`
          still shows the URL (no resume); `agentbox start e2bt2a` →
          `running`; round-trip survives.
        - `agentbox checkpoint create e2bt2a` → `Sandbox.createSnapshot` minted
          `marco6/agentbox-e2bt2a-…:default`; manifest written under
          `~/.agentbox/cloud-checkpoints/e2b/…/manifest.json`; `agentbox
          checkpoint ls` finds it.
        - `agentbox create --provider e2b -y -n e2bt2b -w /tmp/e2bsmoke-repo
          --snapshot e2bt2a-150413` → booted from the snapshot id.
        - `agentbox checkpoint rm e2bt2a-150413` → snapshot deleted on E2B,
          manifest cleared.
        - `agentbox destroy -y e2bt2a e2bt2b` → both sandboxes destroyed.

#### Empirical findings (Task 2, 2026-06-03)

- **`Template.build` requires RELATIVE source paths.** The SDK's
  `template.copy(src, dest)` rejects absolute paths (`Invalid source path
  "/foo": absolute paths are not allowed`). We stage every resolved asset
  into a temp `fileContextPath` dir under its logical name, then pass the
  asset name as a relative `src` — same idea as Docker's `COPY` semantics.
- **`Sandbox.create({ template })` auto-appends `:default`.** A 404 fires
  with `tag 'default' does not exist for template 'xxx'` when the
  `templateId` we store omits the tag. We persist `${templateId}:${tag}`
  (tag = `info.tags[0] ?? 'latest'`) so the create path always lands on a
  built tag.
- **`e2b` SDK must be external to apps/cli's bundle.** The
  `TemplateBuilder` constructor calls `dynamicRequire('node:url')` to
  resolve the caller directory; esbuild's ESM `__require` shim throws
  "Dynamic require of 'node:url' is not supported" when this is bundled.
  Added `'e2b'` to apps/cli's `external` list (same pattern as
  `@daytonaio/sdk` and `@vercel/sandbox`) and added it as a real dep.
- **`pty.create` accepts a max `timeoutMs` of 1 hour on the Hobby tier**
  (`400: Timeout cannot be greater than 1 hours`). The attach helper now
  caps at 55 minutes; longer sessions will need a keepalive ping that
  extends the timeout via `Sandbox.setTimeout` mid-session (future work).
- **Drive harness display quirk** — `node-pty` via the drive harness shows
  an empty screen when the spawned child is the agentbox shell attach, but
  a plain `script -q -c …` capture shows the same attach producing a real
  prompt. Likely a headless-terminal-vs-tmux passthrough mismatch in the
  drive harness rather than the attach helper itself. Filed for later.

### Task 3 — prune + docs + polish  ·  status: DONE 2026-06-03
Goal: close the provider out — wire prune, finish doctor, propagate E2B
everywhere the docs still said "four backends", and finalize the backlog as
shipped.
- [x] `agentbox prune --provider e2b` — `CLOUD_PRUNE_PROVIDERS` already
      included `e2b` from Task 1; live-verified the orphan-sweep path
      (sandbox spawned via the SDK with the `agentbox` marker tag, then
      `prune --provider e2b --dry-run` and `-y` cleanly removed it).
      Templates are sandbox-only — E2B's SDK exposes no `Template.list()`,
      so prune covers sandboxes only (documented in the provider page).
- [x] `agentbox doctor --provider e2b` — credentials + prepared-template
      checks were added in Tasks 1–2; Task 3 fixed the stale `--provider`
      help/error strings in `apps/cli/src/commands/doctor.ts` that still
      listed only `docker | daytona | hetzner | vercel`.
- [x] Internal docs synced: `CLAUDE.md` (five backends, ctl shipping list,
      checkpoint primitive list, ops paragraph, doc-map),
      `docs/cloud-providers.md` (intro table + §3c "The E2B shape" + §4 auth +
      §8 file-map + footer), `docs/cloud-create-flow.md` (cross-provider
      callout), `README.md` (provider table + login + prepare + docs link).
- [x] Public site (Fumadocs) synced: new
      `apps/web/content/docs/e2b.mdx` (mirrors `vercel.mdx`, leads with the
      Dockerfile/`Template.build()` differentiator), `meta.json` providers
      list updated, `cli.mdx` provider section updated.
- [x] Backlog finalized — "provider status: shipped" header above; deferred
      follow-ups summarized below.

#### Deferred follow-ups (intentional, not blocking)

- **No `Template.list()` in the SDK.** `prune --provider e2b` enumerates
  sandboxes only; built templates have to be removed from the E2B
  dashboard. Document this in the provider page; ship as-is.
- **1-hour platform session cap on Hobby.** The attach helper caps
  `timeoutMs` at **55 minutes** (see `packages/sandbox-e2b/src/attach-helper.ts`
  + the staged `apps/cli/runtime/e2b/attach-helper.cjs`) to leave headroom
  under the platform ceiling. Longer interactive sessions would need a
  mid-session `Sandbox.setTimeout` keepalive that extends the lease — out
  of scope for the launch.
- **Drive harness display quirk** on the e2b shell attach (Task 2 finding).
  A plain `script -q -c …` capture shows the prompt; the headless drive
  harness shows an empty screen. Underlying PTY bridge works.
- **No `e2bTimeoutMs` / `e2bNetworkPolicy` config keys.** Vercel exposes
  parallels for its own SDK; on E2B both knobs are template-level (set at
  `Template.build()` time) — there's no per-create override to bind a
  config key to. Revisit if E2B's SDK grows per-create surface.
- **`box.image` cross-provider migration** was already handled in Task 2
  (per-provider `box.imageE2b` lives in `packages/config/src/types.ts`).

#### Post-ship polish

- **Clean prepare-gate error output** (2026-06-03). The "no E2B base
  template found" gate now throws `UserFacingError` (from `@agentbox/core`)
  and the CLI's top-level catch renders it as a one-line message instead
  of a raw stack trace. Same treatment for the parallel vercel/hetzner
  gates.
- **Checkpoint manifest records `baseFingerprint`** (2026-06-03). The custom
  `e2bCheckpoint.create` (mirrors `vercelCheckpoint.create`) now passes
  `baseProvider`, `baseFingerprint`, and `cliVersion` to
  `writeCloudCheckpointManifest` — matching the scaffold default that
  daytona/hetzner inherit. Before, every e2b/vercel default checkpoint
  tripped the wizard's "captured before checkpoint versioning; base
  snapshot unverifiable" branch and stale-prompted forever; now the
  fresh-vs-stale verdict is real for all four clouds.
- **Login nudge + create-time base-freshness check** (2026-06-03). Two paper-
  cuts off the e2b first-run path:
  - `agentbox e2b login` now prints a one-line nudge pointing at
    `agentbox prepare --provider e2b` when no base template is recorded yet,
    so the login-only path doesn't silently leave the next `create` to trip
    the (newly-clean) "no base template found" error.
  - `agentbox create --provider e2b` / `agentbox claude --provider e2b` now
    detect a stale base template at create time. Decision is made purely on
    `contextSha256` — the SHA over the baked runtime files (CLI version
    strings are informational and never gate freshness, so a CLI patch
    that touches nothing baked stays `fresh`). TTY → merged "rebuild the
    base?" confirm; `-y`/non-TTY → loud warn + boot on the existing base
    (no auto-bake). Verified live: fresh-base TTY skips the prompt; mutating
    one hex char of `base.contextSha256` fires the prompt; `-y` mode warns
    and proceeds. Same plumbing covers daytona/hetzner/vercel via the new
    `Provider.baseFingerprint?()` capability.

## Coordination notes (orchestrator)

- Each task is assigned to an agent via
  `agentbox claude -i "<prompt>" -- --permission-mode=plan` (background box).
  The agent: plans → (orchestrator answers questions from the other providers)
  → implements → smoke-tests → opens a PR → fixes bugbot/CI → merges. Orchestrator
  then pulls `main` and starts the next task.
- `E2B_API_KEY` is in `.env.local` and reachable inside every box; boxes run the
  relay and can launch boxes on other providers, so they can fully smoke-test.

## Changelog
- 2026-06-03: E2B usability pass — onboarding seed + shell exec + VNC + tag.
  Live-verified end-to-end against `agentbox-base:latest`.
  - **Onboarding (the blocker)**: cloud creates were dropping into Claude's
    first-run theme picker. Fixed by overlaying `~/.claude/_claude.json`
    from the host's current `~/.claude.json` on every cloud create (across
    e2b/vercel/hetzner/daytona) — see
    `packages/sandbox-cloud/src/claude-json-overlay.ts`. The default
    fallback (host has no `~/.claude.json`) now sets
    `hasCompletedOnboarding: true`.
  - **One-shot `agentbox shell`**: `agentbox shell <cloud-box> -- cmd`
    used to hang because the cloud path always opened a PTY attach via
    `provider.buildAttach`. One-shot now routes through `provider.exec`
    (the same primitive used at create-time); interactive `agentbox shell`
    still uses the PTY attach.
  - **VNC**: two issues — Debian 12 (E2B's base) doesn't ship `vncpasswd`
    (Ubuntu-only `tigervnc-tools`), and E2B's Python-venv websockify
    startup needs ~7-9s to bind. Fix: graceful `-SecurityTypes None`
    fallback in `agentbox-vnc-start` when `vncpasswd` is missing (signed
    preview URL is the access boundary, same effective model), and
    bump the cloud probe ceiling 5s → 15s in `vnc-launch.ts`. Other
    providers (docker/hetzner/daytona/vercel) keep VncAuth.
  - **Doubled `:latest:latest`**: `prepare` status read
    `tmpl agentbox-base:latest:latest` because `info.name` (already
    `"agentbox-base:latest"`) got `:${tag}` re-appended. Now stores
    `info.name` verbatim.
- 2026-06-03: Task 3 done — `agentbox prune --provider e2b` live-verified
  end-to-end (orphan spawned via the E2B SDK, `--dry-run` listed it, `-y`
  deleted it); doctor `--provider` help/error strings extended to include
  e2b; CLAUDE.md / docs/cloud-providers.md / docs/cloud-create-flow.md /
  README.md propagated to "five backends"; new
  `apps/web/content/docs/e2b.mdx` page added with the
  Dockerfile/`Template.build()` differentiator front and center. Provider
  marked as shipped; deferred follow-ups (templates not enumerable,
  55-min/1-hr session ceiling, drive-harness display quirk,
  no `e2bTimeoutMs`/`e2bNetworkPolicy` parallels) recorded above.
- 2026-06-02: Backlog created; task breakdown + E2B↔CloudBackend mapping drafted.
- 2026-06-02: Task 1 done — package + CloudBackend core, smoke-tested end-to-end.
  Open questions answered (preview URL is public by default; checkpoint deferred
  to Task 2; webProxyPort=8080; no dockerd; resources are template-level).
  Three cloud-scaffold gaps surfaced and fixed here: a Buffer→ArrayBuffer
  conversion for `sb.files.write`, a CommandExitError→CloudExecResult catch,
  and the carry root carve-out extended from vercel to e2b.
- 2026-06-03: Task 2 done — `prepare` (Template.build), interactive attach via
  the SDK's PTY API, and `checkpoint` via `Sandbox.createSnapshot`. Smoke-tested
  end-to-end against /tmp/e2bsmoke-repo. previewUrl no longer wakes paused boxes.
  Per-provider config keys (`box.{image,defaultCheckpoint,size}E2b`) added.
  Three SDK gotchas surfaced: `template.copy` rejects absolute paths (staged
  via temp fileContextPath); `Sandbox.create` auto-appends `:default` so we
  store the tagged `${id}:${tag}`; the `e2b` SDK must be external in apps/cli
  bundles (dynamicRequire on `node:url`).
