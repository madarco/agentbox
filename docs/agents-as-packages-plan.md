# Agents as packages

Status: **in progress on `feat/agents-as-packages`.** Update the phase status
lines as work lands; one session per phase.

> Successor to the "agents as in-monorepo plugins" series (PRs #336–#345, all
> merged into `feat/custom_agents`), whose record lives in
> [`agents.md`](./agents.md). That series made agent *data* derive from one
> registry row. This one moves the *code* into packages.

## Context

**Where we came from.** The previous phase (items 0–7 of "agents as in-monorepo
plugins", PRs #336–#345, all merged into `feat/custom_agents`) made agent *data*
derive from one registry row and collapsed the CLI surface: one open `AgentId`,
one command factory, declarative hook seeding, and a keyed agent status map. That
work is done and its record lives in `docs/agents.md`.

**What it did not fix.** Agent *code* still lives inside shared packages, and the
bulk of it is not in the CLI at all:

| where | lines | note |
| --- | --- | --- |
| `apps/cli/src/agents/` | 4,159 | already one folder per agent |
| `packages/sandbox-docker/src/sync/agents/` | 3,077 | **plus 314 per-agent references** across `create.ts`, `lifecycle.ts`, `sync/docker-sync.ts`, `credential-refresh.ts` … |
| CLI leftovers (`download-*`, `install-codex`, `lib/claude-*`) | 1,382 | never moved into `agents/` |
| `packages/sandbox-core/src/sync/` (`claude-pull`, `codex-config`, `claude-hooks-filter`) | 652 | |
| registry rows | 375 | pure data |
| `packages/sandbox-cloud/src/sync/` (`claude-json-overlay`, `codex-agents-override`) | 132 | |
| `packages/ctl/src/{claude,codex}-scraper.ts` | 270 | **cannot move** — ctl is baked into the box image |

**159 agent-named exported symbols**, of which 12 are clean claude/codex/opencode
triples (`ensure<A>Volume`, `start<A>Session`, `build<A>AttachArgv`,
`stage<A>StaticForUpload`, `runInteractive<A>Login`, …) and 7 more are pairs.
Each triple is one interface method wearing three names.

**A full audit counted 611 sites** outside `apps/cli/src/agents/`:

| bucket | sites | |
| --- | --- | --- |
| **C. Branching** | 236 | switches, three-arm chains, name arrays, per-agent barrels |
| **B. Behavior** | 132 | login, teleport, config merge, hook filter, pane scrape, pull |
| **E. Name-only** | 124 | `BoxStatusClaude` / `ClaudeActivityState` aliases over agent-agnostic logic — a mechanical rename clears ~40 |
| **A. Data** | 106 | **~60 duplicate data the registry already holds** (e.g. `SHARED_CLAUDE_VOLUME` vs the row's `dockerVolume`) — the cheapest wins |
| **D. Asset** | 13 | baked hook/plugin files, re-declared per provider |

Three findings from that audit change the shape of the work:

- **`claudeInstall` is a cross-cutting leak, not a per-agent field** — ~35 sites
  across 14 packages (config key → CLI flag → hub API → every provider's
  `prepare`/`prepared-state`/`runtime-assets` → the `AGENTBOX_CLAUDE_INSTALL`
  docker build arg). It is *already* modelled generically as
  `resolveAgentInstall(spec.install, mode)`; only the name and plumbing are
  Claude-specific. Generalizing it to an install-variant keyed by agent deletes
  most of that column.
- **A fourth agent today also edits every cloud provider.** `sandbox-hetzner`,
  `-vercel`, `-digitalocean` and `-daytona` each hardcode three staging blocks in
  `prepare.ts` and re-declare the same baked asset filenames in
  `runtime-assets.ts`. A spec-level `assets:` field lets each provider iterate.
- **`skip-permissions.ts` has no opencode arm** — `cfg.opencode` exists but no
  `applyOpencodeSkipPermissions`. A spec field (`skipPermissionsFlag` +
  `conflictingArgs`) collapses six sites and closes the gap.

**Goal.** An agent becomes a package, exactly as a provider is a package, and
every site outside it calls a generalized abstraction instead of naming an agent.
This is also the groundwork for **dynamic agent plugins** — the reason the
descriptor design below is what it is.

---

## The constraints that shape the design

These are measured, not assumed:

1. **`AgentSyncSpec` is pure data.** Every field is a string, array or plain
   object — no functions (`packages/sandbox-core/src/sync/agents/types.ts`). Its
   only non-type import is `STATE_DIR`, and `@agentbox/config` already exports an
   identical one. So agent data can live in a package whose deps are leaf-only.
2. **The relay, ctl and hub read agent data synchronously and cannot import an
   agent package.** The relay bundle carries no `@agentbox/sandbox-*` at all
   (that is what `scripts/check-cloud-backend-wiring.mjs` guards), and ctl is
   baked into the box image and deliberately never imports the registry — it
   pulls its list over the `agents.list` RPC (#340).
3. **`import()` specifiers must stay literal** for built-ins. `apps/cli`'s tsup
   inlines `@agentbox/*` via `noExternal: [/^@agentbox\//]`, so a computed
   specifier `MODULE_NOT_FOUND`s in the published CLI and never in the dev tree.
   `noExternal` is a regex, so new packages inline with no config change.
4. **`sandbox-core` is depended on by everything**, so it can never import an
   agent package. Any agent data it needs must arrive from below it or be passed
   in.

## The design

**Providers already solved constraint 2, and that is the part to copy.**
`resolveProviderDescriptor` (`packages/sandbox-core/src/provider-descriptor.ts`)
answers "what can this provider do?" **synchronously and offline, without
importing the package** — built-ins from a table, plugins from a snapshot that
`agentbox plugin add` wrote into `~/.agentbox/plugins.json`
(`PluginRecord.descriptors`). Agents get the identical seam, which is what makes
dynamic agents possible later:

```
                    data (sync, offline, never imports a package)
  resolveAgentDescriptor(id) ──┬── built-in: the aggregated spec table
                               └── plugin:   snapshot in the agent registry file

                    code (async, lazy)
  loadAgentModule(id) ─────────┬── built-in: literal import() table
                               └── plugin:   variable import(resolvedEntry)
```

### Data and behavior cannot share a package — proven, not assumed

The first attempt gave each agent package a `./spec` subpath with leaf-only deps,
on the theory that entry points would keep the graph acyclic. **They do not.**
The moment an agent package gains behavior it must depend on `sandbox-docker`,
which depends on `sandbox-core`, which depends on the registry, which imports the
agent package. Turbo refuses to build:

```
Circular package dependency detected: @agentbox/agent-example,
  @agentbox/agent-registry, @agentbox/sandbox-core, @agentbox/relay,
  @agentbox/ctl, @agentbox/sandbox-docker
```

pnpm and turbo resolve dependencies per PACKAGE; subpath exports do not split a
node in that graph. So the split is forced, and it is the provider split:

- **Data** — every built-in spec row lives in `packages/agent-registry/src/specs/`.
  Deps: `@agentbox/core` + `@agentbox/config` (the two leaves) and nothing else.
- **Behavior** — `packages/agent-<id>/`, free to depend on `sandbox-core`,
  `sandbox-docker`, `sandbox-cloud`. Nothing below them imports them; the CLI
  loads them from a literal-import table at the top.

**This costs nothing for community agents, which was the worry.** A plugin agent
lives in the user's `node_modules`, is loaded by a variable `import()`, and is
invisible to the workspace graph — structurally exempt from the cycle. It ships
its descriptor inside its own package and `agentbox agent add` snapshots it into
the registry file, exactly as `plugin add` does for providers. The central table
is only the shortcut for the agents we compile in; `resolveAgentDescriptor` is
the real seam and reads both sources.

**Package layout:**

```
packages/agent-registry/         deps: core, config  (BELOW sandbox-core)
  src/specs/{claude,codex,opencode,example}.ts   the rows
  src/index.ts                   AGENT_SPECS, resolveAgentDescriptor, visibleAgentIds

packages/agent-claude/           deps: sandbox-core, sandbox-docker, …  (ABOVE)
  src/index.ts       `agentModule`: runtime + login + teleport
  src/command.ts     the AgentCliSpec descriptor
  src/runtime.ts     docker bindings, resume probe, skip-permissions
  src/docker-sync.ts was packages/sandbox-docker/src/sync/agents/claude.ts
  src/pull.ts        was packages/sandbox-core/src/sync/claude-pull.ts
  src/login.ts       src/teleport.ts   src/download.ts
```

Adding a built-in agent is then one row in `specs/`, one behavior package, and
one literal-import arm — the same three edits adding a provider costs today.

**Where the aggregator sits.** `packages/agent-registry` (deps: `core`,
`config`) exports `AGENT_SPECS`,
`resolveAgentDescriptor`, `agentIds`. `sandbox-core` depends on it and re-exports
for today's ~48 consumers, so nothing downstream changes import paths in phase 1.

**One module table, not two — verified.** Providers need a literal-import table in
*both* `apps/cli/src/provider/loaders.ts` and `apps/hub/lib/provider-importers.ts`,
plus a third in the relay's dev-tree fallback. Agents need only the CLI one: the
hub reads `AGENT_SYNC_SPECS` and nothing else (`apps/hub/server.ts:276`,
`lib/hub-worker.ts:79`), and the relay likewise uses only `resolveAgentSpec` and
`buildAgentDescriptors`. **The hub and relay consume agent DATA and never agent
CODE**, so the descriptor seam alone serves them — which is also why a dynamic
agent will work on a control box without shipping code there.

**The inversion.** `sandbox-docker` stops importing
`sync/agents/{claude,codex,opencode}.ts` and instead receives an
**`AgentSyncModule`** — one interface whose methods are today's 12 triples:

```ts
export interface AgentSyncModule {
  readonly id: AgentId;
  ensureVolume(...): Promise<void>;        // was ensure{Claude,Codex,Opencode}Volume
  resolveVolume(...): string;              // was resolve<A>Volume
  buildMounts(...): DockerMount[];         // was build<A>Mounts
  buildAttachArgv(...): string[];          // was build<A>AttachArgv
  startSession(...): Promise<void>;        // was start<A>Session
  sessionInfo(...): Promise<AgentSessionInfo | null>;
  ensureInstalled(...): Promise<void>;
  stageStaticForUpload(...): Promise<StageResult>;
  stageCredentialsForUpload(...): Promise<StageResult>;
  pullConfigViaTransport?(...): Promise<PullResult>;
  extractCredentials?(...): Promise<...>;
  afterVolumeSync?(...): Promise<void>;    // absorbs seedCodexAgentsOverride,
                                           // seedOpencodeModelState, seedClaudeJsonAtCreate
}
```

Resolution is by injection, the shape `check-cloud-backend-wiring.mjs` already
guards for cloud backends: the CLI and hub register the loaded agent modules;
`sandbox-docker` asks a registry rather than importing. **No agent name survives
in `sandbox-docker`, `sandbox-core` or `sandbox-cloud` source.**

### Naming — the generalization pass

Every abstraction is named for the *role*, never the agent. The rule: if a name
contains `Claude`, `Codex` or `Opencode` and is not inside `packages/agent-<id>/`,
it is wrong. Representative renames:

| today | becomes |
| --- | --- |
| `ensureClaudeVolume` / `ensureCodexVolume` / `ensureOpencodeVolume` | `AgentSyncModule.ensureVolume` |
| `startClaudeSession` + 2 | `AgentSyncModule.startSession` |
| `ClaudeConfigSpec` + 2 | `AgentConfigSpec` |
| `stageClaudeStaticForUpload` + 2 | `AgentSyncModule.stageStaticForUpload` |
| `applyClaudeSkipPermissions` / `applyCodexSkipPermissions` | `AgentRuntime.skipPermissions.apply` (the seam already exists) |
| `claude-json-overlay.ts` | `agent-config-overlay.ts`, driven by a spec field |
| `seedCodexAgentsOverride`, `seedOpencodeModelState` | `AgentSyncModule.afterVolumeSync` |
| `claudeSessionInfo` | `AgentSyncModule.sessionInfo` |
| `readClaudeCredStatus` | `AgentSyncModule.credentialStatus` |

The existing `no-inline-agent-union.test.ts` grows a third case: **no agent name
in an exported symbol outside an agent package.**

---

## Branch + landing

All of this happens on **`feat/agents-as-packages`**, cut from
`origin/feat/custom_agents`. Each phase is a commit (or a small stack) on that
one branch, green at every step. It merges into `feat/custom_agents` **once, at
the end**, after:

1. Cursor Bugbot has actually **reviewed** it — note #345 reported `skipping`
   rather than passing, so "no findings" must mean a real review, not a skip.
2. The **full smoke suite** below has run live, all three agents plus the fourth,
   on docker and on one cloud provider.

## Phases

**Phase 0 — extract the shared plumbing — DONE (`32c00bb3`).**
`codex.ts`, `opencode.ts`, `seed.ts` and `shell-session.ts` all imported
`buildTermSafeTmuxExec` / `buildTmuxSessionArgs` / `CONTAINER_USER` **from
`claude.ts`**, making claude the de facto shared module — including for
`agentbox shell`, which has no agent at all. Moved to a dependency-free
`sync/agents/shared.ts`, with a test asserting no agent module imports another
and that `shared.ts` imports nothing. Both halves mutation-checked.

**Phase 1 — the seam — DONE (`d8de5bd1`); its layout is superseded by 1c.**
`AgentSyncSpec` moved to `@agentbox/core` (it imported only `AgentId`, so the
move was free). `packages/agent-registry` created below `sandbox-core`;
`registry.ts` went from 436 lines to a 45-line view, so the ~40 call sites that
reach for `AGENT_SYNC_SPECS` through `@agentbox/sandbox-core` are untouched.

**Phase 1b — the fourth agent — DONE (`7de4c368`).**
`@agentbox/agent-example`: a real registry row, `hidden: true`, whose agent is a
login shell so it needs no network and cannot rot. It broke six checks
immediately — three fixtures that hardcoded three agents (now derived from the
registry), two ctl drift tests demanding a *baked* entry for every registry agent
(which re-imposes exactly the coupling the `agents.list` RPC removed: ctl ships
inside the image, so a post-bake agent can only arrive over RPC), and one genuine
gap — an agent with `staticPaths` must declare how to pull them — fixed with a
data field. The rest, the CLI's module and command tables, opt out through
`apps/cli/test/_agents-in-cli.ts`, whose doc names the phase that deletes each
exemption. **When that file has no callers, the claim is proven.**
Verified live: `resolveAgentSpec('example')` resolves through the built package
and already reaches ctl over `agents.list` with no ctl change at all.

**Phase 1c — collapse to the central table — DONE (`0354c052`).** Move the four
`packages/agent-<id>/src/spec.ts` files to
`packages/agent-registry/src/specs/<id>.ts` and delete the four packages. They
return in Phase 2 carrying behavior, which is the only thing they can hold
without the cycle; empty shells are not left behind in the meantime.
`spec-purity.test.ts` re-points at `specs/` — the leaf-only rule is unchanged,
only its subject moves. `visibleAgentIds()` and the `hidden` flag stay as they
are.
**Phase 2 — the CLI layer.** Move `apps/cli/src/agents/<id>/` into the packages;
`AGENT_MODULES` becomes literal imports of `@agentbox/agent-<id>`. Sweep in the
leftovers: `download-<agent>.ts`, `lib/claude-*.ts`, `_claude-login-worker.ts`,
`install-codex.ts`. Fix the four hard-coded three-arm chains in
`_run-queued-job.ts` (a fourth agent silently gets the wrong session name on the
`-i` path today) and the branching in `dashboard.ts` / `compositor.ts` /
`fork.ts`.

**Phase 3a — the duplicated data — DONE (`f739ac96`).** The measured surface
`sandbox-docker` consumes from the three agent modules is only six concepts, and
one of them, `SHARED_<A>_VOLUME`, was a literal duplicate of `spec.dockerVolume`.
It now derives from the registry, and destroy's cleanup + prune's never-reap list
iterate `AGENT_SYNC_SPECS` instead of naming agents. Verified the derived names
are byte-identical — a mismatch would repoint every existing box's volume.

**Phase 3b — DONE (`d4c01a36`, `3962c3a9`, `b8548be2`, `17a8675c`, `f6d95f28`, `2ed3d832`).**
All three agents are packages, `builtins.ts` is deleted, and
`packages/sandbox-docker/src/sync/agents/` holds only shared plumbing
(`module`, `seed`, `shared`, `skills`). `@agentbox/agent-modules` is the single
registration home — the CLI and the hub each call it once, because both create
docker boxes and a missed one is a create-time throw, not a compile error.
The demo agent (`@agentbox/agent-example`) implements the same contract and was
verified end to end against real docker. What is left of phase 3 is behavior, and the
interface is now known exactly, because the import surface was measured rather
than guessed:

| what `sandbox-docker` pulls per agent | becomes |
| --- | --- |
| `ensure<A>Volume`, `resolve<A>Volume`, `build<A>Mounts` | `AgentSyncModule` |
| `<a>SessionInfo` | `AgentSyncModule.sessionInfo` |
| `warmUpClaudeCredentials` | claude-only; `AgentSyncModule.warmUpCredentials?` |
| `seedCodexAgentsOverride` | `AgentSyncModule.afterVolumeSync?` |
| `<A>ConfigSpec` types | `AgentConfigSpec` |

`AgentSyncModule` + a registry now exist in `sandbox-docker`, and every call
site goes through them except claude's `ensureVolume` (its result reports four
extra outcomes and one log line interpolates `ctx.hostWorkspace` — it converts
when claude moves). `builtins.ts` adapts the three shipped modules and registers
them on import, so behavior is unchanged while nothing has moved yet.

**What is left of 3b:** move `sync/agents/<id>.ts` into `packages/agent-<id>`
and register from the app instead of `builtins.ts`. Each agent's arm leaves that
file as it goes, so the exemption in `agent-module-isolation.test.ts` shrinks to
nothing. Land per file, claude last — it is the daily driver.

**Phase 2 — the CLI layer — STARTED; the blocker is smaller than measured.**
The 26-shared-module count is right but misleading, and re-measuring changed the
plan:

- **All six heavy imports belong to claude alone** — `commands/prepare` (975
  lines), `commands/control-plane` (2,729), `wizard.ts`, `provider/registry`,
  `checkpoint-lookup`, `commands/_errors`, all from
  `agents/claude/{command,login-command}.ts`. **codex (606 lines) and opencode
  (371) touch none of them.** They need ten modules, and every one is a near-leaf
  (0–4 local imports of its own). So those two can move on a modest kit; only
  claude needs the heavy six inverted, and that is a separate step.
- **The real blocker was an import edge, not a size.** `lib/agent-login-bindings.ts`
  imported each agent's login spec and docker helpers — a per-agent table in
  shared code, pointing from the shared CLI INTO the agents. Nothing could move
  while that edge existed.

**Done (2a): that edge is gone.** Each `<agent>LoginBinding` had exactly one
caller — its own runtime, which already exposed it through
`AgentRuntime.loginBinding` — so the seam was already there and the functions
were simply on the wrong side of it. They live in
`agents/<id>/login-binding.ts` now; the shared file keeps the
`AgentLoginBinding` contract and `withLoginDefaults`, which is all
`guided-login.ts` and the command descriptor ever used (both by type only).

The `no-agent-named-exports` guard was broadened to catch the **lowercase**
form in the same pass — `claudeLoginBinding` had sat in the shared CLI unnoticed
because the guard only matched `Claude`. Six more files came into view, each
allowlisted against its owning phase, except `commands/_open-in.ts`, which is
excluded rather than exempted: its `codexAddUrl` is the Codex.app `codex://`
deep link, and renaming that would be wrong.

**Done (2b, part 1): the queue's credential pre-flight is agent-agnostic.**
`lib/queue/assert-creds.ts` was the one kit module with agent-specific
dependencies, and it dispatched with `agent === 'codex' ? codex : opencode` — so
**an agent that was neither claude nor codex silently got OpenCode's credential
check**, and a wrong answer with nothing failing. Found while sizing the kit, not
by a test.

Each agent's host check moved to `agents/<id>/host-creds.ts`, and
`AgentRuntime.hostCredStatus` is a REQUIRED member: an agent that has not
supplied one is now a compile error rather than a silent pass. The shared helper
keeps the contract, the errors, and the wording — which already had a generic
fallback for an unknown agent, so only the dispatch was ever wrong. Claude's
`'expired'` message travels in the verdict rather than sitting in the shared file
as a constant.

That emptied `assert-creds.ts` of agent names, and the stale-exemption half of
the `no-agent-named-exports` guard fired on the next run demanding its removal —
the allowlist is 27 files, down from 29.

**Done (2b, part 2 + 2d):** the kit is `@agentbox/cli-kit`, and codex, opencode
and the demo agent each ship their own `AgentCliSpec`.

**Done (2c): claude's descriptor moved, and the six heavy imports were inverted
rather than extracted.** `control-plane.ts` never had to move.

The descriptor could not follow codex's and opencode's while its hooks reached UP
into the app — `runPrepare`, `maybeRunSetupWizard`, `evaluateBaseFreshness`,
`providerForBox`, the two paste helpers. An agent package sits below `apps/cli`,
so importing them would have closed an `apps/cli -> package -> apps/cli` cycle.
They are passed IN now, through `AgentHostServices` on the create context and a
`clipboard` argument to `attachExtras`.

Two things fell out of doing it properly:

- **Three of the six collapsed into one.** claude never *read* `baseStatus` — it
  graded the base, decided whether a hub route made that grading irrelevant, ran
  the wizard, and re-baked on `rebuildBase`, all to forward a value it never
  inspected. That is app policy end to end, so it lives behind a single
  `host.setupWizard()` and the agent passes only what it knows
  (`checkpointFromDefault`). `buildPromptArgs` needed no seam at all: it is a
  one-line wrapper over `resolveAgentLauncher`, which agent packages already have.
- **The wizard's `command: 'create' | 'claude'` discriminant was never about
  claude** — it distinguished the outer `agentbox create` pass from an agent's
  own. Spelled `'agent'` now, so any agent reaching `host.setupWizard` gets the
  real behavior instead of the `!== 'claude'` early return.

`apps/cli/src/agents/` is now the pipeline plus four ~15-line shims. The guard's
blanket `apps/cli/src/agents/` exclusion — which had meant claude's 289-line
descriptor was never measured — is narrowed to those four files, so everything
else in the folder is checked like any other shared code.

**Phase 4 — `sandbox-cloud` — PARTLY DONE (`568cac29`).** `AgentCloudModule` is
the cloud twin of `AgentSyncModule`; codex's `AGENTS.override` fold and
opencode's model-state seed moved into their packages. A separate interface, not
a field on the docker one, because its methods take `CloudBackend`/`CloudHandle`
and the cloud layer depends on the docker layer.

*Worth remembering:* replacing the two named calls with the loop silently dropped
opencode's seed until its module was registered — the existing order test caught
it. Without that assertion a cloud box would have booted on the wrong model with
nothing failing.

**Still open in phase 4:** claude's `seedClaudeJsonAtCreate` (runs after the
declared files and needs `hostWorkspace`, so joining the loop moves it in the
sequence — verify against a real cloud box first), and the `sandbox-core` side:
`claude-pull`, `codex-config`, `claude-hooks-filter`, `host-stage.ts`. The pull
strategy becoming spec-driven is open since #338.

**Measured blocker on that `sandbox-core` side, found when the moves were
attempted.** `claude-hooks-filter` and `codex-config` have exactly one consumer
each outside `sandbox-core` — the matching agent package — and neither is on the
published SDK surface, so both look like clean moves. They are not:
`host-stage.ts` (in `sandbox-core`) imports both, and it cannot import an agent
package without recreating the cycle. So those file moves are gated on
`host-stage.ts` itself moving, and ITS exports (`stage<Agent>StaticForUpload`)
are published SDK surface — a `SDK_API_VERSION` bump and a republish, not a
refactor. Sequence it with the bump rather than before it.

Phase 5a below took the useful half without touching the SDK: the DISPATCH is
registry-driven, so a new agent is staged everywhere even while the two
dedicated stagers still live in `sandbox-core`.

**Phase 5a — the cloud providers' static staging — DONE.** The measurement was
right and the fix needed no new `assets:` field: every `staticPaths` entry
already carries host source, box dir, sub-path, includes and excludes, so
`stageAgentStaticForUpload(agent)` stages any agent from its row alone.
`stageAllAgentStatic` iterates the registry and falls back to it, keeping a
dedicated stager only for the two agents whose staging is not a copy (claude
filters host hooks; codex sanitizes `config.toml` and purges orphan
marketplaces). `stageOpencodeStaticForUpload` became a one-line delegation,
which is the proof the generic path handles a real multi-source layout.
`hetzner`/`vercel`/`digitalocean` dropped their hardcoded three-block staging for
the shared call, and the cloud seed's `chown` derives from what it extracted
rather than listing the built-in agents' home dirs.

One spec field was added: `AgentPathMap.stagedAs`, marking OpenCode's two-way
state tree as shipping on its own newest-wins path. Baking it into a snapshot
would hand one box's state to every box made from that snapshot.

Two bugs found on the way: `daytona` and `e2b` computed the `--agents` set and
never passed it to `stageAllAgentStatic`, so a claude-only snapshot on those
providers carried codex's and opencode's host config; and `host-stage.ts` had no
tests at all — it has them now, mutation-checked against the excludes, the
relocation, the `stagedAs` filter and the dispatch.

**Phase 5b — `claudeInstall` — OPEN, and bigger than this plan estimated.**
Re-measured: **300 sites across 79 files**, not ~35. The original count was
`claudeInstall` alone; the real surface is that name plus
`AGENTBOX_CLAUDE_INSTALL` and the prepared-state plumbing that carries it, and
it reaches places a refactor cannot quietly change:

- `packages/provider-sdk/src/index.ts` — published SDK surface, so a rename is
  an `SDK_API_VERSION` bump and a republish.
- `apps/hub/app/(dashboard)/api/v1/lib/{openapi,validate}.ts` — the REST API's
  request schema, which the tray and the CLI-against-a-control-box both speak.
- `packages/config/schema/user-config.schema.json` and every provider's
  `prepared-state.ts` — persisted on disk in `~/.agentbox`, so a rename has a
  migration question attached.
- `Dockerfile.box` and four providers' `install-box.sh` / `provision.sh` /
  `build-template.sh` — a build arg, so it forces a re-`prepare` on every
  provider and shifts the published box-image tag.
- Seven `apps/web/content/docs/*.mdx` pages.

The mechanism underneath is already generic —
`resolveAgentInstall(spec.install, mode)` takes any agent's install block — so
what is left is the NAME and its plumbing, not the design. That makes it a
mechanical but wide change with a release implication, and it wants its own
session and its own sequencing against the SDK bump rather than being folded
into a refactor commit.

**Phase 6 — config keys — DONE.** `packages/config/src/agents.ts` holds
`AGENT_KINDS`, and `<agent>.sessionName`,
`<agent>.dangerouslySkipPermissions` and `box.isolate<Agent>Config` are generated
from it — descriptor, default and all — the way `perProviderImageKeys()` already
generates the provider keys. It is a table in config, not an import: config is a
zero-internal-dep leaf, the same arrangement `PROVIDERS` uses, drift-tested
against the registry from `apps/cli` (six checks, both halves mutation-checked).

Two deviations from this plan as written, both deliberate:

- **The opencode skip-permissions arm is not "missing" — OpenCode has no such
  flag.** The runtime seam already models that as `skipPermissions: null`, and
  the table's `hasSkipPermissions: false` means no key is generated for it.
  Generating one for every agent would ship a config key that silently does
  nothing, which is worse than its absence. The test now asserts the `null` out
  loud so a deliberate "none" and an unimplemented arm stay distinguishable.
- **The generalization that did land is the flag DATA.**
  `lib/skip-permissions.ts` is now mechanism only — `applySkipPermissions(args,
  rule, enabled)` — with each agent's flag and conflicting args on its own
  runtime, so the shared module names no agent. That took the two named
  `apply<Agent>SkipPermissions` exports out of six call sites.

Two things still cannot be generated and are caught rather than documented: the
block on the `UserConfig`/`EffectiveConfig` interfaces (a TypeScript interface
cannot be built from a runtime array — the limitation `providers.ts` already
records) and the branch in `user-config.schema.json`, which is
`additionalProperties: false`. Both fail the config suite when omitted, which is
how the demo agent's keys were found missing.

**Phase 7a — the name-only aliases — DONE.** Seven aliases over agent-agnostic
types, 77 references, all deleted rather than deprecated:
`ClaudeActivityState`, `ClaudePlanPayload`, `ClaudeQuestionPayload`,
`BoxStatusClaude/Codex/Opencode` and `CLAUDE_ACTIVITY_STATES` collapse onto the
`@agentbox/core` names they already aliased; `ClaudeSessionStatus` →
`AgentSessionStatus` (it was always a tmux probe, for any agent); and the
relay's `ClaudeState` / `BoxScanEntry.claudeState` → `CoarseAgentState` /
`agentState`, whose own doc comment already said "across ALL agents ... not just
claude".

The guard the plan asked for landed with it:
`apps/cli/test/no-agent-named-exports.test.ts` fails on any agent-named EXPORT
outside `packages/agent-*`. It carries a 23-file allowlist, each entry annotated
with the phase that removes it — and it is checked BOTH ways, so a listed file
that no longer offends fails too. The list can only shrink; when it is empty the
rule holds with no exemptions. Both directions mutation-checked. Correctly
agent-named code is excluded rather than exempted: `apps/cli/src/agents/<id>/`
(an agent's own folder, pending phase 2) and ctl's scrapers (baked into the
image; the plan says they stay).

**Phase 7b — the dynamic plugin path — DATA HALF DONE.**
`agentbox agent add|list|remove`, backed by `~/.agentbox/agents.json`, mirroring
`plugin.ts` / `plugin-registry.ts` exactly.

Simpler than the provider version for one reason: an agent's descriptor IS its
`AgentSyncSpec`, which is already pure JSON — the spec has never been allowed to
hold a function, because it is shipped into boxes whose `agentbox-ctl` predates
the agent. So there is nothing to derive; the spec is the snapshot.

`AGENT_SPECS` is `BUILTIN_AGENT_SPECS` merged with the snapshot at import (a
constant, because ~50 sites treat it as one and an agent appearing mid-create
would be worse than one appearing on the next command; `allAgentSpecs()` re-reads
for a long-lived process). A built-in always wins, by id AND by alias — a plugin
taking `claude-code` would otherwise capture every `agentbox claude-code`. Both
halves mutation-checked, and one test had to be rewritten because it passed for
the wrong reason: built-ins are scanned first, so `findAgentSpec` returns claude
whether or not the impostor was admitted. The real claim is that it never
entered the table.

**Validated end to end** with a two-file package importing no `@agentbox/*`
module at all: after `agent add` it appears in `AGENT_SYNC_SPECS`, resolves by id
and alias, satisfies `isRuntimeAgent`, and is dispatched by `stageAllAgentStatic`
into every cloud provider's snapshot — zero edits to AgentBox. Shadowing a
built-in, a package exporting no spec, and a corrupt registry file are each
refused with a message rather than a stack trace, and the registry was removed
afterwards so the dev machine is back to the built-ins.

**Phase 7b — the code half — DONE too.** `registerInstalledAgentModules()` in
`@agentbox/agent-modules` loads each record's `resolvedEntry` through a variable
`import()` and registers whatever `agentSyncModule` it exports. Both entry points
that create docker boxes await it (the CLI at top level, the hub at startup).

Kept separate from the sync `registerAllAgentModules()` rather than folded in:
it is async, and an app that forgets it still gets a fully working plugin agent
for everything data-driven — only a docker create fails, with
`requireAgentSyncModule`'s explicit message rather than a silent wrong answer.
Failures are reported and skipped, and the loop continues, because a broken or
half-uninstalled package must not take down every box command.

A package may only supply modules for agents IT registered — otherwise a plugin
could hand back a module for `claude` and take over the built-in, the code-half
equivalent of shadowing. Data-only packages are a no-op, not a failure: an agent
whose config is purely declarative needs no docker code.

Validated with the demo package extended to export a real `agentSyncModule`: it
loads, appears in `registeredAgentSyncModules()`, and its `afterVolumeSync` runs
through the very hook Bugbot flagged. The takeover attempt is refused and the
built-in survives. Both guards mutation-checked.

The loader's test had to be rewritten once: mocking `@agentbox/agent-registry`
forked the module graph, so the loader registered into a DIFFERENT
`sandbox-docker` instance than the test read — it passed while proving nothing.
It takes a `registryPath` now and runs against a real fixture package, so the
dynamic `import()` under test is the real one.

The measurement the plan asked for is recorded in `docs/agents.md` →
"What a new agent actually costs, measured".

**The example is committed, not a transcript claim.**
`examples/agentbox-agent-example` is a real, dependency-free agent plugin beside
the existing `agentbox-provider-example`, with a README and a test that loads it
the way `agent add` does and validates it with the same function the command
uses. A doc example that has rotted proves the opposite of what it claims, so the
test mutation-checks three ways: claiming a built-in alias, dropping a required
spec field, and declaring a module for an agent the package did not register.

Bugbot found two real bugs in the first version of that example, and the second
mattered more than the file: `install: { kind: 'none' }` is not an
`AgentInstall`, and `agentSpecProblem` only checked that the field was PRESENT —
so `agent add` accepted it and the failure surfaced at bake time, reading
`recipe.kind` off undefined, where the package author is long gone. Validation
now checks the SHAPE of everything load-bearing: the recipe kind and its
per-kind required field, `runAs` (an installer that drops a binary in the
invoking user's `~/.local/bin` puts it in /root when run as root),
`credential.hostBackup` being an absolute path (the fan-out WRITES there, so an
empty one drops a temp file in the process cwd and loses the login), and each
`staticPaths` entry. Every built-in spec still passes; both halves
mutation-checked.

A SECOND Bugbot pass then found two holes in that validation itself, and one was
the worst bug of the series: `hostHomeRel` was checked for being an array but
not for being NON-EMPTY, and staging does `join(homedir(), ...hostHomeRel)` — so
`[]` or `['']` resolves to the user's HOME, and cloud staging would rsync their
entire home tree into a snapshot every box made from it shares. The other:
`boxAbsPath` was only required to be non-empty while its siblings had to be
absolute, and the credential push derives the directory with
`slice(0, lastIndexOf('/'))`, so a relative `auth.json` gives an empty dir and a
copy that silently never lands. Both fixed and mutation-checked.

The lesson worth keeping: each round of validation I wrote was itself too weak,
and only an adversarial reader found it. "The example registered successfully"
never proved the spec was correct — it proved the checks were loose.

## What adding an agent costs today — measured, after phase 3b

| step | needed? |
| --- | --- |
| a spec row in `agent-registry/src/specs/` | **yes** — one file, data only |
| a behavior package `packages/agent-<id>/` | **yes** — that is the point |
| one arm in `agent-modules` | **yes** — the literal-import table, same as a provider |
| anything in `sandbox-docker` | **no** — it receives agents now |
| **a CLI command** | **yes, still** — `agents/commands.ts` + `AGENT_MODULES` are hand-maintained in `apps/cli`. This is why `agentbox example` is not a command even though the agent works. |
| config keys | **yes, still** — phase 6 |
| cloud provider staging | **yes, still** — phase 5 |

The exemptions in `apps/cli/test/_agents-in-cli.ts` are exactly that middle row.

## Smoke test — run 2026-08-31, all green

Against the branch tip, after the phases above:

- **Packed install, not the dev tree** — `npm pack` into a clean prefix;
  `agentbox claude|codex|opencode --help` all resolve. This is the check that
  catches the literal-specifier rule, which only fails in the published bundle.
- **All three agents live on docker** — created concurrently, each mounted the
  right registry-resolved config volume (`agentbox-<id>-config`), each reported
  through the keyed status map under its own id, `agentbox agent state` answered
  per box, all destroyed clean.
- **The registry path drove real work** — a codex box synced from `~/.codex` and
  its `afterVolumeSync` hook wrote `AGENTS.override.md` into the box, both
  through `AgentSyncModule` rather than a named import.
- **The canary reaches a live box** — `example` appears in the `agents.list`
  descriptor with its session name and empty `activitySource`, with no ctl change.
- Full CI: plugin-skill, lint, build, hub standalone, cloud-backends, typecheck,
  and the suite (1,417 CLI tests among them).

**Re-run after phase 3b, with every agent a package** — packed install resolves
all three; all three created live with their registry-resolved volumes; each
reported through the keyed status map; `agent state` answered per box; codex's
`afterVolumeSync` hook wrote `AGENTS.override.md`; claude's `notes` channel
carried `filtered 17 host-path hook(s)` and the `hostWorkspace` alias on an
isolated create. The demo agent was driven through its own module against real
docker: volume created and chowned, mounted, tmux session started and probed.

## Bugbot review (PR #346)

One finding, and it was a real one: **`afterVolumeSync` only ran for codex.**
The hook is declared on the shared `AgentSyncModule` contract, but
`seedAgentConfig` called it inside the codex branch only — so an agent that
implemented it was silently skipped, with nothing failing. Exactly the class of
bug this whole refactor exists to remove, hiding in the refactor itself.

The cause was the shape, not the line: `DockerSyncHandle` carried
`claudeSpec` / `codexSpec` / `opencodeSpec` as three named fields, which grew
three near-identical branches, and only one of them learned about the hook. It
is `agentSpecs: Record<string, AgentVolumeChoice>` now and `seedAgentConfig` is
one loop over the registry, so the hook runs for every agent by construction.
The per-agent log text derives from `staticPaths` instead of being written out
three times. `~/.agents` stays a separate step — it is the shared skills tree,
not an agent.

The regression test registers the hook on a NON-codex agent and asserts it
fires; mutating the loop back to `spec.id === 'codex'` fails it.

## Smoke, after phases 6 and 5a

Run live, on this branch, docker + the real host home:

- **Generated config keys** (`config list`): all four agents get
  `<agent>.sessionName`, `box.isolate<Agent>Config` for each, and
  `dangerouslySkipPermissions` only for claude and codex — OpenCode's absence is
  the point. `example.sessionName` and `box.isolateExampleConfig` set, get and
  unset through the normal precedence chain.
- **A real box**: `agentbox claude -y -d` on `examples/test-workspace` came up,
  `list` showed `claude:idle`, and the box's `status.json` carried both the
  keyed `agents` map and the legacy mirror (item 5's contract, live).
- **The skip-permissions refactor reached the real launch**: the in-box process
  is `claude --dangerously-skip-permissions`, from the rule that now lives on
  claude's runtime rather than in the shared lib.
- **The demo agent against real docker**: `resolveVolume` → `buildMounts` →
  `ensureVolume` created `agentbox-example-config` for real, through the shared
  `AgentSyncModule` contract, with no code outside `packages/agent-example`.
- **Cloud staging against the developer's actual home**: `stageAllAgentStatic`
  dispatched claude (dedicated stager — `settings.json` present and filtered),
  codex, opencode, `example` and `agents`. OpenCode's tarball, now produced by
  the GENERIC path, still has the `config/` relocation, still excludes
  `auth.json`, and still excludes the `stagedAs: 'state'` tree. With a
  `~/.agentbox-example` on the host the demo agent stages too — from its
  registry row alone.

After phases 7a and 7b, re-run plus the checks those phases added:

- **A packed install, not the dev tree** — `npm pack` into a clean prefix. This
  caught a real break: `@agentbox/agent-registry` had gone into `dependencies`,
  where it was the only `workspace:*` entry, and `npm pack` does not rewrite
  those, so the published tarball refused to install
  (`EUNSUPPORTEDPROTOCOL`). The dev tree resolves workspace links and never sees
  it. Fixed (it is a devDependency like its eight siblings), and the packed CLI
  then ran `agent list`, `config list` and the whole `agent add` → `list` →
  `remove` cycle.
- **A community agent package, end to end** — two files, no `@agentbox/*`
  import. After `agent add` it resolves by id and alias, satisfies
  `isRuntimeAgent`, and `stageAllAgentStatic` dispatches it into every cloud
  provider's snapshot. Shadowing a built-in, a package exporting no spec, and a
  corrupt registry are each refused with a message rather than a stack trace.
- **The docker create path, after the loop replaced the three branches** — a
  real box came up, claude's volume synced under the derived label, its ensure
  notes came through the generic path, its declared seeds were placed, and
  `~/.claude` + `~/.agents` were correct inside the container.
- **`agentbox dashboard` through the PTY harness** — phase 7a renamed types in
  its sidebar and footer, so it was driven live: the sidebar shows the box at
  `○ idle`, the footer reads `agentbox ▸ <box> (idle) — ✳ Claude Code`, and the
  attached agent is running with bypass permissions on (the skip-permissions
  rule that moved onto claude's runtime).

Not yet run: a real cloud `prepare` (it bakes a snapshot), and the queued `-i`
runs, which belong with phase 2.

## Phases 7 and 4 — landed, and verified on a real cloud bake

**Phase 7.** `claude-session` -> `agent-session <agent>` (and the socket op),
safe because it had zero callers — unlike the `<agent>-state` names, which
seeded hook files in shared volumes invoke. ctl's two duplicate per-agent
pointer tables collapsed into one, with the on-disk **paths frozen and pinned by
a test**: the writer is a box's baked ctl, the reader is the host CLI, so a
rename silently costs every existing box its resume.

Deviation from this plan, recorded because it was a correction: `claude-tui.ts`
was NOT renamed. It returns Claude Code's own env vars and exists because of
Claude's renderer, so `agentTuiEnv` would claim a generality it lacks. The real
leak is `binary === 'claude' ? claudeTuiEnv(...)` in `detached-agent.ts:337` —
spec data, not a rename. Re-tagged to phase 4.

**Phase 4a — SDK v3, a clean break** (`SUPPORTED_SDK_API_VERSIONS = [3]`). The
three per-agent stagers are replaced by `stageAllAgentStatic`. A v2 provider
bakes exactly three agents, so on a host with a fourth it produces a snapshot
silently missing it — a wrong box, not an absent feature, which is why the older
majors are refused rather than tolerated.

**Phase 4c — the second hardcoded triple.** `sandbox-cloud`'s own `AGENT_SPECS`
meant a fourth agent got no credential mount, no static mount and no seed in a
cloud box. Rows derive from the registry now; staging closures arrive through
the `AgentCloudModule` seam (claude had no cloud module and now registers one).

**The CI gap that let all of this hide.** `examples/` is outside
`pnpm-workspace.yaml`, so nothing built, typechecked or tested it — the v3 bump
could have refused both examples with the suite green, exactly how the agent
example shipped broken. There is a test now, and it also pins the two halves of
the version decision that live in different packages (the SDK's
`SDK_API_VERSION` vs the CLI's supported set), which `pack:test` never covered.

### Verified live on e2b, not just in tests

A real `prepare --provider e2b` (template `o05kawibx9vcmxvgjnk4`) baked clean
through the new staging path, seeding claude, codex, opencode and `~/.agents`
into the image — the demo agent correctly absent, since the host has no
`~/.agentbox-example` to stage. Then a real `agentbox claude --provider e2b` box:
all four static dirs present, both cloud modules' `afterSeed` hooks ran (codex's
`AGENTS.override.md`, opencode's model seed), and — the thing 4c changed —
`~/.agentbox-creds/claude/` mounted 0700 with `.credentials.json` symlinked into
it and carrying a live refresh token. Box destroyed, zero orphaned sandboxes.

**Still deliberately open:** the stager BODIES stay in `sandbox-core`. Moving
them touches the most sensitive path in the product (claude never falls back to
the host credential file; codex warns about the macOS keychain), and mixing that
behavioural change into the same commit as a mechanical table inversion is how
credential bugs ship.

## Final smoke — every phase landed

Run on `e1d74624`, the merge candidate:

- **All four agent commands** resolve from their packages (claude, codex,
  opencode, and the hidden `example`).
- **A packed install into a clean prefix** — all four work in the
  published-bundle shape, which is the only place the literal-import rule can
  fail.
- **The external plugin agent**: `agent add ./examples/agentbox-agent-example`
  -> listed -> its `agentSyncModule` loaded through the variable `import()` ->
  removed cleanly.
- **A real docker box**, which first rebuilt the base image from scratch —
  itself correct, since phase 4b moved code that `agentbox-ctl` inlines and that
  shifts the image tag. The box came up `claude:idle`, with
  `agentbox-claude-config` and `agentbox-agents-config` mounted (both
  registry-derived now), the keyed `agents` status map AND its legacy mirror
  both written, and `claude --dangerously-skip-permissions` as the real process.
- **Phase 7's specific risk, checked live**: the box wrote its session pointer to
  `~/.local/state/agentbox/claude-session` — the frozen path — with a valid
  uuid, and `stop` then `start` printed `resumed claude session`. That is the
  behaviour a renamed path would have broken silently. (The CLI's resume line is
  the evidence; the box was destroyed before its `--resume <id>` argv was
  captured.)
- **Earlier, on real cloud**: an e2b `prepare` baked through the new staging
  path and an e2b claude box came up with `~/.agentbox-creds/claude/` mounted
  0700 carrying a live refresh token.

Not run: a cloud `prepare` against phase 5b's renamed build arg. That IS the
re-bake, which is why 5b sits on its own branch.

## Files that will NOT change

- `packages/ctl/src/{claude,codex}-scraper.ts` — ctl is baked; it gets its agent
  list over `agents.list` and must never import a package. The scrapers stay as a
  ctl-internal table keyed by agent id.
- `packages/sandbox-docker/scripts/{claude-managed-settings.json,agentbox-codex-hooks.json,opencode-agentbox-plugin.js}`
  — baked image assets, already declared via `AgentSyncSpec.seeds`. Their *bytes*
  must not change (shared config volumes; see `docs/agents.md` step 6).

## Verification

**Per phase, before committing:**
`pnpm check:plugin-skill && pnpm lint && pnpm build && pnpm --filter @agentbox/hub build:standalone && pnpm check:cloud-backends && pnpm typecheck && pnpm test`.

**New guards, each mutation-checked** (a guard that has not been seen to fail is
not a guard):
- `agent-registry/src/specs/` imports only the two leaves, in the source AND in
  the manifest — a violation is the build cycle turbo already refused once.
- No agent name in an exported symbol outside `packages/agent-*` (extends
  `no-inline-agent-union.test.ts`, which already catches unions and `of [...]`
  loops).
- `AGENT_MODULES` keys == `agentIds()`; every agent package implements
  `AgentSyncModule`.

**The golden CLI-surface fixture** (`apps/cli/test/agent-cli-surface.test.ts`)
must stay green **unmodified** through phases 2–6. It is the proof no user-facing
flag moved. Regenerating it is a deliberate act, and in this work it should never
be necessary.

**Full smoke, before the merge** (this is the gate the merge waits on):
- Docker, **all four agents** including the hidden example:
  `agentbox <agent> -y -d` → `attach` → `list` shows activity →
  `agentbox agent state` → `download <agent> --dry-run` → `destroy`.
- One `-i` queued run per agent — phase 2 rewrites `_run-queued-job.ts`, which is
  the path where a fourth agent silently gets the wrong session name today.
- One cloud provider end to end (hetzner or e2b), including a `prepare --force`
  after phase 5 because the install-variant build arg is renamed.
- `agentbox dashboard` and one attach through the wrapped PTY — phase 2 touches
  the compositor and the footer.
- **A packed install, not the dev tree**: `npm pack` → clean prefix →
  `agentbox claude --help` and `agentbox <example> --help`. The literal-specifier
  rule fails *only* in the published bundle, never in the dev tree.
- Verify ground truth in the box (`ls`, the status JSON), never an exit code.

**The number that matters.** After phase 7, adding the fourth agent should be its
own package plus one literal-import arm. Record the real count in `docs/agents.md`
— including anything that stubbornly remains.

## Risks

- **This is by far the largest change in the series** — 611 sites against item 5's
  ~40. The mitigation is the phase order: the seam and the canary land before any
  behavior moves, so every later phase has something that fails loudly.
- **Phase 3 is the concentrated risk.** 314 references in the package every docker
  box goes through. Commit per file, claude last, and keep the golden fixture and
  the live smoke as the two nets — the item-3 experience was that the fixture
  proves the declarative surface and is blind to control flow.
- **A long-lived branch drifts.** `feat/custom_agents` moves from other sessions
  and is currently level with `nightly`. Merge the base into the branch at each
  phase boundary rather than once at the end, or phase 3's rename collides with
  someone else's edit to the same 314 lines.
- **A spec file that imports something heavy** re-creates the cycle turbo refused
  in the first attempt. The guard is not optional, and it checks the manifest as
  well as the imports — a transitive pull through a relative file would slip past
  a source scan alone.
- **Init order.** Injected agent modules must be registered before the first
  `sandbox-docker` call. Make the accessor throw when unpopulated rather than
  return an empty set — an empty registry reads as "box has no agents", which is
  a silent wrong answer.
- **Do not touch `apps/cli/runtime/**`** — gitignored, regenerated by
  `stage-runtime.mjs`.
- Re-check the branch before committing; `feat/custom_agents` moves from other
  sessions.
