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
allowlist started at 27 files and is at **6**, each tagged with the item below
that removes it. The test fails both ways — an unlisted offender AND a stale
exemption — so the list can only shrink, and when it is empty the rule holds
repo-wide with no exemptions.

---

## 1. `claudeInstall` → a role name (2 allowlist entries)

`packages/config/src/types.ts`, `packages/sandbox-core/src/prepared-state.ts`.

The mechanism is already generic: `resolveAgentInstall(spec.install, mode)` takes
any agent. Only the *name* is claude-specific — ~320 sites across ~76 files, most
of them the seven providers' `prepare.ts` / `prepared-state.ts`.

**Why it is not just a rename.** It renames a **docker build arg**, so it forces a
re-`prepare` on every provider and shifts the published box-image tag; it changes
the **hub REST schema** (`apps/hub/app/(dashboard)/api/v1/lib/{openapi,validate}.ts`), which
the tray and a remote CLI both speak; and it touches **on-disk prepared state** in
`~/.agentbox`, so it needs a migration or a documented re-bake. The SDK surface is
one symbol, `claudeInstallFingerprint`; `AGENTBOX_CLAUDE_INSTALL` never crosses
the SDK boundary.

Fold the `box.claudeTui` config key into the same change, behind the existing
`RENAMED_KEYS` mechanism (`packages/config/src/parse.ts`) — it hard-errors with a
fix-it message, and doing two config renames in two releases is churn.

**Verification it needs:** `prepare --force` on at least two providers, and a
`~/.agentbox` prepared-state file written before the rename.

## 2. Claude's four files in the shared packages (4 allowlist entries) — blocked

`sandbox-core/src/sync/agent-pull.ts`, `sandbox-core/src/sync/agents/claude/paths.ts`,
`sandbox-core/src/claude-app-config.ts`, `sandbox-docker/src/sync/claude-credentials.ts`.

`agent-pull.ts` is unblocked — 17 exports, just large, and it is the same work as
agents.md backlog item 1 (collapse the three pull strategies). Do them together.

The other three need **one decision first: does the hub load agent modules?**
Today it loads none. `sandbox-core/src/ssh-config.ts` calls
`pruneOrphanClaudeSshConfigs` directly so that the hub and dashboard paths prune
Claude desktop's stale `sshConfigs` too; the hub reaches it through
`syncAgentboxSshConfig` / `autoWriteSshConfig` (`apps/hub/lib/hub-backend.ts`).
Invert that onto a registration seam and the hook is simply never registered in
the hub — the prune stops, silently, with every test green. That is the failure
mode this whole refactor exists to prevent, so the seam is not the answer until
the hub either loads agent modules or the prune moves behind an API the hub calls.

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
