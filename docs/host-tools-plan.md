# Host tools: generalize the box→host CLI shims

## Context

Today a box reaches a host CLI through **hand-written, hardcoded** plumbing. There are exactly
four shims (`packages/sandbox-docker/scripts/{gh,git,ntn,linear}-shim`), each a bespoke bash
allowlist, each baked into every provider image at build time. Adding a fifth CLI means a new
bash file, a new connector descriptor, edits to `stage-runtime.mjs`, `Dockerfile.box`, four
provider install scripts, four `runtime-assets.ts` upload lists, a new `KEY_REGISTRY` config key,
and an image rebake. That is why only Notion and Linear ever shipped — and they were an
experiment, not a product.

The goal: **any host CLI can be proxied into a box, opt-in, without touching the image.** `gh`
stays on by default (Claude Code's PR badge depends on it). Everything else is declared by the
project, approved by the host, and materialized live. A box that discovers it needs a CLI can
**request** it through the same approval channel `cp` already uses.

Decisions taken with the user:

- An `agentbox.yaml` `tools:` block **requests**, it does not grant. The host approves once per
  project, same shape as the existing `carry:` gate. A cloned repo can never silently wire itself
  to host credentials.
- Runtime gating rides the **existing** `box.autoApproveSafeHostActions` flag (default `true`):
  approved tools run silently; flip it false and every tool call raises a host prompt. No new
  per-call knob.
- A **built-in deny list** of credential-printing argv (`auth token`, `configure get`,
  `print-access-token`, …) is refused by the relay unconditionally, replacing linear's bespoke
  `auth token` hard-reject.
- **Notion and Linear are deleted.** Verified from the code: they get *no* special auth handling —
  the relay spawns them with plain `process.env` and each host CLI reads its own auth store
  (`ntn` → macOS keychain, `linear` → `~/.config/linear/credentials.toml`). `mergeConnectorEnv`
  exists but no connector sets `env`. So they are exactly generic tools, and survive as
  documentation examples only.
- `agentbox-ctl tools list` lists **registered** tools only — never a host PATH scan.

AgentBox is unreleased: delete cleanly, no aliases, no deprecation logs.

---

## Design

### One generic shim, symlinked per tool

The current model bakes one bash file per CLI. Replace it with a **single multi-call shim**
(`packages/sandbox-docker/scripts/agentbox-tool-shim`) baked once into every image. It reads its
own invocation name and forwards verbatim:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec "${AGENTBOX_CTL_PATH:-/usr/local/bin/agentbox-ctl}" tool run "$(basename "$0")" -- "$@"
```

Per-tool `~/.local/bin/<name>` symlinks to it are created **at box start by the ctl daemon**,
not at image build — that is what makes arbitrary tools possible without a rebake, and what makes
a `tools request` grant take effect live. `/usr/local/bin` already precedes `/usr/bin` on PATH
(`Dockerfile.box:49-52`; Vercel reorders it in `provision.sh:275-282`), so the symlink wins.

No argv gating in the shim. The existing shims are explicitly *not* the security boundary
(`docs/architecture.md:228`) — the host relay is. Dropping shim-side allowlists loses nothing real
and removes ~450 lines of bash.

### Trust model

```
agentbox.yaml  tools: { terraform: {...} }      <- project REQUESTS (committed, untrusted)
        |
        v  create-time prompt (carry-style, one prompt for the whole block)
~/.agentbox/projects/<hash>/tools.yaml           <- host GRANTS (host-only, authoritative)
        |
        v  relay reads per call (fail-closed)
host binary spawned in worktree.hostMainRepo
```

The relay only ever consults the **granted** file. An unapproved `agentbox.yaml` entry is inert.

### RPC surface (`tool.*`)

| Method | Params | Behavior |
|---|---|---|
| `tool.list` | `{path}` | Granted tools for this box's project. No PATH scan. |
| `tool.request` | `{path, name, reason?}` | Probe host PATH → missing gives exit 127 "not installed on the host" with no prompt; present raises `askPrompt` naming box + reason; on `y` writes the grant, emits `tools-changed`, exit 0. Rate-limited per box; every request lands in the relay event ring buffer. |
| `tool.run` | `{path, name, args[]}` | The proxy. Grant check → built-in deny list → per-tool `deny`/`allow` → gate → spawn. |

`tool.run` order (mirrors `handleIntegrationRpc`, `packages/relay/src/server.ts:2113-2233`):

1. Resolve worktree from `params.path` → exit 64 if none.
2. `refuseIfToolNotGranted(name, cwd)` — re-reads the layered grant file **every call**, fails
   closed. Exit 65 with the `agentbox tools add` hint. Same live-flip approach as
   `refuseIfIntegrationDisabled` (`packages/relay/src/integrations.ts:291-315`).
3. **Built-in credential deny list** — exit 65, before any spawn, before any prompt.
4. Per-tool `deny` patterns → exit 65. Per-tool `allow` patterns → mark this call silent.
5. `assertToolReady(bin)` — reuse the 60s-cached probe at `integrations.ts:95`. Missing → 127.
6. Gate: silent when matched by `allow`, **or** when `reg.autoApproveSafeHostActions !== false`
   (audited via `prompts.noteAutoApprove`, `prompts.ts:89`). Otherwise `askPrompt` with the full
   argv in `context.argv`; `n` → exit 10.
7. `runHostBinary(bin, argv, {cwd: worktree.hostMainRepo, timeoutMs})` — lift verbatim from
   `packages/relay/src/integrations.ts:191-246` into a shared module.

Both dispatchers get it, per the "fix across all providers" rule: docker at
`packages/relay/src/server.ts:731` (`POST /rpc` chain) and cloud at
`packages/relay/src/host-actions.ts:336-386` (`executeCloudAction`).

### Built-in credential deny list

A small, unconditional pattern set in the new `packages/relay/src/host-tools.ts`, matched against
the joined argv, case-insensitive:

```
auth token | auth print-token | print-access-token | configure get
token --raw | --show-secret | secrets get | get-token | export-credentials
```

Refused with `exit 65: '<argv>' prints a host credential — refused`. Extensible per tool via
`deny:` in `agentbox.yaml`. This is the replacement for `linear-shim`'s three-defense
`auth token` reject.

### Known limits to state in the docs

`runHostBinary` runs with stdin ignored, no TTY, buffered stdout, and a timeout. Host tools are
for **short, non-interactive** commands. Per-tool `timeoutMs` (default 120s, matching
`runHostGh`) covers `terraform plan`-shaped waits; anything genuinely interactive is out of scope.

A tool symlink shadows an in-box binary of the same name. That is the intent (host-proxied wins),
but `agentbox tools add` should warn when the box image already ships that binary.

---

## Phases

Each phase is one session; keep the durable doc updated as you go.

### Phase 0 — durable plan doc + delete Notion/Linear

Write `docs/host-tools-plan.md` (this design, phase checklist kept live). Then remove the
experiment wholesale:

- Delete `packages/integrations/` (types, registry, both connectors, both test files) and drop it
  from the workspace + every `package.json` that depends on it.
- Delete `packages/relay/src/integrations.ts`, the `integration.*` branches at
  `server.ts:1038-1049` / `host-actions.ts:373-374` and `runIntegrationRpc`
  (`host-actions.ts:676-778`), `packages/relay/test/integrations.test.ts`, and the integration
  cases in `packages/relay/test/host-actions.test.ts:169-225`.
  **Keep `runHostBinary` + `assertIntegrationReady` + `mergeConnectorEnv`'s namespace idea** by
  moving them to the new `packages/relay/src/host-tools.ts` first.
- Delete `packages/ctl/src/commands/integration.ts` and its registration in `bin.ts:13,53`.
- Delete `packages/sandbox-docker/scripts/{ntn,linear}-shim`, their `Dockerfile.box:183-194`
  COPY blocks, the `notion` symlink, and every staging reference: `stage-runtime.mjs:49-50,64-65,
  139-140,167-168,192-193,231-232,259-260`, the four provider install scripts, and the
  `runtime-assets.ts` lists in sandbox-{hetzner,e2b,vercel,digitalocean} + `provider-sdk`.
- Delete `integrations.notion.enabled` / `integrations.linear.enabled` from
  `packages/config/src/types.ts` (`UserConfig:304`, `EffectiveConfig:466`, `BUILT_IN_DEFAULTS:663`,
  `KEY_REGISTRY:1217-1228`) and `packages/config/schema/user-config.schema.json:204-222`.
- Delete `integrationsChecks` / `checkOneIntegration` (`apps/cli/src/lib/doctor-checks.ts:327-400`)
  and `apps/cli/test/doctor-integrations.test.ts`; drop the notion/linear shim describes from
  `packages/ctl/test/gh-and-shims.test.ts:835+`.
- Drop the notion/linear `carry:` entries from this repo's own `agentbox.yaml:118-153`.

`gh` and `git` shims are untouched throughout.

### Phase 1 — the tools model + config

- `packages/config/src/tools.ts`: the `ToolGrant` record (`name`, `bin`, `allow?`, `deny?`,
  `timeoutMs?`, `approvedAt`, `source: 'yaml' | 'cli' | 'request'`), plus
  `loadGrantedTools(cwd)` layering `~/.agentbox/tools.yaml` (global) under
  `~/.agentbox/projects/<hash>/tools.yaml` (project). Reuse `projectConfigFile`'s hashing from
  `packages/config/src/paths.ts:108`. A **separate file**, not `config.yaml` — `KEY_REGISTRY` is
  a fixed registry of typed scalar keys by design and cannot express an open map.
- `packages/ctl/src/config.ts`: add `'tools'` to `TOP_LEVEL_KEYS` (line 672) and parse the block
  (the supervisor ignores it; the host reads it, exactly like `carry`).
- `packages/ctl/src/tools-spec.ts`: host-side reader for the yaml block, modeled on
  `packages/ctl/src/carry.ts`.
- `apps/cli/src/commands/tools.ts`: `agentbox tools list | add <bin> [--allow …] [--deny …]
  [--global] | rm <name> | approve | deny`. `gh` is seeded as a built-in grant so it works with
  no config at all.
- Register the command in the CLI root and document it in the CLI reference.

### Phase 2 — relay `tool.*`

- `packages/relay/src/host-tools.ts`: the moved `runHostBinary` / `assertToolReady`, the built-in
  deny list, `refuseIfToolNotGranted`, argv pattern matching, and `handleToolRpc`.
- Wire into `server.ts` `POST /rpc` (docker) and `host-actions.ts` `executeCloudAction` (cloud) —
  same handler both sides.
- Emit a `tools-changed` relay event on grant, modeled on the existing `agent-credentials` event
  (`packages/relay/src/types.ts:252`).
- Unit tests: grant/deny matrix, deny-list precedence over `allow`, fail-closed loader,
  silent-vs-prompt under both `autoApproveSafeHostActions` values, exit-code envelope parity
  between the docker and cloud paths.

### Phase 3 — in-box surface

- `packages/sandbox-docker/scripts/agentbox-tool-shim` (the 3-line multi-call shim above); bake it
  once via `Dockerfile.box` + `stage-runtime.mjs` + the four provider install scripts +
  `runtime-assets.ts` lists. This is the **last** image change the feature ever needs.
- `packages/ctl/src/commands/tool.ts`: `agentbox-ctl tool run <name> -- <args…>`,
  `tool list`, `tool request <bin> [--reason …]`. All via `postRpcAndExit`
  (`packages/ctl/src/relay-rpc.ts:207`).
- `packages/ctl/src/tool-links.ts`: materialize `~/.local/bin/<name>` symlinks from a granted
  list; called by the daemon at startup and on `tools-changed`. Refuse to clobber a non-symlink
  that ctl did not create.
- Daemon wiring in `packages/ctl/src/daemon.ts` + `credentials-watcher.ts`-style subscription.

### Phase 4 — request + create-time approval

- `tool.request` handler: PATH probe (missing → 127, no prompt — the user explicitly wants the
  direct error), then `askPrompt` naming box, binary and reason; on approve write the project
  grant with `source: 'request'` and broadcast `tools-changed` so the symlink appears without a
  restart. Rate-limit per box; log every request as a relay event.
- Create-time prompt: when `agentbox.yaml` declares `tools:` entries that are not yet granted,
  raise one carry-style prompt listing them during `create`. Approve → written to the project
  grant file with `source: 'yaml'`. Follow the existing carry resolution/approval path in the
  create flow.
- Surface pending tool requests through the hub `/api/v1/approvals` list and the tray — they are
  ordinary `PromptAskEvent`s, so this should need no new hub route; verify the `command`/`argv`
  context renders usefully in `apps/cli/src/wrapped-pty/footer.ts:262`.

### Phase 5 — doctor, docs, e2e

- Replace `integrationsChecks` with `toolsChecks`: one row per granted tool, probing the host
  binary. Reuse the `info` status (`packages/sandbox-core/src/doctor.ts:22`) for "granted but
  binary missing" vs `warn`.
- Replace `docs/integrations.md` with `docs/host-tools.md`; update `CLAUDE.md`'s documentation
  map and the integrations bullet.
- `apps/web/content/docs/`: collapse `integrations-notion.mdx` + `integrations-linear.mdx` into
  one `host-tools.mdx` that documents the generic mechanism and keeps Notion/Linear as worked
  examples (`agentbox tools add ntn`, `agentbox tools add linear --deny 'auth token'`). Update
  `meta.json` and the CLI reference page.
- Live e2e per the verification section below.

---

## Critical files

| Area | File |
|---|---|
| Generic shim | `packages/sandbox-docker/scripts/agentbox-tool-shim` (new) |
| Image bake | `packages/sandbox-docker/Dockerfile.box`, `apps/cli/scripts/stage-runtime.mjs` |
| Provider bakes | `packages/sandbox-{hetzner,digitalocean}/scripts/install-box.sh`, `sandbox-vercel/scripts/provision.sh`, `sandbox-e2b/scripts/build-template.sh` + each `src/runtime-assets.ts` |
| Relay handler | `packages/relay/src/host-tools.ts` (new), `server.ts:731`, `host-actions.ts:336` |
| Reused host-exec | `runHostBinary` / `assertIntegrationReady` from `packages/relay/src/integrations.ts:95,191` |
| Gate reuse | `askPrompt` + `noteAutoApprove`, `packages/relay/src/prompts.ts:89,283` |
| Box surface | `packages/ctl/src/commands/tool.ts`, `tool-links.ts`, `daemon.ts` |
| Grant store | `packages/config/src/tools.ts` (new), `paths.ts:108` |
| yaml block | `packages/ctl/src/config.ts:672`, `packages/ctl/src/tools-spec.ts` (new, mirrors `carry.ts`) |
| CLI | `apps/cli/src/commands/tools.ts` (new) |
| Doctor | `apps/cli/src/lib/doctor-checks.ts:327-400` |

---

## Verification

**Unit** — `pnpm test` plus new suites: `packages/relay/test/host-tools.test.ts` (grant matrix,
deny-list precedence, both gate modes, docker/cloud envelope parity),
`packages/config/test/tools-grants.test.ts` (global↔project layering, fail-closed),
`packages/ctl/test/tool-shim.test.ts` (multi-call shim resolves its own name; drive the real file
with a stub `agentbox-ctl` via `AGENTBOX_CTL_PATH`, same harness as `gh-and-shims.test.ts`).
Then `pnpm typecheck` and `pnpm lint` — `tsup` does not typecheck, and CI runs both.

**Docker e2e** (the box image must be rebuilt once for the new shim):

```
docker build --network=host -t agentbox/box:dev -f apps/cli/runtime/docker/Dockerfile.box apps/cli/runtime/docker
agentbox relay restart          # relay is a daemon; stale code otherwise
node apps/cli/dist/index.js create -y -n tools-smoke &
tail -f ~/.agentbox/logs/create.log
```

Inside the box (`agentbox shell tools-smoke`), check each leg:

1. `gh pr list` still works untouched (regression guard on the default-on path).
2. `terraform version` → `command not found` (not granted, no symlink).
3. `agentbox-ctl tool request terraform --reason "plan the infra"` → host footer shows the
   request; approve; the command works **without restarting the box** (proves live symlink
   materialization).
4. `agentbox-ctl tool request definitely-not-installed` → exit 127, "not installed on the host",
   and **no** prompt appeared on the host.
5. `agentbox-ctl tool list` → shows only granted tools, never a host PATH dump.
6. `agentbox config set --project box.autoApproveSafeHostActions false` then rerun the tool →
   now prompts on every call; deny → exit 10.
7. `agentbox tools add linear` then in-box `linear auth token` → exit 65, refused by the built-in
   deny list, and confirm no host process spawned (relay event log).
8. `printenv | grep -iE 'token|secret'` in the box shows only `AGENTBOX_RELAY_TOKEN` — no host
   tool credential ever crosses.

**yaml request path** — add a `tools:` block to `examples/`' `agentbox.yaml`, create a fresh box,
confirm the single carry-style approval prompt fires and that **declining** leaves the tool inert
(no symlink, `tool.run` exits 65).

**Cloud parity** — repeat steps 1, 3, 6 on one cloud provider (`--provider e2b` is cheapest and
bakes from a Dockerfile via `agentbox prepare --provider e2b`) to prove the
`executeCloudAction` path matches. Per the "verify ground truth" rule, check effects, not exit
codes.

---

## Phase status

- [ ] Phase 0 — durable doc + delete Notion/Linear
- [ ] Phase 1 — tools model + config
- [ ] Phase 2 — relay `tool.*`
- [ ] Phase 3 — in-box surface
- [ ] Phase 4 — request + create-time approval
- [ ] Phase 5 — doctor, docs, e2e
