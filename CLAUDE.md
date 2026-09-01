# AgentBox — context for Claude Code

`agentbox` is an npm CLI that spins up isolated sandboxes ("boxes") for coding agents (Claude Code, Codex, others) to work in, so they can't touch the host. Seven backends share one provider abstraction: **Docker** (the default — one local container per box, isolated by per-box git branch in an in-container worktree against the bind-mounted host `.git/`), **Daytona Cloud** (`--provider daytona` — a managed remote sandbox seeded from a host git bundle + per-agent credential volumes, reached via SSH-token attach and an in-sandbox bridge relay), **Hetzner Cloud** (`--provider hetzner` — a bare VPS per box, pure OpenSSH ControlMaster comms, locked-down Hetzner Cloud Firewall, baked from a one-time `agentbox prepare --provider hetzner` snapshot), **Vercel Sandbox** (`--provider vercel` — a Firecracker microVM per box, persistent snapshots, public HTTPS preview URLs; nested containers (in-box docker) now supported and baked in, no SSH, baked from a one-time `agentbox prepare --provider vercel` snapshot), **E2B Sandbox** (`--provider e2b` — a Firecracker microVM per box, SDK-only comms, public HTTPS preview URLs, persistent pause/resume; uniquely among the cloud providers, E2B builds its base template **directly from a Dockerfile** via `Template.build()` — `agentbox prepare --provider e2b` runs the build), and **Remote Docker** (`--provider remote-docker`, spelled `agentbox docker:<host> …` — one container per box on a machine the *user* already owns, reached over an OpenSSH ControlMaster and driving **that machine's** docker engine. Cloud-shaped despite being docker: a bind mount can't cross a network, so the workspace is synced (git clone + carried-over stash/untracked) exactly as for the clouds, while the image (Dockerfile), checkpoints (`docker commit`) and DinD stay docker-shaped. No credential — it connects as you, over your own `~/.ssh/config`).

## Architecture overview

