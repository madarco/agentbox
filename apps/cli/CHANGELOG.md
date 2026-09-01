# Changelog

All notable changes to `@madarco/agentbox` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are generated from the commit history with `/release-notes` and then
hand-reviewed — they describe what changed for someone using the `agentbox`
CLI, not the raw commits.

## [Unreleased]

### Added

- **The VNC desktop has a window manager and an icon dock.** JWM now runs on
  display `:1` with a bottom dock carrying a Terminal button, a Browser button,
  and one icon per open window, so windows can finally be raised, moved and
  switched. Always on with VNC; rebuild the image or re-`prepare` to get it.
- **The desktop dock blends into the wallpaper.** It paints the wallpaper's own
  paper colour instead of a dark strip, so it reads as free-floating icons.
- **Starting a browser shows its progress on the desktop.** A launch now opens a
  progress window (and a dock entry) that closes itself when the browser is up,
  instead of leaving an empty desktop while the first launch fetches Chromium.

### Fixed

- **A comment could hang the whole VNC desktop.** The generated `~/.jwmrc` is
  written from an unquoted heredoc, so backticks in its comments ran as
  commands; a blocking one left the box with no window manager and no noVNC.

- **`agentbox git pull` works again.** It merged an unconditional `origin/HEAD`,
  a ref `git clone` writes and a bind-mounted worktree therefore never has, so
  every pull ended in `merge: origin/HEAD - not something we can merge`. It now
  merges the branch's upstream, else its remote-tracking ref — which is also the
  right branch, where `origin/HEAD` would have pulled the remote's default one.
- **Adding an agent to a live cloud box no longer fails on Daytona.** An agent's
  post-install claimed ownership of `~/.agentbox-creds`, which at runtime is the
  mounted credentials volume — virtiofs on Daytona, where `chown` fails even for
  root. It now creates its subdir without asserting ownership.
- **Codex boxes no longer receive your host's Codex databases.** Codex writes six
  SQLite databases under `~/.codex`; the exclude list named two families, so
  `goals_*`, `memories_*` and `queue_*` — nine files with their `-wal`/`-shm` —
  were copied live into every box, carrying cross-project thread goals and
  extracted memories. Every agent's push now denies live database files
  generically rather than by name.
- Each agent's excludes were maintained in two places that had drifted: codex
  boxes were also getting host-identity files (`installation_id`, `version.json`)
  and opencode boxes a `snapshot/` dir, none of which the cloud path shipped.
  Both transports now render one list.
- `agentbox download <agent>` preserves `auth.json`'s `0600` on docker boxes; the
  docker path used a `cp -a` that dropped it.
- Credential fan-out ordering is per-agent data instead of Claude's OAuth JSON
  hardcoded behind generic-looking names, so an agent with its own expiry field
  is no longer silently downgraded to last-writer-wins.
- Config volumes, cleanup and `agentbox prune` handle an agent outside the
  built-in three; they previously fell back to OpenCode's volume, and
  `box.isolate<Agent>Config` now works for every agent rather than three.

### Changed

- **`box.claudeInstall` and `box.claudeTui` are now `claude.install` and
  `claude.tui`.** An agent declares its own settings, and AgentBox generates a
  config key per declaration — for agents installed with `agentbox agent add`
  too. `agentbox prepare --claude-install <mode>` becomes
  `--agent-setting claude.install=npm` (repeatable, works for any agent). The old
  keys are refused with a message naming the new one.
- **One box image per build context.** The published base is agentless, so an
  agent setting no longer forks it: CI published two byte-identical images before
  this, and Daytona's `linux-vm` path could not boot an npm-mode base at all.
  **Re-run `agentbox prepare --provider <name> --force` once per cloud provider.**

### Fixed

- An agent's install `postInstall` could not read its own settings on a cloud
  provider: the root-escalation wrapper expanded them on the host shell before
  `sudo` ran, so they arrived empty everywhere except docker.

### Removed

- Provider SDK 4.0.0 (`SDK_API_VERSION` 4, a clean break):
  `PrepareOptions.claudeInstall` is replaced by `agentSettings`,
  `resolveAgentInstall` takes an agent's settings, `Provider.baseFingerprint`
  takes no arguments, and `claudeInstallFingerprint` is gone. New:
  `renderAgentSettingEnv`, `bakeSettingsFingerprintInput`, `agentSettings` /
  `allAgentSettings` / `agentSettingsFor`.

## [0.29.2] - 2026-08-30

### Added

- Provider SDK 2.10.0: `CloudBackend.attachRunAs?(handle)` lets a provider drop
  its attach session to the box user when the transport lands as root. Optional
  and additive — existing plugins are unaffected.

### Fixed

- **Daytona `linux-vm` boxes ran as `root`**, so the agent never saw the
  credentials seeded into `/home/vscode` and started at a login prompt on a box
  that reported healthy. Boxes now run as `vscode` throughout — exec, attach,
  tmux and the in-box daemons. **Re-bake with `agentbox prepare --provider
  daytona --force`, and destroy and recreate existing `linux-vm` boxes.**
- Daytona now explains when your organization has no VM region — a *dedicated*
  region that Daytona must enable, which neither a new org nor added credit
  grants — instead of failing the bake with a raw SDK stack trace. The docs page
  leads with the requirement.
- A failed `agentbox prepare` now reports why it failed, instead of only
  `bake job <id> ended failed` with the real cause left in the job log.
- `agentbox self-update` could skip a menu-bar app update for up to 24 hours by
  answering from the daily check's cache; it now re-resolves the release.

## [0.29.1] - 2026-08-30

### Fixed

- **A clean install could dead-end on the hub token.** Deleting `~/.agentbox`
  while the hub daemon kept running left it serving a token that no longer
  existed on disk, so every `agentbox prepare` — and the install wizard's bake —
  failed with `The local hub reports no API token`. The advice it printed was a
  dead end: `agentbox hub` is a no-op against a live daemon and never rewrites
  the file. The hub is now restarted to re-mint the token.
- **Attach silently lost its footer and permission prompts** when the optional
  native pty backend (`@homebridge/node-pty-prebuilt-multiarch`) wasn't
  installed — npm swallows an optional dependency that fails to install, so
  `npm i -g @madarco/agentbox` can succeed without it. The notice now names the
  missing package, points at the usual cause (`agentbox` installed under a
  different Node than the one on `PATH`), and is repeated after the session
  exits instead of being painted over by the agent's full-screen TUI.
- A provider plugin that declares no `descriptor` now gets a capitalised display
  label, so the create picker and the tray no longer show two spellings of the
  same provider. Plugins registered before this keep their old label until
  `agentbox plugin add` re-registers them.

## [0.29.0] - 2026-08-28

### Added

- **Host tools — any CLI on your machine, usable from a box.** `agentbox tools
  add <name>` grants a box the right to run one of your host commands
  (`terraform`, `aws`, `linear`, …) through the relay, so it uses your
  credentials without ever receiving them. Grants live host-side; an
  `agentbox.yaml` `tools:` block only *requests* one and raises a single
  approval at create time, and a box can ask for a new tool at runtime
  (`tools.request.enabled`). A built-in credential deny list — token printers,
  `sts get-session-token`, keyring reads — refuses ahead of your own allow
  rules. `agentbox doctor` grows a `tools` section. See
  https://agent-box.sh/docs/host-tools.
