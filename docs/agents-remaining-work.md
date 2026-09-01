# Agents — what is still open

The agent layer's two work plans (`agent-catalog-plan.md`, `agents-as-packages-plan.md`)
are done and deleted. Agents are packages, an agent can arrive from npm with no
change to this repo, and the install seam is one `AGENT_SYNC_SPECS` row driving
the docker derived layer, every cloud derived snapshot and `ensureAgentInstalled`.

**The steady-state reference is [`agents.md`](./agents.md)** — read that first.
Its "Backlog: where the seam still leaks" section holds the per-area leftovers
(the three `download-<agent>.ts` commands, the three pull strategies). This file
holds only the items that were not attached to any one area, and the one design
decision still unmade.

**The live measure is `apps/cli/test/no-agent-named-exports.test.ts`.** Outside
`packages/agent-*`, an exported symbol may not be named after an agent. Its
allowlist started at 27 files and is at **4**, each tagged with the item below
that removes it. The test fails both ways — an unlisted offender AND a stale
exemption — so the list can only shrink, and when it is empty the rule holds
repo-wide with no exemptions.

---

## 1. `claudeInstall` / `claudeTui` → agent settings — **done**

Not a rename in the end. These are genuinely Claude-specific — which installer,
which of Claude Code's two renderers — so a role name would have been a lie the
moment a second agent needed a setting of its own shape. What generalised is the
MECHANISM: an agent declares `settings` on its row, config generates
`<agent>.<key>` from it (for a built-in and for an `agentbox agent add`-installed
package alike), and every call site carries one opaque `agentSettings` map. See
[`agents.md`](./agents.md) → "Agent settings"; the work is recorded in
[`agent-settings-plan.md`](./agent-settings-plan.md).

`box.claudeInstall` / `box.claudeTui` became `claude.install` / `claude.tui` and
hard-error through `RENAMED_KEYS`. Both phase-5b allowlist entries are gone
(6 → 4).

Two things were **deleted** rather than renamed, which is what made the change
smaller than the ~320 sites suggested:

- `AGENTBOX_CLAUDE_INSTALL` was already dead. `Dockerfile.box` declared the ARG
  and no `RUN` read it — the base is agentless — so CI's `[native, npm]` matrix
  published two byte-identical images under two tags, and daytona's
  `writeNpmDockerfile` rewrote a line that did nothing. Settings now fold only
  into the DERIVED artifact's `variantFingerprint`, which removed
  `claudeInstallFingerprint`, `matchClaudeInstallFingerprint`, the build arg, the
  CI matrix, and the mode threading through freshness / doctor / bake-share /
  prepared-hydrate.
- `asRootScript` embedded the script in `sudo -n sh -c "…"`, so everything
  `$`-shaped was expanded by the OUTER shell before sudo ran. A `postInstall`
  reading a variable its own prefix exported saw it empty on every cloud provider
  and correct on docker. The script now rides as a positional parameter.

Cost paid: `SDK_API_VERSION` 3 → 4 (clean break), and one re-`prepare` per
provider, since removing the ARG line moves the build-context sha.

## 2. Claude's four files in the shared packages (4 allowlist entries)

`sandbox-core/src/sync/agent-pull.ts`, `sandbox-core/src/sync/agents/claude/paths.ts`,
`sandbox-core/src/claude-app-config.ts`, `sandbox-docker/src/sync/claude-credentials.ts`.

**The blocker this used to name is gone, and it was never real.** The note said
"one decision first: does the hub load agent modules? Today it loads none." It
does — `apps/hub/server.ts` calls `registerAllAgentModules()` and
`registerInstalledAgentModules()`, added 2026-08-31, one day before that
sentence was written. The hub is a single process (Next runs in-process, routes
reach the backend through `globalThis`), so one registration covers create, the
worker and every route. It was added for exactly the failure the note feared:
"without it a hub-driven create dies on `requireAgentSyncModule`".

The second stated blocker is also stale: the allowlist comment claims
`host-stage.ts` imports two of these and its exports are published SDK surface.
`host-stage.ts` imports none of them, and the SDK exports none of these symbols
— it never imports `@agentbox/sandbox-docker` at all.

