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
The host relay runs the host's `ntn` (keychain auth on macOS — plain `ntn login`).
For the internal-dev nested-box path, `ntn` creds are carried into the box as
**file-based auth** (`NOTION_KEYRING=0 ntn login` → `~/.config/notion/auth.json`).
The connector does **not** force `NOTION_KEYRING=0` (removed — see the
2026-06-07 status-log entry); the in-box nested path sets it manually. See
[`docs/development.md`](./development.md).

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

### T1 — Shared foundation + Notion core plumbing  ✅ done
The working vertical slice: `agentbox-ctl integration notion <op>` round-trips
through the relay to host `ntn`, with read/write classification + write gating.
- `packages/integrations/` package: `types.ts` (IntegrationOp, IntegrationConnector),
  `registry.ts` (getConnector, ALL_CONNECTORS), `connectors/notion.ts`.
  - Notion ops (start minimal, allowlist-only): **read** `api` (GET passthrough,
    e.g. `ntn api v1/users/me`, `ntn api v1/pages/<id>` — POST endpoints like
    `v1/search` are refused by the GET-only gate); **write** `page.create`,
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

### T2 — In-box `notion` shim + image provisioning + config flags  ✅ done
Make a box agent able to type `notion …` or `ntn …`.
- `packages/sandbox-docker/scripts/ntn-shim` (gh-shim pattern: strict
  subcommand allowlist → `agentbox-ctl integration notion <op> -- "$@"`).
  Installed on PATH as `/usr/local/bin/ntn`; `/usr/local/bin/notion` is a
  symlink to it. Same shim for both invocations.
- Staged: `contextFiles` + `execBitFiles` in `apps/cli/scripts/stage-runtime.mjs`
  plus the `hetznerFiles` / `vercelFiles` / `e2bFiles` lists; COPY'd in
  `Dockerfile.box` next to the `gh-shim`/`git-shim` COPY; mirrored into
  `packages/sandbox-hetzner/scripts/install-box.sh`,
  `packages/sandbox-vercel/scripts/provision.sh`, and
  `packages/sandbox-e2b/scripts/build-template.sh` (plus each provider's
  `src/runtime-assets.ts` so the staged file gets uploaded). Daytona stays
  shim-less (matches its T1 gh/git decision).
- Config: added `integrations.notion.enabled` (default **false**) to
  `packages/config/src/types.ts` — `UserConfig`, `EffectiveConfig`,
  `BUILT_IN_DEFAULTS`, and `KEY_REGISTRY`. Parser/merger/writer were taught
  to walk 3-level nested keys (`branch.subbranch.leaf`) so the YAML stays
  natural. Set with `agentbox config set --project integrations.notion.enabled true`.
- Gate placement: the **relay** (`refuseIfIntegrationDisabled` in
  `packages/relay/src/integrations.ts`, wired into BOTH
  `handleIntegrationRpc` in `server.ts` (docker) and `runIntegrationRpc`
  in `host-actions.ts` (cloud — daytona/hetzner/vercel/e2b) per the
  "fix across all providers" rule). One check covers every caller
  (shim / `notion` alias / direct `agentbox-ctl integration` / future
  host-initiated tokens) and re-reads the layered config per call so a
  flag flip takes effect without bouncing the relay (same approach as
  `loadAutopauseConfig`). Disabled → exit 65 with a `agentbox config set …`
  hint; no host process is touched.
- Connector cleanup (minimal): the T1 `comment.add` op is **dropped**.
  `ntn` exposes no top-level `comment` subcommand — the only host path
  would be `ntn api v1/comments -X POST -f …`, which the T1 `api` op
  refuses (GET-only). The op also had no callers (T1 just merged, no shim
  yet), so a forward-only drop is cleaner than carrying dead surface
  through. The shim refuses `notion comment add …` with a clear
  "deferred from T2" message; comments are tracked as a focused
  follow-up (will need a Notion-API-aware payload assembly that maps
  flag args to the structured POST body). Added a `whoami` read op so
  `ntn whoami` doesn't have to widen the `api` allowlist.

### T3 — `agentbox doctor` detection + docs  ✅ done
- `agentbox doctor` now reports each integration in a dedicated
  `integrations:` group, driven off `ALL_CONNECTORS` (no hardcoded
  `'notion'`) so Linear/Trello light up here automatically when they land.
  Each row probes `<hostBin> <versionArgs>` (install check) and
  `<hostBin> <authArgs>` (login check) and surfaces install/login hints
  from new optional `IntegrationConnector.detect.installHint` /
  `loginHint` fields (filled for the Notion connector). The doctor
  deliberately does NOT force `NOTION_KEYRING=0` — on the host the
  keychain entry IS the credential, and the file-auth env override would
  make a keychain-authed user falsely show as "not logged in". A new
  `info` `CheckStatus` rolls up like `ok` so a disabled-but-configured
  integration never pushes the overall doctor status to "warn". Unit
  test (`apps/cli/test/doctor-integrations.test.ts`) stubs a fake `ntn`
  on PATH and asserts the four transitions: disabled / missing /
  unauthed / authed.
