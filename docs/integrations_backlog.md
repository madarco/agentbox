# Plan: Ticketing & Knowledge integrations (Notion, Linear, Trello, ClickUp)

## Context

AgentBox boxes need to talk to ticketing/knowledge tools the same safe way they
already talk to GitHub: a box agent can **read** freely and perform a **limited,
prompted set of writes**, but **credentials never enter the box**. The host owns
the auth; the relay is the gate.

The driving use case: a host ("master") Claude session runs a goal/loop and calls
whatever CLI it likes directly (out of scope here — the host has creds). What we
build is the **box→host plumbing** so that work delegated into boxes can read
tickets/docs and make controlled writes through the relay, with a host approval
prompt on every write — exactly the `gh`/`git` model.

This is the reference architecture already proven by `gh`:

- In-box **shim** (`gh-shim`) intercepts a strict subcommand subset → `agentbox-ctl gh …`
- `agentbox-ctl` POSTs `/rpc` (bearer `AGENTBOX_RELAY_TOKEN`) → host relay
- Relay **classifies read vs write**, gates writes via `askPrompt` (loopback
  `/admin/prompts/answer`), then shells out to the **host's authenticated CLI**
  (`runHostGh`) and ships back `{exitCode, stdout, stderr}`.
- Reads skip the prompt; tokens stay on the host; host-initiated one-time tokens
  let host-typed commands skip the prompt.

### Decisions locked with the user

| Decision | Choice |
|---|---|
| Execution model | **Host-side via relay** — tokens never in box (like `gh`) |
| CLI provisioning | **Host dependency** — user installs + auths the real CLI on the host; `agentbox doctor` detects it; relay shells out to it |
| In-box surface | **Per-service shims** on PATH: `notion`, `linear`, `trello` (later `clickup`) |
| Notion backend | Wrap the **official `ntn`** CLI (beta, first-party) |
| Linear backend | Wrap **`schpet/linear-cli`** (758★, TypeScript, `npm i -g @schpet/linear-cli`, has `--json`) |
| Trello backend | Wrap **`mheap/trello-cli`** (336★, TypeScript, `npm i -g trello-cli`; human-text output, no `--json`) |
| ClickUp | **Deferred** to a later session — weak ecosystem (best is 29★ Go); will be a **custom host-side REST connector** in the shared package, not a wrapped CLI |
| Sequencing | Shared foundation + Notion → Linear → Trello → (ClickUp later) |

### CLI/MCP landscape (why this shape)

- **Notion** — official CLI `ntn` (beta) + hosted MCP. Wrap `ntn`.
- **Linear** — NO official CLI; GraphQL API + hosted MCP. Wrap `schpet/linear-cli`.
- **Trello** — NO official CLI, NO MCP; REST key+token (best read-only-scope story). Wrap `mheap/trello-cli`.
- **ClickUp** — NO official CLI; thin community tools (≤29★, Go/Rust). Build a custom REST connector when we reach it.

We chose CLI-wrapping over the hosted MCP servers deliberately: the relay model is
process-shell-out + read/write classification, which maps cleanly onto a CLI but
not onto an OAuth MCP stream. The hosted MCPs remain the host session's own
business (out of scope).

---

## Architecture: a shared `integrations` abstraction

The four services differ only in (a) the host CLI binary, (b) which subcommands
are read vs write, (c) argument quirks. Everything else — shim → ctl → relay →
prompt → host-exec → result — is identical to `gh`. So we factor the common
machinery into one place and make each service a small **connector descriptor**.

### New package: `@agentbox/integrations` (`packages/integrations/`)

The single source of truth for connector descriptors, shared by the relay (host
exec + gating), the ctl (in-box command surface), and the host CLI (`doctor`,
`<svc> status`). Pure data + small helpers, no docker/network at import time
(keeps unit tests pure, per repo conventions).

```ts
// packages/integrations/src/types.ts
export interface IntegrationOp {
  name: string;                 // e.g. 'issue.create'
  write: boolean;               // true => relay gates with askPrompt
  /** Map ctl argv -> host CLI argv (verbatim passthrough by default). */
  buildArgv?(args: string[]): string[];
}

export interface IntegrationConnector {
  service: 'notion' | 'linear' | 'trello' | 'clickup';
  /** Host binary the relay execs (resolved on PATH). */
  hostBin: string;             // 'ntn' | 'linear' | 'trello' | (clickup: '' => REST)
  /** Doctor: how to detect presence + auth on the host. */
  detect: { versionArgs: string[]; authArgs?: string[] };
  ops: Record<string, IntegrationOp>;
  /** Default: deny. Only listed ops are proxied at all (allowlist, like gh). */
}
```

