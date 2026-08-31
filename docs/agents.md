# Agents

How a coding agent gets into a box, and why a box carries only one.

This is the steady-state reference — the shape the agent layer has today. The
work plan that got us here (and what is still outstanding) lives in
[`agent-catalog-plan.md`](./agent-catalog-plan.md).

---

## Thesis: an agent is a row of data

An agent used to be a `RUN npm install -g …` line in `Dockerfile.box`, mirrored
into four cloud provision scripts, plus a hand-written `ensure<Agent>Installed`
per tool. Adding one meant editing all of them and keeping them in step.

Now each agent is one entry in **`AGENT_SYNC_SPECS`**
(`packages/sandbox-core/src/sync/registry.ts`), and that entry carries an
`install` recipe alongside the sync/credential data it already had:

```ts
{
  id: 'codex',
  binary: 'codex',                       // probe: `command -v codex`
  install: {
    recipe: { kind: 'npm', package: '@openai/codex' },
    runAs: 'root',
    apt: ['bubblewrap'],
    postInstall: '…dirs, symlinks, ownership…',
  },
  // …sessionName, dockerVolume, staticPaths, credential, caps
}
```

**One recipe, two execution sites** (three once the cloud half lands):

| site | what runs it | when |
|---|---|---|
| derived image layer | `buildDerivedAgentImage` (`sandbox-docker/src/image.ts`) | `agentbox <agent>` on docker |
| live box | `ensureAgentInstalled` (`sandbox-core/src/sync/concerns/install.ts`) | adding an agent to a running box |
| cloud derived snapshot | each provider's `prepare` (`--agents <set>`) | baking an agent onto a cloud base |

Keep the sites in step by keeping the *data* in one place — never by copying an
install into a second file. Every site above renders the same
`AGENT_SYNC_SPECS.install` entry, so a baked agent and a runtime-added one are
byte-identical in layout; no provision script installs an agent any more.

### Recipe fields that matter

- **`runAs`** is not a detail. Claude's native installer writes into the
  *invoking* user's `~/.local/bin`, so running it as root puts `claude` in
  `/root` and the box user never sees it. `npm install -g` is the opposite and
  needs root.
- **`postInstall`** owns the agent's home + credential dirs (`~/.claude`,
  `~/.codex`, `~/.agentbox-creds/<agent>/` and the symlinks that pivot each
  agent's credential path into a mounted volume). It lives here, not in the
  Dockerfile, so every install site produces the same layout.
- **`alternates`** are other ways to install the same agent, keyed by mode.
  Only `npm` is used: `box.claudeInstall: npm` is the escape hatch for hosts
  whose egress IP the Claude CDN 403s.
- **`script` recipes fetch to a file and run it with `bash`.** Not `curl | bash`
  — piping hides a blocked download behind bash's exit 0 — and not `sh`, because
  `/bin/sh` is dash on Debian/Ubuntu and these installers are bash scripts.

---

## One agent per box

`agentbox claude` produces a box containing **claude and nothing else** — its
binary, its config volume, its credentials, its home dir. No codex or opencode
login is anywhere in that box.

`createBox({ agents })` is the authoritative selection. Omitted, it falls back to
the historical behaviour (mount whatever the host happens to have) so an
un-migrated caller keeps working.

| | |
|---|---|
| `agentbox claude` | `agents: ['claude']` |
| `agentbox codex` / `opencode` | likewise |
| a queued `-i` job | `[toSyncKind(job.agent)]`, or `[]` for `--no-agent` |
| `agentbox create` | `[]` — no agent |

The shared `~/.agents` skills volume is still mounted for every box: it is
agent-neutral and carries no auth.

---

## Image tiers

```
Dockerfile.box ──prepare/pull──▶ agentless base            agentbox/box:dev
                                        │
                                        ▼ FROM + install recipe
                                   agent layer             agentbox/box:dev-claude
                                        │
                                        ▼ docker commit
                                 project checkpoint        agentbox-ckpt-<hash>:<name>
```

The base carries **no agents**. Each agent is added as a thin `FROM <base>`
layer, not a second full build, because the agent installs would otherwise have
to sit above Playwright, Chromium and the VNC stack — so every one of those
layers would diverge per agent:

| | full variant build | derived layer |
|---|---|---|
| `dev-claude` unique | 1.279 GB | **434 MB** |
| `dev-codex` unique | 1.518 GB | **702 MB** |
| base | 2.23 GB shared | **3.07 GB, fully shared** |

It also means CI publishes **one** image rather than one per agent set.

Timings on a warm layer cache: base 56s, `+claude` 23s, `+codex` 21s, repeat
`claude` 0s.

### Fingerprints and prepared records

- `variantFingerprint(baseSha, { claudeInstall, agents })` folds the build
  variant into the image identity. **The empty variant is the identity fold**, so
  the plain base keeps the raw context hash and a provider that passes no
  variant is unaffected. `claudeInstallFingerprint` is left alone — it ships in
  the published provider SDK.