- Docs:
  - `docs/integrations.md` — new internal design/reference doc
    (descriptor model, relay dispatch flow, the read/write Notion op
    surface, the enable flag, doctor wiring, the carry-based file-auth
    path for nested boxes, open follow-ups).
  - `apps/web/content/docs/integrations-notion.mdx` — new user-facing
    Fumadocs page (prerequisites, enabling, what works in the box,
    security model). Wired into `meta.json` under a new `---Services---`
    section.
  - `apps/web/content/docs/configuration.mdx` — new `## integrations`
    section documenting `integrations.notion.enabled`.
  - `apps/web/content/docs/cli.mdx` — `agentbox doctor` sentence
    updated to mention the new group.
  - `docs/host-relay.md` — new RPC method-family bullet for
    `integration.<service>.<op>` (parser, allowlist, enable gate,
    `refuseCall`, readiness probe, host-initiated token short-circuit,
    `askPrompt` for writes, the `<SERVICE>_*` env namespace guard).
  - `docs/features.md` — Notion integration bullet; the "Additional
    `/rpc` methods" line updated to list `gh.pr.*` /
    `integration.<svc>.<op>` already in place.

### T4 — Live e2e verification + bug-fixes-from-e2e + closeout  ✅ done
- Primary e2e (real box → host relay → live Notion API): `notion whoami` and
  `notion api v1/users/me` return the host bot identity with no prompt;
  `notion api v1/comments -X POST` and `notion api ... --method PATCH` are
  refused with `notion api: only GET is proxied (use page.create /
  page.update for writes); detected method 'POST'` (exit 65). `printenv |
  grep -i notion` shows nothing in the box's process env — the agent never
  holds the credential. (The carried `~/.config/notion/auth.json` is a
  separate concern for nested-box use; the in-box AGENT itself sees no
  token in env.)
- Two bugs surfaced and fixed in T4:
  1. **`agentbox config get` couldn't read nested 3-level keys.** The
     helpers in `apps/cli/src/commands/config.ts` split on the FIRST dot
     only, so `integrations.notion.enabled` resolved to
     `effective.integrations["notion.enabled"]` (undefined / `<unset>`)
     even when `config set` + `loadEffectiveConfig` worked correctly.
     Fix: replace `leafValue`/`rawLeafFromValues` with a single `walkKey`
     helper that splits on ALL dots (mirrors `readLeaf` in
     `packages/config/src/load.ts`). New regression test
     `apps/cli/test/config-get-nested.test.ts` covers the plain, `--json`,
     `--all`, and unset/default cases; without the fix all four fail.
  2. **Connector `buildArgv` used singular `page` but real `ntn` is `pages`
     (plural).** Live evidence: a `notion pages create` call through the
     host relay hit approval → spawned `ntn page create` → failed with
     `error: unrecognized subcommand 'page'. tip: some similar subcommands
     exist: 'update', 'pages'` (exit 2). `ntn --help` confirms the surface
     is `api datasources files pages login logout whoami workers`. Fix:
     `connectors/notion.ts` now builds `['pages', 'create', …]` /
     `['pages', 'update', …]`. Existing tests in
     `packages/integrations/test/registry.test.ts` and
     `packages/relay/test/integrations.test.ts` updated to assert the
     correct argv.
- Live write round-trip (host relay → live `ntn pages create`) was not
  re-run from this box, because the host relay was rebuilt with T3 code
  (pre-fix `page` argv) before T4 started. Once T4 merges and the host
  relay rebuilds with the new `pages` argv, the prompted write path will
  work end-to-end. The fix is validated by (a) the live failure mode
  matching the bug exactly, (b) the `pages create --help` host probe
  showing the correct surface, (c) updated unit tests that pin the new
  argv.
- Nested-box e2e (boxes-launch-boxes path): **deferred**. Docker-in-docker
  is available but the base image isn't baked in this box, and the chain
  for an in-box agent's `notion` write would still terminate at the same
  HOST relay (not this box's daemon — the box daemon forwards to the host
  relay at `host.docker.internal:8787`), so it wouldn't actually exercise
  MY fixed code on the spawn side. The carry block in `agentbox.yaml`
  already ships the file-auth into nested boxes (verified present at
  `~/.config/notion/auth.json` in this box). Real nested-relay isolation
  testing is tracked as a follow-up — see "Open follow-ups" in
  [`integrations.md`](./integrations.md).
- `integrations_backlog.md` updated: Notion path marked complete through
  T4.

## Status log
- 2026-06-06: Backlog created; host-side carry for `ntn` file-auth added to
  `agentbox.yaml`. Top-level box testing uses the host's keychain-authed `ntn`.