One descriptor file per service: `connectors/notion.ts`, `connectors/linear.ts`,
`connectors/trello.ts` (`connectors/clickup.ts` later). A `registry.ts` exports
`getConnector(service)` and `ALL_CONNECTORS`.

This mirrors the existing `Provider` registry pattern (`packages/core/src/provider.ts`)
the codebase already uses for docker/daytona/hetzner/vercel/e2b.

### Shared relay machinery (generalize `gh.ts`)

`packages/relay/src/gh.ts` already isolates `runHostGh` + the read/write op sets +
the allowlist refusal. Generalize the reusable half into
`packages/relay/src/integrations.ts`:

- `runHostIntegration(connector, op, args, cwd)` — the `runHostGh` analogue:
  `spawn(connector.hostBin, op.buildArgv(args))`, capture stdout/stderr/exit.
- `assertIntegrationReady(connector)` — the `assertGhReady` analogue: returns a
  clear exit-4-style error if the host binary is missing or logged out.
- A generic `/rpc` dispatch branch: method `integration.<service>.<op>` →
  look up connector + op → if `op.write` and no valid host-initiated token →
  `askPrompt(...)` (reuse `packages/relay/src/prompts.ts` verbatim) → on `y`
  run `runHostIntegration`, else exit 10. Reads skip the prompt.

This plugs into the existing dispatcher in
`packages/relay/src/server.ts` (the `POST /rpc` block, alongside the `git.*` /
`gh.*` branches) **and** the cloud path in
`packages/relay/src/host-actions.ts` (so daytona/hetzner/vercel/e2b get it for
free, per the project rule "fix across all providers"). The `HostActionQueue` /
`CloudBoxPoller` plumbing is method-agnostic — a new method prefix flows through
unchanged.

### Shared ctl machinery (generalize `commands/gh.ts`)

`packages/ctl/src/commands/integration.ts` builds one commander `Command` per
connector from its descriptor, each subcommand calling
`postRpcAndExit('integration.<service>.<op>', params)` (reuse
`packages/ctl/src/relay-rpc.ts` unchanged). Registered in the ctl entrypoint next
to `ghCommand`. The box shim calls `agentbox-ctl <service> <op> -- <args>`.

### Shared shim machinery

Each shim (`notion-shim`, `linear-shim`, `trello-shim`) is the `gh-shim` pattern:
strict subcommand/flag allowlist → `exec agentbox-ctl <service> <op> -- "$@"`,
reject anything else with a clear message. Because the allowlist is per service,
the shims are thin and near-identical; keep them as separate small bash files
(matching `gh-shim`/`git-shim`) rather than over-abstracting bash.

### Host CLI surface

- `agentbox doctor` learns to report each integration: host binary present?
  authed? (drives a friendly "install `ntn` and run `ntn login`" hint). Extend
  the existing doctor command (Linux-aware doctor lives per
  `docs/linux-host-backlog.md`).
- No `agentbox <svc> login` of our own — auth is the tool's own (`ntn login`,
  `linear auth login`, `TRELLO_API_KEY`/`TRELLO_TOKEN` env). We only **detect**.

### Config keys (typed, per `packages/config/src/types.ts`)

Add an `integrations` block to `EffectiveConfig` with per-service enable flags,
following the precedence model (CLI > workspace > project > global > default):

```yaml
integrations:
  notion: { enabled: true }
  linear: { enabled: true }
  trello: { enabled: false }
```

Disabled → the shim isn't installed / `agentbox-ctl` refuses the method. Default
all **off** until the host tool is detected (avoid dead shims). Update
`BUILT_IN_DEFAULTS` and the config docs.

### Image / provisioning

Shims are tiny bash files staged like `gh-shim`/`git-shim`:

- Add each shim to `packages/sandbox-docker/scripts/` and to the **`contextFiles`
  + `execBitFiles`** lists in `apps/cli/scripts/stage-runtime.mjs` (the canonical
  Dockerfile is regenerated — editing `apps/cli/runtime/docker/Dockerfile.box`
  directly is wiped; see memory note on canonical Dockerfile location).
