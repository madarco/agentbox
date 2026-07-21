# The Control Plane (formerly "control-box") — feature guide

The **hosted control plane** is a small, portable service that holds the
centralized concerns for boxes — git credentials, permission/approval state, and
the box registry/events — so cloud boxes keep pushing commits and opening PRs
**even when the user's laptop is off**.

Today those concerns live in the laptop's loopback relay (`agentbox relay`), which
only works while the laptop is awake and reachable. The control plane moves that
same relay brain to an always-reachable HTTPS service, without giving boxes any
long-lived secret.

> **Naming — "control-box" vs "control plane".** "Control-box" is the **old name**
> for this feature. The v1 design (`agentbox control-box`, `sandbox-hetzner/control-box.ts`)
> ran the relay on a dedicated always-on VPS holding a long-lived fine-grained
> **PAT**, and pushed by reaching back into the box over the cloud SDK to build +
> download a git bundle. That was **removed** and replaced by the portable hosted
> control plane described here (commits `refactor: rename control-box -> control plane`
> and `refactor(relay): remove the legacy --control-box mode + PAT bundle-push`).
> The config key was renamed `relay.controlBoxUrl` → `relay.controlPlaneUrl`.
> There is no "control-box" thing anymore — wherever you see it, read "control plane".

Design of record: [`control-plane-roadmap.md`](./control-plane-roadmap.md)
and [`control-plane-backlog.md`](./control-plane-backlog.md).

---

## 1. The mental model — one relay core, three topologies

There is **one** relay implementation (`@agentbox/relay`) that runs in three shapes:

| Shape | Where | Approval mode | Persistence |
|---|---|---|---|
| **Laptop loopback relay** | your machine (`agentbox relay`) | `block` (waits in-process for you to confirm) | in-memory |
| **Hosted plane on Vercel** | serverless Next.js + Neon Postgres | `poll` (parks a prompt row, box polls for the answer) | Postgres |
| **Hosted plane on a VPS** | Hetzner docker-compose (Postgres + `next start`) | `poll` | Postgres |

The plane is **stateless per request** (all state in Postgres) and does **no host
execution** — it never runs `git` or SSHes into a box. Its only job is to be a
**custodian**: mint short-lived git tokens, hold approval state, and keep the box
registry/events. A box cannot tell whether it is talking to a block-mode laptop
relay or a poll-mode hosted plane — the box-side client absorbs the difference.

---

## 2. How it works — the moving parts

### a. Shared relay core + the "Store seam"
The framework-agnostic core is `packages/relay/src/core/handler.ts`
(`handleRelayRequest(request) → response`). Every handler talks to an async
**`Store`** interface (`packages/relay/src/store/store.ts`) covering boxes, events,
status, the approval-prompt mailbox, and a box-create job queue. Two
implementations back it:
- `MemoryStore` (`store/memory-store.ts`) — the laptop relay + tests (unchanged legacy behavior).
- `PostgresStore` (`store/postgres-store.ts`) — the hosted plane. `pg` is **lazy-imported**
  and marked bundler-external, so the laptop CLI/relay never pull Postgres into their bundle.

The Next.js app (`apps/control-plane/`) is a thin adapter: a single catch-all route
(`app/[...path]/route.ts`) forwards every GET/POST into the core via
`lib/plane.ts`. The lean entrypoint it imports is `packages/relay/src/control-plane.ts`,
which deliberately re-exports **only** the framework-agnostic pieces (no `node:http`
server, no host execution, no cloud SDKs).

### b. Git auth = GitHub-App token leasing (the security core)
Files: `packages/relay/src/github-app.ts` (`GitHubAppLeaser`) and `lease.ts`
(`leaseTokenResult`). The plane holds only the **GitHub App's private key + app id** —
never a PAT, never a box's repo credentials. When a box needs to push, it asks the
plane to **lease** a token; the plane mints a **≤1-hour, single-repo installation
token** (`contents: write`, `pull_requests: write`) and returns it.

Two invariants make this safe:
- The repo is always re-derived from the **box's registered `originUrl`**, never from
  box-supplied params — a box can only ever lease a token for its own repo.
- The **lease gate == the push gate**: an `agentbox/*` branch auto-approves (no
  prompt); anything else runs the approval flow. Compromise of one box yields at
  most a 1-hour, single-repo credential.

### c. Approvals — `block` vs `poll`
File: `packages/relay/src/permission.ts` (`gateApproval`, `PromptMode`).
- **block** (laptop): waits in-process on a Promise until you answer — the behavior
  you have today.
