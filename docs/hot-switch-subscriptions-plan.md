# Hot-switching a box's subscription

A box moves to another login by writing that login into **its own** credential file. Nothing is rebuilt, and claude is not restarted. This replaces the docker recreate (`recreateBoxOnAccount`) and lifts the cloud refusal.

## Phase 0: measurements (2026-11-26)

Setup: claude 2.1.326 in a tmux TUI (`--model haiku`), `CLAUDE_CONFIG_DIR` pointed at a scratch dir holding a copy of a real Max login. "Invalid blob" = the same JSON with well-formed fake `sk-ant-oat01-…` / `sk-ant-ort01-…` tokens. Each swap was an atomic `cp tmp && mv tmp .credentials.json`, the way any writer of ours does it.

### 1. Does a running claude pick up a replaced `.credentials.json`?

| Turn | File on disk at send time | Result |
|---|---|---|
| 1 | valid | answered |
| 2 | invalid (swapped 2 s before) | `Login expired · Please run /login` |
| 3 | valid (restored 1 s before) | answered, same process, same conversation |
| 5 | invalid (swapped < 0.1 s before) | `401 OAuth access token is invalid` |
| 6 | valid (restored < 0.1 s before) | answered |

- **Each turn used the file on disk, never an in-memory token.** Turn 2 failed even though the process held a working token from turn 1.
- **It reads the file before every request**, not only after a 401 or a restart. A swap made under 0.1 s before the send was already in effect. The delay is 0.
- **A 401 can make claude write the file.** After turn 2 it tried to refresh with the fake refresh token, failed, and rewrote the file with empty `accessToken`/`refreshToken` (`expiresAt: 0`), keeping the other fields. Later 401s in the same process (turns 5, 8, 9) did not write again. A fresh process that starts on an expired fake blob writes the wipe at once (turn 10).
- **Setup token (`CLAUDE_CODE_OAUTH_TOKEN`) / API key env vars:** a running process's environment can't be changed from outside, so switching to, from or between pasted tokens still restarts the agent (today's path, unchanged). The file is the only channel a running claude re-reads.
- **codex `auth.json`:** codex is not installed in this box, so this is not measured. The switch writes codex's file the same way and still restarts codex for now (see Phase 1).

### 2. Where can a box's credential live apart from the shared config volume?

- **Symlink: rejected.** With `~/.claude/.credentials.json` a symlink to a per-box file, claude reads through it. But claude's own write (temp file + `rename` onto the link path) **replaces the symlink with a regular file** (turn 10: the link became a 1282-byte regular file; the per-box target kept the old content). On docker the link sits in the shared account volume, so the first refresh after a switch would write this box's login into every other box on that account.
- **File bind mount over the path: works.** With a per-box file bind-mounted over `.credentials.json` (`mount --bind`, the same kernel mechanism as a docker file bind), claude's `rename` fails with EBUSY, and **claude falls back to writing the file in place**. The write landed in the per-box file and the shared directory never changed (turn 11). Reads go through as normal. The ctl watcher reads the same path and doesn't care what backs it.
  - Consequence for writers on the host: a file bind pins the inode, so host-side writes must be **in place** (`writeFile`, no rename) or the container keeps reading the old inode.
- **Cloud boxes already hold a box-local file.** The bake symlinks `~/.claude/.credentials.json` into `~/.agentbox-creds/claude/`. On hetzner, vercel, e2b, digitalocean and remote-docker that dir is box-local. On daytona it is the account's subpath of the shared credentials volume, and claude's first refresh already detaches it by replacing the link (measurement 2). A switch therefore writes with `tmp + mv` **onto the link path**, never through the link, so a daytona box can't write into the shared subpath.

### 3. Refresh race after a switch

- Claude re-reads the file before every request (1), so after the switch the process never refreshes the *old* account from memory. The only window is a refresh already in flight at the moment of the write: claude read the old blob, POSTed the refresh, and writes the old account's rotated blob back over the new one. That window is one HTTP round trip (around 200 ms). It can't be timed reliably by hand without rotating a real token, so it is **reasoned, not reproduced**. Measurement 1 does show that claude writes the file after a refresh attempt, so the race exists.
- The other direction also exists. The ctl watcher polls every 15 s, and the relay credits a blob to the box's account **at receipt**. A blob written just before the switch and shipped just after it would be credited to the new account.
- **Defence: identity.** A claude blob names its owner (`claudeAiOauth.accountUuid`, `organizationUuid`), and so does a codex one (`tokens.account_id`). The relay rejects a blob whose identity differs from the account's stored one, and pushes the account's own login back into that box, because the record is authoritative. The cloud resume reconcile applies the same rule: on a mismatch the host copy wins.
  - Identity can't tell apart two account names holding the *same* real login (as in the live check below). That case is harmless: they share one refresh chain.

## Phase 1: what changes

1. **Docker: a per-box credential file.** At create, every agent with a `credential` gets `~/.agentbox/boxes/<box>/credentials/<agent>/<file>` bind-mounted over its `credential.boxAbsPath`, seeded with the account's login (the volume's copy is shadowed). The record says so (`boxCredentialFiles: true`). Boxes created before this change have no such file and are refused with "recreate the box": AgentBox is unreleased, so there is no fallback path.
2. **Switch to a login = write the target's stored login into the box's own file, then move the record.** Docker writes the host file in place (works running, paused or stopped). Cloud writes over the transport with `tmp + mv` (the box must be running). The record moves first and the file is written second, so a watcher tick in between credits the new blob to the new account. No agent restart when the box was already on a login. Leaving a pasted token still restarts the agent, because its env var must go. `how: 'file'` replaces `how: 'recreate'`.
3. **Fan-out is per box account.** `propagate` writes a docker box's own file (not the volume) and only for boxes on the account. Legacy volume writes remain for boxes without a per-box file. The relay credits by the box's current account and refuses a mismatched identity (see 3).
4. `recreateBoxOnAccount`, `switch-images.ts` and `CLOUD_LOGIN_REFUSAL` are deleted.
5. **Auto-propagate after every completed sign-in** (see "Login paths" below).

### Login paths and propagation

| Path | Fans out after sign-in? |
|---|---|
| `credentials renew` | yes (already) |
| `agentbox <agent> login` (default account) | added |
| `credentials add --login` | added (a new account has no boxes yet, so this is a no-op unless the account already existed) |
| TUI renew | via `renewCommand` (already) |
| `--headless` start (URL printed only) | no: nothing was signed in yet; the `--code` finish fans out |

The relay's host watcher (`history/host-watcher.ts`) ships host *transcripts*, not credentials, so it covers none of these and nothing is pushed twice.

## Open items

- codex: measure whether a running codex re-reads `auth.json`. Until then a codex login switch restarts codex.
- API keys could also hot-switch through claude's `apiKeyHelper` (a script claude re-runs on a TTL) instead of an env var. Not needed for logins, so not done.
