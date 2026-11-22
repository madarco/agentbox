# LLM accounts and the hub egress proxy — plan

Status: **Phase 0 partly done (2026-11-22)** — see [Phase 0 results](#phase-0-results).
Single-account facts are measured; the two-account half of (a)/(b) and every live
codex turn are blocked on the owner. One phase per session.

## Why

Every agent has exactly **one** login, everywhere. A user with two Claude
subscriptions (personal + work), or a subscription plus an API key for overflow,
cannot say which one a box runs on. And nothing shows which login a running box
is using.

Separately, subscription traffic from cloud boxes leaves from datacenter IPs —
many of them, for one account. Some users want every agent call to egress from
one address they control.

Four features, one plan:

1. **Named accounts per agent** — several logins / API keys / setup tokens.
2. **Selection** — per box at create time, with a default per project and global.
3. **Visibility** — which account each box/agent uses, in the CLI, hub web and tray.
4. **Optional hub egress proxy** — agents' LLM calls leave from the hub's IP.

## What exists today (the one-slot model)

Each layer keeps exactly one credential per agent id:

| layer | where | file |
|---|---|---|
| host backup | `~/.agentbox/<agent>-credentials.json` | `packages/sandbox-core/src/sync/concerns/credentials.ts` |
| docker | shared volume `agentbox-<agent>-config` (or `…-<boxId>` with `box.isolate<Agent>Config`) | `packages/sandbox-docker/src/create.ts:676` |
| cloud | staged per create from the host backup; Daytona: one subpath in the per-org `agentbox-credentials` volume | `packages/sandbox-cloud/src/sync/agent-credentials.ts` |
| hub custody | `agents/<agent>/<file>` | `packages/relay/src/custody/store.ts` |
| fan-out | keyed by agent id: ctl `CredentialsWatcher` → relay `CredentialsFanout` → `agentbox credentials propagate` | `packages/relay/src/credentials-fanout.ts`, `apps/cli/src/commands/credentials.ts` |
| env keys | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` sprayed from the host env into every box (`forwardedEnvKeys`) | `packages/agent-claude/src/docker-sync.ts:513`, `packages/sandbox-cloud/src/sync/agent-credentials.ts:253` |

Logins run the agent's own flow in a throwaway container against the shared
volume (`apps/cli/src/agents/command/login.ts`, claude's
`packages/agent-claude/src/cli/login-command.ts`).

The nearest existing concept is **model-auth** ([`model-auth-sources-plan.md`](./model-auth-sources-plan.md)):
a box may *borrow another agent's* login (`--model-auth codex`), recorded as
`BoxRecord.borrowedCredentials` and already carried on the hub's `Box` payload —
but shown nowhere.

Two traps the design must respect:

- **The fan-out is the dangerous part.** A box refreshing account A's token must
  never overwrite account B anywhere. Every key on the fan-out path becomes
  `(agent, account)`.
- **Host-env spray beats a subscription.** Claude Code prefers `ANTHROPIC_API_KEY`
  over its OAuth login, so a box on a named subscription account must NOT get the
  host's API key sprayed into it.

## The model

### Account

```ts
interface LlmAccount {
  agent: string;            // registry id that owns the credential: 'claude' | 'codex' | plugin id
  id: string;               // 'default' | user-chosen slug ('work', 'personal')
  label?: string;
  kind: 'login' | 'setup-token' | 'api-key';
  identity?: { email?: string; org?: string; plan?: string }; // read off the login, display only
  createdAt: string;
}
```

| kind | claude | codex | refresh / fan-out |
|---|---|---|---|
| `login` | `claude auth login` (OAuth, ~8h access token) | ChatGPT login `auth.json` | yes — hash/expiry-gated fan-out, per account |
| `setup-token` | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (long-lived) | — | none — static, safe across many boxes |
| `api-key` | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | none |

Which kinds an agent supports is **registry data** (`AgentSyncSpec.accountKinds`),
so plugin agents get accounts without shared code knowing their names
(`apps/cli/test/no-agent-named-exports.test.ts` must not grow).

`default` is today's slot, migrated in place on first read — no existing box,
backup or custody object changes meaning.

### Storage

- Index: `~/.agentbox/accounts.json` (metadata only, no secrets).
- Secrets: `~/.agentbox/credentials/<agent>/<account>.json`, 0600. `default`
  keeps reading/writing the legacy `~/.agentbox/<agent>-credentials.json` path
  until a later cleanup (AgentBox is unreleased — no alias layer beyond that).
- Custody: `agents/<agent>/<account>/<file>`; `default` stays at
  `agents/<agent>/<file>`.
- **Docker: split credentials from config.** The shared config volume keeps
  transcripts, settings and skills (so `--resume` works across accounts). The
  credential moves to a per-account volume `agentbox-<agent>-creds-<account>`
  mounted at `~/.agentbox-creds/<agent>/` — the same path the image's
  `postInstall` symlink and the cloud layout already use. Each container mounts
  its own account's volume at the same path, so one shared config volume serves
  boxes on different accounts. **Superseded by Phase 0:** claude's refresh
  replaces the symlink and a shared `_claude.json` mislabels the account, so
  docker uses a per-account config volume plus a shared `projects/` volume
  instead (see [Phase 0 results](#phase-0-results)).
- Cloud: staged from the account's file instead of the single backup. Daytona's
  per-org volume gets a subpath per account (`claude/<account>/`).

### Selection

Resolution, most specific first:

1. `--account <name>` on `agentbox <agent>` / `--account <agent>=<name>` (repeatable) on `agentbox create`
2. project config `<agent>.account` (`~/.agentbox/projects/<seg>/config.yaml`)
3. global config `<agent>.account`
4. `default`

`<agent>.account` is an agent setting generated from the registry row
([`agent-settings-plan.md`](./agent-settings-plan.md)). It is **not** read from
the repo's `agentbox.yaml` — an account name is a per-user fact, and a repo must
not be able to pick which of your subscriptions it bills.

Model-auth borrowing picks the **lender's** account the same way
(`pi --model-auth codex` uses `codex.account`).

The choice is recorded on the box: `BoxRecord.accounts?: Record<agentId, accountId>`.
Every later seam (fan-out, reseed on resume, display) reads it from there — never
from current config, which may have changed since create.

### Env spray

A box whose agent runs on a **named** account gets exactly that account's auth:
the agent's `forwardedEnvKeys` that carry auth are suppressed for it. A box on
`default` keeps today's behaviour unchanged.

## The hub egress proxy

`llm.proxy: off | forward | reverse`, default `off`, settable globally or per
project (`--llm-proxy` on create). Recorded on the box at create.

The proxy lives in the **relay daemon** on the hub host (it already holds every
box's token and runs on a remote control box too), on its own port. Boxes dial
the address in `llm.proxyUrl` (defaults to the hub's public URL) — so any
provider works, vercel and e2b included, as long as the hub is reachable from
the internet. The egress IP is the hub's: a home PC with a forwarded port gives
your residential IP; a Hetzner control box gives one stable datacenter IP.

**`forward` (CONNECT).** Covers everything, including OAuth refreshes; never
decrypts traffic. Needs a raw TCP port (not available through a Cloudflare
tunnel).

- **Auth:** `Proxy-Authorization` with the box's relay token; revoked on destroy.
- **Allowlist:** destination hosts are registry data per agent
  (`AgentSyncSpec.llmHosts`: `api.anthropic.com`, `platform.claude.com`, …;
  `chatgpt.com`, `auth.openai.com`, `api.openai.com`). Everything else is
  refused — the port is public.
- **Scope inside the box:** `HTTPS_PROXY` on the agent process would leak into
  every tool subprocess (`npm install` through a hub that refuses it). So the box
  runs a tiny **split proxy** on `127.0.0.1`: allowlisted hosts go to the hub,
  everything else goes direct. It ships as a pushed runtime script (like
  `attach-helper`), not inside baked `agentbox-ctl`, so existing images work.
- **Fail closed:** hub unreachable → the agent call fails with a clear error. No
  silent fallback to direct — the user asked for the proxy on purpose.

**`reverse` (base URL).** For a hub reachable only over HTTPS (`hub expose
--tunnel cloudflare`). The box gets `ANTHROPIC_BASE_URL=https://<hub>/llm/anthropic`
(codex: `chatgpt_base_url` / `OPENAI_BASE_URL`), and the hub forwards. Tool
subprocesses are unaffected. Costs: OAuth refreshes still leave from the box IP
(infrequent), and the hub terminates TLS (it is already trusted with these
credentials).

Provider-specific: vercel's sandbox `networkPolicy` must allow the proxy host
when `llm.proxy != off`.

## Surfaces

- **CLI:** `agentbox <agent> login --account <name> [--api-key | --setup-token]`;
  `agentbox accounts [list | rm | rename | default]`; `agentbox list` shows the
  account in the AGENT cell (`claude:working@work`); `agentbox status` gets an
  ACCOUNTS section.
- **Hub `/api/v1`:** `GET /accounts` (no secrets: agent, id, label, kind,
  identity, expiry, box count); `POST /accounts` for pasteable kinds (api-key,
  setup-token); `PATCH`/`DELETE`; create `opts.accounts: {agent: account}` and
  `opts.llmProxy`; `Box.accounts: [{agent, account, label, kind}]` and
  `Box.llmProxy`. The CLI goes through these (local and remote hub alike).
- **Web:** Settings → "Model accounts"; account select in the create modal;
  account in the box table and detail page.
- **Tray** (`../agentbox-tray`): decode `accounts`, show it in the row subtitle
  and detail window, picker in `CreateBoxPanel`, a settings section. New fields
  are optional so a shipped tray keeps decoding.
- **Public docs** (`apps/web/content/docs/`) in the same change as each surface.

## Phases

| # | what | gate |
|---|---|---|
| 0 | **Live PoC.** (a) Two claude logins sharing one config volume, credential swapped per container: does account B work and bill B, and does the shared `_claude.json` `oauthAccount` (write-once today) break or mislabel it? (b) Same for codex `auth.json`. (c) Claude Code and codex through a CONNECT proxy with `Proxy-Authorization` in `HTTPS_PROXY`; record every host they hit. (d) `reverse`: subscription OAuth via `ANTHROPIC_BASE_URL`; codex ChatGPT login via `chatgpt_base_url`. | decides docker storage and which proxy mode ships first |
| 1 | Account model + store in `@agentbox/core`/`sandbox-core`: types, `accounts.json`, per-account secret paths, `default` migration, `accountKinds` on registry rows. Pure, unit-tested. | — |
| 2 | Logins: `--account`, `--api-key`, `--setup-token` on `<agent> login`; `agentbox accounts`; identity read-off; per-account docker creds volume. | 1 |
| 3 | Selection + seeding: `<agent>.account`, `--account`, hub create `opts.accounts`, `BoxRecord.accounts`; docker mount, cloud staging, Daytona subpaths, env injection at the launch seams, env-spray suppression, model-auth lender account. All providers. | 2 |
| 4 | Fan-out per account: relay resolves the account from the source box's record (no ctl change — old images keep working), backups/custody/propagate keyed by `(agent, account)`, `seedHostBackupsFromCustody` per account. | 3 |
| 5 | Surfaces: `/api/v1/accounts`, `Box.accounts`, CLI list/status, web settings + create + table/detail, public docs. | 3 |
| 6 | Tray. | 5 |
| 7 | Hub proxy, mode chosen by Phase 0: relay listener, auth, allowlist, `llm.proxy` config + flag, split-proxy runtime script, launch-seam env, vercel `networkPolicy`, egress verified against `egress-ip` detection. | 0 |
| 8 | The other proxy mode, if still wanted. | 7 |

Phases 1–6 and 7 are independent; 7 can run in parallel with 1–6 after Phase 0.

## Phase 0 results

Run 2026-11-22 inside a docker box (Claude Code 2.1.323, codex-cli 0.171.0),
with per-container tests in the box's own dockerd. Tags: **measured** = observed
live in this run; **code** = read from source or docs, not observed;
**blocked** = needs the owner (see the last subsection). Agent calls were kept to
one short prompt each. No token values were printed; files were compared by
hash, length and field name only.

### Incident: one refresh logged out every other holder (measured)

To check whether a refresh goes through the proxy, a test container ran Claude
Code on a **copy** of the real login with `expiresAt` forced into the past. It
refreshed through `platform.claude.com` at 09:49Z. **At that moment the login
stopped working in all three of the owner's boxes at once**, although their
access tokens were valid until 14:23Z. The owner renewed it with
`agentbox claude login` at 09:52Z.

What this shows: a Claude OAuth refresh does more than rotate the refresh token.
It also **revokes the previous access token for every other holder, immediately**.
The `freshness` comment on claude's credential spec says an older blob is "dead,
not merely stale". That holds for the access token too, and it takes effect at
refresh time, not at `expiresAt`.

Consequences:

- **Today's model already has this outage window.** Every box holding a copy of
  one login (every cloud box, and every docker box with `isolateClaudeConfig`)
  is logged out by whichever box refreshes first, until the fan-out delivers the
  new blob. Per-account fan-out (Phase 4) does not fix that, it just keys it.
- **Docker boxes should share one file per account, not one copy per box.**
  Claude takes a lock in the config dir (`.oauth_refresh.lock`) before it
  refreshes, so processes that share the directory see the new token at once
  and refresh only once. That is the storage recommendation below.
- **`setup-token` is the right kind for an account used by many boxes**: it is
  long-lived, it never refreshes, so it never revokes anything. The CLI should
  suggest it when one `login` account is about to be seeded into a second box.
- **Refresh tests must never run against a login that other boxes hold.** The
  replacement test, not run: log in a dedicated throwaway account B, put two
  copies of it in two containers, force a refresh in one (`expiresAt` in the
  past) and time when the other starts failing. Only account B is lost.

### (a) Two claude logins, one config volume

- **Read path works (measured).** A clean shared config dir, with
  `~/.claude/.credentials.json` a symlink to a per-account dir mounted at
  `~/.agentbox-creds/claude/` (the plan's proposed layout, and the cloud's), ran
  a turn through the symlink.
- **A refresh breaks the symlink layout (measured).** Claude writes the
  refreshed credential by replacing the file: afterwards
  `config/.credentials.json` was a **regular file** holding the rotated grant,
  and the per-account file was untouched, so stale and now revoked. With a shared
  config volume, the first refresh would put **every box on that volume onto
  the account that refreshed**. The plan's "per-account creds volume behind the
  postInstall symlink" therefore fails.
  Bind-mounting the single file instead also fails: a rename onto a
  bind-mount target returns `EBUSY` (code/kernel behaviour, not measured).
- **`oauthAccount` (measured).** It is display-only and cached:
  - absent → the first **turn** fetches the profile and writes it
    (`claude auth status` alone does not; it reports `email: null`);
  - present but belonging to another account, with a fresh `profileFetchedAt` →
    the turn still runs on the token's account, and `claude auth status` reports
    the **wrong** org name/email. It is not corrected until the cache ages out;
  - `profileFetchedAt` set to 0 → refetched and corrected on the next turn.

  So a shared `_claude.json` mislabels: two accounts keep overwriting each
  other's label, and each box shows whichever account last refreshed the cache.
  Some account-derived caches in the same file are keyed by id
  (`groveConfigCache` by account, `passesEligibilityCache` by org); others are not
  (`modelAccessCache`, `orgModelDefaultCache`, `additionalModelOptionsCache`,
  `additionalModelCostsCache`, `cachedExtraUsageDisabledReason`) and would leak
  model and extra-usage state across accounts.
- **Usage lands on the token's account (code, not measured).** Inference
  carries only `Authorization: Bearer <access token>` (measured in (d)), with
  nothing from `oauthAccount` in the auth headers. Confirming which account is
  billed needs account B (**blocked**).

**Docker storage recommendation:** a **per-account config volume**
`agentbox-claude-config-<account>` (`default` stays `agentbox-claude-config`)
mounted at `~/.claude`. It holds `.credentials.json` and `_claude.json`, so the
refresh lands in the account's one shared copy and `oauthAccount` is always right.
Keep `--resume` working across accounts by mounting one shared
`agentbox-claude-projects` volume over `~/.claude/projects` (transcripts are
keyed by cwd, `-workspace`, the same for every box). Drop the
`~/.agentbox-creds/claude` symlink idea for docker.

### (b) Codex `auth.json`

- **Blocked: the codex login carried into this box is dead.** Its access token
  expired 2026-10-24 and the refresh is refused (`401`, "Your access token could
  not be refreshed. Please log out and sign in again."). No live codex turn was
  possible, so neither the swap nor billing could be measured.
- Measured layout: in a docker box the volume holds `~/.codex/auth.json` as a
  symlink to `~/.agentbox-creds/codex/auth.json`. Whether codex's refresh write
  keeps that symlink (claude's does not) is **untested** and is the first check to
  run once codex is logged in again. Codex has no `oauthAccount` equivalent in a
  shared file: `auth.json` carries `account_id` itself.
- Codex refreshes proactively once `last_refresh` is older than about 8 days
  (observed: it refreshed on start with a 39-day-old `last_refresh`), so the
  revocation risk above applies to codex copies too (assumed, not measured).

### (c) CONNECT proxy

Both agents honour `HTTPS_PROXY=http://user:token@host:port` and send
`Proxy-Authorization` **preemptively** on every CONNECT (measured):

- **claude:** turns work. The forced OAuth refresh went through the proxy
  (`platform.claude.com`). A wrong token gives a clear
  `API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL)`, exit 1, in
  under 45 s. **A proxy that refuses the connection gives no error at all**:
  claude kept retrying silently for over 100 s.
- **codex:** reqwest routes through the proxy with auth, and so does the token
  refresh (`POST auth.openai.com/oauth/token`).

**Tool subprocesses inherit `HTTPS_PROXY` (measured).** Claude's Bash tool saw
it. Codex's own `git ls-remote` of a plugin marketplace went to the proxy for
`github.com`, sent no proxy auth, and failed (`Proxy CONNECT aborted`). With the
hub proxy directly in the agent's env, every tool would send its traffic to the
hub, and would also see the relay token in the URL. The split proxy is needed.

**Hosts seen** (`AgentSyncSpec.llmHosts` input):

| agent | host | what |
|---|---|---|
| claude | `api.anthropic.com` | inference + account/flag/profile calls |
| claude | `platform.claude.com` | OAuth refresh |
| claude | `mcp-proxy.anthropic.com` | claude.ai MCP connectors (account-driven, hit even with an empty config) |
| claude | `http-intake.logs.us5.datadoghq.com` | telemetry, not an LLM host |
| codex | `chatgpt.com` | ChatGPT backend + responses (WebSocket, with an HTTPS fallback) |
| codex | `ab.chatgpt.com` | feature flags |
| codex | `auth.openai.com` | OAuth refresh |
| codex | `github.com` | plugin marketplace `git`, not an LLM host |

Not seen in this run (no interactive login, no API-key mode): `claude.ai` and
`console.anthropic.com` (login), `api.openai.com` (codex API-key mode). Add them
from code. The host config also reached the user's own MCP servers; those are
per-user, not registry data.

Proposed `llmHosts`: claude `api.anthropic.com`, `platform.claude.com`,
`mcp-proxy.anthropic.com`, `claude.ai`; codex `chatgpt.com`, `ab.chatgpt.com`,
`auth.openai.com`, `api.openai.com`. Telemetry and `github.com` go direct through
the split proxy.

### (d) Reverse (base URL)

- **claude, subscription OAuth via `ANTHROPIC_BASE_URL`: inference works
  (measured).** `POST /v1/messages` reached the forwarder with
  `Authorization: Bearer` (OAuth) and `anthropic-beta: oauth-2025-04-20,…`, and
  returned 200. **Everything else bypassed it**: 8 other `api.anthropic.com`
  calls in one `-p` turn, `mcp-proxy.anthropic.com`, telemetry, and OAuth
  refreshes (`platform.claude.com`) all went direct.
- **codex (measured with the dead login, so routing only):**
  `OPENAI_BASE_URL` is **ignored** under ChatGPT auth; all traffic stayed on
  `chatgpt.com`. `-c chatgpt_base_url=…` reroutes the ChatGPT backend side calls
  (`/backend-api/wham/*`, `/ps/plugins/*`, `/ps/mcp`,
  `/codex/analytics-events/*`), but some `chatgpt.com` calls stayed direct, and so
  did the refresh. Whether the `/codex/responses` inference call follows it could
  not be measured. A custom `model_providers.<id>` with `base_url` and
  `requires_openai_auth = true` is the next candidate (**untested**).

So reverse moves **inference only**. The account's identity, flag and refresh
traffic still leaves from the box's IP, which defeats "every call from one
address".

### Recommendations

- **Ship `forward` first (Phase 7).** It is the only mode that carries all of an
  account's traffic, refreshes included, for both agents, and it needs no
  per-agent base-URL knowledge. `reverse` stays Phase 8, documented as
  "inference only" for hubs reachable only over an HTTPS tunnel.
- **Docker storage:** a per-account config volume plus a shared
  `projects/` volume, as above. Not a per-account creds volume behind a symlink.

### Changes to Phases 1–8

- **Storage** (Phase 2/3): replace the docker bullet with the per-account config
  volume + shared `agentbox-claude-projects`. The host-side `~/.claude` → volume
  sync then seeds the account's volume, and each account needs its own seed of
  `_claude.json`.
- **Cloud** (Phase 3/4): the cloud layout has the same symlink pivot, so after a
  refresh the in-box credential is a regular file and the mounted creds path
  (Daytona's volume subpath) is stale. Check that ctl's `CredentialsWatcher`
  watches the agent's real path (`credential.boxAbsPath`) and not the mount
  (code check, not done here).
- **Fan-out** (Phase 4): add the revocation fact. Fan-out latency is an outage
  window for every other holder of the login. Steer users to `setup-token` for
  accounts shared by several cloud boxes, and consider one refresher per
  account (the hub refreshes, boxes only consume) as a backlog item.
- **Split proxy** (Phase 7): it holds the relay token itself, so the agent's env
  carries only `HTTPS_PROXY=http://127.0.0.1:<port>` and no secret reaches tool
  subprocesses. It must **always be listening** and answer `502`/`407` with a
  reason when the hub is unreachable. A refused connection makes claude retry
  silently for minutes, which is not the clear failure the fail-closed rule
  requires.
- **Reverse** (Phase 8): claude `ANTHROPIC_BASE_URL` only; codex needs the
  custom-provider route verified first, since `OPENAI_BASE_URL` is ignored under
  ChatGPT auth.

### Still blocked on the owner

1. **Re-login codex** (the carried login is dead): on the host,
   `agentbox codex login`, then recreate or refresh the PoC box so the new
   `auth.json` is carried in.
2. **Account B for claude**, without touching account A. In this box (Linux, so
   the credential is a file rather than the macOS Keychain), type in the session:
   `! CLAUDE_CONFIG_DIR=/home/vscode/poc-account-b/claude claude auth login`.
   The credential lands at `/home/vscode/poc-account-b/claude/.credentials.json`,
   in the container layer, outside the shared `agentbox-claude-config` volume.
3. **Account B for codex**:
   `! CODEX_HOME=/home/vscode/poc-account-b/codex codex login --device-auth` →
   `/home/vscode/poc-account-b/codex/auth.json`.

With those in place, the remaining Phase 0 runs are: two containers on two
per-account config volumes sharing `projects/` (both turns work, each
`claude auth status` shows its own account, usage shows on B's account page), the
codex symlink-on-refresh check, and the throwaway-account revocation timing test
above. Delete `/home/vscode/poc-account-b` afterwards.

## Backlog (not in these phases)

- Switching a running box to another account (reseed + agent restart).
- OAuth login driven from the hub (web / tray / remote control box), extending
  the existing `jobs/:id/login-code` precedent.
- Per-account usage, once [`agent-history-plan.md`](./agent-history-plan.md)
  lands token usage.
- Dropping the legacy `~/.agentbox/<agent>-credentials.json` path for `default`.
