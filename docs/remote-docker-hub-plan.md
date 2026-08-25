# Remote-docker through the control box — implementation plan

> Working doc. One session per phase; tick the boxes as they land.
> Companion to [`cloud-providers.md`](./cloud-providers.md) §3e (the remote-docker
> shape) and [`hub-testing.md`](./hub-testing.md) (how to exercise a control box).

## Why

`remote-docker` (`agentbox docker:<alias>`) runs a box as a container on a machine
the user owns, reached over **their own `~/.ssh/config`**. That "your machine, your
keys" design is exactly what makes it unusable from a control box today:

- The alias registry (`~/.agentbox/remote-docker-hosts.json`) is per-machine and
  never syncs. The hub reads only its own copy (`apps/hub/lib/hub-backend.ts`,
  `remoteDockerHostCount`).
- The provider passes **no** `identity` and **no** `knownHosts`
  (`packages/sandbox-remote-docker/src/target.ts`, `sshTargetFor`). The hub container
  has `HOME=/root` with only `/root/.agentbox` mounted — no `~/.ssh`, no agent — so
  it cannot dial anything.
- Creates are blocked on three layers: `HUB_ROUTABLE_PROVIDER_NAMES` excludes
  remote-docker (`packages/config/src/providers.ts`), the hub's clone path rejects
  any `docker:` provider (`apps/hub/lib/boxes/control-plane-create.ts`), and the hub
  worker rejects a non-`ProviderKind` spec (`apps/hub/lib/hub-worker.ts`).
- `dockerProvidersHidden()` (`apps/cli/src/control-plane/remote-hub.ts`) turns docker
  **and** remote-docker off on the PC as soon as `relay.controlPlaneUrl` is set —
  including after `hub expose` / `hub set-url`, where the hub *is* this machine.

So deploying a control box costs the user the docker-shaped box entirely. The goal is
to create a remote-docker box **from the PC (routed through the control box)** and
**from the control box's web UI**, with the host registry shared to the hub the way
provider credentials already are — and then to make the control box's own engine a
built-in host called `hub`.

## Shape

| Where | `hub` resolves to | How |
|---|---|---|
| PC, remote control box | the VPS's docker engine | host alias `hub` → the `agentbox-hub` ssh alias the deploy already writes |
| Control box itself | its own docker engine | host alias `hub` → `root@host.docker.internal` + a deploy-minted key |
| PC, co-located hub (`hub expose`) | plain local `docker` | no alias; the docker gate simply stops firing |

Decisions taken with the user: creates route through the hub API; the hub reaches an
engine over SSH with its own key; `box.provider` is widened to hold a `docker:<alias>`
spec; `hub expose` / `set-url` are covered too.

## Phases

- [ ] **1. Unbreak the remote build on docker 29** (prerequisite). `buildOnRemote`
      streams a tar to `docker build -` *with* `-f Dockerfile.box`; docker 29 is
      buildx-only and rejects that pairing (`ambiguous Dockerfile source`). Unpack the
      streamed tar into a remote temp dir and build from a **directory context**, as
      the local docker provider already does.
- [ ] **2. A registry entry another machine can dial.** Extend `RemoteHostEntry` with
      an optional resolved connection (`{host,user?,port?,identityFile?,knownHosts?}`),
      thread it through both ssh chokepoints (`dialTarget`/`ensureTunnel`/`tunnels.open`
      and `sshTargetFor`/`sshOptArgs`), emit `IdentitiesOnly=yes` with an explicit key,
      and add an `ssh -G` resolver so the PC can expand a local alias into something the
      hub can dial.
- [ ] **3. Share the hosts with the control box.** Mirror the provider-credential RPC
      (`POST /api/v1/providers/:id/credentials`): extend `POST /api/v1/hosts` to carry
      the resolved connection + an identity, mint a dedicated per-host keypair on the PC
      and install its public half on the target, add `remote-docker share|unshare`, and
      re-assert from `finalizeControlBoxState`.
- [ ] **4. The hub can create a remote-docker box.** Clone path accepts `docker:<alias>`
      (bare `docker` still refused); hub worker resolves the spec and passes
      `providerOptions.remoteHost`; the web-UI picker and OpenAPI follow.
- [ ] **5. The PC routes a remote-docker create to the control box** when the box knows
      the alias (reusing `prepare`'s `controlBoxKnowsHost` probe), and stops hiding a
      remote-docker host the control box can run.
- [ ] **6. `hub` — the control box's own engine, and the new default.** Deploy mints a
      self-key and seeds the hub's registry; the PC registers `hub`; `box.provider` is
      widened to accept a `docker:<alias>` spec and flipped to `docker:hub`; a
      co-located hub stops hiding local docker.
- [ ] **7. Bake routing polish.** `remote-docker add` should bake through the hub for a
      shared host; `preparePrecheck` should probe the aliased engine.
- [ ] **8. Docs, backlog, tests.**

## Verification

Unit: registry schema round-trip with a resolved connection; identity threading through
`sshOptArgs` / `dialTarget` / `tunnels.open`; `buildOnRemote` argv;
`controlPlaneCreateRequest` accepting `docker:<alias>` while still refusing bare
`docker`; the create-target routing and the `dockerProvidersHidden` truth table; config
parse/write for `docker:hub`. Then `pnpm typecheck` (tsup does not typecheck).

Live, against a deployed control box plus a second machine as the remote engine:

1. `pnpm build`; `agentbox hub update --ref <branch>`.
2. `agentbox remote-docker add engine <ssh>` → `agentbox remote-docker share engine`;
   the hub's `GET /api/v1/hosts` lists it and the VPS can ssh the engine.
3. `agentbox prepare --provider docker:engine` bakes **on the control box**.
4. `agentbox docker:engine claude -n rdsmoke -i "…"` from the PC runs as a control-box
   job; the container appears on the engine; an in-box `git push` goes through the hub
   relay; stopping the PC's relay does not stop it.
5. The same create from the control box's web UI.
6. `agentbox config get box.provider` reads `docker:hub`; plain `agentbox create` lands
   on the control box's own engine.
7. `hub unset-url` + `hub expose` → plain `agentbox create` builds a local docker box
   again. `agentbox hub destroy` → alias gone, `box.provider` back to `docker`.
