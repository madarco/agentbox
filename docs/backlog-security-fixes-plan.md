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
  `127.0.0.1:<box port>` refused; same-origin allowed; `null` origin refused; GET untouched;
  auth off still refuses a cross-site browser page; a proxied `X-Forwarded-Host` chain),
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
  folder and runs the same `rsyncPullToHost` with the backup dir (the same everything-but-`.git` scope as before). The CLI `agentbox download` (which the docker relay path runs)
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
  replaces a custody copy that hasn't. Unknown on either side (an API-key login has
  no expiry) keeps the old last-writer-wins.
- Applied to the automatic sync (`syncAgentCredentials`), `hub credentials push`
  (unless `--force`) and the per-account push after `login` (named accounts too).
- Tests: newer custody skipped, newer PC uploaded, expired PC vs live custody skipped,
  codex JWT exp compared, force still uploads.

### 11. Cloning a box drops its settings

`prepareClone` copied fields one by one: `accounts` was the last wired, the skills
selection and `llmProxy` never were. So a clone of a `--no-skills` box got the
whole library and a clone of a proxied box egressed direct, with no warning.

Fix: `apps/hub/lib/boxes/clone-carry.ts`. `CLONE_RECORD_POLICY` is
`satisfies Record<keyof BoxRecord, 'carry' | 'drop' | 'n/a'>` (and
`CLONE_CLOUD_POLICY` the same over `CloudBoxFields`), so a new record field fails
`tsc` until it is classified. A pure `cloneCarryOpts(source, targetProvider)` builds
the clone's create options, and a unit test checks that removing any `carry` field
changes the result (it fails when a field is classified `carry` but never wired).

- Carried: skills selection; `llmProxy`, mapped explicitly to `forward` / `off` so
  the hub's config can't flip it (same provider only); withPlaywright; VNC; persistent (an explicit
  input still wins); accounts; borrowed logins. On the same provider only: docker
  limits (memory/cpus/pids/disk), shared docker cache, Portless, cloud size,
  location, inbound policy, daytona sandbox class, and the remote-docker engine
  (taken from the `sandboxId`).
- New on the record: `cloud.size` and `cloud.location` (what was ASKED for;
  `resources` is what the backend reported), so a clone of a large box isn't
  created at the default size.
- Box-scope skill bindings: copied to the clone's id once its create job names
  the box (`copyBoxBindingsWhenCreated`, fired by the clone route).
- Intentional drops: image/checkpoint, the TUI agent (documented), config
  volumes/credentials (fresh identity), branch, git push mode, `carry:`
  (re-resolved under `carryYes`), ports/tokens/ids.

### 3. (dropped) and 12. (proposal), see below.

Done when: a cookie POST from a box origin is a 403 and the web UI still works; a
workspace download from a cloud box prompts and leaves the overwritten files under
`download-backups/`; a stale PC claude login is not pushed over a newer custody copy;
a clone of a `--no-skills --llm-proxy forward` box keeps both.

## Deferred (backlog)

- `cp.toHost` contained in the project still auto-approves and overwrites without a
  backup (same reasoning as #2, but a named single path the agent asked for). Not in
  this batch.
- Clone: `credentialSync`, `dangerouslySkipPermissions`, DigitalOcean's `project` and
  the other `providerOptions` (`timeoutMs`, `networkPolicy`) are not recorded on the
  box, so a clone can't carry them. Boxes created before this change have no
  `cloud.size` / `cloud.location`, so their clones use the provider default.
- Clone: the daytona sandbox class reaches the create only on the control-plane
  path. The local queue (`QueueJobCreateOpts`) has no per-create `providerOptions`,
  so a local clone (like a local CLI create) follows `box.daytonaClass`.
- Clone: the LLM proxy carries only when the provider is unchanged (its upstream
  is engine-shaped); a clone onto another provider takes that hub's `llm.proxy`.
- Clone: box-scope skill bindings land after the create job finishes, so the clone's
  first boot-time skills sync can run before them; the next sync applies them.
- Clone: `autoApproveHostActions` / `autoApproveSafeHostActions` ride the registration
  from config, not a create option, so a clone takes the hub's current config.

## Item 12 proposal: planted skills exhausting hub memory / host disk (not implemented)

Verified on nightly. Hub: `createSkillProposals` keeps each pending proposal's
**compressed** tarball in memory until the answer (up to 24 h), with one global cap of
20 (`DEFAULT_MAX_PENDING`) and no per-box cap. The route accepts up to
`AGENTBOX_CUSTODY_MAX_BLOB_BYTES` (100 MiB) per tarball, so one box can pin ~2 GB.
CLI: `proposeBoxSkills` runs `transport.pullTree` on every box skill dir with no size
limit (host disk), then `readLocalSkill` reads the staged copy. A `SKILL.md` that is
a symlink to `/dev/zero`, or a FIFO, is copied as a link and then read on the PC,
which reads forever.

Proposal:

1. **Hub caps** (`skill-proposals.ts`): at most **3 pending per box** and 10 in
   total; a proposal tarball cap of **8 MiB** compressed / 32 MiB unpacked (its own
   `skills.proposalMaxBytes` key, not custody's blob cap); and a **64 MiB total**
   budget across pending tarballs. Over any cap the request is refused with a clear
   409 saying how many are waiting; nothing is queued.
2. **Where pending tarballs live**: keep them in memory under that budget, with no
   disk spill. 64 MiB is cheap on any hub, a spill adds a temp-dir lifecycle
   (cleanup on answer, expiry and restart) for no real gain, and a restart already
   drops the prompts the tarballs belong to.
3. **CLI read cap** (`box-propose.ts` / `readLocalSkill`): before pulling, list the
   skill dir in the box (`find -printf '%y %s %p'`), refuse any non-regular entry
   other than a directory (symlinks, FIFOs, devices), and refuse a skill whose
   regular files sum over the proposal cap. Then pull, and `lstat` every staged
   entry before reading it (a symlink or special file is a `problem`, never
   followed), reading with a byte budget.

Size: hub about 40 lines + 4 unit tests; CLI about 40 lines + 3 unit tests. Half a
day including the live check. One new config key (documented in
`configuration.mdx`), no API shape change (only a new 409 message).
