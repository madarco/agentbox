# Changelog

All notable changes to `@madarco/agentbox` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are generated from the commit history with `/release-notes` and then
hand-reviewed — they describe what changed for someone using the `agentbox`
CLI, not the raw commits.

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