- `variantImageRef` gives each set its own local tag (`…:dev-claude`), so two
  boxes built for different agents can't overwrite one another's image.
- `docker-prepared.json` keeps **one record per variant**. It also stamps `base`
  with the most recently prepared image for `prepare --status` and custody, so
  **read `preparedShaFor(state, variant)`, never `state.base` directly** — after
  any agent bake `base` holds a *variant* hash, and comparing the agentless
  fingerprint against it reports a spurious `stale`.

---

## Adding an agent to a running box

Point a second agent at an existing box (`agentbox codex <claude-box>`, or the
dashboard's agent switch) and it is installed on demand.

The binary install is the easy half. The subtle half is credentials: **docker
fixes a container's mounts at `docker run`**, so the new agent's config volume
can never be attached to a box that is already running. Syncing the host-side
volume would write somewhere the box cannot see and leave the agent
unauthenticated with no visible error.

So `ensureAgentInstalled` pushes the credential **as a file** over the
`SyncTransport` (`pushCredentialToBox`), preferring the `~/.agentbox` backup —
the fan-out's newest-wins copy — over the tool's real path, and shape-validating
so a half-written file counts as absent. This is not a workaround: it is what
every cloud provider already does on each create (`TransportCaps.ephemeralFs`),
and the credential watcher plus `extractAgentCredentials` still carry any
resulting login back to the host.

Because it runs over `SyncTransport` rather than `docker exec`, this is also the
first time a **cloud** box booted from a snapshot that predates an agent can get
that agent at all.

### Root escalation across seams

Docker honours `exec --user root`; cloud backends run as the box user by name and
generally ignore it. One string covers both:

```sh
if [ "$(id -u)" = 0 ]; then <cmd>; else sudo -n sh -c "<cmd>"; fi
```

`sudo -n` never prompts, so a box without a sudo grant fails fast with a usable
message instead of blocking on a password read nothing will answer.

---

## Adding a new agent

1. **Add the row** to `AGENT_SYNC_SPECS`: `id`, `binary`, `install`
   (recipe + `runAs` + any OS `packages` (+ `packagesOptional`) +
   `postInstall`), `sessionName`,
   `dockerVolume`, `staticPaths`, `credential`, `forwardedEnvKeys`, `caps`,
   plus `seeds` / `launchFlags` if the agent needs an agentbox-owned file in
   place to work (see step 4).
   Keep it JSON-serializable — no closures — so the descriptor can later be
   shipped into a box whose `agentbox-ctl` was baked before the agent existed.
2. **Add the agent's folder** under `apps/cli/src/agents/<id>/` and its arm in
   the `AGENT_MODULES` table (`apps/cli/src/agents/index.ts`) — the guided-login
   detector, and a session-teleport resolver if the agent declares
   `caps.teleport: 'full'`. Keep the `import()` specifier LITERAL; a computed one
   is not bundled and `MODULE_NOT_FOUND`s in the published CLI only.
   *No identity union to open* — `AgentId` is an open `string`, so step 1 is what
   makes the agent real to every consumer that reads the registry.
3. **Add the CLI command** — a descriptor, not a clone. In the same
   `apps/cli/src/agents/<id>/` folder: `runtime.ts` (the docker bindings and the
   agent's own login code) and `command.ts` (`buildAgentCommand({...})` with the
   help strings that are genuinely yours), plus one arm in
   `apps/cli/src/agents/commands.ts`. `index.ts`, `attach.ts`,
   `agent-sessions.ts`, `fork.ts` and `argv-prefix.ts` all read the tables, so
   there is nothing to register in any of them.
   *Nothing per-agent left in `list.ts`:* it iterates the box's agent status map,
   so a new agent shows up in the AGENT column and the cmux dock with no edit
   there.
4. **Seeded files**, if the agent loads an agentbox-owned hook/plugin/skill:
   declare `seeds: [{ bakedPath, destRel, sharedAsset, label }]` on the row, and
   `launchFlags` for any argv the agent needs to load them. Then add the file to
   `Dockerfile.box` (a `COPY` to `bakedPath`) and to `sharedFiles` in
   `apps/cli/scripts/stage-runtime.mjs` (the host copy the cloud path uploads
   when a base snapshot predates the asset). Both are asserted — a declared seed
   missing from either fails `packages/sandbox-core/test/agent-seed.test.ts`.
   There is no per-agent seeding CODE to write: docker seeds into the config
   volume and the cloud path seeds into the live box, both from this one row.
5. **Config keys**: one row in `AGENT_KINDS` (`packages/config/src/agents.ts`).
   `<agent>.sessionName`, `<agent>.dangerouslySkipPermissions` (only where the
   agent has such a flag) and `box.isolate<Agent>Config` are GENERATED from it —
   key descriptor, default and all — the way `perProviderImageKeys()` generates
   the per-provider image keys. The row exists because `@agentbox/config` is a
   zero-internal-dep leaf (`sandbox-core` depends on *it*), so it cannot read
   `AGENT_SYNC_SPECS`; it is the same copy-not-import arrangement `PROVIDERS`
   uses, and it is drift-tested against the registry from `apps/cli`, which can
   see both. Two hand edits remain and cannot be generated: the block on the
   `UserConfig` / `EffectiveConfig` interfaces (a TypeScript interface cannot be
   built from a runtime array) and its branch in
   `packages/config/schema/user-config.schema.json`, which is
   `additionalProperties: false` — both are caught by the config suite rather
   than left to discover. The command descriptor reaches the keys through typed
   accessors (`sessionNameOf`, `isolateOf`, `cliOverrides`).
6. **Activity reporting**, if the agent should report one: declare
   `caps.activitySource` — a list of `hooks` / `plugin` / `scraper`, empty if it
   reports nothing (ctl then skips probing it rather than adding a permanently
   `unknown` entry to every snapshot). *There is no ctl code to write:* status is
   a keyed map, one `agent-state <agent> <state>` op serves every agent, and the
   tmux session to probe ships from the host over the `agents.list` descriptor —
   so an agent added after an image was baked reports activity with no re-bake.
   Two things are enforced rather than documented: declaring `plugin` requires
   the `seeds` that put the plugin in the box, and a `WATCHED_CREDENTIALS` entry
   must match the registry (drift tests in `packages/sandbox-core` and
   `packages/ctl`).
   *Do not repoint the seeded hook files at `agent-state`.* ctl still ships the
   frozen `<agent>-state` names for the built-in three, because agent config
   volumes are SHARED BETWEEN BOXES: a `hooks.json` seeded by a newer image can
   be read by a box running older baked ctl, and that box would silently stop
   reporting.
7. **`agentbox download <agent>`** — the box-to-host direction. A CLI command
   (`apps/cli/src/commands/download-<agent>.ts`) plus the pull functions and
   box-path constants in `packages/sandbox-core/src/sync/agent-pull.ts`. Easy to
   miss: nothing fails without it, the subcommand is simply absent, so an agent
   added without this step can never sync its box-side config back.

Step 3 is no longer a 1,300-line clone and step 6 is no longer a wire change
(see the backlog below). **Step 5 is the only per-agent tax left** — a
generalized config namespace collapses it; step 7 is the other open one. See the
seam
analysis in
[`agent-catalog-plan.md`](./agent-catalog-plan.md), and the backlog below.

---

## Provider status

| | docker | hetzner | e2b | daytona | DO | vercel |
|---|---|---|---|---|---|---|
| agentless base | yes | yes | yes | yes | yes | yes |
| agents as a derived layer/snapshot | yes | yes | yes | yes | yes | yes |
| per-box agent selection | yes | yes | yes | yes | yes | yes |
| install into a live box on demand | yes | yes | yes | yes | yes | yes |

Every provider now carries the same three tiers.

Every cloud box gets per-agent credential isolation at **create**: an
`agentbox claude --provider <cloud>` box seeds only claude's credential, and the
other agents' symlinks dangle. On a provider with an agentless base that now
holds across pause/resume too — verified live on hetzner and daytona.

> **Resolved:** daytona used to re-materialise the other agents' credentials on
> resume. It was never host re-seeding (proven with the relay stopped and the
> backend's `uploadFile`/`exec` instrumented); the archive/restore re-applied
> content from a baked base that contained every agent's credential paths. The
> agentless base removes the source, and a resumed box now shows only its own
> agent's credential.

### The three tiers, per provider

Everything below is the same idea as docker's `FROM base` layer: an agentless
base, one artifact per agent set on top of it, and a runtime install as the
fallback when no matching artifact exists. Only the *derive mechanism* differs —
there is no shared `deriveAgentSnapshot` over `CloudBackend`, because
hetzner/DO's `backend.exec` is gated on a per-box SSH key and cannot address a
bake VPS.

| provider | how a variant is derived | measured cost |
|---|---|---|
| docker | `FROM base` + recipe | seconds |
| e2b | `Template().fromTemplate(base)` — declarative, no boot | **43s** |
| daytona (container) | recipe appended to the same Dockerfile build; the builder's layer cache serves everything below it | **77s** (base: 3m18s) |
| daytona (linux-vm) | boot the base snapshot, install, stop, cold-snapshot | untested live |
| hetzner | boot the base snapshot, install over ssh, re-snapshot | ~3.5 min |
| digitalocean | boot the base snapshot, install over ssh, re-snapshot | see below |
| vercel | boot the base snapshot over the SDK, install, re-snapshot | see below |

The recipes are the same `AGENT_SYNC_SPECS.install` entries in every row, so a
baked agent and a runtime-added one are byte-identical in layout.

### Rules that cost us a live debugging cycle each

- **The base pin defeats variant selection.** Every bake pins
  `box.image<Provider>` to the base's own name, so by create time the image ref
  usually *is* our base rather than the sentinel. Hetzner and daytona both need
  a `refIsOurBase` escape that treats it as "no explicit choice", and so does
  DigitalOcean; e2b doesn't, because its backend ignores `req.image` entirely.
- **A variant bake must not pin, share, or adopt.** `box.image<Provider>`, the
  custody record and base adoption are all single-slot: a variant written into
  any of them makes every box on that provider boot one agent's snapshot.
- **`base` must stay the agentless base**, never "the most recent bake".
  Provider-generic readers (freshness, bake sharing, `prepared-custody.ts`) read
  `base.contextSha256` / `base.imageRef` and assume exactly that.
- **A variant must match the base's class/shape.** On daytona a snapshot's class
  is immutable, so the variant takes its class from the base rather than from
  config — a `box.daytonaClass` that disagrees with what was baked would
  otherwise produce an unbootable pairing.
- **Derived bakes log in as the box user, not root** (hetzner, DO): the base
  already carries `PermitRootLogin no`, so a root key is accepted by cloud-init
  and then refused by sshd — which looks like an unexplained `waitForSsh`
  timeout.
- **DigitalOcean cloud-init must stay ASCII.** DO truncates user-data at the
  first non-ASCII byte, so a single em-dash in a comment silently drops the
  whole document: no key is injected and ssh fails with "Permission denied
  (publickey)". Hetzner's derived generator has one; DO's copy must not.
- **A DO snapshot only boots in the regions it lists.** The derived bake reads
  `snapshot.regions` and moves the temp Droplet into one of them rather than
  trusting `box.digitaloceanRegion`. Hetzner has no analogue — its snapshots are
  account-wide.
- **Verify the binary on the BOX USER's PATH**, not just that the build exited
  0. A native installer run as root writes into `/root` and does both.
- **Prerequisites are not all Debian.** Vercel sandboxes are Amazon Linux 2023,
  so `renderPackageInstall` dispatches on the package manager the box actually
  has (`apt-get` | `dnf` | `microdnf`) instead of hardcoding `apt-get`, which
  exits 127 there. Codex's `bubblewrap` is additionally marked
  `packagesOptional` — it ships a bundled sandbox and only warns without the
  system one, so a missing package must never cost a whole box create. New
  prerequisites default to REQUIRED and have to opt into being skippable.
- **A vercel snapshot carries no name, label or tag.** `createSnapshot` accepts
  only `{sessionId, expiration}`, so `vercel-prepared.json` is the *only* record
  of which snapshot is which — there is no server-side orphan sweep, and the
  destroy / `checkpoint rm` guards derive their protected set from that file.
- **Guard every shared tier, not just the base.** Vercel's `destroy` protected
  one id, relying otherwise on `currentSnapshotId === sourceSnapshotId`. That
  source is *session*-scoped and can be absent on a resumed session, so any
  shared snapshot that was not the base — a variant, or a checkpoint — could be
  deleted out from under every box that boots it.
- **Vercel needs no pre-snapshot `sync`.** `sb.snapshot()` stops the sandbox
  before imaging, so the page-cache race that silently emptied hetzner/DO
  snapshots does not apply. Adding one would just cost a resume cycle.

### Per-variant records and GC

Each provider keys one record per agent set under `variants` in its own
`~/.agentbox/<provider>-prepared.json` (`''` = the agentless base), so baking
codex never invalidates the claude artifact. Schema bumps: hetzner 3,
digitalocean 3, e2b 2, daytona 2 — all with lossless migrations that seed
`variants['']` from the existing `base`.

GC differs by how each platform addresses artifacts:

- **hetzner / daytona / digitalocean / vercel** — id- and name-addressed
  snapshots, so a rebuild orphans its predecessor. All four reap it, but only for
  that exact variant and only after the replacement is recorded, so a failed bake
  never leaves you with no base. Hetzner, DigitalOcean and Vercel had no
  base-snapshot GC at all before this.
- **e2b** — templates are *named*, so rebuilding `agentbox-claude:latest` moves
  the tag rather than orphaning an id. There is also no `Template.delete` in the
  SDK to reap one with.

Identifying a snapshot's tier from the platform side varies too: hetzner carries
an `agentbox.agents` label (`none` for the base), while daytona's
`snapshot.create` accepts only name/image/resources/region — so there the **name**
is the only channel, hence `agentbox-<set>-<fp12>`. DigitalOcean is the same: a
snapshot carries no tags, and its name is doubly load-bearing because it is also
how the bake recovers the snapshot id after the async snapshot action completes.

---

## Backlog: where the seam still leaks

The *install* seam is clean — one `AGENT_SYNC_SPECS` row drives the docker
derived layer, every cloud derived snapshot, and `ensureAgentInstalled`, so a
baked agent and a runtime-added one are byte-identical. Everything below is a
place where agent knowledge still lives as **code** instead of data. None of it
is broken; all of it is work a fourth agent would pay for.

### 1. `agentbox download` duplicates the registry's paths, in reverse — **partly done**

Fixed: the box roots and the pull item lists now derive from the registry.
`agentBoxDir(agent)` reads `staticPaths[0].boxDir`, and each spec carries an
`AgentPullSpec` (`items` / `categories` / `jsonMerges`) that
`CLAUDE_PULL_DIR_CATEGORIES`, `CODEX_PULL_ITEMS` and the two opencode lists are
derived from. A drift test asserts the derivation and that every agent declaring
`staticPaths` also declares how to pull them — the gap that let `download` be
forgotten silently.

`AgentPullSpec` is deliberately NOT `staticPaths`: that field's
`exclude`/`include` are push-direction hygiene (claude drops `projects` and
`sessions` on the way in) while the pull's real filters are different ones, and
opencode's `update: true` state root must never be pulled at all — newest-wins is
the opposite of pull's additive rule. The test pins that exclusion.

**Still open:** the three `download-<agent>.ts` commands remain separate
(~120 lines each), and `pullClaudeExtrasViaTransport` /
`pullCodexConfigViaTransport` / `pullOpencodeConfigViaTransport` are still three
functions rather than one driven by the strategy in the spec. Codex and opencode
are the same function differing only in group/root/items; claude is a genuinely
different shape (category children + a JSON registry merge with a path rewrite),
so collapsing them needs the two strategies implemented, not just declared.
The docker-side pull also hand-rolls its own inventory shell, so it can still
drift from the transport path even though both now share the item lists.

### 2. ctl carried a second copy of the credential paths, frozen at bake — **done**

`WATCHED_CREDENTIALS` (`packages/ctl/src/credentials-watcher.ts`) mirrors
`AGENT_SYNC_SPECS[..].credential.boxAbsPath`, and a drift test keeps the two in
lockstep. The sharper problem was that **`agentbox-ctl` is baked into the
image**: a box built from a snapshot baked before an agent existed watched the
old list, so that agent's credential refresh was never reported to the host until
the image was re-baked — and a plugin-supplied agent, which can never be baked,
was invisible forever.

Fixed: ctl now **pulls** the list from the host over an `agents.list` relay RPC
at daemon start, modelled on `tool.list`. Pulled rather than pushed as a file, so
the payload's shape stays host-side and no provider (including a community one)
has to write it. That turns adding an agent from "re-bake every base" into
"restart ctl".

Two rules the implementation depends on, both learned the hard way:

- **Failure is silent and keeps the baked list.** An unreachable relay, an older
  host, or a malformed payload must all leave the box watching what it already
  watched — never nothing.
- **The fetch is never awaited on the startup path.** On a cloud box the
  in-sandbox relay parks every RPC on a `HostActionQueue` that has no timeout and
  expires entries only when the host poller drains it, so with the host off the
  call never settles. The watcher therefore starts on the baked list and is
  upgraded via `setFiles()`; the fetch is additionally bounded at 30s.

Why this matters most for Claude specifically: an OAuth refresh **rotates** the
refresh token, killing every other copy (host backup, other boxes). The watcher
posting the fresh blob to the relay is what keeps the fleet logged in, so a box
whose ctl doesn't watch a credential silently degrades the whole fleet's login
for that agent, not just its own.

**Still open:** a box already *running* when the host's agent list changes picks
it up only on the next ctl restart. `ToolLinksWatcher` solves the equivalent with
`agentbox-ctl tool relink` over `Provider.exec`, but that works because tool links
are on-disk state another process can rewrite — this list lives in the daemon's
memory, so the same push needs a ctl socket op.

### 3. Community provider plugins cannot support per-agent variants — **done**

Fixed: the SDK now re-exports `variantFingerprint`, `normalizeAgentSet`,
`agentSetArg`, `resolveAgentSpec`, `resolveAgentInstall`, `renderInstallRecipe`
and `renderPackageInstall`, and `docs/provider-plugins.md` documents the opt-in
with a worked example. Purely additive — `agents` was already optional on
`PrepareOptions` and `CloudProvisionRequest`, so a plugin that ignores it still
degrades gracefully and `SDK_API_VERSION` stays at 2.

The published surface is pinned by `pack:test`, which installs a real packed
tarball in isolation and fails naming any missing export.

### 4. The per-agent command tail — **mostly done**

`agentbox claude`, `agentbox codex` and `agentbox opencode` were three
hand-maintained files totalling **4,866 lines** for what is one command.
Measured, not estimated: normalise the agent's name out of codex and opencode and
`diff` is 671 lines — ~1,070 were byte-identical. Claude was closer than its line
count suggested: normalised against codex it added exactly **four** options
(`--plan`, `--headless`, `--code`, and one login flag); its extra ~600 lines were
the headless-login machinery and the `--plan` / plugin-rebuild blocks woven
through a body that was otherwise the same.

They are now one factory (`apps/cli/src/agents/command/`) and three descriptors:

| file | holds |
| --- | --- |
| `agents/command/options.ts` | the 38-option surface, in order |
| `agents/command/create-action.ts` | the create body: `-i` queue path, gates, hub route, cloud delegate, docker create |
| `agents/command/start-attach.ts` | `<agent> start` / `<agent> attach` |
| `agents/command/login.ts` | the default `<agent> login` |
| `agents/<id>/runtime.ts` | the agent's docker bindings + its own login code |
| `agents/<id>/command.ts` | the descriptor: help strings that genuinely differ, plus hooks |

Two tables, both with literal specifiers, both under `agents/`: the lazy
`AGENT_MODULES` (`index.ts`) for spec/login/teleport/runtime, and the eager
`AGENT_COMMANDS` (`commands.ts`) for the commander tree. Lazy vs eager is not
cosmetic — `session-teleport` and `agent-sessions` load a module on paths that
must not pull three commanders' worth of imports behind them.

**Per-agent behavior is a closed set of five hooks**, and claude is why they
exist: `preflight` (its `--plan` payload), `beforeCreate` (the setup wizard),
`afterCreate` + `afterVolumeSync` (plugin native deps, setup-skill seeding,
codex's activity hooks), `attachExtras` (clipboard paste), plus `extendCommand`
for `--plan` itself. If a sixth is ever needed the body is not actually shared,
and forking that agent's path is the honest answer.

Some things that looked like accidents turned out to be deliberate and are now
**declared** rather than forked:

- `signInOfferTiming` — claude asks you to sign in BEFORE its wizard can spend
  minutes re-baking a stale base; codex and opencode ask after the hub-routing
  decision, so a box the control box will build never prompts for a local login
  it will not use. Unifying either way loses one of those.
- `acceptsSeedPrompt: false` (opencode) — its launch takes no opening turn, so a
  resync-conflict warning goes to stderr instead of becoming a prompt.
- `ensureInstalledOnCreate: false` (claude) — it has never probed for its binary
  on create, and turning that on is a behavior change on the daily driver's hot
  path, not a cleanup.

**How the collapse was kept honest.** `test/_fixtures/agent-cli-surface.json` was
captured from the three hand-written commands BEFORE the factory existed: every
flag, short form, description, default and positional argument of all three
commands and their subcommands. It is unchanged, which is the whole claim.

The fixture is also not sufficient, and both ways that surfaced are worth
recording. A live smoke caught the one regression it structurally cannot: with
teleport living in each agent's own hook, `agentbox opencode -c` — no teleport,
therefore no hook — silently ignored the flag and built a box instead of
refusing. The flag was still declared, so the fixture was green. Teleport now
resolves in the shared body for every agent, and
`agent-resume-flags.test.ts` drives that body directly so it cannot regress.

Review also caught the one regression the factory itself introduced: claude's
`--plan` marked the run hub-incompatible but left the *reason* unset, so
`agentbox claude --plan … --via-hub` printed a blank warning line before building
locally. The reason had been an optional field on the preflight result that a
hook could forget; it is now only `text.hubIncompatibleReason`, which
`AgentCommandText` requires — the omission is no longer representable.

And one the fixture was never going to see because it predates the factory: the cloud `attach` / `start` branches fell back to the REGISTRY
default session name (`opts.sessionName ?? 'codex'`, three copies) while the
docker branch read `<agent>.sessionName`, so a custom session name meant create
started one session and a later cloud attach silently created a second. One line
to fix now that there is one; `agent-session-name.test.ts` pins it.

What was already done before this is the identity half. There used to be **eight** types spelling the
same thing — `SyncAgentKind`, `AgentKind`, `AgentName`, `TeleportAgent`,
`CloudAgentKind`, `ForkAgent`, `CmuxAgentMode`, `HerdrAgentMode` — plus ~35 more
sites re-declaring `'claude' | 'codex' | 'opencode'` inline. All of them now read
`AgentId` / `AgentMode` / `QueueAgentKind` from `@agentbox/core`.

`AgentId` is an **open `string`**, not a union: an agent is a registry row, so
which ids are valid is a runtime fact. `isAgentKind` (`@agentbox/core`) answers
for the built-ins — a dependency-free leaf has no registry to ask — and
`isRuntimeAgent` (`@agentbox/sandbox-core`) answers from the registry. That is
the same split as `isProviderKind` vs `isRuntimeProvider`, for the same reason.

The trade is real and is paid for by tests, because the compiler no longer lists
the sites a new agent misses:

- `no-inline-agent-union.test.ts` fails if any file re-declares the agent set as
  a literal union. It is tuned to the *agent set*, not to any union containing
  two agent names — `OpenInApp` in `commands/_open-in.ts` legitimately lists
  `Claude.app` and `Codex.app` beside herdr, cmux and finder, and a fourth agent
  does not belong there.
- `agent-module-table.test.ts` asserts `AGENT_MODULES`'s keys equal `agentIds()`,
  that each module carries its registry row **by reference**, and that a
  `teleport` resolver is present exactly when `caps.teleport` is `'full'`.
- `agent-command-coverage.test.ts` asserts the eager command table covers the
  registry, and that each entry carries both a command and an attach wrapper.
- `agent-cli-surface.test.ts` diffs the whole CLI surface against the fixture
  above.
- `agent-resume-flags.test.ts` drives the create body's `-c` / `--resume`
  handling for every agent, including one with no teleport.

Deleting any of those silently re-closes the type. Writing the sweep also
surfaced four more places where a capability had been spelled out a second time
as a literal — `agent-sessions`' `ResumableAgent`, `_cloud-attach`'s resume gate,
`attach`'s agent-priority map and the custody store's valid-agent segments — all
of which now read `caps.resume` or `agentIds()`.

**Deliberately not done:** `AGENT_SYNC_SPECS` does not derive from the module
table. The table is lazy and the specs are read synchronously in ~40 places
across sandbox-core / cloud / docker / relay / hub; deriving would make all of
them async to no benefit, since a spec is small pure data rather than a heavy
SDK. The registry stays the synchronous source of truth and the module table is
the behavior tier above it.

### 5. Spec fields that were declared but inert — **partly done**

Three fields shipped on `AgentSyncSpec` with **zero consumers**, so an agent that
set them got silence and the real behaviour stayed hardcoded elsewhere.

Fixed:

- **`boxRunEnv`** now drives the in-box env on both the docker and cloud paths.
  They had already drifted: cloud set `OPENCODE_CONFIG_DIR` and silently omitted
  `XDG_STATE_HOME`, so a cloud box kept OpenCode's `model.json` outside the dir
  the snapshot captures and lost the selected model across a resume, while a
  docker box kept it. A test now asserts docker and cloud agree with the
  declaration key for key.
- **`caps.resume`** gates `fork`'s `--session` refusal and **`caps.teleport`**
  gates `prepareTeleport`, instead of both testing `agent === 'opencode'`. The
  refusal text moved onto the capability as `caps.teleportStubReason`, so
  declaring `teleport: 'stub'` is now the whole job — no `case` in
  `prepareTeleport` and no per-agent module (`session-teleport/opencode.ts` is
  gone).

**Still open** (and one now closed):

- **`caps.activitySource`** is now a LIST (`hooks` / `plugin` / `scraper`) and
  wired — see section 7. Its old single value under-described reality: claude is
  hooks-primary with a scraper backstop, codex is scraper-primary, opencode is
  plugin-only.
- **`watch` / `roots`** reach the box (see item 2) but nothing consumes the
  `backup` route yet. Wiring it means routing through `cp.toHost` behind a
  `box.agentFileSync` config, with the trust rule `download.claude` already uses:
  a destination inside the box's host project folder is silent, anything outside
  prompts. **Parked by choice:** no built-in agent has a file worth mirroring, so
  the route would ship with no declarer — it wants the agent that needs it.
  (`roots` is filed here but is a different animal: it is a host-side `download`
  field that never reaches a box, and nothing resolves a pull group through it.)

### 6. Hook seeding was three hand-written functions, and docker-only — **done**

`seedSetupSkillIntoVolume` / `seedCodexHooks` / `seedOpencodePlugin` were the
same throwaway-container copy written three times, differing only in which file
went where. They are now `AgentSyncSpec.seeds` — baked source, destination
relative to the config root, and the `runtime/_shared` basename to fall back to —
with `launchFlags` alongside for the argv an agent needs to LOAD what was placed
(codex ignores a `hooks.json` without `--enable hooks
--dangerously-bypass-hook-trust`).

Living in `@agentbox/sandbox-docker` meant **the cloud providers never ran any of
it.** OpenCode's state plugin is its only activity source
(`caps.activitySource: 'plugin'`) and was not even shipped to the VPS providers,
so every cloud OpenCode box reported `unknown` forever; codex never got its
`hooks.json`, nor the flags to load it. Exactly the `boxRunEnv` drift, one item
earlier.

Both transports now run one plan built in `sandbox-core`, asserted equal key for
key. The cloud path prefers the baked copy and falls back to uploading the host's
staged `runtime/_shared/` copy — which is what makes the fix reach **existing**
snapshots: the deployed Hetzner base has no OpenCode plugin to copy, and a
re-`prepare` of every provider would otherwise have been a prerequisite.

Three things, all about WHERE the seed call goes — the declaration was the easy
half:

1. **Seeding on `attach` but not on `start`.** The first version put the cloud
   call on the CLI action closures — and `wireAttachAction` / `wireStartAction`
   are separate bodies, so one edit covered one of them. Found by deleting the
   plugin from a live Hetzner box and running `start`.
2. **Seeding a box that was still paused.** Moving the call onto the two launch
   primitives fixed (1) but left them disagreeing: `cloudAgentAttach` resumes the
   box first, `cloudAgentStartDetached` did not. A seed exec against a paused
   sandbox fails, and best-effort means it fails *silently* — so the agent
   launched without its plugin on exactly the resume-from-pause path where an
   older box needs the seed most. Caught by Bugbot.
3. **A spinner frame is not evidence.** The create-time seed log line never
   rendered for OpenCode — set and replaced inside one spinner frame — while the
   codex one happened to survive. The file in the box was the ground truth; the
   log was an artifact of timing.

(1) and (2) are the same mistake twice: the ordering rule ("box running, then
seed, then launch") was re-derived at each call site. It is now stated once, on
`seedDeclaredFilesForLaunch`, and the seed for the detached path lives *inside*
`startDetachedCloudAgent` after its own `provider.start` — so the control box's
create worker gets it too, not just the CLI.


### 7. Activity status was five named fields, and OpenCode's was dropped — **done**

`BoxStatus` carried a required `claude` plus optional `codex`/`opencode`, three
`<agent>-state` ops, three reporter setters and three snapshot branches; the hub
`/api/v1` Box carried five named fields; `list`, the dashboard, the attach footer
and the relay's queue gate each re-spelled the same three names. A fourth agent
could not report activity — not "was not wired up", but had nowhere to put the
value.

Status is now a **keyed map** (`AgentStatusMap` in `@agentbox/core` — the leaf
both ctl and the relay can reach, since ctl depends on the relay and not the
reverse), with one `agent-state <agent> <state>` op behind it. ctl learns which
tmux sessions to probe from the `agents.list` descriptor it already fetches, so
an agent added after an image was baked is probed **without a re-bake** — the
same reconcile shape `CredentialsWatcher` uses (start on the baked list, upgrade
detached, never on the daemon's critical path).

**Three live bugs came out of it, all of them "the field simply wasn't there":**

1. **OpenCode's activity was produced, transported, persisted, and then dropped.**
   `opencodeActivity` existed nowhere in the repo. Its plugin has always reported
   a real state, and `lifecycle.ts` projected only the session title — so `list`
   could print a bare `opencode` and nothing more, and an OpenCode box that
   errored could not even raise the box's status to `error`. PR #344 had just
   finished making that plugin reach cloud boxes, and the result was invisible.
2. **`agentbox agent state` / `wait-for` / `get-plan-question` were claude-only.**
   Not by a missing flag: `getAgentState` returned `{ claude }` and every wait
   predicate took `BoxStatusClaude`, so on a codex or opencode box they read
   claude's permanent `unknown` forever. They now read the box's most active
   agent, or `--agent <id>`.
3. **The hosted (Postgres) plane emitted none of the five fields**, unlike the
   in-process one, so `agentbox list`'s AGENT column silently degraded to `-`
   against a control box.

**Two things deliberately did NOT change, and both are load-bearing:**

- **`BoxStatus.schema` stays `1`.** `readBoxStatus` and the relay's
  `isValidBoxStatus` both reject anything else outright, so a bump would blank
  every field on every existing reader rather than degrade. `agents` is an
  additive field — the same discipline `probed`, `expose` and `sessionTitle`
  already follow on this type — and back-compat is read-time normalization, the
  rule `normalizeLastAgent` states for persisted agent names.
- **The named fields are still written and still published.** The snapshot writes
  them as a *derived* mirror of the map (asserted derived by a test, so it cannot
  quietly go stale), and the hub payload still carries all five plus the new
  `opencodeActivity`. Skew runs both ways — a baked ctl outlives the host that
  reads it, and a laptop CLI is routinely a different build from the control box
  it points at — and those fields drive the queue's working gate, autopause and
  keepalive, not just display. The macOS tray decodes the three `*SessionTitle`
  keys **by name, as optional strings**, so removing one would blank its box
  labels silently rather than fail loudly.

The seeded hook/plugin files still invoke `<agent>-state`, and ctl still ships
those command names (generated from the built-in list). Agent config volumes are
**shared between boxes**, so a `hooks.json` seeded by a newer image can be read by
a box running older baked ctl; repointing those files at `agent-state` would
break activity reporting on exactly that box, silently.
