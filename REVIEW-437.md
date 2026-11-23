# Review: PR #437 — llm-accounts Phase 3 (account selection + seeding)

Reviewed `origin/feat/llm-accounts-p3` @ 39667e7e against base `nightly` (merge-base 3920289d).
I read the code only. Nothing was built or run, and nothing touched real credentials or volumes.
Line numbers refer to the PR branch.

Summary: the default path (boxes with no account) is unchanged on every seam I traced. Four
BLOCKING findings, all about named-account isolation. The worst is data loss: `destroy` deletes
an account's docker volume. The other three are paths that put the owner's default credential
into a named box, or a named login into the default slot.

---

## 1. BLOCKING: `agentbox destroy` deletes the named account's docker config volume

- `packages/sandbox-docker/src/lifecycle.ts:193-197` (`boxAgentConfigVolumes`) treats every agent
  config volume that is not the agent's shared `dockerVolume` as box-private.
- `lifecycle.ts:733-737` (`destroyBox`) runs `docker volume rm` on each of those volumes.
- A named box records `agentConfigVolumes.claude = agentbox-claude-config-acct-work`
  (`create.ts:736`). That name is not `agentbox-claude-config`, so destroy removes it.

**Scenario:** `agentbox claude --account work`, use it for a few hours, then `agentbox destroy`
it. If it is the only box on `work` (no other container references the volume), the volume is
deleted. That volume held the account's live, refreshed login, and Phase 0 measured that a
refresh revokes the store's older copy. It also held every `work` transcript and the API-key
pre-approval. The next `--account work` box starts from a stale secret and is logged out, and
`--resume` history is gone. The #433 review called the identical `prune --all` problem MUST FIX,
and this PR fixed prune (`lifecycle.ts:951-957`) but not destroy.

**Fix:** in `boxAgentConfigVolumes` (or in the destroy loop), also skip any volume containing
`ACCOUNT_NAME_INFIX`. The prune fix already uses the same test. Only `agentbox accounts rm`
should remove these volumes. Add a destroy unit test next to the prune one.

## 2. BLOCKING: `ensureAgentInstalled` pushes the owner's default login into a named box

`packages/sandbox-core/src/sync/concerns/install.ts:283-287`: whenever it has to install an
agent, it calls `resolveHostCredential(spec.id)` (the DEFAULT login: legacy backup or tool path)
and then `pushCredentialToBox` to `credential.boxAbsPath`. It knows nothing about the box's
account. Three ways to reach it:

- **a. Agentless `create --account`, then an agent added later. Deterministic, docker and cloud.**
  `agentbox create --account claude=work` is explicitly allowed (`apps/cli/src/commands/create.ts:686`).
  The box is built with `agents: []` (`planJobAgent`), so no claude volume is mounted, and the
  record still gets `accounts.claude = work`. Then `agentbox claude <box>` runs
  `start-attach.ts:221` → `ensureClaudeInstalled` → pushes the owner's live default login into
  `~/.claude/.credentials.json`. On cloud, `_cloud-attach` / `ensureAgentInstalled` does the same.
  The box is labelled `work` but runs and bills on the owner's default subscription.
  `syncBoxClaudeCredentials` skips it on purpose (`box-credentials.ts:17`), so nothing repairs it.
  The backlog only notes "keeps whatever volume docker mounted"; it misses the credential push.
- **b. Cloud create where the snapshot lacks the agent.** No derived snapshot was baked for this
  agent set (`prepare --agents`). `cloud-provider.ts:1043` (`ensureAgentsInstalledForCloud`) runs
  BEFORE `seedCredentials`, so the default login is pushed first:
  - For a pasted account (`setup-token` / `api-key`), `withAccountStager` drops the stager
    (`agent-credentials.ts:757-762`), so nothing overwrites the pushed login. For `api-key`,
    Phase 0 (a′) measured that the TUI's default "No" then runs the box on the stored OAuth login,
    which is the owner's. There is no cloud pre-approval (finding 3).
  - On Daytona, if the upload follows the baked `.credentials.json → ~/.agentbox-creds/claude/`
    symlink, it writes into the account's sibling subpath. A second box on that account then sees
    the seed marker and skips the seed (`agent-credentials.ts:473-478`). The account's shared copy
    stays replaced by the owner's login.
- **c. Cloud checkpoints (same effect, different source).** On non-volume backends
  (hetzner / vercel / e2b), a `box.defaultCheckpoint*` snapshot already contains the owner's
  `~/.agentbox-creds/claude/.credentials.json`. Checkpoints do not strip it (`checkpoint.ts`).
  A pasted-kind named box created from that snapshot keeps the file, because no stager overwrites
  it. The same happens to a named login whose secret file is missing (`existsSync` false →
  `tarballPath: null`).

**Why this blocks, beyond billing:** the box now holds a live copy of the owner's login. When it
refreshes, every other holder of that login is revoked (measured). The new relay guard
(`credentials-fanout.ts:116-122`) then drops the box's refreshed blob because the record names an
account. Before this PR the fan-out would have healed the fleet. Now every default box stays
logged out until a manual `agentbox claude login`.

