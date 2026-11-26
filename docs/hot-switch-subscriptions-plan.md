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
- **Defence: identity.** A claude blob names its owner (`claudeAiOauth.accountUuid`, `organizationUuid`), and so does a codex one (`tokens.account_id`). The relay never stores a blob under an account whose stored identity differs.
  - Within 10 minutes of the box's last switch, a blob with the identity of the account the box **left** is that account's refresh. Its refresh token rotated, so it is credited to the left account (newest-wins, then that account's fan-out), and the record's account is pushed back into the box, because the record is authoritative.
  - Any other mismatched blob (a third identity, or the left account's login after the window) is a person's own `/login` inside the box. The box keeps it, and nothing else gets it.
  - **Before the overwrite**, the switch itself reads what the box holds and credits it to the account it is leaving when it is that login and newer than the stored copy. The watcher ships every 15 s, so a refresh made just before the switch would otherwise be lost.
  - **Cloud resume reconcile:** a mismatched blob is never captured. When the account's stored copy is newer (by `expiresAt`), the account changed while the box was down (a switch, or a re-login), so the stored copy goes in. Otherwise the box keeps its own newer login.
  - Identity can't tell apart two account names holding the *same* real login (as in the live check below). That case is harmless: they share one refresh chain.

## Phase 1: what changes

1. **Docker: a per-box credential file.** At create, every agent whose credential declares `bindMountable` (claude only: its in-place fallback is what was measured) gets `~/.agentbox/boxes/<box>/credentials/<agent>/<file>` bind-mounted over its `credential.boxAbsPath`, seeded from the account's stored login (the fan-out keeps that current, and the volume stops being written once its boxes have their own files). The volume's copy is used only when nothing is stored, and the volume's own copy is shadowed. The record lists the agents in `credentialFiles`.
   - **The path in the volume must be a regular file.** The bake symlinks `~/.claude/.credentials.json` into `~/.agentbox-creds/` (the cloud credentials mount), and docker copies that dangling link into every new, empty volume (a pasted-token account's volume, `--isolate-claude-config`). A bind over a symlink lands on the link's target, and claude's next save renames a regular file over the link in the shared volume. So create replaces a link or a missing path with a `{}` regular file before it starts the box.
   - **Mode 0666 inside a 0700 dir.** The box user is uid 1000, which is not the host user on every Linux host, nor under rootless docker, and it must read the file and write its refreshes back. A bind ignores the host dir's mode, so the 0700 dir keeps other host users out.
   - Host writes go in place: one write that pads a shorter blob with spaces over the old length, then a truncate, so a read never sees an empty file or the old tail.
   - A failed create removes the box's credential dir.
   - Boxes created before this change have no such file. They can go back to the login of the volume they mount (after a switch to a token) with a restart, and are refused any other login with "destroy and create it again".
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

## Live check (2026-11-26, docker in an AgentBox box)

Two docker boxes, `hs1` and `hs2`, both on `default`, each answered a real turn. `claude/work` was a copy of the default login with a marker key.

- `credentials switch hs1 claude/work` took 1.5 s and printed "(no restart)". `hs1` kept container id `baf4abd0d4cb` and claude PIDs 516/517. Its own file held work's login (marker present), and `hs2`'s file did not. Both boxes then answered a real turn.
- A refresh written in `hs1` (newer `expiresAt`) was accepted for account `work`. `default`'s stored copy was unchanged.
- After switching `hs1` back to `default`, `hs1` wrote a newer blob with another `accountUuid` (the refresh race). The relay logged `identity mismatch` and put `default`'s login back into `hs1`'s file. `default`'s stored copy was unchanged. `hs1` answered a final turn, still the same container and PIDs.

### Second live check (review fixes, 2026-11-26)

- **Fresh volume:** the base image ships `~/.claude/.credentials.json` as a link into `~/.agentbox-creds`, and a new empty volume gets that link (verified). `hs3`, created on a setup-token account, got its own new volume; that volume held a regular `{}` file. After `hs3` switched to the `work` login (agent restarted, since it left a token), it answered a turn. Its own file held work's login, and the volume still held `{}`.
- **uid:** `hs1`'s host file was owned by uid 1001, mode 0666. The box user (1000) wrote it in place, and the host user (1000, not the owner) wrote the switch in place.
- **Capture before the switch:** a newer `default` refresh written in `hs1` just before `switch hs1 claude/work` landed in `default`'s stored copy through the switch's own capture (no relay accept in the log). Same container, same claude PIDs, then a turn answered.
- **Crediting the left account:** with `work` given its own identity, `hs1` switched back to `default`, then wrote a newer `work` blob. The relay accepted it for `work` and put `default`'s login back. A third identity written afterwards was left in the box and not fanned out. `hs1` answered a final turn, same container and PIDs throughout.
- **Legacy box:** with `credentialFiles` removed from `hs1`'s record, `work` was refused ("destroy and create it again"). `tok` and then back to `default` both went through, each with a restart.

## Open items

- codex: measure whether a running codex re-reads `auth.json` and whether it writes in place on a bind mount. Until then a docker codex box can't switch to a login, and a cloud codex box restarts codex after one.
- Cloud providers were not exercised live here (no cloud credentials in this box). Left for the host: switch a running hetzner/vercel/e2b/daytona/remote-docker box between two logins and check a turn plus `readlink ~/.claude/.credentials.json` (it must be a regular file after the switch; on daytona the shared subpath must be unchanged).
- **`.claude.json` `oauthAccount` stays on the old account after a hot switch.** It is profile metadata (name, email, org, plan). Measured with 2.1.332: a turn answers with an `oauthAccount` naming another account and org, and `claude -p` leaves it alone. At startup, when `profileFetchedAt` is older than 24 h, claude refetches the profile from the token in use and rewrites `oauthAccount` (measured). Until then `/status` shows the old account, and the org claude reads from it as a fallback (`CLAUDE_CODE_ORGANIZATION_UUID` first) is the old one. On docker `.claude.json` lives in the shared config volume, so it is not rewritten per box; a profile refresh in one box shows its account in the others. Cosmetic for requests, so not changed.
- An in-box `/login` within 10 minutes of a switch: a login of the account the box left is put back to the record's account (it can't be told from a refresh race); any other login is kept.
- `agentbox <agent> login` / `credentials renew` fan-out after a real OAuth sign-in was not run live (needs a browser); unit-covered by the volume-change capture.
- API keys could also hot-switch through claude's `apiKeyHelper` (a script claude re-runs on a TTL) instead of an env var. Not needed for logins, so not done.
