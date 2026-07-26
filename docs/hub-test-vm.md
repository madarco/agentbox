# Hub test VM

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Deeper checklists live in [`test-plan.md`](./test-plan.md); the user-facing hub docs are [`deployed-hub.mdx`](../apps/web/content/docs/deployed-hub.mdx).

An always-on, **clean Ubuntu VPS that plays the role of a user's PC**, so the
remote-hub (control box) flow can be tested from a virgin machine — published CLI,
real `gh` credentials, no laptop state leaking in. Driven by
[`scripts/hub-test-vm.sh`](../scripts/hub-test-vm.sh).

It is **not** an agentbox box: a bare `cx33` Hetzner VM (nbg1, Ubuntu 24.04) with
node 20, docker, git, gh, tmux and a non-root `dev` user. Cost is ~€9/mo — keep it
up, it is meant to be reused.

The point is the **vault**: `/home/dev/testkit` holds the credentials
(provider keys, the test account's gh token, agent logins), so `reset` can
`rm -rf ~/.agentbox` and re-seed in a second. Every test therefore starts from a
virgin AgentBox state (no registry, no bakes, no hub config).

## Setup (once)

```sh
scripts/hub-test-vm.sh up                 # provision (~2 min)
printf %s '<PAT>' > ~/.agentbox/hub-test-vm/gh-token && chmod 600 $_
scripts/hub-test-vm.sh creds              # vault: provider keys + gh token + agent logins
scripts/hub-test-vm.sh install nightly    # or: install latest | install 0.28.0
scripts/hub-test-vm.sh testrepo           # non-LFS repo on the test account, cloned at ~/projects/agentbox-hubtest
```

- The PAT belongs to the **test account** (`madawaldos@gmail.com`), scopes
  `repo` + `workflow`. It is re-applied by every `creds`/`reset`, so `gh` is
  never manually logged in on the VM.
- `creds` copies only the [provider key allow-list](../packages/sandbox-hetzner/src/control-plane-deploy.ts)
  (`HCLOUD_TOKEN`, `E2B_API_KEY`, …) from your `~/.agentbox/secrets.env`, plus
  `~/.agentbox/*-credentials.json` (the agent logins — `--no-agent-creds` to skip).
- To test **unreleased** code instead of a published tag:
  `scripts/hub-test-vm.sh deploy` (builds this checkout, `npm pack`, installs it).

Other subcommands: `ssh` (shell, or `ssh -- <cmd>`), `run` (long command detached
in tmux, from the test project dir), `log` (tail `~/.agentbox/logs/latest.log`),
`info`, `down` (destroys the VM and stops the billing).

```sh
scripts/hub-test-vm.sh run 'agentbox create -y -n smoke'
scripts/hub-test-vm.sh log
scripts/hub-test-vm.sh ssh -- tmux attach -t work   # answer a prompt
```

## Before every test

```sh
scripts/hub-test-vm.sh reset
```

Destroys the VM's boxes by name, deletes the control box it deployed (ids read
from its own `~/.agentbox/control-plane/deploy.json`), wipes `~/.agentbox`, and
re-applies the vault. `--keep-hub` keeps the control box.

> **Never run `agentbox prune --provider <cloud>` on the VM.** It shares your
> provider accounts, and after a reset its `state.json` is empty — prune would
> see *your laptop's* sandboxes as orphans and delete them.

## Tests

Run everything from `~/projects/agentbox-hubtest` on the VM — `hub-test-vm.sh run
'<cmd>'` puts you there. Long commands tee to `~/.agentbox/logs/<cmd>.log`
(`hub-test-vm.sh log`); don't block on them.

### A. Baseline — the CLI on a clean Linux host

| # | Run | Expect |
|---|---|---|
| A0 | first `agentbox create` after a reset, **with a TTY** | the first-run wizard opens (provider picker → "build the box image now?") — `-y` does not skip it. Answer it, or run the same command through `ssh -- <cmd>` (no TTY) to auto-skip |
| A1 | `agentbox doctor` | docker ok; hetzner + e2b credentials ok; the rest warn ("not baked"/"not configured") |
| A2 | `agentbox create -y -n smoke` | pulls `agentbox/box:dev` from GHCR (no local build), ends `box smoke ready` |
| A3 | `agentbox ls` / `agentbox shell smoke -- git status` | box `running`, on branch `agentbox/smoke` |
| A4 | `agentbox url smoke` then `curl -sI <url>` | the `web` service answers (200/301) |
| A5 | `agentbox shell smoke -- 'touch f && git add -A && git commit -qm t && agentbox-ctl git push'` | approval prompt on the host relay → approve → branch on GitHub |
| A6 | `agentbox destroy smoke -y` | container + volumes gone |

### B. Baseline — a cloud provider (e2b)