**Fix (smallest):**
- Give `ensureAgentInstalled` an opt-out for the credential push, or pass it a `{ agent, account }`.
- For a named `login`, push the account's secret. For a pasted kind, push nothing and remove any
  stale `credential.boxAbsPath` / `~/.agentbox-creds/<agent>/<file>`. Apply this both at cloud
  create and on the start seams.
- In `resolveBoxAccounts` / `create.ts`, refuse `--account <agent>=…` for an agent the box does
  not carry. Docker cannot mount the account volume later anyway, so the flag can never take
  effect there.
- When seeding a pasted-kind cloud box, also `rm -f` the credential file in the box. This covers
  the checkpoint case.

## 3. BLOCKING: cloud named boxes get the owner's settings.json auth env and the raw host `_claude.json`

The two Phase 2/3 strips only run on docker: `stripAuthSettings` (`agent-claude/src/docker-sync.ts:283`)
and `stripAccountState`. The cloud seeds have no account input:

- `settings.json` reaches cloud boxes through `stageClaudeStaticForUpload`
  (`agent-claude/src/host-stage.ts:180-233`). Its only filter is `filterHostHooks`. The file is
  baked into the cloud snapshot at prepare, and staged per create on `seedsAgentStaticAtCreate`
  backends (remote-docker). An owner `env.ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` there survives into every named cloud box. That is the
  exact #433 MUST FIX ("the key wins in `-p`"), fixed for docker only.
- `_claude.json` is overlaid on every cloud create by `seedClaudeJsonAtCreate`
  (`cloud-json-overlay.ts`, called from `afterDeclaredSeeds`, `agent-claude/src/index.ts:128`).
  It carries the owner's `primaryApiKey` (a Console key, an owner secret), `oauthAccount` (the
  wrong label, per Phase 0), `customApiKeyResponses`, and the unkeyed model caches.

**Scenario:** the owner has `apiKeyHelper` or `env.ANTHROPIC_API_KEY` in `~/.claude/settings.json`
and runs `agentbox claude --provider hetzner --account work`. Every `claude -p` in the box bills
the owner's key, and the TUI offers it too. The PR says "All providers" and "a box on a named
account gets exactly that account's auth", which does not hold on cloud.

**Fix:**
- Thread `accounts` into `afterDeclaredSeeds` / `seedClaudeJsonAtCreate`, and apply
  `stripAccountState` when claude is on a named account.
- For a named box, after the static seed, strip the in-box `~/.claude/settings.json` with `jq`:
  remove the `AUTH_SETTINGS_ENV_KEYS` entries and `apiKeyHelper`. The baked snapshot is shared,
  so this has to happen per create.
- Pre-approve an `api-key` account's key on cloud too: write `customApiKeyResponses.approved`
  into `_claude.json`, as docker's `approveAccountApiKey` does. Pass the key's suffix via
  stdin / a temp file, not argv.

## 4. BLOCKING (multi-PC): adopted box records drop `accounts`, so the adopting PC crosses accounts

`hub-adopt.ts:191` and auto-adopt both build the local record with `registrationToBoxRecord`
(`packages/relay/src/registration-to-record.ts:105-170`). `BoxRegistration` carries no
`accounts`, and neither does the hub's `Box` payload. An adopted named box therefore looks like a
default box on the second PC.

