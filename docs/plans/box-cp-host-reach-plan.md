# Plan: box `cp` reaches the real host, with custody as the cache

Status: **not started**. One session per phase; tick each phase's box as it lands.

- [ ] Phase 0 — measure the current behavior live
- [ ] Phase 1 — host-reach channel (control box ⇄ PC)
- [ ] Phase 2 — custody as the cp cache + the explicit upload surface
- [ ] Phase 3 — `cp toHost` and the offline outbox
- [ ] Phase 4 — docs, backlog, changelog

## Context

With a control box configured (`relay.controlPlaneUrl`), **every** cloud box resolves
`topology: 'control-plane'` (`packages/core/src/sync/topology.ts:19`) and forwards its `/rpc`
straight to the control box (`packages/ctl/src/commands/in-box-transport.ts:17`). So an in-box
`agentbox-ctl cp toHost|fromHost` is served by the **VPS relay**, not the PC:

- `packages/relay/src/server.ts:900-985` gates it (prompt / `canAutoApproveTransfer`) against
  `boxWorkspacePath(reg.boxId)` — read from the **control box's** `~/.agentbox/state.json` — then
  `handleCpRpc` (`:2212`) re-shells `agentbox cp` **on the VPS**.
- For a **hub-created** box that `workspacePath` is the create job's **temp clone**, which
  `makeControlPlaneCreateBox` deletes in its `finally` (`packages/relay/src/create-worker.ts:264`).
- For a **PC-created** cloud box it is a macOS path that does not exist on the VPS at all.

Either way the user's files are never touched, while the shipped docs promise the opposite
(`apps/web/content/docs/deployed-hub.mdx:449` and the "Approval is not execution" callout at `:527`).

**What this is missing is routing, not startup.** The local relay *is* still started with a remote
hub configured — `ensureRelay()` fires on docker create/start, PC-side cloud create
(`packages/sandbox-cloud/src/cloud-provider.ts:689`) and start
(`packages/sandbox-docker/src/lifecycle.ts:449`), queue submit, recover, post-update — and the local
hub embeds the same relay on :8787. But `selectInBoxTransport` sends `/rpc` unconditionally to
`AGENTBOX_CONTROL_PLANE_URL`, so a control-plane box's cp never reaches it even when it is up and the
box is adopted. Adoption fixes the **PC→box** direction (`agentbox cp` typed on the Mac, `attach`,
`shell`); a cp started **inside** the box travels the other way.

**Intent.** `cp` stays the way to get files from the host. The box keeps talking to the control box;
the control box forwards to the PC when it is reachable, **caches the result in custody**, and serves
that cache as the fallback when the PC is off. Uploading files to custody from the PC is a
first-class action, so a box can be fed with the PC offline. Everything stays behind the approval
logic that exists today.

## Shape

Custody becomes the **byte transport** for cp; the PC is the live source, custody the durable
fallback. Boxes never see custody or an admin token — the control box brokers.

```
cp fromHost:  box → CB → (PC reachable? park+drain → PC tars + PUTs custody)
                        → CB pulls custody → agentbox cp <tmp> box:<dest>
              PC off  → CB serves the cached entry (approval parked on CB) or errors
cp toHost:    box → CB → CB downloads from box → custody → PC pulls + lands (approval on PC)
              PC off  → parked in custody as an outbox; PC drains on reconnect
```

Everything needed already exists: `HostActionQueue` (park/deliver/resolve/expire),
`CloudBoxPoller` as the poller template, `runCpRpc` (`packages/relay/src/host-actions.ts:933` —
resolves the box locally, prompts, shells `agentbox cp`), the streaming custody surface
(`/admin/custody-blob`, `packages/relay/src/custody/routes.ts:163`, capped by
`relay.custodyMaxBlobBytes`), the CLI's `CustodyClient`, and `custody-seed.ts`'s fetch-into-box.

---

## Phase 0 — measure first

Before any code change, against the live control box (`https://46.225.235.16.sslip.io`), from a
non-LFS test project: create `--via-hub` on e2b, then in the box run
`agentbox-ctl cp toHost /workspace/probe.txt ./` and `cp fromHost ~/probe-host.txt /workspace/`.

Record the exact exit/stderr, whether an approval parks and where, and — by inspecting the VPS —
where any bytes actually landed. **Confirm or correct the deleted-temp-clone reading above before
building on it.**

## Phase 1 — host-reach channel (control box ⇄ PC)

**Control box** — `packages/relay/src/server.ts`, the `cp.*` branch at `:900`: when this relay is a
control plane and `reg.kind === 'cloud'`, do not gate or execute locally. Enqueue on a new
process-wide `hostReach` queue (a second `HostActionQueue`) and `await`, exactly as box-mode does at
`:736`. No prompt here — the machine that executes is the machine that prompts, or the user is
answering about paths that do not exist where they are looking. "Am I a control plane?" is a
`controlPlane` daemon option set by `apps/hub/server.ts`, where it already special-cases the control
box (`authMode() === 'password'` → durable subscriber floor).

New admin routes, gated by the existing `adminGateAllows` (`packages/relay/src/admin-gate.ts` —
already remote-capable, since the control box sets an admin token):

- `GET /admin/hostreach/poll` — long-poll (mirrors `GET /bridge/poll`).
- `POST /admin/hostreach/result` — `{id, exitCode, stdout, stderr, custody?}` (mirrors
  `POST /bridge/action-result`).

