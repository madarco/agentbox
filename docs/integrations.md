# Integrations — relay-gated service connectors

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Planning context: [`integrations_backlog.md`](./integrations_backlog.md) (the four-service plan). Per-task tracker for Notion: [`notion_backlog.md`](./notion_backlog.md). The user-facing page is `apps/web/content/docs/integrations-notion.mdx` (published at https://agent-box.sh/docs/integrations-notion).

This is the design / reference doc for the host-side integrations spine — the box-to-host bridge that lets an in-box agent read tickets/docs from Notion (and, in future, Linear / Trello / ClickUp) and make a small, prompted set of writes, without ever holding the service's credentials inside the box. The shape mirrors the existing `gh` and `git` relay flows exactly.

## Why this exists

The host owns the credentials. The box is the untrusted side. A box agent should be able to **read** tickets/docs freely (a search, a `GET`) and **write** with the user's per-call approval (a `page.create`, a `comment.add`), but **the token must never enter the box**. The model is the one we already proved with `gh`:

- An in-box shim (`gh-shim`) intercepts a strict subcommand allowlist and forwards through `agentbox-ctl`.
- `agentbox-ctl` POSTs `/rpc` on the box-local relay (bearer-authed, see [`host-relay.md`](./host-relay.md)).
- The relay classifies the op as **read** or **write**. Reads pass; writes go through `askPrompt` (host approval), then shell out to the host's authenticated CLI. The token stays on the host.

Integrations generalize this for any host CLI: each service is one **connector descriptor** in `@agentbox/integrations`, and the relay's `integration.<service>.<op>` dispatcher walks the same path.

## Where the gate lives

The gate lives in the **relay**, not in the box. The in-box ctl is unprivileged; it sends an RPC and waits for a verdict. The relay (a host process) is the only thing that runs the host CLI, and it's the only thing that consults the per-project `integrations.<svc>.enabled` flag, the op's read/write classification, the op's `refuseCall` pre-flight, and `askPrompt` for writes. One check covers every caller — the shim, the `notion`/`ntn` alias, a direct `agentbox-ctl integration` invocation, a future host-initiated one-time token. See "gate at the host boundary" in the user feedback notes.

## The connector descriptor

`packages/integrations/src/types.ts` defines two types:

```ts
export interface IntegrationConnector {
  service: IntegrationService;                // 'notion' (more later)
  hostBin: string;                            // 'ntn'
  detect: {                                   // T3 doctor probes
    versionArgs: readonly string[];
    authArgs?: readonly string[];
    installHint?: string;                     // shown by `agentbox doctor` when missing
    loginHint?: string;                       // shown when unauthed
  };
  env?: Readonly<Record<string, string>>;     // forced env vars; <SERVICE>_* only
  ops: Readonly<Record<string, IntegrationOp>>;
}

export interface IntegrationOp {
  write: boolean;                             // false = read, true = gated write
  buildArgv?: (args: readonly string[]) => string[];   // shape user argv → host CLI argv
  refuseCall?: (args: readonly string[]) => IntegrationOpRefusal | null;
}
```

Pure data + small predicates. No I/O at import time, so unit tests stay pure. The descriptor file (`packages/integrations/src/connectors/notion.ts`) is the single source of truth for the box surface, the relay's allowlist, and (since T3) the doctor's install/login hint strings.

A `registry.ts` exports `getConnector(service)` and `ALL_CONNECTORS`. Adding a service is a new descriptor file + a one-line registry add. No relay change, no ctl change.

### env-var namespace guard

`packages/relay/src/integrations.ts:mergeConnectorEnv` enforces that a descriptor can only set env vars in its own `<SERVICE>_*` namespace (e.g. Notion's connector can set `NOTION_KEYRING` but never `PATH` or `AGENTBOX_PROMPT`). A misconfigured descriptor returns a typed exit-78 envelope rather than silently disabling the relay's gate or rewriting `PATH`.

### env: `NOTION_KEYRING=0`

The Notion connector forces `NOTION_KEYRING=0` on the host spawn so `ntn` reads file-based auth (`~/.config/notion/auth.json`) instead of the macOS keychain. This is required when the integration is exercised **inside a box** (the box has no keychain — see "Carry-based file-auth" below). On the macOS host itself, setting it is harmless: the keychain path is only suppressed when the file-auth path is present, which it isn't on a fresh host. `agentbox doctor` deliberately does NOT set this env var (see "Doctor" below).

## The relay dispatch flow

`packages/relay/src/integrations.ts` is the spine. The dispatcher in `packages/relay/src/server.ts` (docker) and `packages/relay/src/host-actions.ts` (cloud) calls into it for any method starting with `integration.`. Per the "fix across all providers" rule, both paths share the exact same handler.

For `integration.<service>.<op>`:

1. **`parseIntegrationMethod`** splits on the first two dots; dotted ops (`page.create`) keep their dot. Unknown shape → exit 64.
2. **`getConnector(service)`** — unknown service → exit 64.
3. **op allowlist** — unknown op → exit 65, with the list of available ops.
4. **worktree resolve** — `params.path` → which registered worktree (cwd for the host CLI spawn).
5. **`refuseIntegrationCall(op, args)`** — runs the op's `refuseCall` pre-flight (e.g. `notion.api`'s GET-only check). Refused → exit 65, before any host process is spawned.
6. **`refuseIfIntegrationDisabled(service, cwd)`** — re-reads the layered config every call (so a flag flip takes effect without bouncing the relay; same approach as `loadAutopauseConfig`). Disabled → exit 65 with a config-hint. Runs **before** any host probe / prompt so a disabled integration is never user-visible as a permission prompt.
7. **`assertIntegrationReady(connector)`** — cached for 60s per `hostBin`. Probes `<hostBin> <versionArgs>` to make sure the binary exists. Missing → exit 127. Failed version → propagate exit.
8. **Write gating.** For `op.write === true`:
   - If `params.hostInitiated` is set, validate it against `HostInitiatedTokens` (scope + params-hash bound). A present-but-invalid token is a hard reject (attack signal — exit 10).
   - Otherwise (or for any unbound write) `askPrompt(...)` blocks until the host answers `y` / `n`. Denied → exit 10.
   - Read ops skip both gates entirely.
9. **`runHostIntegration`** spawns the host binary in the worktree's `hostMainRepo`, with the connector's `env` merged on top of `process.env` (subject to the namespace guard). Returns the standard `{exitCode, stdout, stderr}` envelope.

## Read vs write — the Notion op surface

`packages/integrations/src/connectors/notion.ts` carries the current allowlist. Intentionally minimal — start conservative, widen as real agent flows surface needs.

| Op            | Class | Host argv                | Notes                                                                                  |
| ------------- | ----- | ------------------------ | -------------------------------------------------------------------------------------- |
| `whoami`      | read  | `ntn whoami`             | dedicated op so the agent doesn't need to widen the `api` allowlist.                   |
| `api`         | read  | `ntn api <args>`         | `GET`-only; `refuseApiNonGet` rejects `-X`/`--method`/`-f`/`-F` (Go pflag-style).      |
| `page.create` | write | `ntn pages create <args>` | gated by `askPrompt`. (User-facing shim form: `ntn pages create …`.)                   |
| `page.update` | write | `ntn pages update <args>` | gated; covers archive + props. (User-facing shim form: `ntn pages update …`.)         |

`comment.add` is intentionally absent — `ntn` exposes no top-level `comment` subcommand. The only path is `ntn api v1/comments -X POST -f …`, which the `api` op refuses (GET-only). Comment creation needs a Notion-API-aware payload assembler that maps CLI flags to the structured `POST /v1/comments` body; tracked as a follow-up in [`notion_backlog.md`](./notion_backlog.md). The in-box shim rejects `notion comment add …` with a clear "deferred" message.

## The enable flag

`integrations.notion.enabled` (typed config, default **false**) lives in `packages/config/src/types.ts` (`UserConfig`, `EffectiveConfig`, `BUILT_IN_DEFAULTS`, `KEY_REGISTRY`). The config parser/merger/writer were taught to walk three-level nested keys (`branch.subbranch.leaf`) for this, so the YAML reads naturally. Layered the usual way: CLI > workspace > project > global > built-in.

Toggle per project:

```bash
agentbox config set --project integrations.notion.enabled true
```

Default off so every box ships the shim but it's inert until the user opts in — no surprise box→host calls.

## In-box surface

`packages/sandbox-docker/scripts/ntn-shim` is the `gh-shim` pattern: strict subcommand allowlist (`whoami`, `api`, `page`, …) → `exec agentbox-ctl integration notion <op> -- "$@"`. Anything off the allowlist is rejected with a clear message. The same shim is symlinked at `/usr/local/bin/notion` so the agent can type either name.

Staging follows the canonical pattern (see the `feedback-canonical-dockerfile-box-location` memory):

- Listed in `contextFiles` + `execBitFiles` in `apps/cli/scripts/stage-runtime.mjs`.
- COPY'd into `Dockerfile.box` next to the `gh-shim` / `git-shim` block.
- Mirrored into `packages/sandbox-hetzner/scripts/install-box.sh`, `packages/sandbox-vercel/scripts/provision.sh`, and `packages/sandbox-e2b/scripts/build-template.sh`, plus the matching `src/runtime-assets.ts` upload lists. Daytona stays shim-less.

## Doctor

`agentbox doctor` reports each integration in a dedicated `integrations:` group, driven off `ALL_CONNECTORS` (no hardcoded `'notion'` in the doctor — Linear/Trello will light up automatically when they ship). Per connector:

- **Disabled** (default, layered config) → `[info] notion  disabled  (enable with \`agentbox config set --project integrations.notion.enabled true\`)`. `info` is a new status that rolls up like `ok` so a disabled integration never pushes the overall doctor status to "warn".
- **Enabled + binary missing** → `[warn] notion  ntn not installed  (install ntn: https://developers.notion.com/reference/notion-cli)`. Hint string comes from `connector.detect.installHint`.
- **Enabled + binary present + unauthed** → `[warn] notion  not logged in  (ntn login)`. Hint from `connector.detect.loginHint`.
- **Enabled + binary present + authed** → `[ ok ] notion  ntn version X.Y.Z · authed`.

**The doctor host probe does NOT set `NOTION_KEYRING=0`.** On the host the user's authed state is exactly their keychain entry; forcing the file-auth path would make `ntn api v1/users/me` look for a non-existent `~/.config/notion/auth.json` and a keychain-authed user would falsely show as "not logged in". The connector's env override applies in-box (where the carried file IS the credential), and the doctor's host probe deliberately skips it. See the comment in `apps/cli/src/lib/doctor-checks.ts:integrationsChecks`.

The live `ntn` host probe is the orchestrator's post-merge check — it can't be verified inside an AgentBox box because the real `ntn` isn't installed there. The unit test (`apps/cli/test/doctor-integrations.test.ts`) stubs a fake `ntn` on PATH so the four status transitions are exercised in CI.

## Carry-based file-auth for nested boxes

For T4 nested-box e2e (box → box, exercise the integration from inside a box), the host's `ntn` auth is carried into the box as a **file**. `agentbox.yaml`'s `carry:` block ships `~/.config/notion/auth.json` (or the equivalent path) into the box, and `NOTION_KEYRING=0` is forced by the connector when the relay shells out, so `ntn` reads the carried file directly. The token still lives only at the leaf hop (the innermost agent's relay invokes the innermost host's `ntn`, which has the file). There is no token in the agent's process env (`printenv | grep -i notion` shows nothing).

Carry is host→box and one-prompt-approved (see [`features.md`](./features.md) → `carry:`). T4 wires the actual e2e verification.

## Verification / live e2e results

T4 ran the integration against the live Notion API from inside a real box.
Captured evidence:

- **`notion whoami` (read)** — round-trips through the in-box shim → host
  relay → host `ntn` → Notion API; returns the host bot identity with no
  approval prompt.
- **`notion api v1/users/me` (read)** — same path; returns the host bot's
  JSON identity record. No prompt.
- **`notion api … -X POST` and `--method PATCH` (refused)** — the
  connector's `refuseApiNonGet` correctly classifies these as writes and
  blocks them before any host process is spawned: `notion api: only GET is
  proxied (use page.create / page.update for writes); detected method
  'POST'`, exit 65.
- **No agent-side credential** — `printenv | grep -i notion` in the box
  returns nothing in the agent's environment. The token lives only on the
  host. The carried `~/.config/notion/auth.json` file is for nested-box
  relay hosts and never reaches the agent's process env.
- **Connector argv bug (fixed in T4)** — a live `notion pages create`
  through the host relay (rebuilt from T3 code) failed with `error:
  unrecognized subcommand 'page'. tip: some similar subcommands exist:
  'update', 'pages'`. Real `ntn`'s surface is `api datasources files pages
  login logout whoami workers`. The connector's `buildArgv` was building
  singular `['page', 'create', …]`; T4 changed it to `['pages', 'create',
  …]` and `['pages', 'update', …]`. Live write round-trip against the
  fix lands after the host relay rebuilds with the merged T4 code.
- **`agentbox config get` nested-key bug (fixed in T4)** — `config get
  integrations.notion.enabled` was returning `<unset>` even though
  `config set` + `loadEffectiveConfig` worked correctly, because
  `apps/cli/src/commands/config.ts` split keys on the FIRST dot only. T4
  replaced the helpers with a `walkKey` function that walks all segments
  (mirrors `readLeaf` in `packages/config/src/load.ts`). New regression
  test `apps/cli/test/config-get-nested.test.ts`.

### Nested-box e2e — deferred, not blocking

The nested-box scenario (a box-inside-a-box running a `notion` op through
this box's relay) was time-boxed in T4 and deferred. Architecturally, the
in-box `agentbox-ctl` daemon (port 8788) forwards `/rpc` to the HOST relay
(`host.docker.internal:8787`), not to a relay running in this box — so a
nested box's `notion pages create` would still terminate at the host
relay's spawn, not in this box's daemon. That means nested-box e2e
exercises the carry mechanics (already verified — `~/.config/notion/`
present in this box) more than the connector's spawn path. A future
follow-up that lifts the relay into the box's daemon would change this;
tracked under "Open follow-ups" below.

## Cross-provider parity

`integration.<service>.<op>` is dispatched identically on docker and cloud because the wire shape is method-agnostic. The cloud path long-polls `/bridge/poll`, runs `executeCloudAction → runIntegrationRpc`, which reuses the exact handler. The Hetzner / Daytona / Vercel / E2B image flows all ship the `ntn` / `notion` shim (see "In-box surface" above). No provider-specific code in the integrations spine.

## Open follow-ups

- **Linear / Trello / ClickUp** — see [`integrations_backlog.md`](./integrations_backlog.md). Each is a new descriptor + a small shim; no relay change. ClickUp will be the one custom REST connector (no good CLI on PyPI / npm).
- **`comment.add`** — deferred; needs a Notion-API-aware payload translator that maps CLI flags to the structured `POST /v1/comments` body.
- **Least-privilege tokens** — Notion capability toggles for the host token; Trello supports `scope=read` (when we add it); Linear personal keys inherit full user perms (OAuth-only for read-scope tokens). Document on each service's user-facing page.
- **Host-initiated tokens** — the relay already accepts `params.hostInitiated` and validates it against `HostInitiatedTokens` (scope + params-hash bound). The host-CLI mint path that issues those tokens isn't wired yet for integrations; once it is, a host-typed `agentbox-ctl integration notion page.create …` can skip the prompt by minting a token first (same shape as the existing `gh.pr.*` and `cp.*` host-initiated paths).
- **Nested-box e2e** — T4 in [`notion_backlog.md`](./notion_backlog.md). Verify the carry-based file-auth path against a real Notion workspace.