- **The whole `gh` CLI now works from a box** (#304). It was a curated
  allowlist, so "implement GitHub issue `<link>`" died at `gh issue: not
  proxied`. One forwarder now carries the entire CLI, with policy instead of a
  list: credential and shell-escape commands (`auth token|login`, `config set`,
  `alias set`, `extension install`, `key add`) are refused outright, destructive
  ones (`repo delete/archive/rename`, `release delete`, `secret set/delete`,
  `gh api -X DELETE|PUT|PATCH`, GraphQL mutations) always confirm even under
  `autoApproveSafeHostActions`, and everything else is allow-once.
  `tools.gh.enabled` revokes the built-in grant.
- Community providers now appear in the create pickers (web UI and tray) and get
  a real credential form, from a new `ProviderDescriptor` a plugin declares and
  `agentbox plugin add` snapshots. Existing plugins keep working unchanged —
  declaring one is optional.
- `agentbox code`, `open`, `prune`, `checkpoint set-default` and `fork` now gate
  on a provider's declared capabilities instead of hardcoded name lists, so a
  plugin that supports them gets them. DigitalOcean gains `code`/`open` this way.

### Changed

- Provider SDK 2.9.0 adds `ProviderModule.descriptor`,
  `ProviderModule.sizeIgnoredReason` and `CloudBackend.stageFilesAsRoot`, and
  ships `agentbox-tool-shim` in place of the per-CLI `ntn`/`linear` shims.
  Additive (`SDK_API_VERSION` stays 2), but a plugin whose provision script
  installs `/tmp/agentbox-ntn-shim` must switch to `/tmp/agentbox-tool-shim`.

### Removed

- The bespoke Notion and Linear connectors, along with
  `integrations.notion.enabled` / `integrations.linear.enabled`. Both are
  ordinary host tools now — `agentbox tools add ntn` does what the connector
  did, for any CLI.

### Fixed

- **Claude Code stopped claiming your login expired when it hadn't.** The check
  read the ~8h access token rather than the ~30-day refresh token, so a healthy
  login looked dead within a day of every sign-in — and accepting the prompt
  rotated the shared token before you reached the browser, so cancelling left
  every copy of that login holding a spent one. A lapsed access token is now
  renewed silently, credential syncs are newest-wins in both directions, and a
  rotation is re-sent until the relay confirms it instead of being lost to a
  restart.
- Claude Code now runs with its classic renderer inside a box. Its fullscreen
  renderer leaves stale characters in the blank areas of the screen over a
  network transport — visible while scrolling, and cleared only by resizing the
  terminal. `box.claudeTui` (`default` / `fullscreen` / `auto`) switches it back.
- Attached sessions no longer print escape-sequence debris into the content
  area (#260). The status footer was repainted after every stream chunk, so it
  spliced itself into whatever sequence the transport had cut in half. Worst on
  finely-chunked providers, where a screen could be left unreadable.
- Host tools now run on the machine that granted them. With a remote hub they
  executed on the control box, against a project directory that no longer
  existed — so a box saw neither your grants nor your binaries. `agentbox tools
  add/rm` also tells running boxes immediately (and says which ones took it)
  instead of each box asking once a minute.
- `cp` between a box and your files now works with a remote hub. A control box
  holds no checkout of your project, so it brokers the copy back to your machine
  — which gates and runs it — instead of failing on a workspace that isn't
  there. With your machine offline, a read is served from a cache the hub keeps
  (approved separately, and labelled with its age) and a write is parked for
  your machine to land on its next connect. `agentbox cp <file> hub:` pre-loads
  a file so a box can read it with your machine off; `relay.hostReachTimeoutMs`
  tunes how long the hub waits before falling back.
- `gh` from a box now targets the repo's own GitHub host (#242), so GitHub
  Enterprise repos work and one stale `github.com` token no longer makes every
  `gh` call look unauthenticated. `~/.ssh/config` host aliases in the remote are
  expanded the way git and gh expand them.
- `agentbox <group> <typo>` no longer silently runs the group's default (#259):
  `agentbox hetzner ssh` ran `hetzner login`, turning a typo into a credential
  prompt. Unknown subcommands now list what the group accepts and exit 1.
- `agentbox create --provider <plugin>` failed with a 400 — creates go through
  the hub, which only knew the built-in providers. `carry:` also failed, and
  then hung the create, on any provider whose box user isn't root.
- `agentbox stop` on an E2B box now sticks; auto-resume revived it on the
  relay's own next poll. E2B boxes also pause at the platform session cap (1h on
  Hobby) instead of being destroyed by it, and a resumed box gets a fresh window
  instead of the SDK's 5-minute default. On Vercel, a reconnect no longer stacks
  a whole extra timeout window each time.
- `relay.port` now actually moves the host daemon. It was documented and
  settable but never read, so the relay always bound 8787. It governs the hub
  too — the two share the port — and 8788 is refused (boxes bind it internally).
  `agentbox doctor` names docker boxes left dialling a port the host no longer
  serves, since their host actions would otherwise just fail with a 502.
- `agentbox relay start` no longer reports success when the relay failed to
  bind. It verifies `/healthz` really is our relay, names a foreign process
  holding the port, inlines the log tail, clears the stale pidfile, and exits
  non-zero.
- A local hub no longer inherits a configured control box's identity — it picked
  up the deployed profile, served the password UI, and switched off the very
  host-action poller it was meant to enable.
- A `box.size` / `box.size<Provider>` that Daytona or E2B will ignore (both fix
  resources when the base image is baked) is now called out when you set it and
  when you queue a `-i` create, instead of only in a detached job's log where
  nobody sees it. Daytona also records the resources a snapshot actually has, so
  the warning names real numbers rather than "the default size".

## [0.28.2] - 2026-08-26

### Fixed

- The hub and the lean relay fought over port 8787 whenever the CLI's version differed
  from the running hub's — the standing state after any upgrade or publish. Each evicted
  the other in a loop, and every eviction restarted the queue loop, so background `-i`
  jobs sat at `queued`. `ensureRelay` now restarts a hub instead of replacing it with a
  relay.
- `agentbox hub status` now warns when the hub was started before the bundle it runs
  from was rebuilt — the state that produced `Cannot find module 'dist-XXXX.js'`.
- Taking port 8787 no longer leaves the other daemon's pidfile behind, so `relay status`
  and `hub status` stop reporting a dead pid as running.

## [0.28.1] - 2026-08-26

### Fixed

- The published package was 4x too big (107MB unpacked, vs 25MB for 0.27.2). Next's
  file tracer was sweeping the previous standalone build into the next one, nesting
  a copy one level deeper on every build. Back to 35MB.

## [0.28.0] - 2026-08-26

### Breaking

- **Docker boxes are gated off when a control box is configured.** A docker box
  built on your laptop can't run with the laptop closed — the whole point of a
  control box — so `create`, the agent launchers and `prepare` refuse `docker`
  there, `doctor` and the install picker drop those rows, and `ls` marks existing
  docker boxes inactive (they stay destroyable by name). New `hub.mode` config key
  (`auto` | `thin` | `local`) — set `local` to keep using docker anyway. Not gated:
  a `docker:<host>` engine the control box can run, and a control box that IS this
  machine (`hub expose`). With no control box configured, nothing changes.
- **`--dangerously-with-credentials` (`git.pushMode=direct`) is refused when a
  control box is configured.** Token leasing (`git.pushMode=auto`) already gives
  a box laptop-off push without copying a git credential into it — and into every
  snapshot of it. Unchanged without a control box.

### Added

- **Remote-docker boxes can run on your control box.** With one configured,
  `agentbox remote-docker add` now hands the engine over automatically: the
  control box gets a connection and a key of its own for it (your key never
  leaves this machine), after which creates and bakes for that host are built
  there — so the box outlives your laptop. That includes the image bake `add`
  runs: it now goes through the hub like every other bake, so a shared host is
  built by the control box instead of your laptop. `--no-share` opts out,
  `agentbox remote-docker share/unshare <alias>` do it after the fact. See
  https://agent-box.sh/docs/remote-docker.
- **`docker:hub` — your control box's own Docker.** Setting up, deploying or
  updating a control box registers its engine as the host `hub` and, when your
  default was still plain `docker`, moves `box.provider` to `docker:hub` — so plain `agentbox create`
  keeps making a docker-shaped box, on a machine that stays on. `box.provider` now
  accepts any `docker:<alias>` engine spec, stored as `box.provider` plus
  `box.remoteDockerHost`.
- `agentbox install portless` sets Portless up for good: it installs the CLI if
  missing and registers Portless's own OS startup service, so the proxy serving
  `https://<box>.localhost` is back after a reboot instead of staying down until
  you start it by hand. `--uninstall` removes the service again.
- **Deployed hub (control box).** `agentbox hub setup` (or `hub deploy hetzner |
  digitalocean`) puts a full hub — relay, web UI, and a create worker — on a VPS you
  own. Cloud boxes are then built and run **there**, so they keep going with your
  laptop closed, including background `-i` agent runs. Create them from the web
  UI, or `agentbox create --via-hub`. See https://agent-box.sh/docs/deployed-hub.
- **Base images are baked on the control box.** `agentbox prepare --provider
  <cloud>` now runs the bake there — the machine that actually builds your cloud
  boxes — streams its log, and adopts the record back. `docker:<host>` routes
  there too when the control box knows that host, since the image lands on the
  shared remote machine. `--local` bakes here instead.
- **Bake records sync both ways.** `self-update` (and `hub setup` / `update`) adopt
  a base the control box already baked for your build context instead of telling
  you to re-bake it.
- **The local hub UI mirrors the control box** for cloud providers, so
  `agentbox.localhost` stops reporting bakes nothing will boot. Docker stays local.
- **Your laptop works as a thin client of it.** `agentbox ls` and `dashboard`
  list hub-created boxes, and `attach`/`cp`/`url`/`destroy` adopt one on first
  use — no manual step. SSH keys are fetched from the hub's custody store on
  demand, and bake records are shared, so the PC and the control box stop
  re-baking the same base into two snapshots.
- **Nightly release channel.** `npm i -g @madarco/agentbox@nightly` (or
  `agentbox self-update --channel nightly`) opts into pre-release builds; the
  channel always installs the newest build of either channel, so stable releases
  still reach you automatically. `--channel stable` opts back out. New
  `update.channel` config key. See https://agent-box.sh/docs/nightly.
- `agentbox queue list` now also shows the control box's box-creation queue —
  where background `-i` cloud runs actually go when a hub is configured. New
  `agentbox hub jobs list` / `hub jobs show <id>` inspect it directly.
- `ssh agentbox-hub` opens a shell on a deployed control box — the deploy adds a
  `Host` entry for its VPS to AgentBox's managed SSH config, alongside your boxes.
- **`agentbox hub expose` turns this machine into the control box — no VPS.** Same
  deployed profile, login and create worker as a real deploy, so it is the cheapest
  way to run (or try) the remote hub. Add `--tunnel cloudflare` (or `tailscale`) and
  cloud boxes reach it from anywhere, so they register, push and run background `-i`
  jobs against your laptop. `agentbox hub unexpose` restores the plain local hub.
- **`agentbox hub deploy digitalocean`** deploys the control box to a DigitalOcean
  Droplet, alongside the Hetzner target: same docker-compose hub, HTTPS on
  `<ip>.sslip.io` via Caddy, and a firewall locked to your egress IP from the moment
  the Droplet boots.
- `agentbox hub update` moves a deployed control box to a new build in place (keeping
  its data volume) and `agentbox hub destroy` tears down the VPS, its firewall and
  this machine's control-plane state. `hub status` reports the build actually running,
  and nudges you when the CLI has drifted from it.
- `agentbox hub deploy --domain hub.example.com` serves the control box on a hostname
  you control instead of the IP-derived `sslip.io` one.
- The control box installs the published npm package by default, pinned to your CLI's
  version so shared bake fingerprints line up; `--package <spec>` picks another, and
  `--ref` still builds from source.
- **The System page now says WHY a provider base is stale.** A stale row opens to show
  the files that actually changed (`~ path  old → new`), diffed against a per-file
  manifest now recorded at bake time. A base baked before manifests existed says so and
  points at a re-bake rather than guessing.
- **The System page shows what your machine hands to a box** — agent configs, your
  skills (by name), and `~/.gitconfig` — replacing the old list of AgentBox's own baked
  files, which said nothing about your setup. Present-only, so a path missing from that
  list is one no box will receive. On a control box, where that home directory is the
  VPS's, it instead reports what a hub-created box really gets — the agent logins held in
  custody, with a link across to Custody. The **Docker** row carries the registry, the exact
  `sha-…` tag this host pulls, and the fingerprint it last stamped — the facts a "why
  didn't it use the prebuilt image?" question otherwise needs a terminal to answer.
- **Web UI: a Custody page and a System page.** Custody lists what the control box
  holds — agent logins, project seeds, bake records, box SSH keys — with sizes and
  hashes, never values. System answers "what is running here, and do I need to
  re-bake?": version, channel, build source, the deploy record, and each provider's
  bake with its fingerprint and freshness.
- A project's detail page now shows its origin URL, branch and provider plus its
  seed/custody status — whether a seed is registered, at which commit, and which
  env files it captured (names and hashes only).
- The local hub shows a banner when it is linked to a remote control box, with a link
  to it.
- **`agentbox hub setup` now finishes the job.** It pushes your agent logins to the
  control box (so a hub-created cloud box is never launched without a Claude login,
  re-pushing only when a token actually changes) and shares your local bake records.
  When a bake cannot transfer — a different build context, or a version-skewed hub —
  setup says so per provider instead of leaving you to discover it on the first create.
- **A control box no longer needs a GitHub App.** `agentbox hub setup` now reuses
  the token from your own `gh auth login`, so nothing has to be installed or
  approved on GitHub — it works on repos you only collaborate on, and in orgs
  where installing an App is an admin decision you can't make. The hub does the
  git work itself, so boxes never receive a credential at all. New `hub.gitAuth`
  key; `--git-auth app` keeps the old per-repo App tokens.

- **Every box command now runs through the hub's public `/api/v1`** — `ls`,
  `create`, the queue and jobs, `start`/`stop`/`pause`/`unpause`/`destroy`,
  `git push|pull|checkout|branch`, `services`, `rename`, `url`/`screen`,
  `checkpoint`/`prune`/`agent`/`logs`, approvals and custody. One server-side
  implementation, so each behaves identically against a local hub and a remote
  control box.
- The hub's API is documented and browsable: `/api/v1/docs` renders it and
  `/api/v1/openapi.json` serves the spec, so the menu-bar app, the web UI and
  your own scripts can drive a hub directly.
- `agentbox ls --live` now probes live box state server-side.

### Changed

- **`agentbox app` now starts the menu-bar app** instead of only reporting
  whether it is running. It is idempotent, `agentbox app status` still reports
  (`--json` moved with it), and the not-installed hint now names the command
  that exists (`agentbox install app`).
- **`agentbox hub` opens your control box when one is configured**, instead of
  starting a second, empty hub on this machine. `agentbox hub start --local`
  forces the local one; `hub stop`/`hub restart` still act on it, and an exposed
  machine (`hub expose`) is its own control box, so it still starts.
- **A create routed to the control box now shows its real progress.** The hub's
  own steps — clone, seed, the provider's create output — stream back to your
  terminal instead of a static "remote hub: running", with `-v` for the full log
  and the whole transcript kept in `~/.agentbox/logs/<command>.log`.
- `agentbox self-update` now offers to update a deployed control box as its last
  step, so your machine and the hub don't drift onto different builds. Skipped
  when the control box is already current; `--skip-hub` declines it.
- Image bakes started from the hub UI or the tray now run one **per provider**
  instead of one at a time, so several providers set themselves up in parallel
  (each remote-docker host counts as its own provider).
- **`agentbox hub setup` is quieter and checks its prerequisites.** It fails
  immediately with an install hint when `gh` is missing (it is mandatory for the
  remote hub) rather than partway through a deploy, no longer offers the GitHub App
  or Vercel paths in its prompts (`--git-auth app` / `--deploy vercel` still work if
  you ask for them), and reports a healthy deploy as one line instead of echoing a
  `/healthz` URL.
- Projects registered on a remote hub are listed by their repo name, matching the
  local hub, instead of a derived key.
- The browser pages of the GitHub App flow (the redirect and the callback) are
  styled and light/dark aware instead of bare HTML.
- The startup "agentbox was updated" prompt and `self-update`'s plan say what the
  refresh actually does (the box image is re-checked, not deleted) instead of
  offering to "download new version now?" — nothing is downloaded.
- **With a control box configured, cloud creates now go to it by default** —
  `agentbox create` and foreground `claude`/`codex`/`opencode` on a cloud
  provider. `--local` or `cloud.viaHub=false` keeps them on this machine; docker
  and remote-docker are unaffected.
- The hosted-hub commands moved from `agentbox control-plane *` into the one
  `agentbox hub *` group (`hub setup`/`deploy`/`boxes`/`approvals`/`credentials`/
  `custody`/…). `agentbox hub status` now reports the configured remote control
  box when one is set, else the local hub process.

- An interactive `agentbox create` runs in its own scheduler lane, so it starts
  immediately instead of queueing behind background `-i` jobs.
- `agentbox services` on a paused or stopped box reports the hub's last known
  snapshot instead of failing to reach the supervisor — it now agrees with
  `status`.
- `@madarco/agentbox-provider-sdk` 2.5.0: cloud provisioning gained
  `extraInboundCidrs` (extra firewall sources for a control-box-provisioned box)
  and `CloudHandle.publicHost` (so an adopting PC can rebuild an SSH target
  without a provider API call). `box.provider` now also accepts a
  `docker:<alias>` engine spec.

### Fixed

- **`agentbox agent approvals` missed the in-TUI prompts of a control-box box.**
  Plan, question and tool-permission rows were read from a status file only the
  local relay writes, so a box parked on a plan approval reported "agent not
  parked on a prompt" — and `agent approve` refused the same prompt as already
  changed. Both now read the snapshot from the hub that owns the box, and a half
  that could not be read is reported instead of rendering as "nothing pending".
- **`agent` commands were silent about a control box they could not authenticate
  to.** They fell back to this machine's hub, whose empty answer for a box it
  never held was reported as "no snapshot" — they now name the plane and the
  missing `AGENTBOX_HUB_API_KEY`, as `agent approvals` already did.
- **`agent state`, `wait-for` and `get-plan-question` reported no snapshot for a
  box the control box created.** They asked this machine's hub first, and a hub
  box the local registry knows answers "no snapshot" rather than "no such box" —
  so the fallback to the control box never happened. All five `agent` readers now
  resolve the owning hub the same way.
- **A remote-docker box's approvals were looked for on the wrong hub** when a
  control box was configured. It registers with the local relay, but an inline
  provider check treated only `docker` as local, so its host-action mailbox was
  read from the control box. Ownership is now decided in one place for both.
- **Remote Docker builds work on Docker 29.** The box image was streamed to
  `docker build -` alongside `-f`, which Docker 29's buildx rejects outright
  ("ambiguous Dockerfile source") — that broke every bake and every registry-miss
  create on a current engine. It now stages the context in a temp dir on the
  remote and builds from there.

- **`carry:` files are owned by the box user on every provider.** They were
  chowned to a hardcoded uid 1000, which is `vscode` on docker/hetzner/
  digitalocean/daytona but not on vercel/e2b — so carried files landed on a
  stranger there, and a 0600 one (like the credentials
  `--dangerously-with-credentials` copies) was unreadable by the agent meant to
  use it. An explicit `user:` in `agentbox.yaml` still means a literal uid.
- **Files you approved in the carry prompt never reached a hub-created box.** The
  approved list was dropped on the way to the control box, so a gitignored path
  you explicitly opted in — a `.env`, a database dump — simply wasn't there. The
  transport couldn't have carried it either: the prompt offered up to
  `box.cpMaxBytes` (100 MiB) while the wire capped out around 22 MiB. Entries now
  ride the seed, and custody streams raw bytes instead of base64-in-JSON. A carry
  that can't be delivered now fails the create loudly rather than building the box
  without the files.
- **`gh pr create` from a box on a control box failed with `spawn gh ENOENT`** —
  which reads as "gh isn't installed", but was the hub spawning it in a workspace
  path that doesn't exist there. `gh` now runs from a real directory and targets
  the repo explicitly. Restart the relay to pick this up.
- **The attach footer shows real status for boxes a control box created.** It
  read a status file only the local relay writes, so a hub-created box always
  showed `(unknown)` and never the `starting N/M…` service count. Status now
  rides the stream the footer already holds open.
- **The footer recovers on its own after a hub restart.** Its stream gave up
  permanently on any error response — including the ones a hub returns while it
  restarts — so approvals stopped arriving until you detached and reattached.
- **Boxes a control box creates are named after the repo** (`optima-a1b2c3d4`),
  not after the throwaway clone directory it built them in. `agentbox ls` shows
  the repo in WORKSPACE for those boxes too.
- **A control box can now build boxes from repos cloned over SSH.** A project
  whose origin is `git@github.com:owner/repo` failed every hub-side create with
  `Host key verification failed` — the hub authenticates git over HTTPS and has
  no SSH key. Those repos are now cloned (and pushed to) over HTTPS.
- **`agentbox self-update` no longer stops to ask for cloud credentials.** Its
  bake-adoption step walked every cloud provider through the first-run credential
  gate, so an update popped a "Vercel setup" (or Daytona, E2B, …) wizard for a
  provider you never asked about — and cancelling it skipped the rest of the
  refresh. Adoption needs no credential.
- **Boxes created through a remote hub came up signed out of Claude.** A create
  re-seeded the control box's credential from custody without checking which copy
  was newer, overwriting a freshly refreshed token with an hours-old one — and a
  Claude refresh rotates the token, so the older copy is dead rather than merely
  expired. Custody is now kept current (a box that refreshes its own token
  records it there, and every hub create path pushes yours before enqueuing) and
  a create never replaces a credential with an older one.
- **A box destroyed from your PC no longer lingers on the control box.** The reap
  now also drops the control box's own record and per-box SSH key dir, so the box
  stops showing as `running` in `hub boxes list`, the dashboard and the tray.
- Hetzner servers are no longer named `agentbox-agentbox-…` when the box name
  already starts with the prefix.
- **A base baked on the control box stayed invisible to your machine**, which
  kept reporting it as stale and offering a multi-minute re-bake. The control box
  now records its bakes in its own custody (it was trying to upload them to a
  control plane it doesn't have), and a PC can adopt a shared base over an
  outdated local record instead of only over a missing one.
- **A cloud create routed to the control box no longer prompts to re-bake the
  local base** — it builds on the hub, from the hub's base, so this machine's was
  never going to be used.
- **The menu-bar app kept offering the update you just installed.** `self-update`
  now restarts a running app, which is what makes it re-read the installed CLI
  version; before, the row could sit stale for up to a day.
- **Creating a box from a control box's web UI failed** with a `tar: Cannot open`
  error. The control box has no working copy to build from, so those creates now
  go through the same clone-and-seed path as `create --via-hub`. A create no
  longer needs a repo cloned on the VPS first.
- **A control box listed a project named after a deleted temp directory**
  (`agentbox-hub-worker-<uuid>`) with no seed and no `agentbox.yaml`. Its boxes
  now group under their repo, named after it. A cloud create also fails up front,
  rather than after provisioning, when its workspace is missing.
- **Creating a hetzner box through a control box failed** with
  `invalid input in field 'labels[agentbox.box]'` — the derived box name exceeded
  Hetzner's 63-character limit. Names and labels are now bounded.
- **Creating a daytona box on a deployed hub failed** with
  `Module "ObjectStorage" is not available` — the hub bundle inlined the Daytona
  SDK instead of leaving it external.
- **`git push` from a cloud box failed on an npm-installed AgentBox** with
  `Cannot find package '@agentbox/sandbox-<provider>'`. The relay resolved
  provider backends from `node_modules`, which the published package doesn't
  ship; the CLI and the hub now hand it their own bundled providers. Downloads
  and `gh pr create` from a cloud box were hit too. Restart the relay (any
  `agentbox` command does it) after upgrading.
- **On an npm install, every cloud provider showed as "baked · unverified"** and shared
  bake records were silently ignored — which on a control box failed creates with "run
  `agentbox prepare` first". The hub bundle sits three levels below the staged runtime
  root, so the self-relative lookup never found it and no provider could compute a live
  fingerprint. The hub child is now told where that root is.
- **Editing eight of the files baked into the box image never rebuilt it.** `gh-shim`,
  `git-shim`, `ntn-shim`, `linear-shim`, `chromium-resolver`, `agentbox-sshd-start`,
  `agentbox-portless-trust` and `opencode-agentbox-plugin.js` are all COPY'd by the
  Dockerfile but were missing from the fingerprint's file list, so a change to any of
  them left every machine on the old image indefinitely. The guard test now derives
  the expected list from the Dockerfile's own COPY lines rather than spot-checking a
  few names, which is why it never caught this. **Every provider's stored fingerprint
  changes once as a result** — expect a single re-bake (or re-pull) per machine.
- **A rate-limited image pull rebuilt the box image from scratch instead.** GHCR
  throttles anonymous pulls per IP, so a machine that had just baked a few times got
  a 429 — and because the pull only reported a bare pass/fail, that was
  indistinguishable from an unpublished tag and fell straight through to a
  ~10-minute local build of an image already sitting in the registry. AgentBox now
  tells the failures apart (rate limit / rejected credentials / genuinely missing /
  network) and, on a throttle, retries once authenticated with your own `gh` token.
  That retry needs the `read:packages` scope, which `gh auth login` does not grant by
  default; without it AgentBox stays anonymous rather than making things worse (a
  token that cannot read packages turns a working anonymous pull into a 403) and
  tells you the one command that fixes it:
  `gh auth refresh -h github.com -s read:packages`.
- The pull-vs-rebuild decision is now in `~/.agentbox/logs/<command>.log`. It went
  only to a self-overwriting spinner for `claude` / `codex` / `opencode`, so the most
  expensive branch of a create left no trace and there was no way to tell afterwards
  why a prebuilt image had not been used.
- The sign-in page of a deployed hub rendered no logo — the auth redirect swallowed
  the asset request.
- A deploy that landed on a recycled IP already at its Let's Encrypt certificate limit
  was reported as a wrong upstream port. The two are now told apart by probing, so the
  advice matches the actual cause.
- **Box and hub `.localhost` URLs stopped working after a reboot.** A Portless
  proxy dies with the machine while the routes it serves persist on disk, and
  nothing restarted it — so `agentbox hub` kept printing
  `https://agentbox.localhost:1355` with nothing listening. AgentBox now brings
  the proxy back whenever it is about to hand out one of these URLs (create,
  agent start, `hub start`/`restart`, `self-update`). It restarts the mode your
  host already uses and never switches: a host on the clean HTTPS proxy is
  pointed at `agentbox install portless` rather than silently downgraded, since
  the scheme and port are part of the URL a box mirrors internally.
- `agentbox doctor` reported the Portless proxy as running on hosts that had
  none — the check matched any command line merely mentioning `portless proxy`.
- The hub no longer advertises a Portless URL unless a proxy is actually
  serving it (it falls back to `http://127.0.0.1:8787`), and re-resolves the URL
  so switching proxy modes can't leave a stale one behind.
- A box's Portless URL no longer depends on the directory the command ran from
  (inside a git worktree it picked up a worktree-scoped hostname that was never
  registered).
- `agentbox self-update` again honors `portless.enabled: false` instead of
  re-registering `agentbox.localhost` for users who had opted out.
- On the nightly channel, the menu-bar app was re-downloaded on every refresh:
  the installed build was compared against the **stable** release's checksum.
- `agentbox self-update` no longer reinstalls an older published version when the
  running build is already newer than anything on the registry.
- A control box now uses a base image you baked with `box.claudeInstall: npm`.
  That setting is folded into the bake fingerprint but lives in `config.yaml`, so
  it never reached the control box — which defaulted to `native`, rejected the
  shared bake, and failed every cloud create with "run `agentbox prepare` first".
  A record baked in either mode is now accepted, and `hub deploy` carries the
  setting across.
- A box's host-action approvals are now visible wherever the box lives: the
  attach footer, `agentbox agent approvals`/`approve`, and the dashboard all ask
  the box's own relay instead of always this laptop's. Hub-box approvals
  previously showed up only in the web UI or tray.
- `agentbox destroy` and `agentbox prune --provider <cloud>` now reap the
  control box's registration + SSH-key custody, so destroyed boxes stop
  lingering as ghosts in `agentbox ls`, the web UI, and the tray.
- `agentbox prune` no longer deletes the state record of live **cloud** boxes
  (it judged every box by `docker inspect`, which a cloud box can never pass);
  with `--all` this also took the per-box dir holding its private SSH key.
- `agentbox dashboard` lists boxes created on the control box, like
  `agentbox ls` already did; selecting one adopts it.
- `agentbox hub deploy hetzner` now migrates the Daytona JWT org id to the
  control box under its correct key (`DAYTONA_ORGANIZATION_ID`, was
  `DAYTONA_ORG_ID`), and also carries provider endpoint/region overrides — so a
  JWT-mode Daytona (or custom-endpoint) provider works on the control box.
- A cloud create could finish with a healthy box and no agent running in it: the
  detached agent start fired a single ssh with no retry, and Daytona's SSH
  gateway hangs up on an attach token minted seconds earlier. It now retries with
  a fresh token, and reports what ssh actually said instead of a bare `exit 255`.
- **`agentbox hub setup` / `hub deploy hetzner` deployed the wrong version and
  failed with a 502.** The git ref was hardcoded to `main`, so the CLI configured
  the VPS for a hub it never built — the deploy timed out against a control box
  that was actually healthy. The ref now defaults to the one matching your CLI,
  and an incompatible `--ref` is rejected before the build instead of after it.
- A failed control-box deploy is now debuggable: both commands write
  `~/.agentbox/logs/hub-{setup,deploy}.log`, the VPS is recorded as soon as it
  boots (it is left running), and the failure prints how to reach it and read the
  hub's own logs.
- A control box with no GitHub App configured failed to boot at all, so it could
  never come up far enough for you to configure one.
- `gh pr create` (and the other `gh` commands) from a box on a control box exited
  127 — `gh` wasn't installed on the hub.
- Config keys AgentBox accepts were flagged as invalid by editors: 15 registered
  keys were missing from the published JSON schema, including `git.pushMode`,
  `cloud.viaHub`, `update.channel`, and the whole `ssh`/`git`/`cloud`/
  `integrations` branches. `box.provider` also rejected `remote-docker`.
- **Stored credentials could be read over the network.** Once the local hub began
  binding all interfaces so docker boxes could reach it, anything holding the hub
  token could fetch stored bytes — agent credentials, `.env` files, per-box SSH
  private keys. That read is now restricted to loopback (and to the admin token
  on a control box), and fails closed.
- A hub-routed create came up without your `.env` and other untracked files; the
  seed push now always runs.
- A hub-routed `claude -i` silently dropped its agent arguments
  (`--dangerously-skip-permissions` and friends).
- `destroy --keep-snapshot` was a silent no-op on docker.
- A failed create now reports the failure in `queue list` / `hub jobs show`
  instead of reading as done, and `queue list` prints the full job id so
  `queue show` / `queue cancel` accept it.
- Destroying a cloud box from the dashboard could hit the wrong hub and leave
  both the sandbox and its registration in place.

### Removed

- `agentbox hub boxes start|stop|pause|resume|rm` — use the plain `agentbox
  start|stop|pause|unpause|destroy`, which now drive the hub themselves.
  `hub boxes list` stays as the hub's admin view.


## [0.27.1] - 2026-07-25

### Fixed

- **A fresh `npm i -g @madarco/agentbox` crashed on every command** with
  `Cannot find module 'ws'`. `ws` is an undeclared transitive peer of
  `@daytona/sdk`'s `isomorphic-ws`, so npm never installed it — only
  pnpm-based dev checkouts, which hoist it, worked. Affects 0.27.0; upgrade
  or `npm i -g ws` alongside it.

## [0.27.0] - 2026-07-16

### Added

- Hub UI: create and manage **remote-docker hosts** from the dashboard. Each
  registered host shows up as a `Docker (<alias>)` option in the create-box
  picker, and the Settings page nests a host list under the Remote Docker row —
  add a host (probes ssh + docker before saving), per-host Bake/Re-bake, and
  remove.

### Changed

- Reworked the `remote-docker` provider around named **host aliases**. Register a
  host with `agentbox remote-docker add <alias> <[user@]host[:port]>`; boxes are
  created against the alias (`agentbox docker:<alias> …`), and `agentbox
  remote-docker update <alias> <new-ssh>` retargets existing boxes after an IP
  change. `doctor`/`list`/`remove` work on aliases, and a raw connection string is
  no longer accepted where an alias is expected. `add` now bakes the box image on the
  host by default (`--no-bake` to skip), and `agentbox install` → Remote Docker prompts
  for the alias + SSH connection. (Subcommands were also renamed from the old
  `check`/`use`/`hosts` to `doctor`/`add`/`list`.)
- `agentbox remote-docker rm <alias>` now confirms before forgetting a host (the
  prompt names the ssh target and how many boxes go unreachable); pass `-y`/`--yes`
  to skip, and it refuses rather than deleting silently on a non-interactive shell.

### Fixed

- remote-docker onboarding/comms fixes surfaced against a real macOS/OrbStack +
  Hetzner remote: the SSH ControlMaster socket path could overrun the `sun_path`
  limit, attach ran the remote command in a non-login shell (docker off `PATH`),
  and the credential seed assumed in-box passwordless sudo the image doesn't grant.

## [0.26.1] - 2026-07-15

### Fixed

- `agentbox plugin add <package>` now works for a published community provider.
  It was resolving `<package>/package.json` through Node's CommonJS resolver,
  which fails for a normal ESM-only provider — its `exports` map defines only an
  `import` entry and doesn't expose `./package.json`, so Node threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` and `add` reported "cannot resolve package"
  even though it was installed. The package directory is now located on disk
  across the global install root / cwd / `NODE_PATH`.

## [0.26.0] - 2026-07-15

### Added

- **`remote-docker` provider** — run a box as a container on a machine you
  already own (a workstation, a team server) reached over **your own SSH**, no
  cloud login. Address it as `agentbox docker:<host> claude`, or set
  `--remote-host` / `box.remoteDockerHost`; new `remote-docker check|use|hosts`
  helpers. Like the cloud backends the workspace is synced (a bind mount can't
  cross a network), while the image, `docker commit` checkpoints, and in-box
  docker stay docker-shaped. `open`/`code` reach the box via SSH `ProxyJump`,
  and boxes are unlimited by default since the engine is your own machine.
- The install wizard now offers to **pin the provider you just set up** as
  `box.provider` (global), so `agentbox claude` uses the backend you configured
  instead of silently falling back to docker. Skipped when it wouldn't change
  anything; `-y` auto-confirms.

### Changed

- **Unknown config keys now warn and are skipped instead of aborting the
  command.** A provider plugin pinned to an older SDK, or a box image baked
  months ago, could carry a config with keys the newer schema hadn't taught it
  yet — and every new key was effectively a breaking change for them. The rest
  of the config still applies; `agentbox doctor` surfaces the warnings. Type
  errors, renamed keys, and `config set <bad-key>` still fail loud.
- **Reworked help.** The default `agentbox --help` is now a compact
  workflow-focused view; the full grouped command list moved to `agentbox help`
  (providers, git, and advanced commands grouped, one line each).
- Faster install and `doctor`: the setup banner only animates on first run and
  no longer stalls on fake "checking" time, an unchanged fork skill isn't
  re-fetched over the network, and `doctor`'s provider probes now run in
  parallel. The Daytona login hint was corrected — it prompts to paste an API
  key, it does not do a browser sign-in.
- `@madarco/agentbox-provider-sdk` **2.4.0** ships the tolerant config parser to
  external plugins (additive; republished separately).

## [0.25.1] - 2026-07-13

### Fixed

- `box.claudeInstall: npm` now pulls the prebuilt box image instead of building
  it locally every time. The pull was hard-disabled for npm mode, from back when
  only the native image was published — most visible as the throwaway container
  behind `claude` sign-in baking from scratch. 0.25.0 started publishing the npm
  image; this actually uses it.

## [0.25.0] - 2026-07-13

### Breaking

- Daytona boxes now default to the `linux-vm` sandbox class, which Daytona runs
  in **`us-east-1` only** — so new boxes are pinned to US-East. Set
  `box.daytonaClass: container` to keep the old behavior and your choice of
  region. Existing container base snapshots keep working (a box boots the class
  its base was baked as); run `agentbox prepare --provider daytona --force` to
  move to a VM base.

### Added

- **Daytona `linux-vm` sandbox class** (`box.daytonaClass`, default `linux-vm`).
  `agentbox pause` is now a true VM freeze — CPU and memory are preserved, so
  running processes and tmux sessions survive `unpause`. Checkpoints work
  (~2 s capture; the old endpoint 404'd), and the base bake drops from ~7 min to
  ~66 s. New keys: `box.daytonaRegion`, `box.daytonaTimeoutMs`,
  `box.daytonaVmBaseImage`.
- Idle Daytona boxes now pause themselves after `box.daytonaTimeoutMs` (25 min).
  The host enforces this: Daytona's own idle timer is reset by any request to the
  sandbox — including AgentBox's own polling — so it never fired, and idle boxes
  billed indefinitely.
- The box image is published for `box.claudeInstall: npm` too, so npm-mode users
  get a pull hit instead of a silent local image build — and can use `linux-vm`
  boxes, which can only boot from a published image.

### Changed

- Daytona attach honors `attach.openIn` (`split`/`tab`/`window`) like every other
  provider, instead of always taking over the current terminal.

### Fixed

- `agentbox pause` on a container-class Daytona box failed outright with
  `Sandbox is not stopped`.
- `agentbox shell` against a paused cloud box now resumes it first, rather than
  failing — both the interactive and the one-shot `-- cmd` forms, on every cloud
  provider.
- `agentbox daytona claude` (and `codex`/`opencode`, queued `-i` jobs, and the
  dashboard) now boot from the base snapshot `prepare` baked. They read the
  generic `box.image` instead of the per-provider key, so they ignored it — a
  silent ~7-min rebuild per create, and on `linux-vm` a hard failure.
- Daytona interactive attach dropped instantly into "box rebooting —
  reconnecting…" on a perfectly healthy box.
- `agentbox screen` on a `linux-vm` box opened the VNC desktop but no browser:
  the image's environment (`DISPLAY`, …) is dropped by the VM conversion, and is
  now restored.
- `agentbox prepare --provider daytona` no longer dies when it has to fall back
  to a container base, and `create` no longer demands a VM base that the fallback
  never produced.
- The box image is republished whenever its content changes. The publish workflow
  filtered on paths that missed most of the image's real inputs, so an image
  could silently go unpublished — which on Daytona quietly downgraded a VM box to
  a container.
- `@madarco/agentbox-provider-sdk` 2.3.0: `CloudBackend` gains `timeoutModel` and
  `attachExecLacksTty`, `AttachSpec` gains `initialInput`, and the box record
  carries `sandboxClass`. Additive only.

## [0.24.6] - 2026-07-12

### Fixed

- `self-update` no longer deletes the box image. It's content-addressed, so an
  update that doesn't change the build context now costs nothing — and when the
  context *has* changed, `doctor` and the app both flag it as stale (fix with
  `agentbox prepare --provider docker`) instead of it surfacing at create.
- `agentbox install` no longer offers to install the menu-bar app when it's
  already installed; it offers an update only when one is actually available.

## [0.24.5] - 2026-07-12

### Fixed

- Update checks no longer interrupt `create` / `claude` / `codex` and the other
  box commands — they say nothing about updates at all, and a newer menu-bar app
  is now a one-line note after a quiet command instead of a prompt.
- The menu-bar app no longer reports a phantom update when it is already current
  (it was comparing an install stamp rather than the app's actual version, so an
  app installed from the DMG always looked stale).

## [0.24.4] - 2026-07-12

### Added

- **DigitalOcean Projects** — `box.digitaloceanProject` (a project name or UUID)
  places boxes in a specific DigitalOcean Project instead of the account's default;
  pick it at `agentbox digitalocean login`, in the hub/app settings, or per repo in
  `agentbox.yaml`. Unset keeps the old behavior.
- (Provider plugins) `@madarco/agentbox-provider-sdk` 2.2.0: `CloudProvisionRequest`
  gains an optional `project` field. Additive; must be republished separately.

## [0.24.3] - 2026-07-12

### Fixed

- **`agentbox self-update` left a running hub broken.** The hub and the relay are
  separate processes, but the post-update refresh only ever restarted the relay.
  An update replaces the installed package directory underneath whatever is still
  running, so a hub left alive across an update kept executing files that no longer
  existed — it failed with `Cannot find module …/dist-<hash>.js` on the first
  operation that needed a part of itself it hadn't loaded yet (destroying a box,
  for instance), and boxes it created died on startup. It stayed that way until
  the hub was restarted by hand. The refresh now restarts the hub too. A host
  running only the relay is unaffected and stays a relay.

## [0.24.2] - 2026-07-12

### Fixed

- **A box created from the hub or the menu-bar app could fail instantly, showing a
  Node stack trace as its status and a progress bar that crept forward forever.**
  The relay/hub is a long-lived daemon, but `npm install -g` (what `self-update`
  runs) replaces the package directory underneath it — so a daemon left running
  across an update ends up in a deleted working directory, and every box-create
  worker it spawned inherited that and died before it started. Workers now run
  from a fixed directory, so an update no longer poisons creates from a hub that
  was already running.
- A create worker that died mid-flight stayed `running` forever — nothing ever
  marked it failed, so `agentbox queue list` kept reporting it as in progress and
  the app's progress card waited on a job that was never coming back. Dead workers
  are now detected while the queue runs, not only when the relay restarts, and
  report as `failed`.
- The job-log stream now sends a keep-alive during quiet stretches. A cloud create
  is legitimately silent for a minute or more (a VM boots, an SSH wait), which a
  client could mistake for a dead connection — it would reconnect, the log replayed
  from the start, and the progress bar jumped ahead while the text appeared frozen.
- Menu-bar app **0.1.11** — the create progress bar no longer double-counts a
  replayed log or advances on blank lines, and DigitalOcean creates now use a
  calibrated bar instead of a generic fallback. Update with `agentbox install app`.

## [0.24.1] - 2026-07-12

### Fixed

- **Menu-bar app updates were never offered.** The app is released separately from
  the CLI, so an app-only release bumps no CLI version — and the post-update
  prompt only fired on a CLI version change. A new app build could sit published
  and unnoticed indefinitely, and you had to know to run `agentbox install app`
  yourself. An interactive command now offers to install a newer app build even
  when the CLI itself is unchanged, reading the existing daily check (no extra
  network on the command path). Answering no remembers that build, so you are
  asked once, not on every command — and only the app is reinstalled, without
  touching the box image or the relay.
- Menu-bar app **0.1.10** — "Check for Updates…" now reports the app as well as
  the CLI (it only ever compared the CLI, so it could report "up to date" while
  the app itself was stale), and offers `agentbox install app` when only the app
  is behind. Also fixes the DigitalOcean provider settings, which sent the API
  token under the wrong key and always failed with "token is required". Update
  with `agentbox install app` (or accept the new prompt).

## [0.24.0] - 2026-07-12

### Added

- **DigitalOcean provider** (`--provider digitalocean`, or `agentbox digitalocean
  <cmd>`): one DigitalOcean Droplet per box, reached over pure SSH, with a per-box
  Cloud Firewall locked to your egress IP, snapshot checkpoints, and
  Docker-in-Docker. Sign in with `agentbox digitalocean login`, bake the base
  snapshot with `agentbox prepare --provider digitalocean`. At parity with the
  Hetzner provider (sizing, credentials, checkpoints, `prune`).
- **Remote access — drive a box from your phone with your laptop off** (Hetzner /
  DigitalOcean). `--inbound open` (or a CIDR list; also `box.inbound`) opens the
  box's SSH to another device; `agentbox inbound <box> open|lock|<cidr…>` changes
  it live with no reboot; `agentbox connect <box>` prints the SSH connection
  bundle, adds another device's key with `--add-key`, or exports the box key with
  `--export-key`.
- **Independent boxes** — `--dangerously-with-credentials` copies one git
  credential into a cloud box so it can `git push`/`fetch`/`pull` on its own with
  your PC off (`git.pushMode=direct`; an interactive prompt asks token vs SSH).
  Add it to an already-running box with `agentbox connect <box>
  --dangerously-git-credentials`.
- **Unified `--size` and `--location`** across cloud providers — Hetzner server
  type, DigitalOcean Droplet slug, Daytona/E2B `cpu-mem-disk`, Vercel vCPUs; pin
  per provider with `box.size<Provider>` / `box.hetznerLocation` /
  `box.digitaloceanRegion`. Choices are preflight-validated against the provider's
  live catalog, and the real provisioned resources are reported after create.
- **Agent settings sync + credential fan-out** — a refreshed agent login
  (Claude/Codex/OpenCode) now propagates to every running box and the host backup
  so other copies don't 401 after a token rotation (`box.credentialSync`, on by
  default; `--no-credential-sync` to opt a box out). Pulled agent settings
  propagate to other boxes too.
- **`agentbox download claude|codex|opencode`** — copy an agent's login out of a
  cloud box back to the host.
- Every base image now ships the `docker compose` and `docker buildx` CLI plugins,
  so in-box `docker compose` / `docker buildx` work out of the box.
- (Provider plugins) `@madarco/agentbox-provider-sdk` 2.1.0: the inbound-access
  surface (`Provider.setInbound` / `enableDirectGit`, `CloudProvisionRequest.inbound`,
  `CloudHandle.inbound`, `CloudBoxFields.inbound`) is now exported. The retired
  `box.vercelVcpus` config field was removed (superseded by the unified `--size`).
  Must be republished separately from the CLI.

### Changed

- Agent sign-in now runs under a PTY and prompts on the host, so interactive
  provider/agent logins behave consistently.

### Fixed

- `git` inside a box: `file://` and local-path clones pass straight through to
  real git, clone tokens are classified correctly, and read-only flags plus
  `pull --ff-only` route properly.
- Hetzner: the SSH provisioning deadline is now 10 minutes with an actionable
  timeout message instead of an opaque failure.
- `carry:` skips macOS AppleDouble (`._*`) stubs and now carries E2B and
  Codex/OpenCode credentials.
- Codex: the seeded `hooks.json` no longer includes a `$comment` key that Codex's
  strict parser rejected.
- Cloud create: mount-safe workspace seeding, root-exec extraction (fixes
  "dubious ownership" on root-exec sandboxes), and a bootstrap spawn guard so a
  missing best-effort daemon no longer aborts the whole bootstrap.

## [0.23.5] - 2026-07-08

### Added

- Failed box creates can now be dismissed on demand. When a `create` fails it
  lingers as an "error" box; the hub UI and the macOS menu-bar app now offer a
  **Dismiss** action to clear it immediately instead of waiting for it to
  auto-expire.

### Fixed

- `agentbox prepare` (and the docker/cloud workspace seeds) no longer abort with
  an `EACCES` permission error when your agent config (`~/.claude`, `~/.codex`,
  `~/.agents`, `~/.local/share/opencode`) contains read-only files — e.g. skills
  or plugins symlinked into the Nix store, or dotfiles managed declaratively by
  Nix/home-manager, Ansible, or chezmoi. The staging copy is now forced
  user-writable.

## [0.23.4] - 2026-07-08

### Added

- The hub box page's Access card now always lists every "open in" app (Claude,
  Codex, VS Code, cmux, Herdr, iTerm2, Finder) plus Open web / Open VNC —
  buttons that can't work right now are disabled with an instant hover tooltip
  explaining why (app not installed, not supported for the box's provider, box
  paused/stopped, no web service, VNC off) instead of being hidden.
