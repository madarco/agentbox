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

**Phase 1c — collapse to the central table (the correction) — NEXT.** Move the four
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

**Phase 3 — `sandbox-docker` (the big one).** Define `AgentSyncModule`, move the
3,077 lines out, invert the 314 references. Land per file, claude last — it is
the daily driver.

**Phase 4 — `sandbox-core` + `sandbox-cloud`.** `claude-pull`, `codex-config`,
`claude-hooks-filter`, `claude-json-overlay`, `codex-agents-override`,
`host-stage.ts` (the biggest single per-agent file). The pull strategy becomes
spec-driven (open since #338).

**Phase 5 — the cloud providers + `claudeInstall`.** Add `assets:` to the spec so
`sandbox-{hetzner,vercel,digitalocean,daytona}` iterate instead of hardcoding
three staging blocks and re-declaring asset filenames. Generalize `claudeInstall`
to an agent-keyed install variant across its ~35 sites — including the
`AGENTBOX_CLAUDE_INSTALL` build arg, which is a rename with a bake implication, so
it lands with a forced re-`prepare` and its own live check.

**Phase 6 — config keys** (the old item 7). `packages/config` generates
`<agent>.sessionName`, `<agent>.skipPermissions`, `box.isolate<Agent>Config` from
`BUILTIN_AGENT_KINDS` the way `perProviderImageKeys()` already generates provider
keys. Adds the missing opencode skip-permissions arm as data. Defaults and the
JSON schema must be generated too — `writeLeaf` silently no-ops without the branch
object, and `schema-drift.test.ts` fails on a registry key missing from the schema.

**Phase 7 — the name sweep + the plugin path.** Rename the ~124 name-only sites
(`BoxStatusClaude`, `ClaudeActivityState`, `ClaudeQuestionPayload`, relay's
`ClaudeState`) to their agent-agnostic equivalents — mechanical, and the aliases
are already documented as such in `packages/ctl/src/types.ts`. Then the dynamic
path: `agentbox agent add`, an agent registry file, `AgentModule.descriptor`
snapshotting and a version gate, mirroring `plugin.ts` / `plugin-registry.ts`.
**Measure the fourth agent again here** and record the final number in
`docs/agents.md` — that count is the deliverable, not a vague "it's a package now".

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
