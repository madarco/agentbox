# Notion integration + shared foundation — backlog

Live tracker for building the **Notion** integration and the **shared
`integrations` foundation** described in [`integrations_backlog.md`](./integrations_backlog.md).
Each task is one box → one PR into the `add-ticketing-integrations` feature
branch. Boxes work **sequentially**: each branches off the latest feature-branch
HEAD *after* the previous task merges (PRs stack cleanly, no conflicts).

## Model recap (why this shape)

Mirror the `gh` relay model exactly: in-box `notion` shim → `agentbox-ctl
integration notion <op>` → host relay → host's authenticated `ntn` CLI. Writes
gated by `askPrompt`; reads pass through; **the box never holds a Notion token**.
The host relay runs the host's `ntn` (keychain auth on macOS). For nested-box
e2e, `ntn` creds are carried into the box as **file-based auth**
(`NOTION_KEYRING=0` → `~/.config/notion/auth.json`); the connector forces
`NOTION_KEYRING=0` when shelling out so it works on Linux boxes.

Reference implementations to copy: `packages/relay/src/gh.ts`,
`packages/ctl/src/commands/gh.ts`, `packages/sandbox-docker/scripts/gh-shim`,
`packages/relay/src/prompts.ts`, `packages/relay/src/host-initiated.ts`.

## Per-box workflow (every task)

1. **Plan first** — enter plan mode, produce a concrete plan, get it approved.
2. **Implement** on a branch off the current feature-branch HEAD.
3. **Verify** — `pnpm typecheck`, `pnpm test`, `pnpm build`, plus the task's
   own verification (unit tests + a real `agentbox-ctl integration notion …`
   round-trip where applicable). Verify ground truth, not exit codes.
4. **`/review high`** then **`/simplify`** — apply findings.
5. **File a PR** into `add-ticketing-integrations` (not `main`).
6. **Fix bugbot** comments on the PR until clean.
7. **Merge**, then the orchestrator moves to the next task in a fresh box.

## Tasks

### T1 — Shared foundation + Notion core plumbing  ⬜ not started
The working vertical slice: `agentbox-ctl integration notion <op>` round-trips
through the relay to host `ntn`, with read/write classification + write gating.
- `packages/integrations/` package: `types.ts` (IntegrationOp, IntegrationConnector),
  `registry.ts` (getConnector, ALL_CONNECTORS), `connectors/notion.ts`.
  - Notion ops (start minimal, allowlist-only): **read** `api` (GET passthrough,
    e.g. `ntn api v1/search`, `ntn api v1/pages/<id>`); **write** `page.create`,
    `page.update` (archive/props), `comment.add` — all gated.
- `packages/relay/src/integrations.ts`: `runHostIntegration`,
  `assertIntegrationReady`, generic `integration.<svc>.<op>` dispatch (reuse
  `askPrompt` + `HostInitiatedTokens`). Connector forces `NOTION_KEYRING=0` env.
- Wire dispatch into **both** `packages/relay/src/server.ts` (`POST /rpc`) and
  `packages/relay/src/host-actions.ts` (cloud path — "fix across all providers").
- `packages/ctl/src/commands/integration.ts` (built from descriptors) + register
  in the ctl entrypoint next to `ghCommand`.
- Unit tests: op read/write classification; allowlist denies unknown ops;
  dispatch gates writes (askPrompt called) and not reads; denied → exit 10.

### T2 — In-box `notion` shim + image provisioning + config flags  ⬜ not started
Make a box agent able to type `notion …`.
- `packages/sandbox-docker/scripts/notion-shim` (gh-shim pattern: strict
  subcommand/flag allowlist → `agentbox-ctl integration notion <op> -- "$@"`).
- Stage it: add to `contextFiles` + `execBitFiles` in
  `apps/cli/scripts/stage-runtime.mjs`; COPY in `Dockerfile.box` near the
  `gh-shim`/`git-shim` COPY; mirror into
  `packages/sandbox-hetzner/scripts/install-box.sh` and the cloud runtime lists.
- Config: add `integrations` block to `packages/config/src/types.ts`
  (`integrations.notion.enabled`, default off) + `BUILT_IN_DEFAULTS`. Disabled →
  shim not installed / ctl refuses.

### T3 — `agentbox doctor` detection + docs  ⬜ not started
- `agentbox doctor`: report `ntn` presence + auth (`ntn whoami` / `ntn doctor`),
  with a friendly install/login hint.
- Docs (same change, per repo rule): new `docs/integrations.md`; a `.mdx` page +
  CLI reference under `apps/web/content/docs/`; note new RPC methods in
  `docs/host-relay.md`; mention in `docs/features.md`.

### T4 — Nested-box e2e verification + carry + closeout  ⬜ not started
- Carry `ntn` file-auth into a box; from that box create a nested box; run a
  `notion` read (no prompt) + a `notion` write (prompted, approve→succeeds,
  deny→nothing created), verifying ground truth in the live Notion space.
- Confirm a box never holds a Notion token (`printenv | grep -i notion`).
- Fix anything the e2e surfaces; mark the Notion path done in
  `integrations_backlog.md`.

## Status log
- 2026-06-06: Backlog created; host-side carry for `ntn` file-auth added to
  `agentbox.yaml`. Top-level box testing uses the host's keychain-authed `ntn`.