- `agentbox open --targets` reports *why* an unavailable app is unavailable
  (new optional `reason` field in `--json`); the hub and the menu-bar app show
  it. The menu-bar app (from v0.1.6) mirrors the always-listed behavior and
  gains an OPEN IN section in the box details window with the same tooltips.

### Fixed

- Finder is no longer reported as an always-available open target: it now
  requires `sshfs` on PATH, so a missing sshfs shows up front as a disabled
  button with the install hint instead of an error only after clicking.

## [0.23.3] - 2026-07-08

### Fixed

- Opening a box's VNC from the menu-bar app or the hub web UI now starts the
  in-box browser first (pointed at the box's web app), so the desktop shows the
  app instead of a blank X screen — previously only `agentbox screen` did this.
  New hub action `POST /api/v1/boxes/{id}/screen` runs the prep for docker and
  cloud boxes; the menu-bar app uses it from v0.1.5.

## [0.23.2] - 2026-07-08

### Fixed

- First-run `agentbox create` no longer looks frozen while the pulled box
  image extracts: `docker pull` prints nothing during the extraction phase
  (minutes, for a multi-GB image), so create now emits a "still extracting"
  keepalive after 20s of silence.

## [0.23.1] - 2026-07-08

### Breaking

- **`agentbox install tray` is now `agentbox install app`** — matching the
  `AgentBox.app` bundle and the `agentbox app` lifecycle command. The old name
  errors (no alias); update any scripts.

### Added

- The hub's Settings page shows the running AgentBox version, and
  `GET /api/v1/health` now includes a `version` field. The macOS menu-bar app
  gained the same version footer in its Settings window.

### Changed

- `agentbox install <target>` with an unrecognized target now exits with an
  error listing the valid targets (`cmux`, `herdr`, `codex`, `app`) instead of
  silently ignoring it and launching the setup wizard.
- The install wizard's compatibility check now names what warned — e.g.
  `system warn: optional sshfs, macfuse` — instead of an opaque `system warn`,
  and marks optional deps as such.
- `agentbox doctor` reports missing Daytona credentials as a one-liner
  (`not configured`, with the `agentbox daytona login` hint) like the other
  cloud providers, instead of the SDK's env-var paragraph.

### Fixed

- The GitHub star prompt remembers any explicit answer — declining, or starring
  via the browser fallback, no longer makes it re-ask after every self-update.

## [0.23.0] - 2026-07-08

### Added

- **Every Docker box now runs an SSH server** — loopback-only (published on
  `127.0.0.1` on an ephemeral port, never reachable off-host), authenticated by
  a per-box ed25519 key, and written to a managed `~/.ssh/config` alias, so
  `ssh <box>` just works and lands in `/workspace`. Boxes created before this
  release predate the sshd — recreate them to get it.
- **`agentbox open` live-mounts the box** — `/workspace` is mounted over sshfs
  at `~/.agentbox/mounts/<box>/` and revealed in Finder, with edits flowing
  both ways (Docker, Hetzner, and Daytona boxes); `--unmount` tears it down.
  Needs `brew install macfuse sshfs` — `agentbox doctor` now checks both
  (optional, warn-only). Vercel/E2B have no SSH and fail fast with a pointer to
  `agentbox download`; pre-sshd Docker boxes keep the old rsync export.
- **Open a box in the Claude desktop app: `agentbox open <box> --in claude`.**
  Claude has no add-SSH deep link, so AgentBox writes the box's SSH alias into
  the app's own settings (`sshConfigs` in `~/.claude/settings.json`) and
  launches it — pick the box from the Environment dropdown, where the app can
  also list and resume the Claude sessions already recorded inside the box.
  Entries are upserted by id, never touch the rest of your settings, and
  are pruned automatically once the box is gone. Docker + Hetzner boxes.
- `--in codex` now works for Docker boxes too (was Hetzner-only), and `finder`
  is a first-class target in `open --targets` so the tray/hub can offer it.
- **Hub: "Apps" launchers on the box detail page** — open a box in Claude,
  Codex, VS Code/Cursor, cmux, Herdr, iTerm2, or Finder from the web UI. Apps
  show only when installed on the host and eligible for the box's provider;
  localhost macOS hubs only. New `GET /api/v1/open-targets` and
  `POST /api/v1/boxes/:id/open` endpoints.
- **Hub: the create modal now tells the truth about the base image** — Docker
  freshness is actually probed (was hardcoded "fresh"), a first-run or stale
  base shows a bake note and auto-chains a streamed "Building base image…"
  prepare job into the create, and a stale cloud base offers Rebuild & Create /
  Use Existing Image.
- **Hub REST widened for native clients** — `GET /api/v1/boxes` now carries
  state, provider, project, git worktrees, and per-agent session/activity
  fields (so the tray app can run on REST instead of shelling the CLI), and
  `POST /api/v1/boxes/:id/start` starts a stopped box.
- **Provider SDK 2.0.0 (breaking)** — `BoxRecord.cloud.ssh` moved to top-level
  `BoxRecord.ssh` (now with `port`), plus the new Docker sshd fields.
  `SDK_API_VERSION` is now `2`; v1 plugins still load. Plugin authors:
  republish against `@madarco/agentbox-provider-sdk@2.0.0`.

### Fixed

- **`agentbox self-update` actually updates the package now.** A globally
  installed CLI invoked from the shell was misdetected as "running from
  source" (no npm user-agent, and argv is the bin symlink), so the
  `npm install -g` step was silently skipped. Detection now resolves the bin
  symlink (npm's `lib/node_modules`, pnpm's global dir; a project-local
  install still skips), and the "newer version available" nudge only appears
  when self-update can actually act.
- VS Code/Cursor are detected — and launched — via the `.app` bundle when the
  `code`/`cursor` PATH shim isn't installed, so the tray/hub Open-In menus no
  longer hide VS Code on a freshly dragged-in install.

## [0.22.2] - 2026-07-08

### Added

- **Open a box in a host app: `agentbox open <box> --in codex|herdr|cmux|vscode|iterm2`.**
  `codex` writes the box's SSH alias and auto-opens Codex's add-SSH-connection
  form via its `codex://` deep link (persistent-SSH boxes, i.e. Hetzner — the
  same link `shell --ssh-config` prints, now launched for you); `herdr`, `cmux`,
  and `iterm2` open a new workspace/window in that terminal app running the box
  attach (the box is auto-started, and a failed attach leaves a live shell);
  `vscode` is equivalent to `agentbox code`. Plain `agentbox open` still opens
  the workspace in Finder. `agentbox open --targets [--json]` reports which of
  these apps are installed. cmux blocks external control by default — enable
  `socketControlMode: automation` (or a socket password) in its settings.
- **Menu-bar app: per-box "Open In…" submenu** listing only the apps installed
  on your machine (probed once at launch) and eligible for that box's provider;
  "Copy Web URL" moved into it, keeping Open Web / Open VNC at the top level.
- **Rename a box** with `agentbox status <box> --set-name <name>` (or
  `--clear-name`) — a cosmetic display label; the container, git branch, and
  URLs are untouched, and box lookups accept the label. Shown in `list`, with a
  Rename button in the hub (`POST /api/v1/boxes/:id/rename`) and a "Rename…"
  item in the menu-bar app.
- **Update detection.** After you update the package yourself (`npm update -g`),
  the next interactive command offers the post-update refresh (host skills, box
  image, relay, menu-bar app). At most once a day a background probe checks for
  a newer release and prints a nudge — disable with the new `update.check`
  config key. `agentbox self-update` now also updates the menu-bar app (only
  when the published build actually changed) and reports current vs latest.

### Fixed

- Boxes created or resumed **through the hub** now get their `~/.agentbox/ssh/config`
  entry too — hub-created Hetzner boxes were missing their `ssh <box>` alias.
- Non-interactive box creates (menu-bar app / hub queue, `--yes`, CI) now adopt
  an already-running Portless proxy instead of silently skipping Portless on a
  machine that never opted in from a terminal.

## [0.22.1] - 2026-07-07

### Added

- **`agentbox app log`** — collect the macOS menu-bar app's diagnostics for a bug
  report. Reads the app's macOS unified-log entries (`--last <window>`, `-f` to
  stream live, `--crashes` for crash reports only) and lists its crash reports from
  `~/Library/Logs/DiagnosticReports`; `--open` reveals that folder in Finder and
  `--out <file>` writes one self-contained bundle (versions + log + newest crash
  report) to attach. The app keeps no log file of its own — these are
  macOS-native surfaces (unified logging + OS `.ips` crash reports).
