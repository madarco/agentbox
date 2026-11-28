# LLM accounts and the hub egress proxy — plan

> **2026-11-26:** `agentbox accounts` and `<agent> login --account/--setup-token/--api-key` are now `agentbox credentials` (`list`, `add`, `renew`, `use`, `rm`, `label`, `switch`); see [`credentials-tui-plan.md`](./credentials-tui-plan.md). Command names below are as they were when this was written.

Status: **Phase 0 partly done, Phases 1-5 and 7 done (2026-11-22), Phase 9 (hub-owned subscriptions) 2026-11-28** — see
[Phase 0 results](#phase-0-results) and [Phase 1 as built](#phase-1-as-built).
Single-account facts are measured for claude and codex; the two-account half of
(a)/(b) is blocked on account B. One phase per session. Open items:
[`llm-accounts-backlog.md`](./llm-accounts-backlog.md).

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

`default` is today's slot, folded in on every read (no write until the first
mutation) — no existing box, backup or custody object changes meaning. `default`
is always a `login`; a pasted kind needs a named account.

### Storage

- Index: `~/.agentbox/accounts.json` (metadata only, no secrets).
- Secrets: `~/.agentbox/credentials/<agent>/<account>.json`, 0600. `default`
  keeps reading/writing the legacy `~/.agentbox/<agent>-credentials.json` path
  until a later cleanup (AgentBox is unreleased — no alias layer beyond that).
- Custody: `agents/<agent>/accounts/<account>/<file>`; `default` stays at
  `agents/<agent>/<file>`. (The fixed `accounts/` segment, not the bare id:
  a plugin credential file need not contain a `.`, and `agents/foo/token` must
  not double as account `token`'s directory. `agent add` refuses a credential
  file named `accounts`.)
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
  per-org volume gets a SIBLING subpath per account (`claude-acct-<account>/`),
  never `claude/<account>/`: a default box mounts the whole `claude/` subtree and
  would read every named account's secret.
- Account ids: 1-32 lowercase letters, digits, inner dashes — always one path
  segment, never a traversal.
