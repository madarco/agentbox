# Testing the hub and the control box

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). The design lives in
> [`control-box-plan.md`](./control-box-plan.md); the user-facing guide is
> [`deployed-hub.mdx`](../apps/web/content/docs/deployed-hub.mdx); provider-wide regression
> checklists are in [`test-plan.md`](./test-plan.md).

Every way to exercise the hub — from a 30-second local flip to a real VPS driven from a virgin
machine. **Start at the top and only go down when the cheaper environment can't prove the thing
you changed.**

## Which environment

| | Setup | Cost | Proves | Can't prove |
|---|---|---|---|---|
| **[1. Your host](#1-your-host--hub-expose)** (`hub expose`) | seconds | free | the whole exposed/control-box code path: deployed profile, password auth, SQLite store, resident worker, `/api/v1`, approvals, web UI | nothing reaches it from a cloud box **unless you add a tunnel** |
| **[2. Inside a box](#2-inside-an-agentbox)** | ~1 min | free | the same, isolated from your real `~/.agentbox` — plus the **VPS image itself** via `docker build` | no real cloud creates from in-box; no Caddy/TLS |
| **[3. A real VPS](#3-a-real-hetzner-vps)** (`hub deploy hetzner`) | ~3 min | ~€4/mo | the deploy itself: cloud-init, compose, Caddy + Let's Encrypt, firewall, npm install, update/destroy | nothing about a *clean* client machine |
| **[4. The clean-PC VM](#4-a-clean-pc--the-hub-test-vm)** | ~2 min (reused) | ~€9/mo | the published CLI from **virgin state** — no laptop config leaking in | slowest loop; shares your cloud accounts |

A useful rule: **1 and 2 test the hub; 3 tests the deploy; 4 tests the user's first run.**

---

## 1. Your host — `hub expose`

The fastest loop, and the one to reach for when changing hub behaviour rather than deploy
mechanics. `agentbox hub expose` flips the hub you already run into the control box — same
process, deployed profile.

```sh
agentbox hub setup --deploy none        # mint credentials, provision nothing
agentbox hub expose --bind 127.0.0.1 --no-autostart
agentbox hub status                     # mode: exposed (control box, worker on)
```

`--bind 127.0.0.1 --no-autostart` is the polite test shape: loopback only, and no launchd/systemd
unit left behind on your own machine.

Undo it — this restores the plain localhost hub and clears the config:

```sh
agentbox hub unexpose -y
agentbox hub start
```

### Making it non-interactive

`hub setup` prompts for an admin email/password. To script it, pre-seed the env file and it
short-circuits:

```sh
mkdir -p ~/.agentbox/control-plane
cat > ~/.agentbox/control-plane/control-plane.env <<EOF
AGENTBOX_RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
AGENTBOX_HUB_API_KEY=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
AGENTBOX_HUB_ADMIN_EMAIL=test@example.com
AGENTBOX_HUB_ADMIN_PASSWORD=$(openssl rand -hex 12)
EOF
chmod 600 ~/.agentbox/control-plane/control-plane.env
```

### Testing the parts that need a real cloud box

Loopback and LAN are unreachable from a Firecracker microVM, so a cloud box will not register.
Add a tunnel and the whole remote-hub story works from your laptop, no VPS:

```sh
agentbox hub expose --tunnel cloudflare      # zero-account, ephemeral hostname
agentbox create --provider e2b               # routes to the hub; box calls home over the tunnel
```

This is the cheap way to exercise registration, approvals, `agentbox-ctl git push` through the
hub, and the queue — the things that only happen when a box can actually reach it.

### Snapshot before, compare after

`hub expose` writes real state on your machine. Capture it first so you can prove the teardown
was clean:

```sh
agentbox hub status; agentbox config get relay.controlPlaneUrl
ls ~/.agentbox/control-plane 2>/dev/null; ls ~/Library/LaunchAgents | grep -i agentbox
```

After `hub unexpose` all four should be back where they started.

---

## 2. Inside an agentbox

Same as above but isolated from your real `~/.agentbox`, which makes it the right place for
anything that writes credentials or fights over port 8787.

```sh
agentbox claude --shared-docker-cache --carry-yes    # box with agentbox built and on PATH
```

Then inside the box, the section-1 recipe works as-is. Two box-specific notes:

- The box has no cloud credentials unless you carried them, so hub-driven **creates** will fail;
  registration, approvals and the API surface all still work.
- Build images with `docker build --network=host -t agentbox/box:dev -f apps/cli/runtime/docker/Dockerfile.box apps/cli/runtime/docker`
  rather than `agentbox prepare` — the box runs without `CAP_SYS_PTRACE`.

### Testing the VPS image itself, without a VPS

A box has docker, so it can build and run the *actual* hub image the deploy ships. This catches
Dockerfile and boot problems in a minute instead of a five-minute deploy:

```sh
docker build --network=host -f apps/hub/Dockerfile -t agentbox-hub .
docker run --rm -p 8787:8787 \
  -e AGENTBOX_HUB_PROFILE=hetzner -e AGENTBOX_HUB_WORKER=on -e AGENTBOX_HUB_WORKER_MOCK=1 \
  -e AGENTBOX_RELAY_ADMIN_TOKEN=t -e BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
  -e AGENTBOX_HUB_ADMIN_EMAIL=a@b.c -e AGENTBOX_HUB_ADMIN_PASSWORD=pw \
  -v "$HOME/.agentbox:/root/.agentbox" agentbox-hub
```

`/healthz` should answer `ok:true` with `profile:"hetzner"`, better-auth should accept the admin
login, and a `docker restart` should preserve `store.db` / `auth.db` / `custody/` on the volume.
Use `-f apps/hub/Dockerfile.package` to test the **npm-install** image the deploy actually uses by
default (pass `--build-arg AGENTBOX_SPEC=<version>`).

---

## 3. A real Hetzner VPS

The only way to test the deploy itself. Needs `agentbox hetzner login`.

```sh
agentbox hub setup --deploy hetzner     # first time: credentials + provision
agentbox hub deploy hetzner             # thereafter: reuses ~/.agentbox/control-plane
```

### Choosing what the VPS runs

By default it installs `@madarco/agentbox` pinned to your CLI's exact version — so the two sides
always match, which is also what makes shared bake fingerprints line up.

```sh
agentbox hub deploy hetzner                          # this CLI's version (default)
agentbox hub deploy hetzner --package nightly        # a different npm spec
agentbox hub deploy hetzner --ref my-branch          # build from source on the VPS
agentbox hub deploy hetzner --repo me/fork           # a fork (implies --ref)
agentbox hub deploy hetzner --domain hub.example.com # your own hostname
```

**`--ref` is how you test unreleased code**, and a CLI you built yourself falls back to it
automatically (a dev version has nothing published to install).

### Lifecycle

```sh
agentbox hub status      # url, live version, channel, drift nudge
agentbox hub update      # move it to a new build in place, keeping its data volume
agentbox hub destroy     # VPS + firewall + this machine's control-plane state
```

`hub update --package <older-version>` is a good deliberate-downgrade test: a build that can't run
with the current config must **fail**, not report success.

### Gotchas specific to the VPS

- **Let's Encrypt rate limits bite on recycled IPs.** An sslip.io hostname is derived from the IP,
  and Hetzner reuses released addresses. Land on one that already had five certs this week and
  HTTPS never comes up on a perfectly healthy hub. Destroy and redeploy for a different address,
  or use `--domain`. The deploy now names this explicitly instead of blaming the upstream port.
- **A failed deploy is not torn down** — the VPS and its firewall keep billing. `agentbox hub
  destroy` clears them; otherwise check the [Hetzner console](https://console.hetzner.cloud) for
  servers labelled `agentbox.role=control-plane`.
- **Deploy logs** are at `~/.agentbox/logs/hub-deploy.log` (`hub-update.log` for updates), and the
  VPS is reachable at `ssh agentbox-hub`. Only `:22` is IP-locked; `:80`/`:443` are open so boxes
  can reach the hub from anywhere.

---

## 4. A clean PC — the hub test VM

An always-on, **clean Ubuntu VPS that plays the role of a user's PC**, so the remote-hub flow can
be tested from a virgin machine — published CLI, real `gh` credentials, no laptop state leaking
in. Driven by [`scripts/hub-test-vm.sh`](../scripts/hub-test-vm.sh).

It is **not** an agentbox box: a bare `cx33` Hetzner VM (nbg1, Ubuntu 24.04) with node 20, docker,
git, gh, tmux and a non-root `dev` user. ~€9/mo — keep it up, it is meant to be reused.

The point is the **vault**: `/home/dev/testkit` holds the credentials (provider keys, the test
account's gh token, agent logins), so `reset` can `rm -rf ~/.agentbox` and re-seed in a second.
Every test therefore starts from a virgin AgentBox state — no registry, no bakes, no hub config.

### Setup (once)

```sh
scripts/hub-test-vm.sh up                 # provision (~2 min)
printf %s '<PAT>' > ~/.agentbox/hub-test-vm/gh-token && chmod 600 $_
scripts/hub-test-vm.sh creds              # vault: provider keys + gh token + agent logins
scripts/hub-test-vm.sh install nightly    # or: install latest | install 0.28.0
scripts/hub-test-vm.sh testrepo           # non-LFS repo, cloned at ~/projects/agentbox-hubtest
```

- The PAT belongs to the **test account** (`madawaldos@gmail.com`), scopes `repo` + `workflow`. It
  is re-applied by every `creds`/`reset`, so `gh` is never manually logged in on the VM.
- `creds` copies only the [provider key allow-list](../packages/sandbox-hetzner/src/control-plane-deploy.ts)
  (`HCLOUD_TOKEN`, `E2B_API_KEY`, …) from your `~/.agentbox/secrets.env`, plus
  `~/.agentbox/*-credentials.json` (the agent logins — `--no-agent-creds` to skip).
- To test **unreleased** code instead of a published tag: `scripts/hub-test-vm.sh deploy` (builds
  this checkout, `npm pack`, installs it).

Other subcommands: `ssh` (shell, or `ssh -- <cmd>`), `run` (long command detached in tmux, from
the test project dir), `log` (tail `~/.agentbox/logs/latest.log`), `info`, `down` (destroys the VM).

```sh
scripts/hub-test-vm.sh run 'agentbox create -y -n smoke'
scripts/hub-test-vm.sh log
scripts/hub-test-vm.sh ssh -- tmux attach -t work   # answer a prompt
```

### Before every test

```sh
scripts/hub-test-vm.sh reset
```

Destroys the VM's boxes by name, deletes the control box it deployed (ids read from its own
`~/.agentbox/control-plane/deploy.json`), wipes `~/.agentbox`, and re-applies the vault.
`--keep-hub` keeps the control box.

> **Never run `agentbox prune --provider <cloud>` on the VM.** It shares your provider accounts,
> and after a reset its `state.json` is empty — prune would see *your laptop's* sandboxes as
> orphans and delete them.

### The matrix

Run everything from `~/projects/agentbox-hubtest` — `hub-test-vm.sh run '<cmd>'` puts you there.
Long commands tee to `~/.agentbox/logs/<cmd>.log`; don't block on them.

#### A. Baseline — the CLI on a clean Linux host

| # | Run | Expect |
|---|---|---|
| A0 | first `agentbox create` after a reset, **with a TTY** | the first-run wizard opens (provider picker → "build the box image now?") — `-y` does not skip it. Answer it, or run through `ssh -- <cmd>` (no TTY) to auto-skip |
| A1 | `agentbox doctor` | docker ok; hetzner + e2b credentials ok; the rest warn ("not baked"/"not configured") |
| A2 | `agentbox create -y -n smoke` | pulls `agentbox/box:dev` from GHCR (no local build), ends `box smoke ready` |
| A3 | `agentbox ls` / `agentbox shell smoke -- git status` | box `running`, on branch `agentbox/smoke` |
| A4 | `agentbox url smoke` then `curl -sI <url>` | the `web` service answers (200/301) |
| A5 | `agentbox shell smoke -- 'touch f && git add -A && git commit -qm t && agentbox-ctl git push'` | approval prompt on the host relay → approve → branch on GitHub |
| A6 | `agentbox destroy smoke -y` | container + volumes gone |

#### B. Baseline — a cloud provider (e2b)

| # | Run | Expect |
|---|---|---|
| B1 | `agentbox prepare --provider e2b` | builds the template from the Dockerfile, writes `~/.agentbox/e2b-prepared.json` (~10 min). `prepare` writes **no** log file — watch with `hub-test-vm.sh ssh -- tmux capture-pane -p -t work` |
| B2 | `agentbox create -y -n cloud --provider e2b --local` | box ready; `--local` forces the PC-side build |
| B3 | `agentbox claude cloud` | Claude starts **logged in** (the vault's `claude-credentials.json` travelled) |
| B4 | `agentbox destroy cloud -y` | sandbox gone from `Sandbox.list()` |

#### C. Remote hub — deploy

| # | Run | Expect |
|---|---|---|
| C1 | `AGENTBOX_HUB_ADMIN_EMAIL=… AGENTBOX_HUB_ADMIN_PASSWORD=… agentbox hub setup --deploy hetzner` | finds the gh token, asks to copy it, provisions the VPS, ends with `https://<ip>.sslip.io` |
| C2 | `curl -sf https://<ip>.sslip.io/healthz` | 200 (a 502 means Caddy is up but the hub container isn't) |
| C3 | `agentbox hub status` / `agentbox hub target` | reachable; version + channel shown; `relay.controlPlaneUrl` set |
| C4 | open `https://<ip>.sslip.io`, sign in | dashboard loads; Settings shows hetzner + e2b **configured** |

Set the admin env vars inline — otherwise the deploy prompts and the run can't be scripted.

#### D. Remote hub — the payoff

| # | Run | Expect |
|---|---|---|
| D1 | `agentbox hub credentials push` then `agentbox hub custody list` | the agent logins are in custody |
| D2 | `agentbox hub project push` | project seed uploaded (untracked + env) |
| D3 | `agentbox create --provider e2b` (no `--local`) | routed to the control box (`cloud.viaHub` default): job enqueued, worker provisions it, `agentbox hub jobs list` shows it done. **Needs a base template the control box can see** — with neither side baked it fails fast with `no E2B base template found` (do B1 first, or bake from the hub's Settings page) |
| D4 | Web UI → **Add project** (clone the test repo on the VPS) → **Create box** | box appears in the dashboard with live status, nothing ran on the VM |
| D5 | `agentbox ls -g` | the web-created box shows as `on hub`; `agentbox attach <box>` adopts it |
| D6 | **stop the VM's relay** (`agentbox relay stop`), then in the box: `agentbox-ctl git push` | push succeeds via the control box's `gh` token; approval (non-`agentbox/*` branch) shows in the web UI and `agentbox hub prompts list` |
| D7 | `agentbox hub boxes list` / `… boxes stop <id>` / `… boxes rm <id>` | drive + destroy from the CLI over `/api/v1`. These take the box **id** from `boxes list` — a name gets `No box '<name>' on the control box` |

D6 is the whole reason the control box exists: with the laptop (here: the VM's relay) down, the
box still pushes.

#### E. Teardown

```sh
scripts/hub-test-vm.sh reset       # boxes + control box + ~/.agentbox
```

Then check the Hetzner console for leftovers.

### First pass — 2026-07-26

Run on `0.28.0-nightly.202607260716` (npm `nightly`), from a virgin `~/.agentbox`.

- **Passed:** A0–A6 · B1 · C1–C3 · D1–D3, D5–D6 (including **push with the VM's own relay
  stopped** — the payoff) · `reset` back to virgin.
- **Not run:** B2–B4, C4 (browser sign-in), D4 (web-UI create), D7 `boxes rm`.
- **Found:** a hub create fails fast when neither side has a base bake (D3) — bake first;
  `agentbox url` can't open a browser on Linux (known gap); `hub boxes <action>` needs the id.

---

## Gotchas that bite in every environment

- **The hub is a daemon — rebuild AND restart it.** A running hub keeps serving stale code after
  you edit `apps/hub/**` or anything it imports (`@agentbox/relay`, `@agentbox/sandbox-docker`, …).
  The staged bundle the CLI spawns is refreshed by `build:standalone`, **not** by a plain CLI
  build, so:
  ```sh
  pnpm --filter @agentbox/hub build:standalone
  pnpm --filter @madarco/agentbox stage
  agentbox hub restart
  ```
  Symptom when you forget: a change that is definitely in the source doesn't show up — e.g.
  `hub status` missing a field the running hub never learned to report.
- **Use a non-LFS repo** for anything the hub clones; the `agentbox-test-repo*` repos have git-LFS
  objects that break the control box's clone.
- **`hub setup` needs a TTY** for the "copy this token?" confirm.
- **A nightly CLI pairs with a nightly deploy.** The default (npm, pinned to your CLI's version)
  gets this right; only `--ref`/`--package` can put the two sides out of step.
- **Cloud accounts are shared** between your laptop, boxes and any test VM. Identify a control box
  by the ids in the relevant `deploy.json`, not by the `agentbox.role=control-plane` label — every
  control box wears it.