- **poll** (hosted plane, can't block): applies store fast-paths (`AGENTBOX_PROMPT=off`
  or a box's `autoApproveHostActions` → allow), else **parks a prompt row** and returns
  `202 {promptId}`. A human answers via `POST /admin/prompts/answer` (or the built-in
  dashboard at the plane's `/`); the box polls `GET /rpc/status/:promptId` until the
  answer lands, then the approved action runs there.

### d. The dual-mode `node:http` relay, the bridge, and the CloudBoxPoller
`packages/relay/src/server.ts` is the laptop/in-box relay and runs in two modes
(`RelayMode = 'host' | 'box'`):
- **host mode** — the laptop loopback relay: executes host-only RPCs locally
  (`git push`/`fetch`, `cp`, `download`, checkpoint), serves `/admin/*` over loopback
  only, and starts a **`CloudBoxPoller`** (`packages/relay/src/cloud-poller.ts`) per
  cloud box on registration.
- **box mode** — the in-sandbox relay: parks host-only RPCs on a queue and exposes
  `/bridge/*` (bearer-authed with a `bridgeToken`) for the host poller to drain.

The `CloudBoxPoller` long-polls the box's `/bridge/poll` over its preview URL,
forwards events/status into the host stores, executes each parked action on the host,
and posts the result back — which unblocks the in-box caller. This is how a box's
`agentbox-ctl git push` reaches host credentials today.

### e. Boxes created BY the plane (the worker + create-job queue)
Because a serverless function can't hold a long checkout, box creation runs in a
**worker**: `POST /remote/boxes` enqueues a job (Postgres `create_jobs`, atomic
`FOR UPDATE SKIP LOCKED`), and `agentbox control-plane worker` drains it. The
create step (`apps/cli/src/control-plane/create-box.ts`, `makeControlPlaneCreateBox`)
leases a token → clones the repo **host-side** into a temp dir → scrubs the remote →
hands the checkout to the normal, tested `provider.create()`. **Cloud providers only** —
docker is never a plane target (its bind-mounted `.git` can't survive the worker's
temp-dir cleanup).

### f. The in-box side
- **Self-clone at bootstrap** (`packages/ctl/src/commands/bootstrap.ts` +
  `packages/sandbox-cloud/src/bootstrap-launch.ts`): on the plane/cloud-IDE create
  path, the box clones its own workspace from a leased token-bearing `AGENTBOX_CLONE_URL`
  and immediately scrubs the remote to the bare `AGENTBOX_ORIGIN_URL`. On the laptop
  path the workspace is host-seeded and this step is skipped (it detects a populated
  `/workspace`).
- **Relay-env token channel** (`packages/ctl/src/relay-env.ts`): cloud boxes have no
  global env, so the daemon writes a **0600 `/run/agentbox/relay.env`** (tmpfs, never
  snapshotted) holding the relay URL + token; in-box `agentbox-ctl` reads it. Only the
  tokens are secret and they never touch the world-readable `/etc/agentbox/box.env`.
- **Direct lease-and-push** (`packages/ctl/src/commands/git.ts`, `leaseAndPush`,
  gated by `AGENTBOX_GIT_LEASE=1`): the forward-looking topology where a box points
  `AGENTBOX_RELAY_URL` **directly at the hosted plane**, leases a token, injects it
  into the remote URL only for the push, and scrubs it after. The block-vs-poll and
  http-vs-https transport are handled transparently in `packages/ctl/src/relay-rpc.ts`
  (`postRpcAwait` → 202 → `pollParkedResult`).

---

## 3. How to use it

All commands live under `agentbox control-plane` (`apps/cli/src/commands/control-plane.ts`).

### Stand up a plane (one-time)
```
# Create the GitHub App (browser flow) AND deploy to Vercel + Neon Postgres:
agentbox control-plane setup --deploy vercel

# Deploy from a specific repo/ref (default is madarco/agentbox @ main):
agentbox control-plane setup --deploy vercel --repo myuser/agentbox --ref main

# Self-host on a Hetzner VPS (docker-compose, HTTPS via <ip>.sslip.io + Caddy):
agentbox control-plane setup --deploy hetzner

# Just create the App + config, deploy later yourself:
agentbox control-plane setup --deploy none --name my-agentbox-app --org my-org
```
`setup` opens the browser to GitHub's App-manifest flow
(`apps/cli/src/control-plane/github-app-manifest.ts`), writes the App key + a generated
admin token to `~/.agentbox/control-plane/`, then runs the chosen deploy
(`deploy-vercel.ts` / `deploy-hetzner.ts`) and points your config at the result.

The Vercel deploy is resilient: it **auto-forks** the repo if you don't own it
(`github-fork.ts`), provisions Neon **only if not already attached**, and falls back
to the **Vercel Deploy Button** in the browser if the API can't connect the repo —
the plane **boots gracefully unconfigured** until secrets arrive.

### Point boxes at a plane / check it
```
agentbox control-plane set-url https://agentbox-control-plane.vercel.app
agentbox control-plane status          # GET /healthz, reports reachability + counts
agentbox control-plane status --json
```
`set-url` persists the `relay.controlPlaneUrl` config key (global scope); it is the
sugar for `agentbox config set relay.controlPlaneUrl <url>`. When set, new cloud boxes
use the plane for token-leasing, approvals, and the registry/events.

### Authorize a project's repo on the App
```
agentbox control-plane add             # from inside a git repo: open the App install/select page
```
Pushes can only lease a token for a repo the App is installed on. `agentbox claude`
(and `codex`/`opencode`) auto-run this check at launch via
`apps/cli/src/control-plane/ensure-repo-installed.ts` — if the repo isn't authorized it
prompts once (and remembers the answer in `~/.agentbox/control-plane/repos.json`).

### Run the box-creation worker (for plane-created boxes)
```
agentbox control-plane worker --store "$POSTGRES_URL"                 # loop
agentbox control-plane worker --store "$POSTGRES_URL" --once          # drain once
agentbox control-plane worker --store "$POSTGRES_URL" --poll-interval 10000
```
A long-running host with provider creds + the App key that drains the create-job queue.

### From a box's perspective
Once `relay.controlPlaneUrl` is set, `agentbox claude --provider vercel` (etc.) creates
a cloud box that registers with the plane; in-box `agentbox-ctl git push` on an
`agentbox/*` branch leases a 1-hour token and pushes to GitHub directly (auto-approved),
while a push to a protected branch parks an approval you answer from the plane dashboard
or `POST /admin/prompts/answer`.

---

## 4. State, endpoints, and code map

**Local state** — `~/.agentbox/control-plane/` (all 0600):
`github-app.pem`, `control-plane.env` (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`AGENTBOX_RELAY_ADMIN_TOKEN`), `control-plane.json` (App metadata), `deploy.json`
(Hetzner record), `repos.json` (per-repo authorization cache).
Config key: `relay.controlPlaneUrl` (`packages/config/src/types.ts`).

**Plane endpoints** (all through the one catch-all → core handler):
- Box (per-box bearer): `POST /events`, `POST /rpc` (`git.lease-token`, `browser.open`),
  `GET /rpc/status/:promptId`.
- Admin (admin bearer, fail-closed, constant-time): `/admin/register-box`,
  `/admin/forget-box`, `/admin/box-status`, `/admin/events`, `/admin/registry`,
  `/admin/prompts`, `/admin/prompts/answer`, `/admin/app/repo-installed`, `/admin/store`.
- Create (admin bearer): `POST /remote/boxes`, `GET /remote/boxes/:id`.
- Open: `GET /healthz` → `{ ok, controlPlane, configured:{db,app,admin}, boxes, events }`.

**Code map**
| Concern | Location |
|---|---|
| Next.js app (catch-all route, adapter, dashboard, Docker/compose/vercel.json) | `apps/control-plane/` |
| Framework-agnostic core handler | `packages/relay/src/core/handler.ts` |
| Lean plane entrypoint (re-exports) | `packages/relay/src/control-plane.ts` |
| Store seam (Memory/Postgres/Remote + RPC allow-list) | `packages/relay/src/store/` |
| GitHub-App leasing | `packages/relay/src/github-app.ts`, `lease.ts` |
| Approvals (block/poll) | `packages/relay/src/permission.ts` |
| Dual-mode server, bridge, cloud poller | `packages/relay/src/server.ts`, `cloud-poller.ts` |
| CLI command surface | `apps/cli/src/commands/control-plane.ts` |
| Deploy + onboarding helpers | `apps/cli/src/control-plane/` (`deploy-vercel.ts`, `deploy-hetzner.ts`, `github-app-manifest.ts`, `github-fork.ts`, `create-box.ts`, `ensure-repo-installed.ts`) |
| In-box lease-and-push / clone / relay-env | `packages/ctl/src/commands/git.ts`, `bootstrap.ts`, `relay-env.ts`, `relay-rpc.ts` |

---

## 5. Status / caveats

- **Verified live:** `agentbox control-plane setup --deploy vercel` created the GitHub
  App, deployed to Vercel + Neon Postgres, and `/healthz` reported
  `configured:{db:true, app:true, admin:true}`. Admin auth round-trips (valid token →
  200, missing/wrong → 401). Vercel cloud boxes push through the relay end-to-end (an
  `agentbox/*` branch lands on GitHub with a matching SHA).
- **Direct lease-push (Phase 10, laptop `create` path):** when `relay.controlPlaneUrl` is
  configured, `agentbox create --provider <cloud>` now resolves `topology: 'control-plane'`,
  registers the box on the plane with its origin URL, runs an in-box forwarder to the plane, and
  writes `AGENTBOX_GIT_LEASE=1` into `/etc/agentbox/box.env` so the box leases a token and pushes
  **direct** to GitHub. The flag is host-written into `box.env` (the daemon's env isn't inherited
  by the login shell that runs `git push`) — it is *not* daemon-set. Classic-cloud (no
  `controlPlaneUrl`) is unchanged: pushes route host-side via the box-mode relay + `/bridge`
  CloudBoxPoller.
- **Caveats worth knowing:**
  1. The plane's own server-side create worker (`makeControlPlaneCreateBox`) does **not** yet set
     the control-plane signal (deferred) — a plane-*created* box still needs the topology + an
     in-plane registration. Use the laptop `create` path for the direct-lease topology today.
  2. **Docker is never a plane target** (bind-mounted `.git`); the plane creates cloud
     boxes only.