- Docker volume name for a named account: `<volume>-acct-<account>`, not
  `<volume>-<account>` — `box.isolate<Agent>Config` already mints
  `<volume>-<boxId>` and a box id is a valid slug.

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
| 9 | **Hub-owned subscriptions on a remote hub**: a PC's logins and keys are imported into the remote hub's own account store; every PC, the web UI and the tray see and create on the same list. See [Phase 9](#phase-9-hub-owned-subscriptions-on-a-remote-hub). | 5 |

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

### (a′) Login + API-key mix on one volume (measured)

The owner provided an Anthropic key as a stand-in "account B". Its prefix is
`sk-ant-usr`, 106 characters: not a Console key (`sk-ant-api03`) and not an
OAuth token (`sk-ant-oat01`). The API accepts it both as `x-api-key` and as a
Bearer (`GET /v1/models` → 200 both ways), so Claude Code treats it as an API
key. Which product issues `sk-ant-usr` keys, and which account it bills, is for
the owner to confirm. Calls were made 2026-11-22 between **10:26Z and 10:30Z**
(about 14 one-word `haiku` turns; none used the key before 10:27Z).

Setup: one shared config dir holding a copy of the subscription login
(`.credentials.json`, today's docker layout). Container A had no key; container
B had the same dir plus `ANTHROPIC_API_KEY` from a 0600 `--env-file`.

- **Both turns work at the same time.** A and B ran concurrently and both
  succeeded.
- **With both available, the key wins in `-p` mode.** B's `claude auth status`
  shows `authMethod: api_key`, `apiKeySource: ANTHROPIC_API_KEY`, and no
  org/email fields. B prints a warning on every turn: "claude.ai connectors are
  disabled because ANTHROPIC_API_KEY … takes precedence over your claude.ai
  login". A reports `authMethod: claude.ai` with the subscription's org and
  email, unaffected.
- **The interactive TUI prompts, and its default is to ignore the key.** It
  shows "Detected a custom API key in your environment … Do you want to use this
  API key?" with **No (recommended)** preselected, after the folder-trust
  dialog. Answering No wrote `customApiKeyResponses.rejected` into the **shared**
  `_claude.json`. From then on, an interactive session in a container that has
  the key no longer asks, and **silently runs on the volume's OAuth
  subscription** (`/status`: "Login method: Claude … account", the
  subscription's org and email). `-p` ignores the rejection and keeps using the
  key. So the plan's trap "host-env spray beats a subscription" holds only for
  `-p`. In the TUI, which is how boxes run claude, it can go either way, and one
  box's answer decides it for every box on the volume.
  Answering Yes records the key in `customApiKeyResponses.approved`, its last 20
  characters only (code, not measured: the test answered No). `apiKeyHelper` is
  not needed.
- **The key container does not touch `.credentials.json`** (hash unchanged
  across every B run), and it **does not overwrite `oauthAccount`** (unchanged
  after a B-only turn). What it does add to the shared `_claude.json`:
  `metricsStatusCacheByPrincipal` keyed `key:<hash>`, plus, on first run, the
  unkeyed feature-flag and model-option caches, which it shares with the OAuth
  boxes.

What this does **not** stand in for: two OAuth subscriptions colliding on one
volume (the refresh replacing the symlink, two `oauthAccount`s fighting), and
the revocation timing test. Both still need a second OAuth login, on a
throwaway account for the revocation test.

Consequence for `api-key` accounts in docker: give them their own config volume
(no `.credentials.json` in it), as the per-account volume recommendation already
implies, and pre-seed that volume's `_claude.json` with
`customApiKeyResponses.approved` holding the key's last 20 characters, so the
TUI never prompts and never falls back. Do not put an API key into a box whose
volume holds an OAuth login.

### (b) Codex `auth.json`

The first run found the carried codex login dead (access token expired
2026-10-24, refresh refused with `401`). The owner logged in again
(`last_refresh` 2026-11-22T10:20Z); the results below come from that login.

- **Live turns work (measured).** Five one-prompt `codex exec` turns ran on the
  ChatGPT login, through the `~/.codex/auth.json` →
  `~/.agentbox-creds/codex/auth.json` symlink that docker boxes already use.
- **A normal turn never writes `auth.json` (measured).** Across all five turns
  the file kept its inode, mtime and hash, and the symlink stayed. Codex writes
  the file only on a refresh: proactively once `last_refresh` is older than about
  8 days (observed in the first run, with a 39-day-old `last_refresh`), or after
  a `401`.
- **Whether codex's refresh write keeps the symlink: not measured.** Measuring
  it needs a refresh, and refreshing the real login would revoke the other
  holders' copies, as happened with claude. The test, for a throwaway account B
  only: put B's `auth.json` behind the same symlink, set `last_refresh` in that
  one copy to 9 days ago, run one turn, then check whether `~/.codex/auth.json`
  is still a symlink, and which of the two paths holds the new tokens (compare
  hashes).
- Codex has no `oauthAccount` equivalent in a shared file: `auth.json` carries
  `account_id` itself, and every backend request sends it as
  `chatgpt-account-id` (measured at the forwarder in (d)). A shared codex config
  volume therefore cannot mislabel an account. The only open risk is the
  symlink on refresh.
- The revocation risk is assumed to apply to codex copies too (not measured).
- Billing on account B is **blocked** (needs account B).

### (c) CONNECT proxy

Both agents honour `HTTPS_PROXY=http://user:token@host:port` and send
`Proxy-Authorization` **preemptively** on every CONNECT (measured):

- **claude:** turns work. The forced OAuth refresh went through the proxy
  (`platform.claude.com`). A wrong token gives a clear
  `API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL)`, exit 1, in
  under 45 s. **A proxy that refuses the connection gives no error at all**:
  claude kept retrying silently for over 100 s.
- **codex:** a live turn on the ChatGPT login works through the proxy, including
  the responses WebSocket on `chatgpt.com`. The token refresh also goes through
  it (`POST auth.openai.com/oauth/token`, seen with the dead login).

**Tool subprocesses inherit `HTTPS_PROXY` (measured).** Claude's Bash tool saw
it, and so did codex's shell tool (`env` printed `HTTPS_PROXY`). Codex's own
`git ls-remote` of a plugin marketplace went to the proxy for
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
| codex | `*.oaiusercontent.com` (`sdmntpr<region>…`) | seen once, on a turn that failed with an unsupported model; content storage, probably not needed |

**claude on an API key** (measured, container through the proxy): only
`api.anthropic.com` (11) and the datadog telemetry. No `mcp-proxy.anthropic.com`
(connectors are off with a key) and no `platform.claude.com` (nothing to
refresh). The OAuth login on the same volume, same prompt: `api.anthropic.com`
(9), `mcp-proxy.anthropic.com` (7), telemetry.

Not seen in this run (no interactive login, no codex API-key mode): `claude.ai` and
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
- **claude, API key via `ANTHROPIC_BASE_URL` (measured).** Not "everything
  follows" by default: only `POST /v1/messages` reached the forwarder (with
  `x-api-key`), and 7 `api.anthropic.com` calls plus telemetry still went direct.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` closes most of the gap
  (measured).** On the key, **every** call went to the base URL, with zero
  direct connections. On the OAuth login, inference went to the base URL and
  only 1 `api.anthropic.com` call plus the `mcp-proxy.anthropic.com` connector
  calls went direct, plus refreshes when they happen. The flag also turns off
  telemetry, the auto-updater and similar background calls. Whether it costs
  anything that matters in a box (feature flags) is untested.
- **codex, ChatGPT login (measured, live).** Ran against a forwarder to
  `chatgpt.com`, with the CONNECT proxy logging whatever went direct:
  - `OPENAI_BASE_URL` is **ignored** under ChatGPT auth (dead-login run: all
    traffic stayed on `chatgpt.com`).
  - `chatgpt_base_url` over plain `http://` is **refused for inference**: the
    side calls followed it, but the turn failed with
    `workspace backend must use an HTTPS origin without credentials`.
  - `chatgpt_base_url="https://<hub>/backend-api/"` (TLS, with the test CA passed
    through `CODEX_CA_CERTIFICATE`): **the turn works and inference follows it**.
    The `/backend-api/codex/responses` WebSocket upgraded (101) at the forwarder,
    with `Authorization: Bearer` and `chatgpt-account-id`. The side calls
    followed too (`/wham/*`, `/ps/plugins/*`, `/ps/mcp`,
    `/codex/analytics-events/*`). Still direct: one `chatgpt.com` connection,
    `ab.chatgpt.com` and `github.com`; refreshes to `auth.openai.com` would be
    direct too.
  - A **custom provider**:
    `model_provider="hub"`, `model_providers.hub.base_url="<hub>/backend-api/codex"`,
    `wire_api="responses"`, `requires_openai_auth=true`. **The turn works on the
    ChatGPT login, over `https` and over plain `http`.** Only inference moves:
    `GET /codex/models` and `POST /codex/responses` (HTTP streaming, not
    WebSocket) arrive with the ChatGPT Bearer and `chatgpt-account-id`. Every
    side call (8 `chatgpt.com` connections) and `ab.chatgpt.com` stayed direct.

So reverse moves **inference** (codex's `chatgpt_base_url` also moves the
backend side calls), but the identity, flag and refresh traffic still leaves from
the box's IP for both agents, which defeats "every call from one address". The
exception is claude on an API key with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, where reverse carries everything. For
codex, the custom provider is the cleaner reverse knob: it accepts plain `http`
and leaves `chatgpt_base_url` alone. `chatgpt_base_url` needs a TLS origin the
box trusts, so a tunnel URL with a public certificate.

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
- **Env spray / `api-key` accounts** (Phase 3): an `api-key` account gets its
  own config volume with no OAuth credential and a pre-approved
  `customApiKeyResponses` entry (see (a′)). Suppressing the host's
  `ANTHROPIC_API_KEY` on `login` boxes stays necessary, and so does keeping a
  key out of an OAuth volume entirely: the TUI's stored answer is shared by
  every box on the volume.
- **Reverse** (Phase 8): set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` with
  `ANTHROPIC_BASE_URL`, which makes reverse complete for claude API keys and
  nearly complete for claude logins. Codex: a generated
  `model_providers.agentbox` (`base_url` = hub, `wire_api = "responses"`,
  `requires_openai_auth = true`) selected with `model_provider`, written into the
  box's codex config at launch. Not `OPENAI_BASE_URL`, which is ignored under
  ChatGPT auth. Not `chatgpt_base_url`, which needs a trusted HTTPS origin. The
  hub forwards `/backend-api/codex/*` to `chatgpt.com` without changing the
  `Authorization` or `chatgpt-account-id` headers.
- **Codex docker storage:** keep codex's credential pivot as it is (normal turns
  never write `auth.json`) until the throwaway-account symlink-on-refresh test
  runs. If codex replaces the symlink, as claude does, codex gets the same
  per-account config volume as claude.

### Still blocked on the owner

1. ~~Re-login codex~~: done 2026-11-22T10:20Z; the codex results above use it.
2. **A second claude OAuth login** (a throwaway account; the API key in (a′)
   covered the login + key mix only), without touching account A. In this box (Linux, so
   the credential is a file rather than the macOS Keychain), type in the session:
   `! CLAUDE_CONFIG_DIR=/home/vscode/poc-account-b/claude claude auth login`.
   The credential lands at `/home/vscode/poc-account-b/claude/.credentials.json`,
   in the container layer, outside the shared `agentbox-claude-config` volume.
3. **Account B for codex** (also unblocks the symlink-on-refresh test in (b)):
   `! CODEX_HOME=/home/vscode/poc-account-b/codex codex login --device-auth` →
   `/home/vscode/poc-account-b/codex/auth.json`.

With those in place, the remaining Phase 0 runs are: two containers on two
per-account config volumes sharing `projects/` (both turns work, each
`claude auth status` shows its own account, usage shows on B's account page), the
codex symlink-on-refresh check, and the throwaway-account revocation timing test
above. Delete `/home/vscode/poc-account-b` afterwards. Also for the owner:
confirm on the key's account that usage appeared for 10:27–10:30Z on
2026-11-22, and only for the B turns.

## Phase 1 as built

- **`@agentbox/core`** (`packages/core/src/sync/llm-accounts.ts`): `LlmAccount`,
  `LlmAccountKind`, `AccountsFile`, `DEFAULT_ACCOUNT_ID`, `accountIdProblem`,
  `accountKindProblem`, and the one derivation of each per-account name:
  `accountSecretPath`, `accountCustodyPath`, `accountConfigVolume`,
  `accountCloudSubpath`. `migrateAccountsFile` is the pure normalize + `default`
  fold (drops malformed rows, keeps the first of a duplicate, an existing
  `default` row wins over the legacy slot).
- **`AgentSyncSpec.accountKinds`**: claude `login, setup-token, api-key`; codex
  `login, api-key`; every other built-in absent (only `default`). Plugin specs
  are validated at `agent add` (`accountKindsProblem`: known kinds, no
  duplicates, `login` needs a `credential`).
- **`@agentbox/sandbox-core`** (`packages/sandbox-core/src/llm-accounts.ts`):
  - `readAccounts` never writes. A legacy backup counts as `default` only when
    it passes the spec's `realShape`; `default` is listed iff that holds, and a
    stored `default` row only adds its label. Rows the write rules refuse, and
    an untrustworthy file, are left out of the view, so the defaults still show.
  - Mutations (`upsertAccount`, `removeAccount`) never write the view back.
    They edit the file's raw rows under the lock, replace or delete only their
    own `(agent, id)` (alias spellings included), and pass every other row
    through verbatim — a long-lived hub that has not loaded a plugin agent, or
    an older CLI that does not know a kind, cannot delete them. The first
    mutation adds the legacy `default`s to the file. A corrupt, wrong-shape or
    future-version file makes mutations throw `AccountsFileError` instead of
    rewriting it.
  - Specs default to the live registry (`allAgentSpecs()`), not a module-load
    snapshot.
  - `writeAccountSecret` writes NAMED accounts only (the `default` file keeps
    its existing guarded writer, `writeCredentialBackup`), needs the row first,
    and runs under the accounts lock. A `login` secret must pass `realShape`
    and the freshness rule (`written: false` for an older blob); a pasted secret
    must be the `{kind, token}` encoding of the row's kind. Files are 0600, and
    `credentials/` and `credentials/<agent>/` are tightened to 0700 even when
    they already exist.
  - `agent add` refuses a path-unsafe plugin id, a `credential.boxRelPath` that
    is absolute, traverses, or starts with `accounts/`, and a `dockerVolume` /
    `cloudSubpath` containing `-acct-`.
  - Nothing calls the store yet; Phase 2 does.
- **Where it differs from the plan above:** reads do not write (the plan said
  "migrated in place on first read"), the `-acct-` docker volume infix, the
  sibling Daytona subpath, the `accounts/` custody segment, and `default`
  pinned to `login`.

## Phase 2 as built (logins)

Scope, decided against the Phase 0 results and the Phase 1 backlog:

1. **`<agent> login --account <name> [--label <text>]`** for a `login`-kind
   account (only on agents whose row declares `accountKinds`). Docker storage is
   Phase 0's: a **per-account config volume** `accountConfigVolume(<shared>, id)`.
   The login container signs in against it; then the volume's credential file
   (`credential.boxRelPath`) is captured into `credentials/<agent>/<id>.json`
   through `writeAccountSecret` (real-shape + newest-wins gated) and the row is
   upserted. A named login **never** touches the shared volume, the legacy
   backup or custody — claude's default finalize (`syncClaudeCredentials`,
   volume→legacy backup) must not run for it, or account B's blob would land in
   `default`.
2. **Seeding a named account volume from the host** keeps the host's config
   (settings, skills, plugins) but never the host's identity: the host's
   credential file is excluded (it is the owner's real login; a copy is one more
   holder for a refresh to revoke) and claude's `_claude.json` seed drops
   `oauthAccount` and the account-derived caches Phase 0 listed, so the first
   turn fetches the right profile.
3. **`--api-key` / `--setup-token`** (pasted kinds): the secret is read from a
   hidden prompt on a TTY, otherwise from stdin — never from argv. Requires
   `--account` (`default` stays a login). Stored with `upsertAccount` +
   `writeAccountSecret`. No docker volume yet: an API-key volume must be seeded
   with `customApiKeyResponses.approved` at box create, which is Phase 3.
4. **Identity read-off** (display only): claude from the credential's
   `claudeAiOauth.subscriptionType` and the volume's `_claude.json`
   `oauthAccount` after the warm-up turn; codex from the `id_token` claims in
   `auth.json`. Pure parsers on each agent's runtime.
5. **`agentbox accounts`** (`list`, `rm`, `label`): reads the host store; `rm`
   drops the row, the secret and the account's docker volume (best effort).
   `default` and `rename` are deferred: `default` writes `<agent>.account`,
   which Phase 3 introduces, and an id cannot be renamed while volume and
   custody names derive from it.
6. **Local by design for now.** A login drives an interactive container on the
   PC that owns the docker volume, so it stays a CLI command; the store is the
   PC's `~/.agentbox`. Moving `accounts` behind `/api/v1/accounts` is Phase 5.

Implementation notes:

- The capture is `captureVolumeLogin` (`packages/sandbox-docker/src/sync/account-login.ts`):
  it refuses to turn a pasted-kind account into a login, and an existing
  account's identity only moves when the store accepts the new secret.
- The CLI refuses a named `login` for a runtime that does not declare
  `supportsAccountLogin` (claude and codex do): one that ignored the volume
  hints would capture the owner's login under the new name.
- A claude re-login resets the account state already in the volume's
  `_claude.json` (`resetVolumeAccountState`), because the seed is write-once.
- `stripAccountState` also drops `primaryApiKey` (a Console key Claude Code
  stored for the host login).
- The headless `--code` call reports an error when the store refuses the new
  login, so an orchestrating agent is not told it was saved.

## Phase 3 as built (selection + seeding)

1. **Selection.** `<agent>.account` (generated for every agent with
   `accountKinds`) resolves `--account` > project config > global config >
   `default`. The repo's `agentbox.yaml` `defaults:` layer is **ignored** for
   this key (a repo must not pick which subscription it bills); a value there
   is warned about. `agentbox <agent> --account <name>`, `agentbox create
   --account <agent>=<name>` (repeatable), hub create `opts.accounts`. The
   resolved choice is validated against the store (a named account must exist)
   and recorded as `BoxRecord.accounts` (named accounts only; absent = all
   `default`). Every later seam reads the record, never current config.
   `--account` exists only on the create flows (`start`/`attach` take an
   existing box, which keeps its account; switching is backlog). The parent
   `agentbox <agent>` and its `login` subcommand both declare `--account`, and
   commander hands a shared flag to the parent, so `login` reads it through
   `optsWithGlobals` (positional options were not an option: `start`/`attach`
   read parent-only flags after the subcommand).
2. **Env per kind is registry data**: `AgentSyncSpec.accountEnv` (`api-key` →
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `setup-token` →
   `CLAUDE_CODE_OAUTH_TOKEN`). A box on a named account gets exactly that
   account's auth: every `accountEnv` key is suppressed from the host-env spray
   for that agent, and a pasted kind injects its own key.
3. **Docker.** A named account mounts `accountConfigVolume(...)` instead of the
   shared volume (it wins over `isolate`), re-seeded from the host with
   `account` set, so the host's login, account state and now **`settings.json`
   auth env** (`env.ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`) stay out. The credential sync runs
   against the account's secret, never the legacy backup. An `api-key` volume
   is pre-seeded with `customApiKeyResponses.approved` (Phase 0 (a′)). The
   exec seam re-applies the policy from the box record. `prune --all` keeps
   every `-acct-` volume.
4. **Cloud.** A named account mounts its sibling subpath
   (`accountCloudSubpath`) and stages the account's secret instead of the
   legacy backup; a pasted kind stages no file. The env policy applies to the
   provision env.
5. **Fan-out guard until Phase 4.** A named box's credential must never reach
   the legacy backup or other boxes, and the default login must never be pushed
   into a named box: the relay drops a credential update from a box whose
   record names an account for that agent, propagate skips such boxes, and the
   cloud resume reconcile / checkpoint extract skip those agents.
6. **Model-auth lender account.** A borrowed login uses the lender's resolved
   account (`codex.account`), from the account store; it must be a `login`.
7. **Every claude credential mirror is account-aware**
   (`syncBoxClaudeCredentials`): the `start` hook and the dashboard's start
   used the isolate branch for any non-shared volume, which would have seeded
   the default login into a named volume whenever the default's token was
   newer; `start`'s host re-sync passes `account` too.

## Phase 4 as built (fan-out per account)

Replace the Phase 3 guards ("drop / skip anything on a named account") with
real routing, keyed by `(agent, account)`. ctl is unchanged — it posts
`{agent, content}` as before; the RELAY decides the account from the source
box, so old images route correctly.

1. **Relay ingest** (`CredentialsFanout.handle`): account = the box's
   registration (then `state.json`). `default` → the legacy backup + custody
   `agents/<agent>/<file>`, as today. A named account → its own secret
   (`accountSecretPath`) + custody `agents/<agent>/accounts/<id>/<file>`, same
   newest-wins gate. An unverifiable source (registry unreadable) is still
   dropped — it cannot be routed. Debounce and propagate are keyed per
   `(agent, account)`; the spawned `credentials propagate` gets `--account`.
2. **Propagate** (`credentials propagate --account`): reads that account's
   secret and targets only boxes whose record names the same account for that
   agent (`default` ↔ no record), running it or borrowing it. The account filter
   applies only when the caller names an account, so SETTINGS propagate (same
   planner) reaches named boxes again (#437 review, finding 8). Docker boxes on
   one account share its volume, so the source's volume is the only docker
   target and is excluded; cloud and borrowing boxes are pushed.
3. **Cloud resume reconcile** runs per account: a named agent reconciles
   against its account's secret instead of being skipped. (The checkpoint
   `--set-default` extract stays refused for named boxes.)
4. **Custody, both directions**: `hub credentials push` also uploads every named
   account's secret under its account path, and the relay mirrors accepted
   named updates there; `seedHostBackupsFromCustody` materializes them per
   account, newest-wins. Rows (`accounts.json`) do not travel yet — a remote
   hub still refuses a named create until Phase 5 gives it the account list.
5. **Settings propagate** (`agentbox download <agent>`'s push to other boxes)
   stays within the source box's account: a pulled item set can carry the
   agent's login (codex's `auth.json`), which must never cross accounts.

## Phase 5 as built (surfaces)

**Where accounts live.** An account is a fact about ONE machine: its logins
are interactive and land in that machine's store (`~/.agentbox/accounts.json`
+ `credentials/`). The hub that serves `/api/v1/accounts` is therefore the
hub of the machine that owns the store — the laptop hub, or an exposed one.
A remote control box lists its own store (empty unless someone signed in on
it) and still refuses a named create (it cannot use a PC's account; see the
custody design below).

1. **`/api/v1/accounts`** (backend slice `apps/hub/lib/backend/accounts.ts`):
   `GET` → `{ accounts: [{agent, id, label?, kind, identity?, hasSecret,
   boxes: string[]}], agents: [{id, name, kinds}] }` (no secrets, ever);
   `POST` `{agent, id, kind: 'api-key'|'setup-token', token, label?}` for the
   pasteable kinds (a `login` is interactive: `agentbox <agent> login
   --account`); `PATCH /accounts/{agent}/{id}` `{label}`; `DELETE
   /accounts/{agent}/{id}` (409 while a box records it; removes the secret and
   the docker volume).
2. **`Box.accountsInfo`**: `[{agent, account, label?, kind?}]` next to the raw
   `Box.accounts` map (#437), resolved from the hub machine's store. Both
   optional, so a shipped tray keeps decoding.
3. **CLI through the hub**: `agentbox accounts` list / label / rm call the
   LOCAL hub's `/api/v1/accounts` (the machine's own store, even when a remote
   control box is configured); `agentbox list` shows the account in the AGENT
   cell (`claude:working@work`); `agentbox status` gets an ACCOUNTS section.
   Logins stay CLI-local (interactive container on this machine).
4. **Web** (pure REST client, client-side fetch): Settings → Model accounts
   (list, add a key / setup token, relabel, remove); an account picker per
   agent in the create modal (sends `opts.accounts`); the account in the box
   table and detail page. The page is its own sidebar entry (**Accounts**,
   next to Devices) rather than a Settings section: Settings is one page.
5. **Custody design (the #442 must-design item).**
   - Named-account custody objects are keyed by the ORIGIN MACHINE:
     `agents/<agent>/accounts/<machineId>/<id>/<file>`. Two PCs' `claude/work`
     never collide. The relay mirrors a box's named refresh under the box's
     registration `originMachineId` (else the hub's own machine).
   - Pasted secrets (API keys, setup tokens) are NOT pushed: nothing on a hub
     reads them, and they never refresh. Only named logins travel.
   - A hub seeds named accounts from custody only for its OWN machine id —
     its store is per machine.
   - ~~Next step: a per-machine account list on the control box (rows travel
     next to the secret, a create resolves accounts against the REQUESTER's
     machine).~~ **Superseded by [Phase 9](#phase-9-hub-owned-subscriptions-on-a-remote-hub)**
     (owner's decision, 2026-11-28): that design keeps a subscription usable
     only from the PC that signed it in. On a remote hub a subscription now
     belongs to the HUB, and every PC uses the same list.

## Phase 7 as built (hub egress proxy, `forward`)

Phase 0 (c) measured the CONNECT path for both agents (refreshes included), so
`forward` shipped first; `reverse` stays Phase 8.

1. **Registry data.** `AgentSyncSpec.llmHosts` (validated for plugin agents by
   `llmHostsProblem`: exact lowercase hostnames, since the hub allowlist is
   built from them). claude: `api.anthropic.com`, `platform.claude.com`,
   `mcp-proxy.anthropic.com`, `claude.ai`. codex: `chatgpt.com`,
   `ab.chatgpt.com`, `auth.openai.com`, `api.openai.com`. Telemetry and
   `github.com` go direct. Agents without the field are never proxied.
2. **Config.** `llm.proxy: off | forward` (default `off`), `llm.proxyPort`
   (default 8790), `llm.proxyUrl`. `--llm-proxy off|forward` on `create` and
   the agent commands; `opts.llmProxy` on `POST /api/v1/boxes`. One resolver,
   `resolveLlmProxyRecord` (sandbox-core): docker →
   `host.docker.internal:<proxyPort>`; every other provider (remote-docker
   included) needs `llm.proxyUrl` and is refused without it. **A hub-bound
   create sends the mode and the hub resolves the upstream from its own
   config** (the upstream is the hub's address); a create run on this machine
   resolves it locally. Recorded as `BoxRecord.llmProxy = { mode, upstream }`
   and carried on the queue job (`QueueJobCreateOpts.llmProxy`) and the
   control-box job (`CreateJobRequestOpts.llmProxy`, not a portable key).
3. **Relay listener** (`packages/relay/src/llm-proxy.ts`), started by the hub
   server and `agentbox-relay serve` on `llm.proxyPort` (a taken port is
   logged, never fatal). **Auth is a proxy-only credential**
   (`Proxy-Authorization: Basic <boxId>:<HMAC-SHA256(relayToken,
   "agentbox-llm-proxy")>`, `llmProxyCredential`), which the hub recomputes from
   the registration's token (`store.getBox`) and compares in constant time. The
   hub leg to `llm.proxyUrl` is unencrypted TCP, and the relay token is the
   box's whole hub identity (git push over `/rpc`, host tools, `cp`, events,
   credential posts), so it never travels there (#446 review B2). The box reads
   its token from `relay.env` (or the container env) and its id from
   `AGENTBOX_BOX_ID` / `/etc/agentbox/box.env`. Destination must be an
   `llmHosts` entry on 443. 407 / 403 / 502 carry the reason in the body. Never
   decrypts.
4. **Split proxy** (`LLM_SPLIT_PROXY_SCRIPT`, sandbox-core). A CommonJS script
   shipped base64 on the launch command (about 7 KB of preamble, under tmux's
   16 KB message cap), so any image on any provider gets it with no bake.
   `--ensure` is idempotent (probes its own `/__agentbox` marker, which carries
   its upstream and host list, and a version). It reads the token per
   connection (`relay.env`, then env), so a re-registered box keeps working. A failed start stops
   the launch with the reason instead of running the agent unproxied.
5. **Launch seams.** `llmProxyLaunchPreamble` (no single quote, so it is safe
   in a `sh -c` string and inside the cloud launcher's `bash -lc '…'`).
   Docker: `withSessionLlmProxy` in `startClaudeSession` / `startCodexSession`.
   Cloud: `boxLlmProxyPreamble` passed to `buildCloudAttachInnerCommand` by the
   attach, the detached start and the dashboard. A box without `llmProxy` gets
   a byte-identical command.
6. **Vercel.** `withLlmProxyHost` appends the proxy host to an allowlist
   `networkPolicy`; unset / `allow-all` / `deny-all` are left alone.
7. **Payload.** `Box.llmProxy` (`{ mode, upstream }`) on `/api/v1/boxes`. It
   rides the relay registration too (`BoxRegistration.llmProxy`, kept across a
   re-register that omits it), so `hub adopt`, an adopted foreground create,
   the dashboard and a PC relaunch start the agent behind the proxy; a
   foreground create that asked for `forward` refuses to attach a box that came
   back without it (#446 review B1).
   **Review changes.** The listener runs only once this machine opted in
   (`llmProxyListenerEnabled`: global `llm.proxy: forward` or `llm.proxyUrl`),
   and a `forward` create is refused without it. `llm.proxyPort` / `llm.proxyUrl`
   are read from the GLOBAL config (the mode follows the project). The split
   proxy carries every agent's hosts, so a second agent in the box reuses it,
   and `--ensure` replaces a stale instance of itself. It reads the token from
   `relay.env` first, answers 502 when the hub closes without replying, and the
   preamble keeps an existing `NO_PROXY`.
8. **Verified live** against an isolated hub (relay 18799, proxy 18790) with a
   registered fake box and the real split-proxy script: Anthropic answered 401
   (no key) and chatgpt.com 200 through the hub; example.com went direct; the
   hub refused a non-LLM host (403), port 80 (403), a wrong token and no
   credential (407); the split proxy passed the hub's 407 through; with the hub
   stopped, a model host got `502 … hub proxy 127.0.0.1:18790 unreachable`
   while other hosts still worked. An egress-IP check from a real cloud box
   needs a public `llm.proxyUrl` and is left to the coordinator (PR body).

## Phase 9: hub-owned subscriptions on a remote hub

Observed 2026-11-28: a Mac with `claude/default` and `claude/second` ran
`agentbox hub setup`. The remote hub listed only the `default` logins; its
custody held `agents/claude/accounts/<mac>/second/.credentials.json`, but
nothing read it (the hub lists and resolves accounts from its own store, and
rows never travelled). Worse, with `claude.account: second` in the Mac's
global config, a hub-routed `agentbox claude --provider hetzner` built a box
recorded as `claude/second` with **no login in it**: the CLI resolved the
account against the Mac's store and sent the name, and the worker passed it
to `provider.create` unchecked, whose stager found no secret on the hub.

**Decision (owner).** On a remote hub a subscription belongs to the **hub**,
not to the PC that signed it in. Every enrolled PC, the web UI and the tray
see one list and can create boxes on any entry. The hub's copy is the live
token: hub boxes refresh it and the relay fans the renewal out. A local hub
(no `relay.controlPlaneUrl`) is unchanged: it is the PC's own store.

### Import

The PC never writes a hub account through custody. It calls
**`POST /api/v1/accounts/import`** with one item per login or key:
`{agent, id, kind, identity?, secret, machine, machineLabel?, force?}`
(`id` is the PC's own name; `machine` its machine id). The hub decides and
answers per item `{agent, id, hubId?, action, reason}`, `action` one of
`created | merged | updated | kept | renamed | refused | removed`.

- **Callers**: every point that pushed logins before. `hub setup` /
  `hub update` finalize and the change-detected re-push (`syncAgentCredentials`,
  run after a login and before a hub-routed create), `hub credentials push`,
  and the PC-side fan-out's custody mirror (`credentials propagate`). An old
  hub answers 404, and the PC falls back to the old custody push.
- **Store**: the hub writes the row into its OWN `accounts.json` and the
  secret through `writeAccountSecret`, so list, resolve, seed, switch, the
  relay fan-out and `Box.accountsInfo` work unchanged. It also mirrors a
  login to custody at `agents/<a>/accounts/<hubMachine>/<hubId>/<file>` (the
  path `seedAccountSecretsFromCustody` already reads, and the one a PC pulls
  from). Which PC account each hub account came from is kept in a hub-side
  file, `~/.agentbox/account-imports.json`
  (`{imports: [{agent, machine, localId, hubId, machineLabel?, at}], removed: [...]}`),
  never on the `LlmAccount` row: the core model stays as it is.
- **`default`** is imported too, into the hub's `default` (legacy backup +
  `agents/<a>/<file>` custody), newest-wins. That replaces the hash-only
  custody PUT for the default login.
- **Identity dedupe.** Two PCs signed in to the same subscription become one
  hub account: an incoming login merges into a hub login of the same agent
  whose identity has the same email (case-insensitive) and no conflicting
  org. The secret is then gated newest-wins (`writeAccountSecret`), so
  merging never puts an older token over a live one. A pasted kind (no
  identity) merges only into a hub account of the same kind holding the
  SAME token. Nothing merges into `default` from a named account, or the
  other way round (the default slot is its own path).
- **Mapping first.** An item whose `(agent, machine, localId)` is already
  mapped goes to that hub account (a re-push after a refresh), unless both
  identities are known and differ (the PC re-signed that name into another
  subscription): then it is treated as new.
- **Id collisions.** The same id from another PC with a different (or
  unknown) identity never overwrites: it is imported under a suffixed id
  (`second_2`, `second_3`, …; the base is cut to fit 32 characters) and the
  mapping records it. Picked over refusing because the mapping already makes
  the PC's own name work for that PC (Selection below), so nothing has to be
  renamed, and a refusal would leave a stored subscription unusable until
  someone ran a rename that the account model does not have (ids name docker
  volumes and custody paths).
- **Pasted keys and setup tokens now travel.** Phase 5 kept them home because
  nothing on a hub read them. A hub-owned account is read by every create on
  that hub, and both kinds are static: a setup token never refreshes, so any
  number of holders is safe (it is the kind Phase 0 recommends for many
  boxes), and an API key has no refresh at all. They go only through the
  import route, into the hub's store, and are not mirrored to custody (no box
  posts them back, so nothing would ever read the copy).
- **Removed on the hub** (`DELETE /api/v1/accounts/:agent/:id` there): the
  mappings of that account become tombstones in `removed`, so the next
  automatic push from that PC answers `removed` instead of bringing it back.
  `agentbox hub credentials push --force` clears them.
- **Old custody objects**: every import deletes the Phase 5 per-PC copy of
  the item (`agents/<a>/accounts/<machine>/<localId>/…`, unless it is the
  hub's own canonical path) and any Phase 4 flat object
  (`agents/<a>/accounts/<id>/<file>`, five segments). Both are dead: nothing
  reads them.

### Who refreshes

The same rule as today's `default` on a remote hub, now for every login:

- The hub's copy is the live token. A hub box that refreshes posts it to the
  relay, which writes the hub's store, mirrors it to custody under the HUB's
  machine id (#444 (b): it used the box's origin PC before, which filed a
  hub-owned account in a PC's slot) and fans it out to the account's boxes.
- That refresh revokes the PC's copy (Phase 0 incident). The PC must not
  hand the dead copy back: the import is **newest-wins on the hub**
  (`writeAccountSecret` / `shouldAcceptCredentialUpdate` compare the
  freshness field), not hash-only, and it needs no custody read on the PC
  (an enrolled PC has only the API key, which cannot read custody, which is
  why the PC-side `planCredentialPush` gate fell back to always-upload).
- The PC gets the live copy back with `agentbox hub credentials pull`, which
  now pulls named logins too: for every hub login mapped to this machine it
  reads `agents/<a>/accounts/<hubMachine>/<hubId>/<file>` (admin-token read,
  as for `default`) into the PC's own `<localId>`, newest-wins.
- `agentbox credentials renew <agent>/<id>` on a PC pointed at the hub signs
  in on the PC, imports the new login (newer, so accepted) and asks the hub to
  fan it out (`POST /accounts/:agent/:id/renew` on the hub).

### Selection

- The CLI resolves only the NAME when the create goes to a remote hub:
  `--account` > project `<agent>.account` > global `<agent>.account`, sent as
  `opts.accounts` (an explicit `default` included). It does not check the
  PC's store (`resolveBoxAccounts({ verify: false })`): the hub may hold an
  account this PC never signed in. A create that falls back to building
  locally checks the PC's store as before.
- The hub worker resolves every agent of the box (its agent plus borrowed
  lenders) BEFORE anything is built, `resolveHubCreateAccounts`:
  1. a name the requester's machine imported (`requester.machineId` +
     `localId`) → its hub account;
  2. else a hub account with that id;
  3. no name sent → the hub's global `<agent>.account` (what
     `PUT /api/v1/accounts/default` writes; web and tray creates send none);
  4. else `default`.
  A named account that is missing, has no secret, or is a pasted kind where a
  borrowed login is needed **fails the job** with the reason; a create never
  starts a box on an account it cannot seed. The box records the HUB id, so
  `agentbox ls`, `Box.accountsInfo`, `credentials switch` and the fan-out all
  read one name.

### Surfaces

- `GET /api/v1/accounts` on the hub lists the imported accounts; each may
  carry `importedFrom: [{machine, machineLabel?, id}]` (optional, additive,
  so the web page and the tray decode it unchanged).
- `agentbox credentials` (list, the menu, `rm`, `use`, `switch`, `renew`) on
  a PC with a remote hub configured asks the REMOTE hub (it used
  `preferLocal`). `--local` keeps the old view of this PC's own store, which
  its docker boxes still use. `use` writes the PC's own config (project or
  `--global`), validated against the hub's list, because that config is what
  the CLI sends; the hub's own default is set from the web UI.
- `add --login` still signs in on the PC (an interactive container here),
  then imports to the hub. `add --api-key/--setup-token` goes to the hub
  directly.
- `rm` on the hub removes the row, the secret, the hub-machine custody copy
  and every PC copy it was imported from, and tombstones the mappings.
- The hub System page counts only `agents/<a>/<boxRelPath>` as the agent's
  login (#442); named objects no longer read as "logged in".

### Left out

- Teams (Stage 2): any enrolled device can claim any `machine` in an import
  or a create's `requester`, so the mapping is a convenience, not a trust
  boundary. Same hole as the rest of multi-PC host-reach.
- A PC's local docker boxes keep using the PC's own store; an account removed
  on the hub stays on the PC until `agentbox credentials --local rm`.
- A named login and the `default` of another PC that are the same
  subscription stay two hub accounts (two holders, two refresh chains).

## Backlog (not in these phases)

- Switching a running box to another account (reseed + agent restart).
- OAuth login driven from the hub (web / tray / remote control box), extending
  the existing `jobs/:id/login-code` precedent.
- Per-account usage, once [`agent-history-plan.md`](./agent-history-plan.md)
  lands token usage.
- Dropping the legacy `~/.agentbox/<agent>-credentials.json` path for `default`.