- `Dockerfile.box` COPY block (near the existing `gh-shim`/`git-shim` COPY at
  lines ~143-155) places them on PATH ahead of any real binary.
- Mirror into the hetzner install script
  (`packages/sandbox-hetzner/scripts/install-box.sh`) and the vercel/e2b/daytona
  runtime file lists in `stage-runtime.mjs`.
- **No host CLIs are bundled** — they are host dependencies (the user's laptop),
  exactly like `gh`. The box only ever has shims.

---

## Per-session breakdown

Each row is its own session. Session 1 builds the shared spine + Notion as the
reference connector end-to-end; later sessions are mostly "add a descriptor +
shim + tests."

### Session 1 — Shared foundation + Notion (`ntn`)
1. Create `packages/integrations/` (types, registry, `connectors/notion.ts`).
   Notion ops: reads (`page.get`, `db.query`, `search`, `api GET …`); writes
   (`page.create`, `page.update`/archive, `comment.add`) — gated.
2. `packages/relay/src/integrations.ts`: `runHostIntegration`,
   `assertIntegrationReady`, generic dispatch helper. Wire the
   `integration.<svc>.<op>` branch into `server.ts` **and** `host-actions.ts`.
3. `packages/ctl/src/commands/integration.ts` + register in ctl entrypoint.
4. `notion-shim` + stage-runtime wiring + Dockerfile COPY (+ hetzner/cloud mirrors).
5. `integrations` config block in `packages/config/src/types.ts` + defaults.
6. `agentbox doctor` integration section.
7. Tests + docs (see below).

### Session 2 — Linear (`schpet/linear-cli`)
- `connectors/linear.ts`: hostBin `linear`. Reads (`issue list/view`, `team list`);
  writes (`issue create`, `issue update`/status, `comment create`) — gated.
- `linear-shim`; config flag; doctor entry. No relay/ctl core changes (descriptor
  only) — this validates the abstraction.

### Session 3 — Trello (`mheap/trello-cli`)
- `connectors/trello.ts`: hostBin `trello`. Reads (`board:get`, `list:get`,
  `card:get`); writes (`card:create`, `card:move`, `comment`) — gated.
- Note: output is human-text, not `--json` — the shim/connector must not promise
  JSON; agents parse text. Auth via `TRELLO_API_KEY`/`TRELLO_TOKEN` (host env),
  and Trello supports a least-privilege `scope=read` token — document that.

### Session 4 — ClickUp (custom REST connector)
- No good CLI → `connectors/clickup.ts` sets `hostBin: ''` and the relay path
  uses a small host-side REST client (`fetch` against `api.clickup.com/api/v2`,
  `pk_` token from host env/config) instead of `runHostIntegration`. This is the
  one connector that exercises the "custom CLI/connector" branch the user
  anticipated; keep it inside the same shared package so the box surface and
  gating are identical to the others.

---

## Critical files

- **Reference to copy from**: `packages/relay/src/gh.ts`,
  `packages/ctl/src/commands/gh.ts`, `packages/sandbox-docker/scripts/gh-shim`,
  `packages/relay/src/prompts.ts`, `packages/relay/src/host-initiated.ts`.
- **New**: `packages/integrations/` (package), `packages/relay/src/integrations.ts`,
  `packages/ctl/src/commands/integration.ts`,
  `packages/sandbox-docker/scripts/{notion,linear,trello}-shim`.
- **Edit**: `packages/relay/src/server.ts` (`POST /rpc` dispatch),
  `packages/relay/src/host-actions.ts` (cloud path),
  `apps/cli/scripts/stage-runtime.mjs` (contextFiles/execBitFiles + cloud lists),
  `packages/sandbox-docker/Dockerfile.box` (COPY shims),
  `packages/sandbox-hetzner/scripts/install-box.sh` (mirror),
  `packages/config/src/types.ts` (config block + defaults),
  `apps/cli/src/commands/doctor.ts` (detection).
- **Docs (same change, per repo rule)**: a new `docs/integrations.md`; CLI
  reference + a `.mdx` page under `apps/web/content/docs/`; mention in
  `docs/host-relay.md` (new RPC methods) and `docs/features.md`.

---

## Reused, not rebuilt

- `askPrompt` + `PromptSubscribers` (`prompts.ts`) — the write gate, verbatim.
- `HostInitiatedTokens` (`host-initiated.ts`) — host-typed commands skip prompt.
- `postRpcAndExit` / `relay-rpc.ts` — box→relay transport, verbatim.
- `HostActionQueue` + `CloudBoxPoller` — cloud round-trip is method-agnostic.
- Provider-registry pattern (`core/src/provider.ts`) as the model for the
  connector registry.
- `stage-runtime.mjs` staging + `gh-shim` COPY pattern for shim provisioning.

---

## Verification (end-to-end, per session)

Unit (pure, vitest):
- Connector registry: each op classified read/write; allowlist denies unknown ops.
- `refuse`-style guards: unknown subcommand/flag rejected with a clear message
  (mirror the `gh.ts` refusal tests).
- Relay dispatch: write op with no host-initiated token → `askPrompt` called;
  read op → not called; denied prompt → exit 10.

Manual e2e (docker first, then one cloud provider — follow CLAUDE.md "Testing"):
1. Install + auth the host tool (`ntn login` / `linear auth login` /
   `TRELLO_API_KEY`+`TRELLO_TOKEN`). `agentbox doctor` shows it green.
2. `node apps/cli/dist/index.js create -y -n smoke &`; `tail -f ~/.agentbox/logs/create.log`.
3. In the box (`agentbox shell smoke` or attach): run a **read**
   (`linear issue list` / `notion search …`) → returns host data, **no prompt**.
4. Run a **write** (`linear issue create …`) → host approval prompt appears
   (the wrapper's `/admin/prompts/stream`); approve → succeeds; deny → exit 10,
   nothing created. **Verify ground truth** (the issue/card/page actually exists
   or doesn't) rather than trusting exit codes — per the "verify ground truth"
   project rule, and because Trello's wrapper output is human-text.
5. Confirm the box never holds a token: `printenv | grep -i token` inside the box
   shows only `AGENTBOX_RELAY_TOKEN`, never a Notion/Linear/Trello credential.
6. Repeat steps 3-4 on one cloud provider (e.g. hetzner) to confirm the
   `host-actions.ts` path works (the cloud poller drives the same gate).

## Open follow-ups (note in `docs/integrations.md`, don't block)
- Least-privilege tokens: document Trello `scope=read` and Notion capability
  toggles; Linear personal keys inherit full user perms (OAuth-only read scope).
- Per-op write allowlist tuning once real agent flows exist (start conservative).
- ClickUp connector trust/maintenance caveats; revisit if a stronger CLI emerges.

---

## Status

- **Notion path: COMPLETE (T1–T4 done, 2026-06-06).** Shipped the shared
  `@agentbox/integrations` foundation (descriptor, registry,
  `runHostIntegration`, generic `integration.<svc>.<op>` dispatch in both
  `server.ts` and `host-actions.ts`); in-box `notion`/`ntn` shim across all
  five providers; `integrations.notion.enabled` typed config flag with the
  relay-side `refuseIfIntegrationDisabled` gate; `agentbox doctor` per-
  connector reporting driven off `ALL_CONNECTORS`; public + internal docs.
  T4 closed the loop with a live read e2e (`whoami` + `api v1/users/me` +
  `refuseApiNonGet` for non-GET) and fixed two bugs the e2e surfaced —
  `agentbox config get` nested-key resolution (`apps/cli/src/commands/config.ts`)
  and the `pages` vs `page` argv mismatch (`connectors/notion.ts`). See
  [`notion_backlog.md`](./notion_backlog.md) for full T4 evidence.
  **Deferred / follow-ups**: `comment.add` (needs a Notion-API payload
  assembler for the structured `POST /v1/comments` body — `ntn` exposes no
  `comment` subcommand to wrap), host-initiated tokens for integrations
  (the relay accepts them but the host-CLI mint path isn't wired yet for
  the `integration.*` family), nested-box e2e (architecturally the in-box
  agent's relay calls terminate at the host relay either way, so this
  exercises the carry block more than the spawn-side; tracked, not
  blocking).
- **Linear / Trello / ClickUp paths: NOT STARTED.** Each is a new descriptor
  + small shim; no relay/ctl core changes (the abstraction was validated by
  Notion). ClickUp will be the one custom-REST connector (no good CLI).
