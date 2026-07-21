# Control Hub — architecture & roadmap

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Forward-looking design + roadmap for
> the **Control Hub** — the always-on custodian that creates, hosts, and manages boxes so they keep
> working with the laptop off. **"Control Hub" (CLI `agentbox hub`) is the new name for what the code
> currently calls "control-plane"** (config key `relay.controlPlaneUrl`, `apps/control-plane`); the
> rename is milestone **M1** below. What already shipped under the old name is in
> [`control-plane-backlog.md`](./control-plane-backlog.md). See also [`host-relay.md`](./host-relay.md),
> [`in-box-supervisor.md`](./in-box-supervisor.md), and [`control-plane-guide.md`](./control-plane-guide.md).

## Context — where we are and why this changes

The hosted control plane already works: one `@agentbox/relay` core, deployed as a Next.js + Postgres
app to Vercel (serverless) or a Hetzner VPS (container), with GitHub-App token leasing, poll-based
approvals, a durable `create_jobs` queue, and a worker that creates cloud boxes (backlog Phases 0–6,
all shipped). But three things block the real goal:

1. **Box creation still requires a long-running host that *drives* it.** `provider.create()` runs ~16
   host→box round trips (`packages/sandbox-cloud/src/cloud-provider.ts`), and the plane's worker
   (`apps/cli/src/control-plane/create-box.ts`) clones the repo to local disk before calling it — so a
   serverless function can't do it, and the local + plane create paths are two code paths.
2. **The hub is a "second brain" that competes with your PC**, not an extension of it — and your PC is
   the real source of truth (envs, custom CLI logins, secrets). Moving everything to the cloud loses that.
3. **Local-first isn't first-class.** Postgres is required even for a single user on their own laptop.

The goal of this roadmap: **an always-on hub you can spawn boxes from — from your PC exactly like
today, *and* directly from the hub's web UI** — built by *unifying* creation on an in-box, pollable
model rather than duplicating it, and by treating your PC as the default hub with real sync, not a
cloud replacement.

## The three shifts

1. **In-box create/bake + poll (the load-bearing refactor).** The setup/bake work runs *inside the box*
   (detached, under tmux/screen); the creator — local host relay *or* serverless plane — only **polls
   status**. One creation code path, connection-drop resilient, serverless-compatible. See §2.
2. **Hub-anywhere, PC-first.** The hub runs on your PC by default (SQLite, inside the relay), on a
   server/container, or serverless — same core, different capability profile (§3). Your PC is a hub
   until you install a dedicated one; then the dedicated one is primary and the local one points at it.
3. **Custody + 3-way sync, not cloud lock-in.** The hub becomes a custodian of the things a box needs
   (git tokens — done; agent creds; SSH keys; secrets/envs) with explicit sync back to your PC, so
   "boxes as an extension of your PC" stays true even with the PC off (§5, §6).

## 1. One relay core, many topologies

There is one relay implementation (`@agentbox/relay`, core in `packages/relay/src/core/handler.ts`)
behind an async **Store seam** (`packages/relay/src/store/`, selected by `makeStore()`). It runs in
these shapes:

| Topology | Store | Approval | Capability profile | Status |
|---|---|---|---|---|
| **Local host** (your PC, inside `agentbox relay`, first-install default) | **SQLite** (new) | `block` | full-host | new (M2) |
| **Mac mini** (always-on local host + 3-way sync) | SQLite | `block`/`poll` | full-host + private-cloud | later |
| **Server / container** (Hetzner, DO, Render, Fly, Railway) | Postgres | `poll` | full-host (DinD, clone-all) | partial |
| **Serverless** (Vercel now; **Cloudflare** later) | Postgres (Neon) | `poll` | serverless (leased, in-box create, throwaway sandbox) | shipped (Vercel) |

**PC-is-a-hub-by-default:** on first `agentbox` install the local relay *is* the hub (SQLite). If the
user runs `agentbox hub install` to stand up a dedicated hub, that becomes primary; the local endpoint
detects a configured `relay.controlPlaneUrl`/hub and just **shows a message linking to it** instead of
acting as the brain. `pg` is already lazy-imported + tsup-external so the laptop bundle carries no
Postgres; **SQLite must follow the same pattern** (lazy import, `externalAtRuntime`, a `makeStore()`
branch, mirror `PostgresStore`'s `SCHEMA_SQL`). Dep choice is open (`node:sqlite` needs Node ≥ 22.5 but
`engines` floors at 20.10; `better-sqlite3` is a guarded native dep like `node-pty`) — see Risks.

## 2. The unified in-box create/bake + poll model