**PC** — new `packages/relay/src/host-reach-poller.ts`, modelled on `cloud-poller.ts` (same backoff,
timeouts, connection-error handling; no preview-URL recovery). Runs in the host relay when
`relay.controlPlaneUrl` is set, authenticating with the admin token from
`~/.agentbox/control-plane/control-plane.env` (the file `apps/cli/src/control-plane/box-plane.ts:63`
already reads). Per action it calls the existing `executeCloudAction` with the **PC relay's** deps,
so `runCpRpc` prompts on the PC and resolves paths against the PC's project. A box it cannot resolve
locally gets a real result back, never a hang: "box `<name>` is not adopted on this machine; run
`agentbox ls` here first".

**Reachability** = a poll connection seen within `relay.hostReachTimeoutMs` (new config key, default
~60s). Connected → keep today's no-TTL semantics (a copy waits on the user's answer). Not connected →
fall through to custody (Phase 2) rather than failing outright.

**Startup gap.** The paths that only ever touch a hub box — `create --via-hub`, adoption,
`attach`/`shell`/the agent launchers on an existing hub box — never call `ensureRelay()`, so a
hub-only workflow can have no drainer running. Add it there (idempotent; a no-op when the local hub
already holds the port), and have `agentbox hub status` say when a control box is configured but no
drainer is up — precisely the state where cp degrades to the cache.

**Verify:** PC up → `cp fromHost` a file that exists only on the Mac lands in the box, and the
approval shows in the PC's surfaces (attach footer, local hub, `agentbox agent approvals <box>`).
`cp toHost` lands on the Mac under the box's local workspace. Uncontained/secret shapes still prompt
(`~/.zshrc` as source); contained ones auto-approve. A docker box is unchanged (local relay, no
parking). Check ground truth with `ls`/`stat`, never exit codes.

## Phase 2 — custody as the cp cache

**Key.** `projects/<owner__repo>/cp/<sha256(absHostPath)>.tar` plus a sibling `.json` (original path,
whether it was a dir, capture time, source machine, mode). Same `projects/<slug>/` scope the seed
material already uses (`packages/sandbox-cloud/src/custody-seed.ts`); the hash keeps a host path
inside custody's one-segment charset.

**Live path (PC reachable).** The PC tars the approved sources, PUTs the blob + metadata over
`/admin/custody-blob`, and returns the key. The control box pulls it, unpacks to a temp dir, and
re-shells `agentbox cp <tmp>/<name> <box>:<dest>` — the same executor as today, only the source
moves. Two hops instead of one: the cost of getting the cache for free and keeping one delivery path.
The payload is already capped at 100 MiB.

**Fallback (PC not reachable).** Look the key up. Hit → an approval **parked on the control box**
(answerable from the web UI, tray, or `agentbox hub approvals`), whose detail says plainly that this
is a cached copy and when it was captured; the box's stdout says the same, so an agent never mistakes
a stale file for a live read. Miss → one error naming both facts: the machine is offline **and**
nothing is cached for that path, with the `agentbox cp <file> hub:` command that would fix it.

**Explicit upload (new user-facing surface).** `agentbox cp <paths...> hub:` (and the matching
`agentbox hub custody push`) writes exactly the same cache entry for the resolved absolute path — so
pre-loading a dataset and warming the cache are one operation, and a box can be fed with the PC off.
Uploads appear in the existing custody UI; `relay.custodyMaxBlobBytes` bounds them.

Refresh-on-read: every live fetch rewrites the entry, and custody's content-addressed `put` skips the
write when the bytes are unchanged.

**Verify:** `agentbox relay stop`, retry a `fromHost` that was fetched live before → served from
custody, approval answerable from the **web UI**, stdout says "cached, captured &lt;ts&gt;". A path never
copied before → the two-fact error; then `agentbox cp <file> hub:` from the Mac and retry → succeeds
with the PC still down. Restart the relay → live path again, cache entry refreshed, not duplicated.

## Phase 3 — `cp toHost` and the offline outbox

PC reachable → the PC lands the files as in Phase 1 (bytes travel box → control box → custody → PC,
one transport). PC off → the payload is parked in custody under `projects/<slug>/cp-out/<id>.tar`
with its intended destination, the box is told so explicitly, and the PC drains the outbox on its
next connect — landing each one **behind the usual approval**, since the copy is applied to the
user's disk at that later moment.

This is the smaller half; if it slips, the box gets the same clear "machine offline" error and
nothing is silently lost.

## Phase 4 — docs, backlog, changelog

Per the repo rule, in the same change as the code:
`apps/web/content/docs/deployed-hub.mdx` (the "What still needs your laptop" bullet + the "Approval is
not execution" callout — both describe behavior that only becomes true here), the new
`agentbox cp … hub:` surface in `cli.mdx` and the two new keys in `configuration.mdx`,
`docs/architecture.md:265`, `docs/cloud-providers.md:511`, and the "the host means the control box"
claim in `docs/hub-api-single-path-plan.md:1469`. Changelog under `[Unreleased]`.

`download.workspace` / `download.env` / `download.claude` share the identical defect
(`packages/relay/src/server.ts:1063`). **Out of scope**, but the queue/poller/custody path is built so
each is a routing line later; the docs say plainly that only `cp` is fixed. Backlog: cache eviction
policy (today entries persist until deleted from the custody UI).

## Tests

`pnpm test`, `pnpm typecheck`, `pnpm lint`, plus: host-reach queue expiry and fallback selection;
poll → claim → respond round-trip; control-box routing (a cloud box's cp parks, a docker box's does
not); cache key derivation + metadata round-trip; the cached-serve path marks its result as cached;
an unresolvable box yields a result rather than a hang. Extend `docs/test-plan.md` with the
remote-hub cp matrix (live / cached / cold-miss).
