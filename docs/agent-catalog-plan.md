# Agent catalog — on-demand agents and base variants

> **Looking for how agents work today?** See [`agents.md`](./agents.md) — this
> file is the work plan and its early sections predate the implementation (it
> argues against derived layers, which is what we ended up building for docker).

Status: **in progress.** Rescoped to *one agent per box*; agent plugins are parked
(the seam analysis at the end stays as the north star). Prerequisite for
[`openclaw-hosting-plan.md`](./openclaw-hosting-plan.md).

| | |
|---|---|
| Dockerfile layer reorder | **done** — a ctl/core edit rebuilds 16 cheap layers, not ~1.8 GB |
| Catalog (`install` recipes on `AGENT_SYNC_SPECS`) | **done** — one source for the derived layer, the cloud scripts and the runtime installer |
| `ensureAgentInstalled` over `SyncTransport` | **done** — cloud boxes gain on-demand install for the first time |
| Agentless base image | **done** — 3.07 GB, was 4.80 GB with all three agents |
| Agents as a **derived layer** (`FROM base`) | **done** (docker) — unique size per agent 1.279 GB → 434 MB (claude), 1.518 GB → 702 MB (codex) |
| Per-box agent selection | **done** (docker) — only the selected agent's volume, credentials and home dir |
| `variantFingerprint` + per-variant image tag + per-variant prepared record | **done** (docker) — alternating agents no longer rebuilds |
| Seed the login when an agent is added to a live box | **done** — pushed as a file; a mount can't be added to a running container |
| Publish the agentless base + CI matrix | todo — until then the first build on a cold machine is local |
| Cloud **derived snapshots** (hetzner, vercel, e2b) | todo — boot base snapshot → install → re-snapshot |
| `--agents` through `PrepareOptions` → hub API → queue → worker | todo |
| Cloud selection (`stageAllAgentStatic`, cloud credential volumes) | todo — cloud still bakes and mounts all three |
| Checkpoints recording their agent set | todo |

**No cloud regression in the meantime:** the cloud provision scripts still install
all three agents, so cloud boxes behave exactly as before and
`ensureAgentInstalled` is a no-op there.

---

## Context

Adding a coding agent today means editing `Dockerfile.box` with a hand-written `RUN npm
install -g …`, then mirroring that file list in **three** hand-maintained places
(`apps/cli/scripts/stage-runtime.mjs`'s seven arrays, `DOCKER_CONTEXT_FILE_MAP` in
`packages/sandbox-core/src/prepared-state.ts`, and `SHARED_RUNTIME_ASSETS` in
`packages/provider-sdk/src/runtime-assets.ts`), plus the four cloud install scripts. Every
agent is baked into every box for every user, whether they use it or not.

That does not scale to Pi, Grok, OpenClaw and whatever comes next. We want:

- `agentbox claude` / `agentbox codex` stay instant (baked).
- `agentbox pi` works the first time without a repo change to the Dockerfile, and is fast
  from the second time on.

### The size reality — read this before optimising for it

The base image is **4.75 GB**. The agents are a small slice of it; the weight is
Playwright (459 MB), Chromium (415 MB), the VNC stack (309 MB) and the devcontainer base.
De-baking agents buys **extensibility, not size**. If image size is the goal, the lever is
Playwright/Chromium/VNC, and that is a separate piece of work.

### Correction to the "bake a new layer" framing

A true derived-image chain (`FROM agentbox/box:dev` + install) is clean on docker,
remote-docker, vercel and e2b — but:

- **daytona linux-vm is a hard blocker**: VM snapshots can only be built from a *prebuilt
  registry image* (an SDK `Image` + `LINUX_VM` fails `Unauthenticated`), so a derived layer
  must be published to GHCR first.
- **hetzner / digitalocean** have no image-build primitive at all: a "layer" means booting a
  real VPS, installing, and `create_image` — minutes and real money per agent.
- `PreparedBaseSnapshot` models exactly **one** base per provider (`base.imageRef` + one
  `contextSha256`), and both custody sharing (`sharePreparedBase`/`tryAdoptPreparedBase`)
  and the hub's global pin `boxImageConfigKey(provider)` assume one record per provider.

So we do **not** build a layer *chain*. We build a **base variant** — still one base per
provider, just a different fingerprint. That reuses `prepare` end to end instead of
inventing a new tier, and it works on all seven providers.

---

## The design: one recipe, two execution sites

### 1. The catalog

Give each agent an install recipe as **data**, next to the sync spec it already has in
`packages/sandbox-core/src/sync/registry.ts` (`AGENT_SYNC_SPECS`):

