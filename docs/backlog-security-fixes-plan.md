# Backlog security batch (fix/backlog-security)

A batch of verified backlog bugs, fixed in one PR. Each was re-verified on nightly
`573452c23` before the fix. Item 3 (credentials in the origin URL) was dropped by the
owner and recorded in `docs/agent-history-backlog.md`; item 12 (planted skills
exhausting hub memory) is a proposal only, see the end.

## Phase 1 — the fixes

### 1. Cookie-authenticated cross-site POSTs to the hub (CSRF)

A docker box's web URL is `http://127.0.0.1:<port>`: same *site* as the hub on
`127.0.0.1:8787`, so the `SameSite=Lax` hub cookie rides along. The gate
(`apps/hub/proxy.ts`) checked neither Origin nor Content-Type, and `readJson` parsed
any body, so a page served from a box could send a `text/plain` POST (no preflight)
to `/api/v1/boxes`, `/api/v1/prune` and the lifecycle/git routes.

Plan:
- `session-gate.ts` (pure): the gate learns *which* credential authorized the request
  (`bearer` / `query` / `cookie`). A new pure `csrfOutcome` refuses an unsafe method
  (anything but GET/HEAD/OPTIONS) authorized by a **cookie** unless
  `Sec-Fetch-Site: same-origin` or the `Origin` host equals the request host. No Origin
  and no Sec-Fetch-Site on a cookie POST is refused too: every browser sends one of them
  on a POST, and nothing else carries the cookie.
- `proxy.ts` renders the refusal as a JSON 403 `csrf_rejected` and stamps
  `x-agentbox-cookie-auth: 1` on allowed cookie requests (overwriting a client copy).
- `readJson` refuses a non-empty body whose Content-Type is not `application/json`
  when that header is set. Bearer callers (CLI, tray) are unchanged.
- `/api/mcp` (POST) and `/api/events` (GET) go through the same gate: covered.
- Tests: gate truth table (bearer POST without Origin allowed; cookie POST from
  `127.0.0.1:<box port>` refused; same-origin allowed; `null` origin refused; GET untouched),
  and `readJson` with/without the cookie marker.

### 2. A cloud box's workspace download overwrites the PC's project unasked and without a backup

Why it was auto-approved: dd2ee2fa5 ("relax approvals for a safe subset of host
actions", 2026-07-05) treated "the destination is inside the project folder" as safe,
reasoning only about escaping the folder and exfiltration. Overwriting the project
itself was not considered, so there is no real reason. The docker relay path
auto-approved it the same way.

Plan (owner decision: always ask, back up what is overwritten):
- Both relay paths (`server.ts` docker, `host-actions.ts` cloud) always prompt for
  `download.workspace`.
- `rsyncPullToHost` (shared stage 2) takes `backupDir`: `rsync --backup --backup-dir`,
  so only files it actually replaces are kept, at their relative paths.
- `downloadBackupDir(boxId)` → `~/.agentbox/boxes/<id>/download-backups/<stamp>/`: on the
  host, outside the project (the box can't reach it). The 5 newest are kept.
- The cloud relay path stops untarring over the project. It unpacks into a temporary
  folder and runs the same `rsyncPullToHost` with the shared `workspaceExcludes()`
  and the backup dir. The CLI `agentbox download` (which the docker relay path runs)
  passes the backup dir too, so every provider gets backups.
- Tests: rsync backup keeps the replaced file; approval is no longer auto.

### 9. The PC's stale login overwrites the control box's refreshed one

`planPush` compared hashes only, so after a hub box refreshed claude's login (revoking
the PC's copy) the next hub-routed create uploaded the PC's older, revoked copy.

Plan:
- `credentialExpiry(agent, text)` (sandbox-core): the agent's declared freshness
  (`claudeAiOauth.expiresAt`), else the `exp` of an OAuth access-token JWT
  (`tokens.access_token`, codex's shape), in ms.
- `planCredentialPush` (custody-client): for each `changed` item, read custody's copy
  and skip the upload when custody's expiry is known and not older than the PC's
  (`custody copy is newer`). Validity check: a PC copy that has already expired never
  replaces a custody copy that hasn't. Unknown on both sides keeps the old
  last-writer-wins.
- Applied to the automatic sync (`syncAgentCredentials`), `hub credentials push`
  (unless `--force`) and the per-account push after `login` (named accounts too).
- Tests: newer custody skipped, newer PC uploaded, expired PC vs live custody skipped,
  codex JWT exp compared, force still uploads.

### 11. Cloning a box drops its settings

`cloneCreateInput` carried only `persistent`, borrowed logins and accounts. What every
`CreateBoxOpts` key does on a clone is decided in one table, `CLONE_CARRY` in
`apps/hub/lib/boxes/clone-carry.ts`, typed `satisfies Record<keyof CreateBoxOpts, …>`.
A new create option fails `pnpm typecheck` until someone decides it, and a unit test
checks that every `carry` key is actually produced from a fully populated record.

| option | clone | why |
| --- | --- | --- |
| skills | **carry** (bug) | a `--no-skills` box's clone got the whole library |
| llmProxy | **carry** (bug) | a forward box's clone went direct, silently |
| withPlaywright, vnc | **carry** (bug) | same kind of box |
| sharedDockerCache, memory/cpus/pidsLimit/disk | **carry** when the provider is unchanged (bug) | resource limits are per engine |
| persistent, borrowCredentials, accounts | carry (already) | |
| image, snapshot, hostSnapshot, build, imageRegistry, resync | drop | the clone is a fresh box built from the exported workspace |
| withEnv, envFiles, carry, carryAsk, carrySkip, promptAnswers | drop | carry is re-approved via `carryYes`; env files aren't exported |
| useBranch, sessionName, restore, bundleDepth | drop | per-create, not per-box |
| size, location, inbound, providerOptions, gitPushMode, credentialSync, remoteHost, dangerouslySkipPermissions, portless | drop: not on the record | backlog: record them to carry them |

### 3. (dropped) and 12. (proposal), see below.

Done when: a cookie POST from a box origin is a 403 and the web UI still works; a
workspace download from a cloud box prompts and leaves the overwritten files under
`download-backups/`; a stale PC claude login is not pushed over a newer custody copy;
a clone of a `--no-skills --llm-proxy forward` box keeps both.

## Deferred (backlog)

- `cp.toHost` contained in the project still auto-approves and overwrites without a
  backup (same reasoning as #2, but a named single path the agent asked for). Not in
  this batch.
- Clone: size/location/inbound/providerOptions/gitPushMode/credentialSync/remoteHost/
  dangerouslySkipPermissions are not recorded on the box, so a clone can't carry them.
- Clone: `autoApproveHostActions` / `autoApproveSafeHostActions` ride the registration
  from config, not a create option, so a clone takes the hub's current config.

## Item 12 proposal — planted skills exhausting hub memory / host disk (not implemented)

See the PR body; owner decides.