- 2026-06-06: T1 shipped — `@agentbox/integrations` package with Notion
  descriptor, `packages/relay/src/integrations.ts` (host exec + readiness
  probe), generic `integration.<svc>.<op>` dispatch wired into both
  `server.ts` (docker) and `host-actions.ts` (cloud), and `agentbox-ctl
  integration` command tree. PR pending.
- 2026-06-06: T2 shipped — `ntn-shim` + `notion` symlink on PATH across
  docker/hetzner/vercel/e2b; `integrations.notion.enabled` (default false)
  added to the typed config (with nested-key support in parser/merger/
  writer); host-side enable gate in `handleIntegrationRpc` returning exit
  65 with a config-hint when disabled; connector cleanup (dropped
  `comment.add`, added `whoami` read op). Comments deferred to a focused
  follow-up — they need a Notion-API-aware payload translator that maps
  CLI flags to the structured `POST /v1/comments` body.
- 2026-06-06: T3 shipped — `agentbox doctor` now reports the new
  `integrations:` group (registry-driven), with `info` for disabled and
  install/login hints sourced from the connector descriptor.
  `IntegrationConnector.detect` gained optional `installHint` /
  `loginHint` fields (filled for Notion: install URL + `ntn login`).
  Unit test stubs a fake `ntn` on PATH and verifies the four status
  transitions. Doctor's host probe does NOT set `NOTION_KEYRING=0` (a
  comment in the code records why). Public docs site + internal
  reference doc landed in the same PR: new `docs/integrations.md`, new
  `apps/web/content/docs/integrations-notion.mdx` (Services section in
  `meta.json`), config-key + doctor sentence in the published
  `configuration.mdx` / `cli.mdx`, new RPC method-family bullet in
  `docs/host-relay.md`, Notion entry in `docs/features.md`. T4 (nested-
  box e2e + carry-based file-auth verification) is the remaining task.
- 2026-06-06: T4 shipped — live e2e from inside a box against the real
  Notion API. Reads pass through with no prompt (`notion whoami`,
  `notion api v1/users/me`), `notion api` correctly refuses non-GET
  methods (`-X POST` / `--method PATCH` → exit 65 with `refuseApiNonGet`
  message), `printenv | grep -i notion` shows nothing in the agent's
  env. Two bugs fixed: (1) `config get` couldn't read 3-level nested
  keys because `apps/cli/src/commands/config.ts` split on the first dot
  only — replaced with a `walkKey` helper that splits on all segments
  (mirrors `readLeaf` in `packages/config/src/load.ts`); regression
  test `apps/cli/test/config-get-nested.test.ts` added; (2) connector
  built singular `['page', 'create', …]` argv but real `ntn` is `pages`
  (plural) — confirmed live by the host relay's spawn failing with
  `unrecognized subcommand 'page'`, fixed in `connectors/notion.ts`,
  existing tests in `packages/integrations/test/registry.test.ts` and
  `packages/relay/test/integrations.test.ts` updated. Live write
  round-trip with the fix needs a host relay rebuild post-merge.
  Nested-box e2e deferred — the box-daemon → host-relay chain means an
  in-box agent's write still terminates at the host relay (not this
  box's daemon), so it wouldn't exercise the spawn-side fix from a
  nested box anyway; the carry block is verified present.
- 2026-06-06: Live-write loop closed (orchestrator, post-#76-merge). The host
  relay was rebuilt + restarted with the `pages` argv fix, then a real write
  was issued from inside a box: `notion pages create --parent page:<id>
  --content '# agentbox write-verify <ts>'` → host approval gate fired →
  approved → a real child page was created in "Marco D'alia's Space"
  (ground-truth confirmed via `ntn api v1/pages/<new-id>` → `object: page`,
  created by the integration bot), then archived (`in_trash:true`) to clean
  up. Notes for users: the real `ntn pages create` flags are `--parent
  page:<id>` + `--content <markdown>` (no `--title`), and the shim already
  injects the `--` arg separator so callers must NOT add their own (a doubled
  `--` makes `ntn` reject the flags). **Notion path verified DONE end-to-end:
  reads pass through, writes are gated + create real pages on approval, the
  box holds no token.**
- 2026-06-07: Removed the forced `env: { NOTION_KEYRING: '0' }` from the Notion
  connector. It was only ever needed for the internal-dev nested-box path, but
  `mergeConnectorEnv` applies a connector's `env` on the **host** relay spawn
  too — which forced the host `ntn` into file-auth mode and disagreed with both
  the docs (`ntn login` → keychain) and `agentbox doctor` (probes keychain).
  Result: a keychain-authed user got a green doctor but a relay that couldn't
  find the token. With the env gone the relay uses `ntn`'s default (keychain on
  macOS) — relay, doctor, and docs now agree. The generic `env` field +
  `mergeConnectorEnv` `<SERVICE>_*` namespace guard stay (no connector uses
  them now). The nested-dev `NOTION_KEYRING=0 ntn login` requirement moved to
  [`docs/development.md`](./development.md). Earlier status-log/task lines that
  say "the connector forces `NOTION_KEYRING=0`" are superseded by this entry.