- **Boxes** — one isolated sandbox per agent run. The shape differs by provider but the abstraction is one `Provider` interface (`packages/core/src/provider.ts`):
  - **docker**: container `agentbox-<id|name>`; `/workspace` is the in-container git worktree on branch `agentbox/<box-name>`; host's `.git/` is bind-mounted RW so commits land on the host immediately. Boxes pause/unpause for cheap context switching and survive stop/start; `destroy` wipes the container + per-box volumes. The base image (`agentbox/box:dev`) is **pulled** from GHCR on first use (tagged by build-context fingerprint, see `pullOrBuild`/`registryRefForSha` in `image.ts`) and only built locally on a pull miss; `--build` / `box.imageRegistry=""` force a local build. See [`docs/development.md`](./docs/development.md) → "Image: pull vs rebuild".
    **One agent per box:** the base image carries NO agents; `agentbox claude` derives `agentbox/box:dev-claude` (`FROM` the base + the agent's install recipe) and mounts only that agent's config volume + credentials. See [`docs/agents.md`](./docs/agents.md).
  - **daytona** (cloud): Daytona sandbox with `/workspace` seeded from a host `git bundle create` (incl. stash + untracked carry-over for the user's local state). Lifecycle goes through the Daytona SDK; agent credentials (`~/.claude`, `~/.codex`, `~/.config/opencode`) live in shared per-org volumes seeded from the host. Host↔box comms go through a per-box bridge URL (CloudFront preview) that the host relay's `CloudBoxPoller` long-polls.
  - **hetzner** (cloud): one Hetzner VPS per box (default `cx23` / `nbg1`). Workspace seeded the same way (git bundle + stash + untracked tar). Per-box ed25519 SSH key minted on the host into `~/.agentbox/boxes/<sandboxId>/ssh/` and injected via cloud-init. Per-box Hetzner Cloud Firewall auto-locked to the host's egress IP (multi-probe fail-loud). All comms (exec, scp, port forwards, attach) flow over one persistent `ssh -fNT -M` ControlMaster per box; `previewUrl(port)` mints `ssh -O forward` on demand. No agent credentials volume — credentials pushed via scp at create time (Hetzner has no shared-volume primitive). `agentbox prepare --provider hetzner` bakes a one-time base snapshot since Hetzner can't build images from a Dockerfile.
  - **vercel** (cloud): one Vercel Sandbox (Firecracker microVM, Amazon Linux 2023) per box. Workspace seeded the same way (git bundle + stash + untracked tar). Boots from a Vercel snapshot baked once by `agentbox prepare --provider vercel` (no Dockerfile build). Persistent sandboxes auto-snapshot on stop and auto-resume on `Sandbox.get({ resume: true })` → pause/resume for free. Comms via the SDK: `exec` runs as `vscode` (root → `sudo -u vscode`); `previewUrl(port)` returns the public `sandbox.domain(port)` (HTTPS, no token), so the host relay's `CloudBoxPoller` reaches the in-box bridge directly. **In-box docker (DinD)** is baked into the base snapshot and `dockerd` is auto-started on create/resume (`launchDockerd:true`, via the shared `agentbox-dockerd-start`) — Vercel Sandbox now supports nested containers. **No SSH** (attach is a custom `attach-helper.js` tmux bridge over the SDK). Max 4 exposed ports, region `iad1` only.
  - **e2b** (cloud): one E2B Sandbox (Firecracker microVM, Debian 12) per box. Workspace seeded the same way (git bundle + stash + untracked tar). **Key differentiator from Vercel/Hetzner: E2B builds its base image directly from a Dockerfile** via the SDK's `Template.build()` — `agentbox prepare --provider e2b` drives the build and pins the resulting template id to `box.imageE2b`. `Sandbox.pause`/`Sandbox.connect` (auto-resume) gives free pause/resume; `Sandbox.createSnapshot` is the reusable, id-addressed checkpoint primitive (same shape as Vercel). Comms via the SDK: `exec` runs as `vscode`; `previewUrl(port)` returns the public `{port}-{sandboxId}.e2b.app` URL (HTTPS, no token; constructed locally so it doesn't wake a paused sandbox). **In-box docker (DinD)** is baked into the base template and `dockerd` auto-starts on create/resume (`launchDockerd:true`) — E2B microVMs support nested containers (full root + cap_sys_admin, verified 2026-06-23), contrary to the original "same as Vercel" assumption. **No SSH** — attach is a custom `attach-helper.cjs` SDK-streaming PTY bridge over `pty.create`. 1-hour platform session cap on the Hobby tier (the attach helper caps at 55 minutes for headroom).
- **In-box supervisor** (`@agentbox/ctl`) — reads `/workspace/agentbox.yaml` and runs the declared tasks/services under a DAG scheduler. Ships as `agentbox-ctl` inside every box (docker, daytona, hetzner, vercel, e2b).
- **Host relay** (`@agentbox/relay`) — a host node process boxes call for things they have no credentials for (`git push`, checkpoint capture, `cp`/`download`) and to push status events. Keeps SSH keys out of the box. The cloud path drives the same relay via `CloudBoxPoller` + `executeCloudAction`.
- **Checkpoints** — `docker commit` (+ periodic `FROM scratch` flatten) for docker; Daytona snapshots (`sb._experimental_createSnapshot`) for daytona; Hetzner `create_image` snapshots (no-pause default — matches `docker commit`) for hetzner; Vercel `sb.snapshot()` (id-addressed; stores the snapshot id in the cloud-checkpoint manifest) for vercel; E2B `Sandbox.createSnapshot` (id-addressed template, same shape as Vercel) for e2b. All flow through `provider.checkpoint.create`. `box.defaultCheckpoint` is the cross-provider fallback; `box.defaultCheckpointDocker` / `box.defaultCheckpointDaytona` / `box.defaultCheckpointHetzner` / `box.defaultCheckpointVercel` / `box.defaultCheckpointE2b` override per provider.
- The full design — file-handling rationale, the checkpoint model, pause/resume strategy, what we explicitly rejected — lives in [`docs/architecture.md`](./docs/architecture.md) and [`docs/create-and-checkpoints.md`](./docs/create-and-checkpoints.md). Each cloud provider's shape and its known caveats live in [`docs/cloud-providers.md`](./docs/cloud-providers.md). **Read them before making non-trivial changes to the lifecycle code.**

## Important notes

 - You have docker and you are authorized to run docker commands, inspect containers, run commands inside containers, etc.
 - You are authorized to start cloud boxes, cloudflare tunnels, tailscale tunnels, etc.
 - For cloud work: the Daytona API key + org id, the Hetzner `HCLOUD_TOKEN`, the Vercel auth trio, and the E2B `E2B_API_KEY` all live in `~/.agentbox/secrets.env` (managed by the per-provider `agentbox <provider> login` commands). You may use each cloud's SDK directly to inspect / clean up sandboxes when a test leaves an orphan, or `agentbox prune --provider <name> -y` for the supported path.
 - For hetzner-cloud work: the base-snapshot id is recorded at `~/.agentbox/hetzner-prepared.json` (written by `agentbox prepare --provider hetzner`); per-box SSH keys live under `~/.agentbox/boxes/<sandboxId>/ssh/` (private key never leaves host, dropped on `destroy`). You may use the Hetzner REST API directly via `curl -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/...` to clean up orphan servers / firewalls / snapshots when a test leaves something behind. `agentbox prune --provider hetzner` is not yet wired (backlog item — the underlying `backend.list()` works).
 - For e2b-cloud work: the base-template id is recorded at `~/.agentbox/e2b-prepared.json` (written by `agentbox prepare --provider e2b`, which drives `Template.build()` from a Dockerfile). You can use the `e2b` SDK directly (`node -e "import('e2b').then(({Sandbox})=>Sandbox.list())"`) to inspect or clean up sandboxes when a test leaves an orphan, or `agentbox prune --provider e2b -y` for the supported path.

## Testing / verifying

`create`, `claude`, `codex`, and `opencode` tee their progress to a file at
`~/.agentbox/logs/<command>.log`, and `~/.agentbox/logs/latest.log` always points
at the most recent run. The log is rotated 1-deep — the previous run is at
`<command>.log.prev`.

When verifying a change:

- **Don't pick a blind long timeout.** Start the slow command in the background
  (e.g. `node apps/cli/dist/index.js create -y -n smoke &`), then
  `tail -f ~/.agentbox/logs/latest.log` to watch real progress. Stop waiting
  the moment the log shows what you need (e.g. `box ... ready` or a failed
  step). Don't sit on a 120s blocking call hoping it returns.
- **Interactive TUIs (`dashboard`, `claude`, `codex`, `opencode`):** drive them
  through `pnpm drive` (the PTY harness at `apps/cli/test/_harness/`).
  `pnpm drive start --name X -- node apps/cli/dist/index.js dashboard`, then
  `pnpm drive screen X` to read the rendered terminal and
  `pnpm drive send X "<C-a>q"` to send keystrokes. `pnpm drive --help` and
  `apps/cli/test/_harness/README.md` cover the surface.
- **Typical create check:** `node apps/cli/dist/index.js create -y -n smoke &`,
  then `tail -f ~/.agentbox/logs/create.log` until you see the BEGIN/END
  markers for each step. If a step's END never arrives, you've found the
  hang — inspect that step rather than killing the whole command.
- **Test projects**: use the `examples/` directory mainly, or `../agentbox-test-repo` to test push/pull on a test repo setup on GitHub, and `../agentbox-test-repo-gh` for the same repo but with https origin using `gh` tool. Also `../express-server` can be used to test the setup wizard since it doesn't have an `agentbox.yaml` file.
- **Use Agentbox inside Agentbox**: start a container with `agentbox claude --shared-docker-cache --carry-yes` to have a box ready with agentbox compiled and in the path and reuse docker cache for faster builds. For Images build use `docker build --network=host -t agentbox/box:dev -f apps/cli/runtime/docker/Dockerfile.box apps/cli/runtime/docker` instead of `agentbox prepare` because the box runs without `CAP_SYS_PTRACE`.
- **Hub is a persistent daemon — always rebuild + restart it after any hub change.** `agentbox hub` (relay + Next UI on 8787) is long-lived and spawns the **standalone build**, so a running hub keeps serving stale code after you edit `apps/hub/**` or any package it imports (`@agentbox/relay`, `@agentbox/sandbox-docker`, …). On dev, rebuild the standalone and restart before verifying:
  ```
  pnpm --filter @agentbox/hub build:standalone
  AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
  ```
  The `AGENTBOX_HUB_BIN` override is load-bearing: `resolveHubServer` prefers the CLI-staged `apps/cli/runtime/hub/…/server.js` (only refreshed by a full `agentbox` CLI build) over the fresh `apps/hub/dist-standalone`, so a bare `hub restart` respawns the stale staged bundle. Rebuild the imported packages too if you touched them. Same rule as `agentbox relay restart` for relay code. For fast UI-only iteration run the hub directly with `pnpm --filter @agentbox/hub hub:dev` (`tsx watch server.ts`). Note: `public/` assets (logo, favicon) only work through `build:standalone` (which stages `public/`) or `next dev`/`next start` — never assume a static asset serves without one of these.

## Conventions

- **TypeScript strict, ESM, `verbatimModuleSyntax`** — always `import type { … }` for types.
- **tsup** builds each package's `src/index.ts` → `dist/`. Don't reach into another package's `src/` from a sibling; consume via the package name.
- **vitest** for tests, default discovery (`test/**/*.test.ts`). Keep unit tests pure — no docker, no network. Integration testing is manual for now (see README → Development).
- **eslint + prettier**, flat config at repo root. `pnpm lint` and `pnpm format` are the commands.
- **commander** for CLI surface; **@clack/prompts** for any interactivity. Don't add a third prompts/CLI lib.
- **execa** for shelling out to `docker` (debuggable, no native deps). Don't introduce `dockerode` without a good reason. **One sanctioned native-dep exception**: `@homebridge/node-pty-prebuilt-multiarch` (ships ABI-stable N-API prebuilds, no end-user compiler) is used **only** by `agentbox dashboard` for the in-process terminal compositor. It is an `optionalDependencies` of `apps/cli` with a guarded dynamic import — a missing prebuild degrades `dashboard` to a clear error, never breaks the rest of the CLI.
- **Do the work behind the hub `/api/v1`, not in the CLI.** When a command does real work — bake, create, lifecycle, git — it should drive the hub's REST API and let the hub's queue worker execute it, rather than calling a provider inline. There are four front-ends (the local CLI, the CLI pointed at a remote control box, the web UI, the macOS tray) and the API is the only surface all four share: logic that lives in the CLI serves exactly one of them. Baking is the worked example — `agentbox prepare`, the install wizard and `agentbox remote-docker add` all go through `runPrepare` → `POST /api/v1/…` → the hub worker; there is no inline `provider.prepare` on the CLI side. See [`docs/hub-api-single-path-plan.md`](./docs/hub-api-single-path-plan.md).
- **No emojis in code or output** unless explicitly requested.
- **Comments only when the WHY is non-obvious** (a constraint, a workaround, a surprising invariant). Names should carry the WHAT.
- **`@madarco/agentbox-provider-sdk` is published separately — rebuild + republish it when you change its interface.** The provider-plugin SDK (`packages/provider-sdk`) is a self-contained npm package that external plugins depend on; it inlines the internal `@agentbox/*` packages via tsup `noExternal`. Its public surface = the re-export list in `packages/provider-sdk/src/index.ts` **plus** the re-exported types/values from `@agentbox/core` (`Provider`/`CloudBackend`/`ProviderModule`), `@agentbox/sandbox-cloud` (`createCloudProvider`, attach/staging/checkpoint helpers), and `@agentbox/sandbox-core` (prepared-state, runtime-assets). If a change alters any of those, the shipped SDK is stale until you rebuild and **republish** it (bump its own `version`; a breaking change also bumps `SDK_API_VERSION` in that index + must be in the CLI's `SUPPORTED_SDK_API_VERSIONS`). Gate + publish per [`docs/provider-plugins.md`](./docs/provider-plugins.md) → "Publishing the SDK": `pnpm --filter @madarco/agentbox-provider-sdk pack:test` then `cd packages/provider-sdk && npm publish`. The `/release-notes` skill checks for this automatically.

## AgentBox Tray (macOS menu-bar app)

A native macOS **menu-bar app** lives in the sibling repo [`../agentbox-tray`](../agentbox-tray)
(private GitHub `madarco/agentbox-tray`). It surfaces all boxes and gives one-click actions — open
the hub, open each box's Web/VNC, start/stop, per-box git ops (`pull`/`push`/`push --host-only`/
`checkout`/`branch`), restart services, and answer host-action approvals — without a terminal. It
updates live over the hub's SSE stream and falls back to polling.

It has **no build-time coupling** to this repo — it's a Swift Package Manager / AppKit app (Swift
5.10, no Xcode, no external deps) that drives the two public surfaces:

- **Boxes + actions** via the local **Control Hub** REST API at `127.0.0.1:8787`: `GET /api/v1/boxes`
  (which carries the raw host-side fields — `state`, `projectRoot`, endpoint URLs, session titles —
  and the synthetic `creating`/`error` boxes for in-flight/failed creates) plus the lifecycle
  (`start`/`pause`/`resume`/`stop`/`destroy`), git, rename, and services routes. Approvals use
  `/api/v1/approvals` (+ `…/{id}/answer`), live events the SSE `/api/events` stream. **Auth to
  remember when changing the hub:** both `/api/v1/*` and `/api/events` go through the same gate
  (`apps/hub/proxy.ts`) and accept `Authorization: Bearer <token>` — a headless client (the tray
  against a remote control box) subscribes to events with the same Bearer key it uses for `/api/v1`.
  The token cookie (`agentbox_hub_token`, or the better-auth session cookie on a password profile) is
  an *additional* accepted credential for the hub's own same-origin browser fetches, not a
  replacement. Token is `~/.agentbox/hub/token`. SSE events are refetch signals only (empty
  `data: {}`).
- **Inherently-local actions** via the installed CLI, shelled through a login shell
  (`/bin/zsh -lc 'agentbox …'`, because a GUI app has no inherited PATH): `open --in`/`open --targets`
  (terminal attach in iTerm2/cmux/Herdr), and `hub status`/`hub start` to bootstrap the hub itself.