**The real risk is different, and it has a known answer.** A registration seam is
silently absent when unregistered: if claude's module stopped registering the
ssh-config prune, it would stop with every test green. That is a property of
seams, not of the hub — and the codebase already has both answers.
`requireAgentSyncModule` throws by design ("an unpopulated registry otherwise
reads as 'this box has no agents', which is a silent wrong answer"), and
`agent-module-table.test.ts` asserts a teleport resolver exists **iff**
`caps.teleport === 'full'`. Declare the capability, assert it in a coverage test,
and absence becomes a test failure.

**What actually blocks each file now:**

- `agent-pull.ts` — unblocked and partly done: the pull is one implementation
  plus a per-agent hook (see agents.md backlog 1). What remains is moving
  claude's ~240-line half into `packages/agent-claude`.
- `agents/claude/paths.ts` — the one REAL structural constraint.
  `sync/concerns/dynamic.ts` needs it and lives in `sandbox-core`, while
  `agent-claude` sits above (it depends on `sandbox-docker`). Fixing it means
  inverting dynamic-sync onto declared data, which is worth doing anyway: that
  concern is fully claude-coupled today (`BOX_WORKFLOWS_DIR` is
  `/home/vscode/.claude/workflows`, `DynamicSyncSetName` is a closed
  `'workflows' | 'memory'`) with **zero agent-named exports**, so the guard
  cannot see it.
- `claude-app-config.ts` — arguably misfiled as an exemption. It writes the
  Claude **desktop app's** `~/.claude/settings.json` for `agentbox open --in
  claude`, beside cmux/herdr/iTerm2/Finder — and its exact codex counterpart,
  `codexAddUrl`, is already a NOT_APPLICABLE *exclusion* reasoned as "the DESKTOP
  APP … renaming it would be wrong". The counter-argument is that the same file
  is claude-the-agent's real settings. One call makes it a move rather than a
  reclassification: `ssh-config.ts`'s prune.
- `claude-credentials.ts` — the most friction and the least urgency. `SYNC_SCRIPT`
  hardcodes claude's OAuth JSON, a test string-rewrites it, and
  `docker-sync.test.ts` mocks it by file path. agents.md §3 already warns this is
  where credential bugs ship.

**The guard undercounts.** It is a name check, so three more fully
claude-coupled files pass it: `sync/concerns/dynamic.ts`,
`sync/concerns/credentials.ts` (fixed — see agents.md backlog 8) and
`sync/claude-pull.ts` (199 lines, claude paths and categories, a filename that
says claude and not one export that does).

## 3. The stager bodies stay in `sandbox-core` — deliberate

Phase 4 inverted the *dispatch* (registry-driven, `AgentCloudModule`), but
`claude-hooks-filter.ts` and `codex-config.ts` still live in `sandbox-core`.
Moving them touches the most sensitive path in the product — claude never falls
back to the host credential file, codex warns about the macOS keychain — and
mixing that behavioural change into a mechanical table inversion is how
credential bugs ship. Move them on their own, with their own live smoke, or not
at all.

## 4. Publish the agentless base + the CI matrix

`.github/workflows/box-image.yml` publishes on `main` and `nightly` only, so the
agentless base's fingerprint tag reaches GHCR when this work merges. Until it
does, a cold machine builds the base locally, and **daytona's linux-vm derive
stays untestable** — VM snapshots can only be built from a prebuilt registry
image, and the agentless base 404s on GHCR. Re-check daytona derive right after
the first `main`/`nightly` publish.

## 5. Bake on first use (`box.agentBake`) — never started

The catalog plan's phase 5: the first `agentbox <new-agent>` is usable
immediately via `ensureAgentInstalled`, and a base *variant* carrying that agent
is promoted in the background so the second run is fast. Nothing was built; the
on-demand safety net it depends on is live, so this is pure UX and optional.

Two constraints if it is picked up. A variant bake on hetzner/DigitalOcean costs
real money and minutes (VPS boot + `create_image`), so auto-promote must be
opt-out-able and must never fire without a clear log line. And the default agent
set must fold to the **unchanged** fingerprint — guard it with
`node apps/cli/scripts/print-box-context-sha.mjs` — or every existing user
re-pulls the whole base image.

## 6. Downstream: OpenClaw

[`openclaw-hosting-plan.md`](./openclaw-hosting-plan.md) is not started and was
written against the catalog plan. Its phase 1 is now just an
`AGENT_SYNC_SPECS` row with `placement: 'ondemand'` — the mechanism it was
waiting on exists. See [`agents.md`](./agents.md) → "Adding a new agent".
