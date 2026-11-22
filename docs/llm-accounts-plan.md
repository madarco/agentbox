# LLM accounts and the hub egress proxy — plan

Status: **planned, not started.** One phase per session; Phase 0 is a live PoC and
gates the rest.

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
  boxes on different accounts. Phase 0 verifies this is enough (see
  `oauthAccount` below).
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

## Backlog (not in these phases)

- Switching a running box to another account (reseed + agent restart).
- OAuth login driven from the hub (web / tray / remote control box), extending
  the existing `jobs/:id/login-code` precedent.
- Per-account usage, once [`agent-history-plan.md`](./agent-history-plan.md)
  lands token usage.
- Dropping the legacy `~/.agentbox/<agent>-credentials.json` path for `default`.