**When you change the hub `/api/v1` API (the Box payload especially), the SSE event/auth contract, or
the CLI commands the app still shells (`open`, `hub`), update the tray app too** — its own
[`CLAUDE.md`](../agentbox-tray/CLAUDE.md) documents exactly which surfaces it depends on. The app's
data/action layer sits behind a `BoxSource` protocol (implemented by `HubAPIBoxSource`) so it can
target the hosted control-plane unchanged (so it can target a deployed control box unchanged).

## Documentation map

Each topic has a dedicated file under [`docs/`](./docs). Read the relevant one before changing that area.

> **Keep the public docs in sync — every change.** The user-facing documentation
> site lives in [`apps/web/content/docs/`](./apps/web/content/docs) (Fumadocs,
> published at https://agent-box.sh/docs). Whenever you add or change a CLI
> command, flag, config key, default, or provider/lifecycle behavior, update the
> matching `.mdx` page (and `meta.json`/CLI reference) in the **same** change —
> stale public docs are a bug. When the UI a figure shows changes, recapture it
> per [`apps/web/images.md`](./apps/web/images.md). See [`apps/web/CLAUDE.md`](./apps/web/CLAUDE.md)
> for the site's structure, theming, and build.
- [`docs/architecture.md`](./docs/architecture.md) — **the single architecture reference**: the box/worktree/checkpoint model and *why* it is shaped that way (plus what was rejected), the repo tree, where every piece of state lives, the two long-lived processes (`@agentbox/ctl` in the box, `@agentbox/relay` on the host), and what the product does today.
- [`docs/create-and-checkpoints.md`](./docs/create-and-checkpoints.md) — implementation reference for `agentbox create` (file/git handling) and the checkpoint capture/restore mechanics.
- [`docs/cloud-providers.md`](./docs/cloud-providers.md) — every non-docker provider (daytona, hetzner, vercel, e2b, remote-docker, digitalocean): how each differs from docker, the bridge relay model, credential volumes, preview URLs, and each one's known caveats.
- [`docs/cloud-create-flow.md`](./docs/cloud-create-flow.md) — step-by-step walk of a cloud create: how `.git` and workspace files reach the box (git bundle + stash + untracked tar), and the base-vs-project snapshot tiers.
- [`docs/sync-architecture.md`](./docs/sync-architecture.md) — the sync layer: one provider-agnostic way to move files/credentials in and out of a box.
- [`docs/terminal-integration.md`](./docs/terminal-integration.md) — host-terminal attach placement (tmux/cmux/Herdr/iTerm2), terminal titles, the cmux sidebar status, and the Herdr integration + plugin.
- [`docs/agents.md`](./docs/agents.md) — **the agent reference**: agents as data (`AGENT_SYNC_SPECS` + install recipes), one-agent-per-box, the agentless-base/derived-layer image tiers, adding an agent to a running box, and the checklist for adding a new agent. **An agent can also arrive as an npm package** — `agentbox agent add <pkg>` snapshots its `AgentSyncSpec` into `~/.agentbox/agents.json` (read sync + offline by everything, exactly as `plugin add` does for providers) and its `agentSyncModule`, if it ships one, is loaded by a variable `import()` from `@agentbox/agent-modules`. A plugin cannot shadow a built-in agent's id or alias, in either half.
- [`docs/agents-remaining-work.md`](./docs/agents-remaining-work.md) — what is still open in the agent layer after the agents-as-packages work: the four claude-named files still in the shared packages and the one decision that blocks them (**does the hub load agent modules?** — it loads none today, so a registration seam would silently stop the hub's ssh-config prune), and the never-started bake-on-first-use UX. The live measure is `apps/cli/test/no-agent-named-exports.test.ts`, whose allowlist can only shrink.
- [`docs/agent-settings-plan.md`](./docs/agent-settings-plan.md) — **agent settings**: an agent declares its own settings on its registry row, config generates `<agent>.<key>` keys from them (built-ins *and* `agentbox agent add` packages), and every call site carries one opaque `agentSettings` map — the agent's own recipe / `postInstall` / launch env is the only thing that knows what a setting means. `box.claudeInstall`/`box.claudeTui` are now `claude.install`/`claude.tui`.
- [`docs/host-tools.md`](./docs/host-tools.md) — the box→host CLI proxy: how any host CLI (`gh`, `terraform`, `aws`, `ntn`, `linear`) reaches a box through one generic shim, the request-vs-grant trust split, and the built-in credential deny list.
- [`docs/provider-plugins.md`](./docs/provider-plugins.md) — external / community providers on the published `@madarco/agentbox-provider-sdk`, the `agentbox plugin add` registry, and the SDK-version gate.
- [`docs/development.md`](./docs/development.md) — build + verify commands, manual end-to-end runs, the image-rebuild checklist, assumed host environment, and the release + nightly-cut flows.
- [`docs/nightly-channel-plan.md`](./docs/nightly-channel-plan.md) — the nightly release channel: how `stable` vs `nightly` resolves, the version scheme, and the silent-failure gotchas (publishing without `--tag nightly` moves `latest`).
- [`docs/test-plan.md`](./docs/test-plan.md) — the provider regression checklist: exact command, machine-checkable signal, and what each check really proves.
- [`docs/hub-testing.md`](./docs/hub-testing.md) — **how to exercise anything hub- or control-box-shaped**, cheapest first: flip your own host with `agentbox hub expose` (seconds, free — with `--tunnel cloudflare` real cloud boxes reach it, so the whole remote-hub story needs no VPS); the same inside a box, plus building the actual VPS image; a real Hetzner deploy (`--ref`/`--package`/`--domain`, `hub update`, `hub destroy`); and the always-on clean-PC VM. Read its "gotchas" section before debugging a change that "isn't taking" — it is usually the stale staged hub bundle.