- **Build your own provider.** The provider SDK now ships on npm as
  `@madarco/agentbox-provider-sdk` and carries the full surface a real provider
  needs (base-image `prepare`, no-SSH `buildAttach`, id-addressed `checkpoint`),
  with a complete reference provider to copy (`examples/agentbox-provider-example`)
  and a new [Build a provider](https://agent-box.sh/docs/build-a-provider) guide.
  (The `agentbox plugin` system itself shipped in 0.22.0.)
- **Per-box SSH config via a managed Include.** SSH-capable boxes now keep their
  `Host` blocks in an AgentBox-owned `~/.agentbox/ssh/config`, referenced by one
  managed `Include` in `~/.ssh/config` and regenerated from box state (so it
  self-heals stale/destroyed boxes and refreshes a Hetzner box's IP across
  stop/start). On by default (`ssh.autoConfig`); `agentbox shell --ssh-config` /
  `code` / `open` still write on demand, and legacy inline blocks in
  `~/.ssh/config` are stripped on next touch.

### Changed

- **The macOS menu-bar app is now named "AgentBox"** (was "AgentBoxTray"). It
  installs to `/Applications/AgentBox.app`; `agentbox install tray` removes any
  old `AgentBoxTray.app` on install so the two never coexist. The bundle
  identifier is unchanged, so launch-at-login and notifications carry over.
- **First-run web URLs come up on `:443`.** The first time a box needs a public
  web URL, AgentBox starts its Portless proxy on `:443` with a one-time root
  prompt, and no longer prints a misleading fallback port.

### Fixed

- **`agentbox checkpoint` covers provider-plugin checkpoints.** `checkpoint ls`,
  `ls -g`, and `rm` now include checkpoints captured by external provider plugins,
  not just the built-in cloud providers.
- **`agentbox hub` now starts after a fresh `npm install`.** The published
  package shipped the hub's Next.js bundle with a pnpm-linked `node_modules` that
  `npm publish` mangles, so a globally-installed hub crashed on startup with
  `Cannot find package 'next'` (it only worked from a dev checkout). The hub's
  runtime dependencies (`next`, `react`, `react-dom`, `better-auth`, `kysely`)
  are now declared as real package dependencies and resolved by npm, and the
  private `@agentbox/sandbox-*` providers are bundled into the hub server. The
  broken ~44 MB bundled `node_modules` is no longer shipped.
- **Clearer hub startup failures.** When the hub process dies while starting,
  `agentbox hub` now fails fast and includes the tail of `~/.agentbox/hub.log`
  (with the real error) in its message, instead of waiting ~25s and only pointing
  you at the log file.

## [0.22.0] - 2026-07-06

### Added

- **`agentbox hub` — a local Web UI + REST API for your boxes.** The control
  plane was renamed to the **hub**: `agentbox hub` runs a persistent relay + web
  app (served at `https://agentbox.localhost` via Portless, port 8787). From the
  browser you can launch and manage boxes on any configured provider (docker or
  cloud), watch build logs live over SSE, run per-box git ops (sync, branch
  picker, `push`/`push --host-only`/`checkout`) and service restarts, answer
  host-action approvals, create/delete projects, and manage provider credentials
  + bake provider base images. A public REST API at `/api/v1` backs all of it, so
  the hub (and the tray app) are pure REST clients. `agentbox hub install /
  update / uninstall` manage the daemon.
- **`agentbox app`** — start / stop / restart / status for the macOS AgentBoxTray
  menu-bar app, driving the process directly (mirrors the `relay` group).
- **`agentbox install tray`** — install the macOS menu-bar app. It is downloaded
  from GitHub Releases (SHA-256 verified, ditto-extracted to `/Applications`),
  no longer bundled in the npm package.
- **External provider plugins.** Publish an `agentbox-provider-<name>` package on
  the public `@madarco/agentbox-provider-sdk` and add it with `agentbox plugin add`; the
  CLI loads it at runtime through a trust-on-add registry. See
  `examples/agentbox-provider-sample`.
- **Hosted control plane (experimental/WIP).** `agentbox control-plane
  setup|worker|set-url|unset-url|status|add` — a GitHub-App setup flow, a
  Git-backed Vercel deploy, and a durable box-create worker that leases
  GitHub-App tokens to push on the box's behalf.
- **`box.claudeInstall`** config key — install Claude via npm at image-bake time
  (a fallback when the native installer CDN 403s a cloud egress IP).
- **`git.pushMode`** config key — choose whether a box's `git push` goes through
  the host relay or a GitHub-App lease.
- **`agentbox services list --json`** for scripting.
- **`agentbox doctor`** gained a Portless health row (non-OrbStack docker +
  hetzner) and now flags a stale provider base image with an actionable fix.
- **Expired-Claude-login recovery** — `create` detects an expired in-box Claude
  login and offers an in-card re-login (hub + CLI).

### Changed

- **A safe subset of host actions now auto-approves without a prompt** — e.g. a
  contained git write-back that stays within the box's own branch namespace. The
  approval prompt still fires for anything that could publish or overwrite
  outside that boundary.
- **`agentbox services restart`** accepts a bare service name on a single-box
  project (no need to name the box).
- Interactive login/SSH shells and background box creation now register a
  Portless alias, so hub- and background-created docker boxes get web URLs too.

### Fixed

- **Relay push gate** now keys its scratch-branch bypass on the branch actually
  being pushed, closing a case where a push could slip the gate.
- A failed relay re-register on a sanctioned-branch write-back now warns you
  (pointing at `agentbox relay restart`) instead of silently leaving the relay
  gating on the old branch.

## [0.21.0] - 2026-06-30

### Added

- **`agentbox recover [box]` — reconnect to a running box without power-cycling
  it.** Rebuilds the host-side state (relay registry, Hetzner SSH tunnel, host
  Portless aliases, the detached agent session) that is lost on a host reboot,
  relay restart, or new CLI process, then relaunches and attaches the agent the
  box was running — all without restarting the sandbox. `recover --provider
  <cloud> --adopt [ref]` rebuilds local state for a sandbox missing from this
  host entirely. Works across all five providers.
- **`agentbox git push <box> --host-only` — land a box's branch in your host's
  local repo without publishing it anywhere.** The destination branch defaults
  to the box's branch; `--as <branch>` renames it and `--force` allows a
  non-fast-forward overwrite. Nothing leaves the host. Covers docker and all
  four cloud providers.
- **`agentbox cp` now copies multiple files/dirs in one call.** List several
  sources before a destination directory (`agentbox cp a b c <box>:/dest/`);
  from inside a box this means one host-approval prompt instead of several.
  Excludes and the size guard are now honored on every provider.
- **`agentbox install codex` — install and enable the Codex plugin for you.**
  Wires up the marketplace add, plugin add, and enable (previously a manual
  three-step chore); also runs inside the `agentbox install` wizard when Codex
  is detected. From a source checkout it points Codex at the local repo and
  live-symlinks skills so edits go live on restart.
- **Codex now sees the box's system prompt.** The same sandbox facts baked for
  Claude (DinD, per-box worktree, push/PR/cp via the host relay, box identity)
  now reach the in-box Codex agent via `~/.codex/AGENTS.override.md`, folded in
  beneath your own `AGENTS.md`.
- **`agentbox shell <box> --ssh-config`** writes an `~/.ssh/config` alias on
  demand so external apps (the Codex app, Claude desktop, VS Code Remote-SSH)
  can reach a box over plain SSH, and prints the identity path plus a Codex
  deep link. Hetzner only (the provider with a persistent per-box key).
- **Interactive SSH/login shells now open in `/workspace`** (the project)
  instead of the home directory, across all providers.

### Changed

- **Hetzner boxes self-heal their firewall when your egress IP changes.** Moving
  your laptop between networks used to make every box op fail with an opaque SSH
  timeout until you ran `firewall sync` by hand; now a connection failure
  auto-detects the IP change and re-syncs the per-box firewall (only when it
  actually changed). `--no-firewall-sync` opts out on shared/untrusted networks.
- **Faster, smaller Codex box setup.** Codex config staging now skips ~1 GB+ of
  host-only artifacts (macOS binaries, plugin runtimes, regenerable caches) that
  were never usable in a Linux box — a fresh box's `~/.codex` dropped from ~1.5
  GB to ~59 MB. Config, auth, skills, prompts, and plugins still sync.

### Fixed

- **`agentbox-ctl git push` from a cloud box no longer fails with "no relay
  configured".** Cloud boxes have no global env, so the in-box agent had lost
  its relay token; it's now restored via a `0600 /run/agentbox/relay.env`.
- **`agentbox git push <box> --force` is no longer silently dropped** on a
  normal remote push (it was only honored on the `--host-only` land path).
- **In-box services and `https://<box>.localhost` work from inside cloud boxes.**
  The in-box Portless CA is now trusted, so the box's own VNC Chromium and
  Playwright stop rejecting the self-signed cert. (Needs a re-`prepare` /
  docker image rebuild.)
- **Hetzner `prepare` no longer bakes a snapshot with no `claude`.** The native
  installer (which can hit an intermittent Cloudflare 403 on datacenter IPs) is
  retried with backoff and aborts the bake on persistent failure instead of
  shipping an agent-less box that crash-loops on attach.
- **Background `--no-attach` cloud starts now actually start the agent session**,
  and resume the recorded session rather than going idle.
- **`recover` / lifecycle fixes:** unpauses a paused docker box instead of
  erroring; restores only the box's last agent rather than resurrecting
  unrelated sessions; and the in-box ctl-daemon launch is now idempotent (no
  more idle-daemon pile-up on repeated start/recover).
- **Codex setup robustness:** agent home dirs are `vscode`-owned so Codex can
  create its `state_*.sqlite`; the `AGENTS.override.md` seed only reports success
  when it actually wrote; and staged dev skills symlink more reliably.

## [0.20.1] - 2026-06-25

### Added

- **git-lfs repos now check out with real content inside boxes.** LFS-tracked
  files land as their actual content instead of broken pointer files (or a
  failed seed) at both create and checkpoint-restore. Covers every provider —
  docker plus the cloud backends (daytona, hetzner, vercel, e2b). Cloud boxes
  carry only the checked-out ref's objects (no creds/network needed in-box);
  pushing box-created LFS objects back is not yet supported. Cloud providers
  need a re-`prepare` to pick up the in-box git-lfs binary.

### Fixed

- **Attaching to a box no longer flashes and exits with an unusual terminal.**
  When your terminal isn't in the box's terminfo database (e.g. Ghostty's
  `xterm-ghostty`), `agentbox claude` / `codex` / `opencode` / `shell` attach
  used to flash-quit with "missing or unsuitable terminal"; it now falls back
  to `xterm-256color`. Terminals the box does recognize keep full fidelity.
  Fixed across docker and all cloud providers.

## [0.20.0] - 2026-06-24

### Added

- **Boxes resume your running agent across a restart.** When a box stops (or a
  cloud box idle-pauses and resumes), `agentbox start` — and attaching to a
  down box, and cloud idle-wake — now relaunches the agent resuming the *same*
  conversation (`claude --resume`, `codex resume --last`) instead of opening a
  fresh session, so background/`-i` work isn't lost. Verified on docker,
  vercel, and hetzner. Requires a docker image rebuild / cloud re-`prepare`;
  until then it no-ops.
- **Headless `agentbox claude login` for non-interactive use.** Sign in without
  a TTY (CI, an orchestrating agent) via a two-call protocol:
  `agentbox claude login --headless` prints the approval URL (and a greppable
  `AGENTBOX_LOGIN_URL=` marker), then `agentbox claude login --code <CODE>`
  completes it. Headless mode is auto-selected when stdin is not a TTY;
  interactive login is unchanged.
- **E2B now runs docker-in-docker by default.** In-box docker is baked into the
  E2B base template and `dockerd` auto-starts on create/resume — nested
  containers work on E2B (full root + namespaces), matching the other cloud
  providers. Re-`prepare --provider e2b` to pick it up.
- **Configurable E2B session timeout.** New `box.e2bTimeoutMs` config key
  (default 45m, mirrors `box.vercelTimeoutMs`) records the box's real session
  lifetime so the keepalive holds the box open precisely while the agent is
  working.

### Changed

- **Non-interactive runs fail fast on a missing or expired Claude login.** The
  `-i` queue preflight and TTY-less foreground runs now check credential
  validity (expiry is consulted on cloud) and exit early with an
  `agentbox claude login` hint, instead of creating a box whose agent silently
  parks on its `/login` screen.
- **Herdr plugin is discoverable from the marketplace.** The `herdr-plugin.toml`
  manifest moved to the repo root, so the install shorthand is now
  `herdr plugin install madarco/agentbox`.

### Fixed

- **Multi-line `-i` seed prompts survive on cloud.** A multi-paragraph seed
  prompt passed to a detached cloud `-i` run was being split into one argument
  per line, killing the agent at launch; prompts are now encoded so embedded
  newlines are preserved.
- **`-i` fan-out reliably opens its Herdr terminal.** Concurrent box launches no
  longer trip "herdr gave no pane id" — JSON-RPC replies are now matched by
  request id (ignoring interleaved notifications), and pane ids with letters
  (`:pA`, `:pB`, …) are accepted.
- **Cloud `-i` start failures surface instead of reporting done.** A detached
  cloud session that fails to launch (transient SDK error, agent crash, stale
  in-box credentials) is now marked failed with an actionable hint, rather than
  silently writing `status: done` with no agent running.
- **`agentbox create --provider <cloud> -w ../repo`** now resolves a relative
  workspace path to absolute, fixing the git seed that failed with "does not
  appear to be a git repository".
- **E2B fixes:** the dashboard attach now forwards the provider env so the
  attach helper gets its inner command (right pane no longer blank); the
  create→attach pre-start no longer hangs the CLI on a blank screen.
- **Docker Claude config sync** no longer aborts (rsync exit 23) on nested
  symlinked skill dirs that point outside the box, and a box whose shared-volume
  login token was blanked by a failed in-box refresh now re-offers sign-in
  before launch instead of booting into a login error.

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
