# Changelog

All notable changes to `@madarco/agentbox` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are generated from the commit history with `/release-notes` and then
hand-reviewed — they describe what changed for someone using the `agentbox`
CLI, not the raw commits.

## [0.19.0] - 2026-06-23

### Added

- **Codex in boxes now sees your full setup.** Running `agentbox codex` syncs
  your complete skill set (from `~/.agents/skills`, the cross-agent skills dir,
  not just the handful of runtime skills), sanitizes the box's `config.toml`
  (strips host-only MCP servers, `notify`, and macOS-desktop marketplaces that
  can't resolve in a Linux box), and pre-trusts `/workspace` so Codex no longer
  pops a "trust this folder?" prompt on attach. Skills that were symlinks on the
  host are materialized as real dirs in the box.
- **`agentbox fork` autodetects the agent and session.** A bare `agentbox fork`
  now works from inside either Claude Code or Codex — it detects which agent
  launched it (and which session to resume) from the environment. You can also
  pass the provider positionally (`agentbox fork hetzner`). Explicit `--agent`
  still wins.
- **`/agentbox` fork skill installs via the `skills` CLI.** `agentbox install`
  now registers the `/agentbox` fork skill through `npx skills add`, so it shows
  up on the skills.sh directory; it falls back to a plain copy offline.
- **Cloud boxes no longer die mid-work.** A new host-relay keepalive renews a
  cloud box's session timeout while its agent is actively working (Vercel and
  E2B), so a long test or build run is no longer cut off when the 45-minute
  create timeout elapses. Idle boxes still lapse as before. (Bounded by each
  plan's hard session cap.)
- **In-box Docker on Vercel.** Vercel Sandbox now supports nested containers, so
  `dockerd` is baked into the Vercel base snapshot and auto-started — `docker
  run` works inside a Vercel box. Re-run `agentbox prepare --provider vercel` to
  pick it up.
- **Checkpoint restore carries your host state on cloud boxes.** Creating a
  cloud box from a checkpoint now re-branches onto a fresh `agentbox/<box>`
  branch at your current host tip, ships the missing commits as a delta bundle,
  and replays your stash + untracked files (conflicts resolve box-wins and are
  reported back) — matching docker, instead of booting the frozen snapshot
  verbatim. Honors `--no-resync`.
- **`status --inspect` and cloud `status` list tasks/services/ports.** The
  inspect view now renders each task, service, and port (live from the in-box
  daemon when running, else the persisted snapshot) instead of just a count.
- **`{{AGENTBOX_BOX_HOST}}` resolves to the public preview host** on public-URL
  cloud boxes (Vercel/Daytona/E2B), so env-init substitution targets a reachable
  host instead of an unreachable `*.localhost`.

### Fixed

- **`agentbox fork --agent codex` resumes straight into `/workspace`.** The
  teleport now rewrites the working directory in every Codex per-turn record
  (and stops seeding Codex's host-wide session-index DBs into the box), so a
  forked Codex session no longer pops "Choose working directory" or resumes at
  the host path — and your cross-project Codex history no longer leaks into the
  box.
- **In-box `agentbox-ctl cp`/`download` with a relative host path** now resolves
  against the box's workspace, not whatever directory the long-lived relay was
  started from (files could land in an unrelated project's folder).
- **In-box docker socket** is reliably world-accessible — the dockerd start
  helper re-asserts the socket permissions even when it exits early on an
  already-running daemon, so the unprivileged box user can always reach it.

## [0.18.0] - 2026-06-18

### Added

- **Herdr integration.** Running `agentbox claude|codex|opencode` inside
  [Herdr](https://herdr.dev) now feels native: each box shows up as a normal
  agent in Herdr's sidebar with live status (working / idle), a pending
  host-relay approval (git push / PR / checkpoint) highlights the box as
  **blocked** and raises a Herdr notification, and `attach.openIn` /
  `queue.openIn` open boxes as Herdr splits, tabs, or workspaces — defaulting to
  a new **tab** under Herdr. New `attach.herdrStatus` config key (default on)
  controls the status reporting.
- **Herdr plugin** — `agentbox install herdr` (or, from Herdr,
  `herdr plugin install madarco/agentbox/herdr-plugin`) installs a plugin that
  adds a **boxes overlay** (`prefix a`), a **new box** shortcut
  (`prefix shift a`), and **Ctrl+click** a box to open its web app.
- **Paste screenshots into a box under Herdr.** Pressing **Ctrl+V** with an
  image on the clipboard while attached to a box's Claude now ships the image
  into the box and attaches it (`[Image #1]`) — works on docker and cloud boxes.
- **GitHub star prompt** — a one-time nudge to star the project, shown after
  `agentbox install` / `agentbox update`.

## [0.17.1] - 2026-06-17

### Fixed

- **The CLI no longer crashes on startup with `ERR_REQUIRE_ESM` on Node
  20.10–20.18.** Every `agentbox` command (not just the `e2b` ones) failed to
  start on Node versions before 20.19, because the bundled E2B SDK loaded an
  ESM-only build of `chalk` that older Node can't `require()`. E2B's `chalk` is
  now pinned to a CommonJS build, so the CLI loads on every supported Node
  (>=20.10).
- **`agentbox vercel login` (Sign in with Vercel) no longer dead-ends after a
  successful sign-in.** Recent Vercel sandbox CLIs stopped writing the team id
  to their config, so the login harvest reported "no credentials were found in
  the Vercel CLI store" even though a valid token was present. Login now
  resolves the team from `VERCEL_TEAM_ID`, the CLI config, or your account's
  default team.

## [0.17.0] - 2026-06-15

### Added

- **`agentbox attach [box]`** — one agent-agnostic command to reattach to a
  box's running agent, regardless of whether it's Claude Code, Codex, or
  OpenCode. It probes the box for the live agent session and reattaches; with
  more than one session it prompts you to pick (or, when non-interactive, takes
  the most recently started). Unlike the per-agent `claude/codex/opencode
  attach`, it **never auto-starts** an agent — if nothing is running it prints
  `no agent session running in <name>` and exits non-zero. Works across docker
  and all cloud providers.

### Fixed

- **Ctrl+C at an interactive prompt now quits instead of silently answering
  "No".** Previously, pressing Ctrl+C at a confirm/select prompt (e.g. `agentbox
  claude`'s "Sign in with your Claude subscription?") was treated the same as a
  negative answer and the command proceeded. Cancelling now exits cleanly.

## [0.16.0] - 2026-06-07

### Added

- **Notion integration.** A box can now call Notion through the host's
  authenticated `ntn` CLI without the Notion token ever entering the box. The
  in-box `ntn`/`notion` shim proxies to the host relay: reads pass straight
  through, writes (`pages create`/`pages update`) prompt for host approval.
  `ntn api` is read-only — GET to any endpoint plus the read-only POSTs
  `v1/search`, `v1/databases/<id>/query`, and `v1/data_sources/<id>/query`
  (full JSON bodies via `-d '<json>'`); every other method/endpoint is refused.
  Off by default; enable per project with
  `agentbox config set --project integrations.notion.enabled true`. Shows up in
  `agentbox doctor`.
- **Linear integration.** Same model for `@schpet/linear-cli`: read issues,
  teams, and filtered queries plus a GraphQL **query** passthrough
  (`linear api`); `mutation`/`subscription` are refused. `issue create`/
  `update`/`comment add` prompt for host approval; `auth token` is hard-rejected
  so the key stays on the host. Enable with `integrations.linear.enabled`.
- **`run_once:` tasks** in `agentbox.yaml` (renamed from `idempotent:`): a task
  that runs only on a cold box and is skipped on warm boots, tracked by a
  durable marker.
- **`agentbox.yaml` replacement engine** with an `{{AGENTBOX_AUTO_SECRET}}`
  generator (stable per-project secret) and a new `agentbox render` command to
  preview the resolved file. Replacements also apply to `carry:` targets.
- **Docker `image:` services.** Sidecar containers declared under `image:` now
  take their `ports`/`env` nested under `image:` as well, keeping all
  image-level config in one place.
- **Codex plugin marketplace.** AgentBox installs as a Codex plugin straight
  from the repo (`codex plugin marketplace add madarco/agentbox`).

### Fixed

- `carry:` and `agentbox cp` copy files via `docker exec tar` instead of
  `docker cp`, fixing "read/write on closed pipe" failures into the
  bind-mounted workspace and relative-path targets (e.g. `./backups/...`).
- `agentbox doctor` integration probes are time-bounded and stdin-isolated, so
  doctor no longer hangs when a connector's auth check blocks; a timed-out
  probe now reports a timeout rather than "not logged in".

### Security

- The Notion `ntn api` gate is fail-closed: it refuses any unrecognized flag
  rather than ignoring it, closing a bypass where ntn's value-consuming global
  flags (`--workers-config-file`, `--env`) could shift the real request
  endpoint past the read classification. Host-file (`--file`/`--input`) bodies
  and `.`/`..` path segments are refused.

## [0.15.0] - 2026-06-05

### Breaking

- Carry and `cp` now share a single size cap. The `AGENTBOX_CARRY_MAX_BYTES`
  env var is removed; both the `carry:` step and `agentbox cp` are governed by
  the `box.cpMaxBytes` config key (default 100 MiB, up from carry's old 50 MiB).
  Scripts that set `AGENTBOX_CARRY_MAX_BYTES` no longer have any effect — set
  `box.cpMaxBytes` instead.

### Added

- `queue.openIn` config key: when a background `-i` job's box becomes ready,
  optionally open an attached terminal onto it — `split`, `window`, or `tab`
  (default `none`, the previous behavior). Fires only when you submit from
  inside tmux, cmux, or iTerm2.
- `agentbox cp` (and the `carry:` copy step) now stream the tar instead of
  buffering it, so copies are no longer capped by Node's buffer limit (large
  folders that silently failed with "tar: Write error" now work). Added a
  repeatable `--exclude=<glob|name>` and `--no-default-excludes`; heavy
  regenerable dirs (`.git`, `node_modules`, `dist`, `.next`, `target`, …) are
  excluded by default. Copies larger than `box.cpMaxBytes` are blocked with a
  du-style tree of the biggest folders and a suggested strategy unless `--yes`.
- `agentbox agent approvals` / `agentbox agent approve`: inspect and answer
  relay host-action confirmations (git push, `cp`, `gh` PR writes, checkpoint)
  from a host orchestrator, instead of hand-curling the loopback endpoint.
  Prompt ids are content-derived, so a prompt that changed since you listed it
  is refused rather than mis-answered. Adds an opt-in per-box
  `box.autoApproveHostActions` (default off, audited) for unattended runs.
- The attach footer's `(...)` slot now shows aggregate box service status —
  `starting N/M…` while services boot, `service error` on a crash/failed task,
  `ready` once all are up (probe-aware: a `ready_when` service counts as up only
  once its probe passes, so the footer no longer flashes `ready` early). Boxes
  with no services fall back to the agent activity label.

### Changed

- `queue.openIn` under cmux: `split` and `tab` queued jobs now open in the
  workspace you submitted from (split targets the original pane, falling back to
  the parent workspace) instead of always spawning a new top-level workspace.
  `window` still opens a separate workspace.
- `agentbox config set queue.openIn` now warns that the feature only fires
  inside tmux/cmux/iTerm2, and that cmux additionally needs `socketControlMode`
  set to `automation`/`password` plus `cmux reload-config`.

### Fixed

- The `carry:` block is now documented in the published `agentbox.yaml` JSON
  schema, so editors and in-box agents that fetch the schema no longer see it as
  invalid or undiscoverable.
- The stale default-checkpoint recreate prompt now fires for already-configured
  projects too (it was skipped for them, silently booting old base layers), and
  on recreate it reuses the existing `agentbox.yaml` instead of telling the agent
  to regenerate a config that already exists.
- `agentbox cp` now enforces `box.cpMaxBytes` on single-file uploads, not just
  directories.
- A supervisor screen-scrape safety net flips a stuck Claude `working` state to
  `waiting` when its hooks miss a prompt (MCP dialogs, dropped notifications), so
  `agent wait-for input-needed` reliably wakes.

## [0.14.0] - 2026-06-04

### Added

- E2B as a fifth provider (`--provider e2b`): a Firecracker microVM per box with
  public HTTPS preview URLs and free pause/resume. Unlike the other clouds, E2B
  builds its base image directly from a Dockerfile — `agentbox prepare --provider
  e2b` drives the build. Full lifecycle is supported: `agentbox e2b login`,
  create, attach (`shell` / `claude` / `codex` / `opencode`), checkpoints, VNC,
  and `agentbox prune --provider e2b`.
- `agentbox agent wait-for input-needed` — a single state that fires whenever the
  agent needs you: the turn finished and the prompt is ready, or it's blocked on a
  question, plan approval, permission prompt, or error. Replaces racing separate
  `wait-for` calls that each hang to timeout, and prints the concrete state it
  matched so callers can branch on why it woke.
- Cloud `<provider> login` now nudges you to run `agentbox prepare` when no base
  has been baked, and `create` detects a stale cloud base (by content checksum)
  and folds a rebuild prompt into the existing recreate wizard. Non-interactive
  runs (`-y` / no TTY) warn and boot on the existing base rather than auto-baking.

### Changed

- Cloud provider docs lead with how to use each provider, and the recommended
  setup is the one-flow `agentbox install` wizard (login + base bake in one step).
- `create` / `claude` / `codex` / `opencode` no longer print the `log: <path>`
  startup line; logs are still written and `~/.agentbox/logs/latest.log` still
  tracks the latest run.
- Cloud attach shows a "starting <agent>" banner so a freshly attached cold cloud
  box is never blank during cold-start, and credential seeding no longer corrupts
  the create spinner.

### Fixed

- Parallel boxes are now reliable: `~/.agentbox/state.json` is written atomically
  under a cross-process lock, so concurrent `create` / `destroy` (the `-i` use
  case) no longer lose records, wedge the queue counter, or leave boxes missing
  from `agentbox list`. Concurrent creates get distinct project indices, and a
  box is recorded as soon as its container starts so a mid-create failure is still
  resolvable by `destroy` / `prune`.
- A box created from a checkpoint now gets a fresh per-box git branch and worktree
  — previously all boxes from one checkpoint shared a branch and their `.git`
  broke once the source box was destroyed (no diff, commit, or `/review`).
- `agentbox shell <box> -- <argv>` passes the post-`--` arguments verbatim instead
  of re-parsing them through `bash -c`, fixing corrupted redirects and quoting
  (e.g. `curl -w '%{http_code}'`). One-shot `shell -- cmd` against a cloud box no
  longer hangs.
- Docker-based services in `agentbox.yaml` no longer race a not-yet-ready docker
  socket: dockerd is launched and awaited before the in-box supervisor on every
  create/restart across all DinD providers.
- Cloud boxes are seeded with working agent credentials and onboarding state, so a
  fresh box lands at a ready prompt instead of a 401, a bypass-permissions accept
  screen, or the first-run theme picker. Credential seeding is best-effort and
  refreshes from the host before each create.
- A working box is no longer auto-paused (autopause now considers codex/opencode,
  not just claude), and `agentbox drive` auto-unpauses a paused box before
  attaching.
- Chromium is resolved lazily and shared with the project's own Playwright build,
  fixing browser launches that hung waiting on a stale baked-in binary; the base
  image is also smaller.
- Resync only flags an untracked-file conflict when the box and host content
  actually differ, so byte-identical files no longer needlessly skip
  `agentbox.yaml` services.
- A missing cloud base (skipped `agentbox prepare`) now reports a one-line
  actionable error instead of a full stack trace.

## [0.13.0] - 2026-06-02

### Added

- cmux terminal integration. `--attach-in` / `attach.openIn` now place the
  attached session in cmux (`split` -> new-split, `tab` -> a surface in the
  current workspace, `window` -> a separate workspace), alongside the existing
  tmux and iTerm2 support.
- While attached inside cmux, a box's live agent status is reflected on its
  workspace colour and description (blue working, amber needs-input, cleared on
  idle), restored on detach. When several boxes share a workspace as tabs, the
  one needing input is flagged with a cmux notification. Gated by
  `attach.cmuxStatus` (default on); no-op outside cmux.
- `Ctrl+a t` in any attach session opens a fresh shell in the same box in a new
  tab (cmux surface / tmux window / iTerm2 tab).
- `Ctrl+a k` destroys the current box after a `y/N` confirmation, in both the
  attach footer and the dashboard.
- `agentbox install cmux` pins a live box list to cmux's right-sidebar Dock
  (`--dry-run` / `--force` / `--height` / `--title`); the panel groups boxes by
  project. `agentbox list --cmux` renders the same compact, sidebar-tuned view
  directly. (cmux's Dock is a beta feature — enable it under Settings -> Beta
  features -> Dock.)
- A full documentation site at [agent-box.sh/docs](https://agent-box.sh/docs),
  including a new Integrations section for iTerm2, tmux, and cmux.

### Changed

- The dashboard's destroy chord moved from `Ctrl+a d` to `Ctrl+a k`, so `k`
  means "kill" in both the dashboard and an attach session and never collides
  with detach. Box switching stays on `Control+Option+arrows`.

## [0.12.0] - 2026-06-01

### Breaking

- `agentbox fork` replaced the opt-in `--carry-yes` flag with an opt-out
  `--carry <mode>`. Fork now copies the declared `carry:` files into the box
  by default; pass `--carry skip` to opt out. Scripts passing `--carry-yes`
  to `fork` must drop it.

### Added

- On agent-session start (`claude` / `codex` / `opencode`, including `-i`) and
  on create-from-checkpoint, the box now resyncs with the host workspace:
  it merges the host's current branch and overlays uncommitted + untracked
  changes (box wins conflicts, skipped paths surfaced to the agent). Gated by
  `box.resyncOnStart` (default on) / `--no-resync`. Docker only for now.
- `agentbox checkpoints -g` / `--global` lists checkpoints across every
  project, grouped and labeled by project root (mirrors `agentbox list -g`).
- Expanded the relay `gh` proxy: `gh pr diff` / `gh pr checks`,
  `gh run list` / `view` / `rerun`, allowlisted read-only `gh api` (GET), and
  posting PR review comments via `gh api` POST without a prompt.
- `agentbox fork --plan <path>` carries a Claude Code plan into the box and
  launches `claude` in plan mode, resuming from the plan.
- `agentbox create --size` plus `box.size` config with per-provider overrides
  (`box.sizeDaytona` / `box.sizeHetzner`, etc.). Hetzner reads it as a
  `server_type`; Daytona parses `cpu-memory-disk` GB.
- Per-provider `box.image` keys (`box.imageDocker` / `box.imageDaytona` /
  `box.imageHetzner` / `box.imageVercel`) so a `prepare` on one provider no
  longer overwrites another's base image.
- Boxes are now seeded with your `~/.claude/workflows/` and the project's
  `memory/` at create, refreshed incrementally per-box rather than baked into
  the snapshot. Works on docker, daytona, hetzner, and vercel.
- `-i` queued background runs now honor the `carry:` block (previously dropped).

### Changed

- `agentbox install` (and `pnpm register`) now symlink the host skills when run
  from a source checkout, so edits to the bundled skills are picked up live; an
  installed package still copies.
- Folded the orphan `git`, `vercel`, and `doctor` commands into the Advanced
  group in `agentbox --help`.

### Fixed

- The setup wizard no longer silently boots from a stale default checkpoint. A
  default snapshot captured against a since-rebuilt base (or a dead
  image/snapshot) is now detected: interactive runs re-prompt (recreate vs use
  anyway), and `-y`/non-interactive runs discard it and provision from the
  current base. Explicit `--snapshot` is still honored as-is.
- Cloud boxes (vercel / hetzner / daytona) now get a git committer identity at
  create, mirroring the host repo's, so the agent's commits and
  `agentbox git pull` merge commits no longer fail with "Committer identity
  unknown".
- `agentbox prepare` now always migrates a stale generic `box.image` left by an
  older version, not just when it writes a new snapshot.
- A host skill symlinked outside the box-mounted trees (common in dev checkouts)
  no longer aborts the whole `~/.claude` sync.
- A single corrupt project config no longer aborts `agentbox checkpoints -g`.

## [0.11.3] - 2026-05-31

### Changed

- `agentbox self-update` now refreshes the host skill files in `~/.claude`
  (and the Codex / OpenCode copies) as part of the update, so an updated CLI
  no longer keeps serving stale skill content until you separately ran
  `agentbox install --skills-only`. Pass `--skip-skills` to opt out.

### Fixed

- The `agentbox` host reference skill was out of date — it omitted the Vercel
  provider, still described `-i` background runs as docker-only, and was
  missing the PR-through-relay (`agentbox-ctl git pr`) and HTTPS-origin push
  notes. It now reflects the current feature set.

## [0.11.2] - 2026-05-31

### Added

- The `-i` / `--initial-prompt` background queue now works on the cloud
  providers (Daytona, Hetzner, Vercel), not just docker. Queued cloud jobs
  create the box and pre-start a prompt-seeded detached session, with any
  post-`--` args (e.g. `--permission-mode=plan`) forwarded through.

## [0.11.1] - 2026-05-31

### Fixed

- Queue runner no longer starts boxes past `--max-running`. Just-started jobs
  whose box was still provisioning weren't counted by the running-box gate, so
  during that window (≈25s on cloud, an image pull on docker) the per-tick
  scheduler could re-fill the same slot and run over the cap. In-flight jobs are
  now counted toward the limit.

## [0.11.0] - 2026-05-31

### Added

- Linux host support: `agentbox doctor` now reports accurate checks on Linux
  (warns on unsupported OS, distinguishes a stopped Docker daemon from the user
  not being in the `docker` group), and all host URL/file opens — cloud login
  dashboards, `agentbox url` / `screen` / `code` / `open`, the dashboard's
  VNC/web/code launchers, and box-initiated "open link on host" — go through
  `xdg-open` on Linux instead of macOS-only `open`. Attaching in a new terminal
  works on Linux when running inside tmux.
- A single recap card is now shown when you launch an agent
  (`agentbox claude` / `codex` / `opencode`) on any provider: one bordered card
  with the box name (and source checkpoint), project folder, the from→to branch
  mapping, and the detach/reattach hint — replacing the scattered status rows.

### Changed

- The `# yaml-language-server: $schema` hints in `agentbox.yaml` and the
  user-config schema now point at `agent-box.sh/schema` (the previous
  `agentbox.dev` domain was never owned).

### Fixed

- Box ids are now prefixed with `b` so they are never all-digits. Previously
  ~2.3% of generated ids came out as decimal-only (e.g. `26524695`) and were
  unresolvable, since a bare integer is treated as a per-project index — which
  broke any command that targets a box by id.
- Vercel: Ctrl+V clipboard-image paste now works. The box bake now builds xclip
  from source (it isn't in the AL2023 repos), and the host-side input router
  intercepts the enhanced-keyboard (kitty / modifyOtherKeys) encoding of Ctrl+V,
  not just the raw byte. Vercel boxes need a re-run of
  `agentbox prepare --provider vercel`.

## [0.10.1] - 2026-05-30

### Changed

- First-time setup is now a `docker pull` instead of a local image build. The
  box image is fetched prebuilt (multi-arch) from GitHub Container Registry on
  first use — including for the cloud providers, which need it for the local
  agent-login step — cutting first install from a ~10-15 min build to a
  download. If the registry is unreachable or you've customized the build
  context, it falls back to building locally as before. Use `--build` on
  `agentbox create` / `agentbox prepare`, or set `box.imageRegistry` to empty,
  to always build locally.

## [0.10.0] - 2026-05-30

### Breaking

- `agentbox browser` is renamed to `agentbox url` (it opens the box's web-app
  URL). No alias is kept.
- `agentbox list --all` / `-a` is renamed to `--global` / `-g`, matching the
  npm/pnpm convention. The old form is removed with no alias — update any
  scripts that used it.

### Added

- `agentbox install` is now an interactive setup wizard (system compatibility
  check, provider picker, login/prepare hints, host `/agentbox` skill install)
  and a new `agentbox doctor` reports the same checks in full detail. The wizard
  auto-runs once on first use; `--skills-only` keeps the old host-skill-only
  behavior.
- Portless integration on Docker Desktop: boxes can get a stable
  `https://<box-name>.localhost` URL for their web app via the
  [Portless](https://portless.sh) proxy. Opt-in on first run (saved to the new
  `portless.enabled` config key; `--portless` / `--no-portless` flags). The same
  URL works from the host and from inside the box's VNC browser.
- Cloud boxes now offer to sign you in before the box starts when agent
  credentials are missing or expired, seeding the login into this box and every
  future one (Claude, Codex, OpenCode).
- Attach now survives a box reboot: the wrapper stays open and auto-reconnects
  once the box is back, so a Vercel checkpoint or restart no longer drops your
  session.
- `agentbox url` and `agentbox screen` reach an in-box web service on Vercel —
  the in-box proxy binds to the always-exposed port 8080, and `url` falls back to
  the first exposed service port when no proxy is configured.
- `agentbox list --live` forces a real state probe of cloud boxes; by default
  `list` now reads persisted box state, so it's fast even with several boxes.
- A 3-line alert band above the footer surfaces relay confirm prompts,
  checkpoint notices, and the agent's questions without hiding the status bar —
  in both the single-attach TUI and the dashboard.
- Agents skip their interactive permission prompts by default inside boxes
  (boxes are already isolated). Controlled by `claude.dangerouslySkipPermissions`
  / `codex.dangerouslySkipPermissions` (both default on); override per-box with
  `--no-dangerously-skip-permissions`.

### Changed

- `Ctrl+a` leader chords are now mnemonic and consistent across the agent/shell
  footers and the dashboard: `s` opens the noVNC screen, `u` opens the web-app
  URL, `d` detaches. The dashboard keeps `Ctrl+a q` to quit and moves "stop the
  box" to `Ctrl+a t`.
- A Vercel checkpoint reboots the box, so it now asks for confirmation first
  (skip with `-y`).
- Chromium is baked into the Vercel base snapshot at `prepare` time, so
  agent-browser is ready immediately on every box instead of installing on each
  create.
- The host relay is now a version-consistent global singleton shared by all
  boxes, robust to mismatched `npx` caches.
- Faster dashboard switching on the Vercel provider; install-wizard copy and
  progress animation polished.

### Fixed

- The cloud login offer runs in the default docker image instead of a cloud
  snapshot ref, fixing a `docker build` failure on `snap_…` image names.
- `agentbox list` shows the real state of cloud boxes (stopped/paused) instead
  of always reporting `running`.
- Resuming a cloud box re-ensures its daemons and declared services, and a
  stopped cloud box is resumed before attach instead of failing.
- Hetzner box creation waits for SSH to be ready before returning, so the next
  command no longer races a not-yet-reachable VPS.
- The published npm package now includes the repo README.
- `Ctrl+c` during the startup banner animation exits cleanly.
- Skip-permissions conflict detection now also matches inline `--flag=value`
  syntax, so an explicit user choice always wins; background-queue jobs honor
  `--no-dangerously-skip-permissions`.
- The footer spinner keeps animating when the alert band collapses on a tiny
  terminal.

## [0.9.0] - 2026-05-29

First release with a tracked changelog. Earlier history lives in the git log.