**Today (host-driven):** `create()` runs `seedCloudWorkspace` (heavy host-git seed) + ~10 more
host→box seed steps (agent creds, codex override, git identity, claude-json, dynamic config, env files,
carry) and then `kickCloudBootstrap` — one exec the host **awaits**. The plane worker reuses all of this
by cloning host-side first, so it needs a persistent host.

**What already exists to build on:**
- **A single in-box entry point** — `agentbox-ctl bootstrap` (`packages/ctl/src/commands/bootstrap.ts`):
  idempotent, detaches its daemons, already does optional **in-box clone** (the `inBoxClone` seam that
  *bypasses* `seedCloudWorkspace`) + dockerd + ctl + VNC.
- **A poll-based, drop-resilient status channel** — in-box `StatusReporter`
  (`packages/ctl/src/status-reporter.ts`) pushes status to the in-box relay; the host `CloudBoxPoller`
  (`packages/relay/src/cloud-poller.ts`) drains `GET /bridge/poll` with cursor + exponential backoff +
  tunnel recovery. This is exactly "push status, poll it, survive drops" — for *runtime* status.

**The refactor:**
- **Move the seed steps in-box.** Extend `agentbox-ctl bootstrap` (or a sibling `agentbox-ctl create`)
  to perform the seeding itself, fed a small **create manifest** + **leased URLs** instead of host
  round trips: workspace via the existing `inBoxClone`; agent creds/config/env fetched by the box from
  the hub (leased, per-box token) rather than pushed step-by-step from the host. Pure in-box command
  steps (chown, codex override, git identity) relocate trivially.
- **Run it detached under tmux** so the box keeps going if the creator disconnects, and **report
  creation-progress** through the *existing* StatusReporter → `/bridge/poll` channel (add a
  `create phase/percent/error` field). The creator (host relay or plane) **polls the create job** —
  `GET /remote/boxes/:id` / `/bridge/poll` — instead of driving.
- **Local host uses the same path**: the relay kicks the in-box create, then attaches/polls the tmux
  session to show live progress — no more per-step drive, so laptop sleeps/network blips don't abort a
  create.
- **Serverless orchestration = Vercel Workflow (WDK).** The durable "kick → poll until ready/failed"
  loop for create and bake runs as a Vercel Workflow (greenfield — none in the repo today), replacing
  the ad-hoc `setTimeout` poll loops and the need for a resident worker. Cloudflare Workflows later.

**Bake follows the same shape.** Hetzner/Vercel prepare already runs an install script *inside a temp
box* (`agentbox-install.sh` / `agentbox-provision.sh`) with the host streaming synchronously; make that
**detached + poll** so a serverless hub can bake. Daytona/E2B already build server-side (SDK) — the hub
just kicks + polls those.

Net: `drainCreateJobs` becomes serverless-runnable, the plane worker becomes **optional**, and the
laptop + hub create paths are **one** path.

## 3. Two capability profiles (mapping the legacy terms)

The same hub exposes different capabilities by where it runs. These map the two matrices from the design
notes: the notes' "control plane" is the **serverless profile**; the notes' "control-box" is the
**full-host profile**.

### Serverless profile ("control plane" — Vercel / Cloudflare)
| Concern | Approach |
|---|---|
| Local↔hub forward | **Done** — box forwards ops through the hosted relay. |
| Git auth | **Done** — GitHub-App leased 1h repo-scoped token. |
| Box create | In-box create + poll (§2). Hetzner still mints an SSH key — move keygen to **pure-Node `crypto`** (today it shells `ssh-keygen`, `packages/sandbox-hetzner/src/ssh-key.ts`). The per-box **SSH key is stored on the hub** and must be **downloadable to the host** (new — no backup path exists today). |
| Box bake | Long task → **throwaway Vercel sandbox**, or in-box tmux/screen + poll (§2). |
| HTTPS | Vercel managed = fine. Hetzner `<ip>.sslip.io` has Let's Encrypt **rate-limit** risk — needs a better cert story. |
| Agent creds | **Store on the hub** (uploaded from the host). **Refresh via a throwaway sandbox** — generalize the *existing* docker-container Claude refresh (`packages/sandbox-docker/src/claude-credentials.ts` `syncClaudeCredentials` + `_claude-login-worker`) to a cloud throwaway box. |
| Local portless/tunnel | SSH tunnel from Hetzner **if the host can download the box SSH key** (ties to Box-create). |
| Multi-project | A DB/registry setting. |
| Secrets/envs | Live on the host today → the hub needs a **secret store** (upload once / update). The source-of-truth call-out (§4). |