**Scenario:**
1. PC1's hub (with `hub expose`; the Mac is the control box today) creates a named cloud box.
2. PC2, pointed at that hub, runs `agentbox claude <box>`. auto-adopt runs on the local miss.
3. The box is paused, so `_cloud-attach.ts:124` calls `provider.start` → `reEnsureCloudBox` →
   `reconcileAgentCredentials` (`cloud-provider.ts:710`). `box.accounts` is undefined, so claude
   is reconciled newest-wins against PC2's DEFAULT backup:
   - If account B's token is newer, it is written into PC2's default backup (and from there
     reaches custody and PC2's default boxes).
   - Otherwise PC2's default login is pushed into the named box.

   PC2's relay guard (state.json) also sees no account. The backlog marks the remote case as
   "moot" because a remote hub has no account store, but an exposed laptop hub does have one.

**Fix:** carry `accounts` on the registration (`registerBoxWithRelay` from docker and cloud
create/start, plus the `BoxRegistration` type), copy it in `registrationToBoxRecord`, and add it
to the hub `Box` payload (Phase 5 planned `Box.accounts`; at least the raw field is needed now).
This also lets the fan-out guard read `reg.accounts` instead of state.json, which removes finding 5.

---

## 5. LATER: a cloud create race lets a named box's first credential post reach the default backup

ctl's watcher posts the current blob on its first scan (`ctl/src/credentials-watcher.ts:15`).
On cloud, ctl starts at bootstrap (`cloud-provider.ts:~1155`). `registerBoxWithRelay` (`:1407`)
starts the host poller, but the record holding `accounts` is only written later, at
`recordBox(record)` (`:1532`). If the poller drains the queued `credentials-updated` event before
`recordBox` lands, `stateBoxAccount` finds no record and returns `undefined`. The named login is
then accepted as default, and it wins whenever its `expiresAt` is newer.

The window is narrow (one poll round trip against a local write), but contention on the state
lock widens it, for example during parallel creates. Docker is not affected: its provisional
record is written before ctl starts. Same fix as finding 4: read the account from the
registration.

## 6. LATER: pasted-account secrets go on the docker argv

`docker run -e KEY=VALUE` (`sandbox-docker/src/docker.ts:145`) and `docker exec -e`
(`agent-claude/src/docker-sync.ts:1041`, `agent-codex/src/docker-sync.ts:641`) now carry the
account's `CLAUDE_CODE_OAUTH_TOKEN` / API key. Anyone who can run `ps` on the host sees it while
docker runs. Today's host-key spray already does this, so it is not a regression. Still, the
pasted secret was deliberately kept off argv at login (hidden prompt / stdin). Fix: pass `-e KEY`
(no value) and put the value in execa's `env`.

## 7. LATER: a checkpoint `--set-default` from a named cloud box bakes account B into the default checkpoint

`hub-backend.ts:3264` skips extracting named agents (correct). But on non-volume backends the
snapshot itself contains `~/.agentbox-creds/claude/.credentials.json` holding B. A later DEFAULT
box seeded from that checkpoint keeps B whenever the host has no default backup to overwrite it
with (`stageClaudeCredentialsForUpload` → empty). Its watcher then posts B as default, and the
relay accepts it. Fix: warn or refuse `--set-default` on a box with named accounts, or strip the
credential before the snapshot.

## 8. LATER: settings propagate now skips named boxes too

The guard at `agent-propagate.ts:304` sits in `planPropagateTargets`, which also drives SETTINGS
propagation (`apps/cli/src/commands/_agent-propagate.ts:93`). So named boxes stop receiving
skills/plugins propagation. This is a functional regression for named boxes only, with no
credential impact. Fix: gate on a flag that only the credentials caller passes.

## 9. LATER: smaller items

- `agentbox download codex <named-box>` copies the box's `auth.json` (account B) to the host's
  `~/.codex/auth.json` when the host has none (additive pull, codex `pull.items` includes
  `auth.json`). It then becomes the default login through `resolveHostCredential`. This needs an
  explicit user action. Skip `auth.json` for a named box.
- Community providers built on the published `@madarco/agentbox-provider-sdk` (an old inlined
  `createCloudProvider`) silently ignore `req.accounts`: the box comes up on the default login and
  the host key is sprayed. The SDK needs a rebuild and republish (additive interface:
  `CreateBoxRequest.accounts`, `BoxRecord.accounts`, `AgentSyncSpec.accountEnv`).
- `sessionAccountPolicy` (`account-session-env.ts`) fails OPEN to `NO_ACCOUNT_ENV` if `readState`
  throws, so the host key is forwarded into a named box at session start. This is rare (the
  writes are atomic). Consider failing closed for the suppress half.
- The named docker credential mirror writes `credentials/<agent>/<id>.json` from a root container
  (`SYNC_SCRIPT` `cp -a`), bypassing `writeAccountSecret`'s lock. It is newest-wins like the
  default path, so this is cosmetic.

---

## Default-path (no account) verification: unchanged

Traced against `origin/nightly`; with `accounts` absent each seam reduces to the old call:

- docker `seedCredentials` (the loop skips, then the old claude branch)
- `ensureClaudeVolume`: `stripAuthSettings` is false, and the `accountStateStripped` OR-merge is
  equivalent
- `claudeSessionEnvFlags`: same flags, same order
- `startCodexSession`
- `syncBoxClaudeCredentials`, default branch: identical args at the `start` hook and on the
  dashboard
- cloud `buildForwardedEnv`, mount subpath (`accountCloudSubpath(…, 'default')` is the base path),
  and `withAccountStager` (returns the spec unchanged)
- resume reconcile: the `agents` filter is applied only when `box.agents` is set or a named
  account exists
- extract: `skip: []`
- `planPropagateTargets`
- `borrowedCredentialCarry`: model-auth `--model-auth codex` with no `codex.account` uses the old
  resolver
- relay fan-out: one `readState`, box found with no accounts, proceeds; it fails closed only if
  state.json is unreadable
- hub create: `resolveCreateAccounts` returns `{}` and never reads accounts.json without a named
  value

Old records without `accounts` and old images are fine: `boxAccount` defaults, and ctl is
unchanged. The repo's `agentbox.yaml` cannot select an account: `resolveBoxAccounts` reads only
the `project` and `global` layers and warns on `workspace`. Login secrets stay off argv
(`approveAccountApiKey` uses stdin, and `HOST_REL` is validated), except as noted in finding 6.