```ts
install: {
  placement: 'baked' | 'ondemand',
  probe: 'openclaw',                                  // command -v <probe>
  recipe:
    | { kind: 'npm';    package: 'openclaw'; allowScripts?: boolean }
    | { kind: 'script'; url: 'https://claude.ai/install.sh'; retries?: 3 }
    | { kind: 'exec';   script: string },
  apt?: ['bubblewrap'],
  postInstall?: string,                               // dirs / symlinks
}
```

One recipe, executed in one of two places. That is the whole idea — everything below is
plumbing that already exists.

### 2. Site A — on-demand (always available, the safety net)

Generalise the two functions that already do this: `ensureCodexInstalled` /
`ensureOpencodeInstalled` (`packages/sandbox-docker/src/sync/agents/{codex,opencode}.ts`)
are today near-identical hand-written twins — `command -v <bin>` probe, then
`npm install -g <pkg>` as root, then a typed error.

Collapse them into `ensureAgentInstalled(transport, spec)` driven by the catalog, and put it
on the **`SyncTransport.exec` seam** (`packages/core/src/sync/transport.ts`) instead of raw
`docker exec`. That single change:

- removes the per-agent duplication,
- **closes the current cloud gap** — there is no `ensure*Installed` for cloud today, so a
  cloud box booted from a snapshot predating an agent simply has no path to it,
- makes any new agent work on day one with no image change at all.

Cost: 30–90 s on first use in a given box. Lands in the container's writable layer, so it
survives stop/start and is captured by a project checkpoint.

### 3. Site B — baked into a base *variant* (the fast path)

`claudeInstall` is the existing precedent and it already reaches every provider:

- `PrepareOptions.claudeInstall` is documented as *"threaded into each provider's install
  script (`AGENTBOX_CLAUDE_INSTALL` env) or Dockerfile build-arg"* — and indeed
  `Dockerfile.box:275`, `install-box.sh:391`, `provision.sh:349` and
  `build-template.sh:309` all branch on it.
- It threads CLI → `runPrepare` → hub `/api/v1/providers/:id/prepare` → validate → queue
  (`QueueJobPrepare`) → `_run-queued-prepare` → `provider.prepare()`.
- `claudeInstallFingerprint(baseSha, mode)` folds it into the image identity, and
  **`native` is the identity fold** — the default variant hashes to the base sha itself.
- `.github/workflows/box-image.yml` already runs a **matrix** over it, publishing one
  fingerprint tag per variant and skipping buildx when the tag already exists.

So add an `agents` variant along exactly that path:

| Piece | Change |
|---|---|
| `PrepareOptions` | `agents?: string[]` beside `claudeInstall` |
| `prepare` CLI | `--agents <list>` beside `--claude-install` |
| hub API | one field in `validate.ts` + `openapi.ts`; `QueueJobPrepare` gains `agents` |
| fingerprint | generalise `claudeInstallFingerprint` → `variantFingerprint(baseSha, {claudeInstall, agents})`, **keeping the identity fold for the default set** |
| `Dockerfile.box` | `ARG AGENTBOX_AGENTS=claude,codex,opencode` + a catalog-generated conditional `RUN` block (the `ARG` + `RUN if […]` idiom already used for Claude) |
| install scripts | `AGENTBOX_AGENTS` read the same way `AGENTBOX_CLAUDE_INSTALL` is, in all four |
| CI | extend the existing matrix with the agent sets we want prebuilt |

**Why the identity fold matters:** the default variant produces the *same* fingerprint as
today, so adding Pi to the catalog does not invalidate anyone's base image or force a
re-pull. Only users who ask for a non-default set get a new tag — and CI prebuilds the
popular ones, so they pull rather than build.

### 4. "Bake on first use" — the UX you asked for

On the first `agentbox pi`:

1. Create the box from the current base.
2. `ensureAgentInstalled` installs Pi in-box — the box is usable now
   (`"first run: installing pi, one-time"`).
3. **In the background**, enqueue a variant bake through the existing hub prepare queue.
4. The next `agentbox pi` starts from the prebuilt variant.

The box being usable at step 2 is what makes the background bake acceptable. Gate the whole
behaviour with `box.agentBake: auto | prebuilt-only | off` (default `auto`; `prebuilt-only`
for people who never want a local bake).

### 5. Which agents stay baked

Phase 1 keeps **claude + codex + opencode** baked — no behaviour change, no regression, and
`ensureAgentInstalled` already covers the stale-image case. New agents (openclaw, pi, grok)
default to `ondemand` + variant bake.

Whether to later drop `opencode` out of the default base is a separate call: it degrades
gracefully (the fallback exists), but it makes first use slower for anyone without a
prebuilt variant. Decide it once the variant path is proven, not before.

---

## Prerequisite fix: Dockerfile layer order