### Full-host profile ("control-box" — server/container: Hetzner, Render, Fly, Railway; and local/mac-mini)
| Concern | Approach |
|---|---|
| Local↔hub forward | **Done.** |
| Managed box | Fine on a server (always-on). Note Vercel-serverless can't auto-wake a box on inbound HTTP — a full-host hub can. |
| Box create | Essentially as today (host execution available) **+ SSH-key backup/download**. |
| Box bake | As today. |
| HTTPS | `sslip.io` for now (same rate-limit caveat). |
| Agent creds | **DinD from the hub box** — run the throwaway-container refresh locally on the hub. |
| Local portless/tunnel | Same, gated on SSH-key download. |
| Multi-project | Clone **all** projects into this always-on Ubuntu host. |
| Secrets/envs | Inside each project, like the host — no separate store needed. |
| **Private cloud** | The server hub can use **local-docker as the provider** — boxes run on your own always-on machine, driven from your PC (3-way sync) or the hub web UI. |

## 4. The source-of-truth tension (design constraint, not a feature)

Moving the brain off your PC is powerful (always-on, mobile) but your PC is where the real state lives:
env vars, and **custom CLI logins** (Notion is handled; AWS, Terraform, GCP, etc. are not). A box is a
great *extension* of a PC that can do everything; a hub that tries to *replace* the PC inherits the hard
problem of reproducing all that state. This roadmap deliberately keeps the PC first-class and treats the
hub as **custody + reach**, mitigated by: the hub secret/env store (serverless profile), DinD-local
creds (full-host profile), the throwaway-sandbox cred refresh, SSH-key custody + download, and 3-way
sync. The **private-cloud** option (full-host hub using local-docker) sidesteps most of it by keeping
execution on your own always-on machine.

## 5. Headline features

- **Always on** — turn your PC off; boxes keep running, pushing, and opening PRs.
- **3-way sync** — launch a box from your PC, continue from mobile (hub web UI), download the result
  back to your PC.
- **Private cloud** — a server/mac-mini hub runs boxes on your own machine via local-docker, driven from
  the PC or the web UI.
- **Spawn from the web UI** — create/start/stop/destroy + live box status + agent control from the browser.

## 6. CLI / UX surface (the rename + new commands)

- **Rename `control-plane` → `hub`** across CLI, config, package, docs (~317 refs; `apps/control-plane`
  → `apps/hub`, `apps/cli/src/control-plane/` dir, `@agentbox/control-plane` package,
  `vercel.json` build filter). The config key `relay.controlPlaneUrl` and the CLI verbs are the only
  *user-facing* surface — since **AgentBox is unreleased, rename cleanly (no alias/deprecation)**, per
  project convention.
- `agentbox hub` (default `status`) → when no hub is configured, **hint `agentbox hub install`** (not
  `set-url`), with the text **"Install agentbox hub and set up the GitHub App."**
- `agentbox hub install` (was `setup`) → **prompt before opening the browser** for both the App-create
  and App-install steps ("press Enter to open …").
- `agentbox hub update` (new) → update the deployed hub (git-pull the fork / redeploy the Vercel/Hetzner
  install to the latest ref).
- `agentbox hub uninstall` (new) → tear down the Vercel project / Hetzner VPS created by `install`.
- `agentbox hub status | set-url | add | worker` — retained (renamed).
- `agentbox relay` → **show whether a hub is in use** (print the configured hub URL + reachability in
  `relay status`; today it prints none).
- **Setup UX:** when a project is added, detect its repo and **prompt to authorize it on the App**
  (show the URL / open the browser) — extend `ensureProjectRepoOnControlPlane`.
- **Web UI:** a polished dashboard (open boxes, box info, a `top`-style live view, and **API docs /
  Swagger**) — **shared between the hub and the local relay** so it isn't duplicated. Autogenerated
  unique GitHub-App name is already done.

## 7. Roadmap (milestones)

- **M0 — Foundation (DONE).** Bring-up on `agentbox-ctl bootstrap` + `inBoxClone`; GitHub-App leasing;
  Store seam (Memory/Postgres); poll approvals; `create_jobs` queue + worker; Next.js app + dashboard;
  Vercel + Hetzner deploy. (Backlog Phases 0–6.)
- **M1 — Rename to Hub.** `control-plane` → `hub` across CLI/config/package/docs; new `hub install`
  prompts + `hub update`/`hub uninstall`; `relay status` shows the hub. Clean rename (unreleased).
- **M2 — Local-first hub (SQLite).** `SqliteStore` behind `makeStore()`; the local relay *is* the hub
  by default; a dedicated hub takes over as primary and the local endpoint links to it.
- **M3 — In-box create + poll (unification).** Move the seed sequence in-box (create manifest + leased
  fetch, reusing `inBoxClone`); add a **creation-progress** field on the StatusReporter/`bridge/poll`
  channel; retarget the host relay *and* the plane worker from "drive" to "kick + poll." Drops the
  host-driven create; makes `drainCreateJobs` serverless-runnable; unifies laptop + hub paths.