| # | Run | Expect |
|---|---|---|
| B1 | `agentbox prepare --provider e2b` | builds the template from the Dockerfile, writes `~/.agentbox/e2b-prepared.json` (~10 min). `prepare` writes **no** log file — watch it with `hub-test-vm.sh ssh -- tmux capture-pane -p -t work` |
| B2 | `agentbox create -y -n cloud --provider e2b --local` | box ready; `--local` forces the PC-side build (no hub yet, but be explicit) |
| B3 | `agentbox claude cloud` | Claude starts **logged in** (the vault's `claude-credentials.json` travelled) |
| B4 | `agentbox destroy cloud -y` | sandbox gone from `Sandbox.list()` |

### C. Remote hub — deploy

| # | Run | Expect |
|---|---|---|
| C1 | `AGENTBOX_HUB_ADMIN_EMAIL=… AGENTBOX_HUB_ADMIN_PASSWORD=… agentbox hub setup --deploy hetzner` | finds the gh token, asks to copy it, provisions the VPS, ends with `https://<ip>.sslip.io` |
| C2 | `curl -sf https://<ip>.sslip.io/healthz` | 200 (a 502 means Caddy is up but the hub container isn't — see the deploy troubleshooting section of the public doc) |
| C3 | `agentbox hub status` / `agentbox hub target` | reachable; `relay.controlPlaneUrl` set |
| C4 | open `https://<ip>.sslip.io` in a browser, sign in | dashboard loads; Settings shows hetzner + e2b **configured** (the deploy carried the keys) |

Set the admin env vars inline — otherwise the deploy prompts for them and the
run can't be scripted.

### D. Remote hub — the payoff

| # | Run | Expect |
|---|---|---|
| D1 | `agentbox hub credentials push` then `agentbox hub custody list` | the agent logins are in custody |
| D2 | `agentbox hub project push` | project seed uploaded (untracked + env) |
| D3 | `agentbox create --provider e2b` (no `--local`) | routed to the control box (`cloud.viaHub` default): job enqueued, worker provisions it, `agentbox hub jobs list` shows it done. **Needs a base template the control box can see** — with neither side baked it fails fast with `no E2B base template found` (do B1 first, or bake from the hub's Settings page) |
| D4 | Web UI → **Add project** (clone the test repo on the VPS) → **Create box** | box appears in the dashboard with live status, nothing ran on the VM |
| D5 | `agentbox ls -g` | the web-created box shows as `on hub`; `agentbox attach <box>` adopts it |
| D6 | **stop the VM's relay** (`agentbox relay stop`), then in the box: `agentbox-ctl git push` | push succeeds via the control box's `gh` token; approval (non-`agentbox/*` branch) shows in the web UI and `agentbox hub prompts list` |
| D7 | `agentbox hub boxes list` / `… boxes stop <id>` / `… boxes rm <id>` | drive + destroy from the CLI over `/api/v1`. These take the box **id** from `boxes list` — a name gets `No box '<name>' on the control box` |

D6 is the whole reason the control box exists: with the laptop (here: the VM's
relay) down, the box still pushes.

### E. Teardown

```sh
scripts/hub-test-vm.sh reset       # boxes + control box + ~/.agentbox
```

Then check the [Hetzner console](https://console.hetzner.cloud) for leftovers —
servers labeled `agentbox.role=control-plane` (a failed deploy is *not* torn
down) and their firewalls keep billing.

## First pass — 2026-07-26

Run on `0.28.0-nightly.202607260716` (npm `nightly`), from a virgin `~/.agentbox`.

- **Passed:** A0–A6 (docker box on a clean Linux host, GHCR image pull, web
  service, in-box push as @madawaldos, destroy) · B1 (e2b bake, 10 min) ·
  C1–C3 (hub setup + Hetzner deploy, healthz 200, CLI repointed) ·
  D1–D3, D5–D6 (custody push, hub-routed e2b create, adopt, and **push with the
  VM's own relay stopped** — the payoff) · `reset` back to virgin.
- **Not run:** B2–B4, C4 (browser sign-in), D4 (web-UI create), D7 `boxes rm`.
- **Found:** a hub create fails fast when neither side has a base bake (D3) —
  bake first; `agentbox url` can't open a browser on Linux (known gap);
  `hub boxes <action>` needs the id, not the name.

## Gotchas

- **The VM shares your cloud accounts.** Boxes it creates sit next to your
  laptop's in the same Hetzner/E2B project. Identify a control box it deployed by
  the ids in its `~/.agentbox/control-plane/deploy.json`, not by the
  `agentbox.role=control-plane` label — your laptop's control box wears the same one.
- **Use a non-LFS repo** for anything the hub clones; the `agentbox-test-repo*`
  repos have git-LFS objects that break the control box's clone.
- **`hub setup` needs a TTY** for the "copy this token?" confirm — run it through
  `hub-test-vm.sh run` (tmux) or an interactive `hub-test-vm.sh ssh`.
- **`ssh -- 'nohup <cmd> &'` dies with the session** — the CLI's `docker pull`
  child gets killed mid-stream and the log just stops. That's what `run` (tmux)
  is for.
- **A nightly CLI must be paired with a nightly deploy ref.** `hub deploy`
  defaults `--ref` to the ref matching the installed CLI; don't pin an older one.
- Only providers whose keys exist in *your* `~/.agentbox/secrets.env` reach the
  vault. Today that's `HCLOUD_TOKEN` + `E2B_API_KEY`; run `agentbox daytona login`
  etc. on your laptop first if you want more, then re-run `creds`.