`COPY packages/ctl/dist/bin.cjs` sits at **`Dockerfile.box:161`**, *before* the agent
installs (275–325), Playwright/Chromium (354–377), the VNC stack (392–419) and sshd (432).
ctl's bundle is built with `noExternal: [/.*/]`, so it inlines `@agentbox/core`,
`sandbox-core`, `relay` and `integrations`.

**Consequence:** editing any of those packages invalidates **~1.8 GB** of downstream layers.
`.github/workflows/box-image.yml` documents this as the reason it has no `paths:` filter.

It matters doubly here, because the agent catalog would live in `sandbox-core` — so adding
"pi" to a table would rebuild Chromium for everyone. **Move the ctl COPY and the small shim
COPYs to the end of the Dockerfile.** This is a worthwhile change on its own merits,
independent of this feature.

---

## Collapse the three asset mirrors

Adding one agent asset today means editing `stage-runtime.mjs`, `DOCKER_CONTEXT_FILE_MAP`
and `SHARED_RUNTIME_ASSETS` — three hand-mirrored lists whose drift is only caught by a
guard test that derives the expected set from the Dockerfile's `COPY` lines. Collapse them
into one manifest that all three consumers read. Without this, every new agent adds a fourth
place to forget.

---

## Plugin-supplied agents (the north star)

`ProviderName` is an **open string** backed by `~/.agentbox/plugins.json` + a variable
`import()` + an `SDK_API_VERSION` gate. `AgentId` is a **closed union**. That asymmetry is
the only structural reason a third party can ship a provider but not an agent.

Once the catalog exists, the endgame is small:

- open `AgentId` the way `ProviderName` is open,
- add `agents: string[]` beside `providers: string[]` in `PluginRecord`
  (`packages/sandbox-core/src/plugin-registry.ts`),
- let a plugin contribute an `AgentSpec` (sync spec + install recipe + launcher),
- version-gate it with the existing `SUPPORTED_SDK_API_VERSIONS`.

A plugin agent can never be baked into our base, so it is `ondemand`-only — which is
precisely why Site A has to exist first. `agentbox plugin add @foo/agentbox-agent-pi` then
adds an agent with **no change to this repo**.

---

## Phases

| # | Phase | Outcome |
|---|---|---|
| 1 | Dockerfile layer reorder | a `sandbox-core` edit stops invalidating ~1.8 GB |
| 2 | Catalog + `ensureAgentInstalled` on `SyncTransport` | any agent installable on demand, docker **and** cloud; two hand-written twins collapse to one |
| 3 | Collapse the three asset mirrors | one manifest |
| 4 | `agents` base variant + fingerprint fold + CI matrix | prebuilt fast path, zero churn for existing users |
| 5 | Auto-promote on first use + `box.agentBake` | the "bake on first use" UX |
| 6 | Open `AgentId`, plugin-supplied agents | Pi/Grok without a repo change |

OpenClaw consumes this from phase 2 onward: it becomes a catalog entry with an `npm` recipe
instead of a fourth hand-written `RUN` line in `Dockerfile.box`, which is also the first
real test that the mechanism works.

---

## Verification

- **Phase 2:** a catalog agent with no Dockerfile entry installs and launches on a docker box
  *and* on a hetzner box; `ensureAgentInstalled` is a fast no-op on a base that already has
  the binary; the existing codex/opencode stale-checkpoint path still works.
- **Phase 4:** `node apps/cli/scripts/print-box-context-sha.mjs` prints the **unchanged**
  sha for the default agent set (the identity fold), and a new sha for
  `--agents claude,codex,openclaw`. This is the regression guard that protects every
  existing user from a 4.75 GB re-pull.
- **Phase 5:** first `agentbox pi` is usable before the bake finishes; the second is fast.
- `pnpm test` (registry/drift/runtime-asset guards will fail until updated — intended),
  then `pnpm typecheck`, then `npx prettier --write <touched files>`.

## Risks

- **Fingerprint churn is the thing to get right.** If the default set does not fold to
  identity, every user re-pulls 4.75 GB. Guard it with a test on the printed sha.
- **A variant bake on hetzner/DO costs real money and minutes** (VPS boot + snapshot).
  Auto-promote must be opt-out-able and must never fire without a clear log line.
- **`PreparedBaseSnapshot` holds one base per provider.** Variants keep that invariant
  (one record, different fingerprint); do not drift into a multi-record scheme without
  also fixing custody sharing and the hub's global `boxImageConfigKey` pin.
- **Do not reuse checkpoints as the cache tier.** They are project-scoped by construction
  (`checkpointImageTag` hashes `projectRoot`), auto-flatten at `checkpoint.maxLayers` (3)
  via `FROM scratch` — which destroys layer sharing with the base — and `ensureImage`
  deliberately never touches a checkpoint image.
