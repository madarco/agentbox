# Changelog

All notable changes to `@madarco/agentbox` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are generated from the commit history with `/release-notes` and then
hand-reviewed — they describe what changed for someone using the `agentbox`
CLI, not the raw commits.

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