- **M4 — Serverless orchestration + cred refresh.** Vercel Workflow (WDK) for the durable create/bake
  poll; **throwaway-sandbox agent-cred refresh** generalized from the docker precedent.
- **M5 — Custody + sync.** Hub secret/env store (upload/update); **SSH-key store + host download**
  (+ hetzner keygen → pure-Node `crypto`); agent-cred store; **3-way sync** (PC ↔ hub ↔ mobile).
- **M6 — Bake from the hub.** In-box tmux + poll bake for hetzner/vercel; server-side kick + poll for
  daytona/e2b — base snapshots without the laptop.
- **M7 — Web UI polish.** Spawn-from-browser, live `top` view, API/Swagger docs; shared with the local
  relay UI.
- **M8+ — Reach.** Cloudflare serverless target; **private-cloud** (full-host hub with local-docker
  provider); mac-mini 3-way-sync deployment.

## 8. Reuse (existing pieces the plan builds on)

- In-box entry + self-clone: `agentbox-ctl bootstrap` (`packages/ctl/src/commands/bootstrap.ts`),
  `kickCloudBootstrap` + `CreateBoxRequest.inBoxClone` (`packages/sandbox-cloud/src/bootstrap-launch.ts`).
- Poll/status substrate: `StatusReporter` (`packages/ctl/src/status-reporter.ts`), `CloudBoxPoller` +
  `/bridge/poll` (`packages/relay/src/cloud-poller.ts`), `agentbox-ctl wait-ready`.
- Queue + worker: `create_jobs` + `drainCreateJobs` (`packages/relay/src/create-worker.ts`, `store/`),
  `POST /remote/boxes` (`core/handler.ts`), `makeControlPlaneCreateBox` (`apps/cli/src/control-plane/`).
- Leasing: `GitHubAppLeaser` / `leaseTokenResult` / `toAuthedHttpsUrl` (`packages/relay/src/`).
- Store seam: `makeStore()` + `PostgresStore` (lazy `pg`, tsup external) as the SqliteStore template.
- Cred refresh precedent: `syncClaudeCredentials` + `_claude-login-worker`
  (`packages/sandbox-docker/src/claude-credentials.ts`, `apps/cli/src/commands/_claude-login-worker.ts`).
- Deploy + HTTPS: `deploy-vercel.ts` / `deployControlPlaneToHetzner` + Caddy/sslip.io; `hetzner firewall sync`.

## 9. Risks / open questions

- **SQLite dep** — `node:sqlite` (needs Node ≥ 22.5; `engines` floors at 20.10) vs `better-sqlite3`
  (native, but guarded like `node-pty`). Decide before M2.
- **Vercel Workflow maturity** for long create/bake polls; Cloudflare Workflows parity for M8.
- **SSH-key custody** — encrypted at rest, admin-gated download, never logged; the key leaving the
  minting host is a new trust edge.
- **Secret/env store** — which host state can be reproduced on the hub (Notion yes; AWS/Terraform/GCP
  logins are the hard cases) — scope M5 to what's safe + useful, keep the PC authoritative.
- **Config-key rename** is user-facing; clean rename is fine only because AgentBox is unreleased.
- **In-box seed migration** — the data-upload steps (claude-json, dynamic config, env files, carry) must
  become box-pulled/leased without regressing the docker + laptop paths (keep host-seed as a fallback).

## Verification (per milestone, end-to-end)

- **M1:** `agentbox hub` / `hub install` / `hub status` work; `relay status` shows the hub; grep shows
  no stale `control-plane` user-facing refs; existing configs migrate. `pnpm --filter @agentbox/relay
  test` + CLI typecheck green.
- **M2:** local relay boots as a hub on SQLite (no Postgres); `/healthz` reports `db:true`; installing a
  dedicated hub flips primary and the local endpoint links to it. Store conformance suite green for SQLite.
- **M3:** create a cloud box (vercel/e2b/hetzner) with the host relay disconnected mid-create — the box
  finishes and reports ready via poll; the same job runs from the plane worker with no local clone.
  Verify a real `claude -p` turn + `agentbox-ctl git push` on `agentbox/*` (as this session did).
- **M4/M6:** a serverless hub creates and bakes with no resident worker (Vercel Workflow drives the poll);
  a throwaway sandbox refreshes an expired Claude token and writes it back to the hub store.
- **M5:** `agentbox hub pull <box>` downloads the SSH key + secrets to `~/.agentbox/...`; laptop
  attach/tunnel works against a hub-created hetzner box; 3-way sync round-trips a box PC→hub→PC.
