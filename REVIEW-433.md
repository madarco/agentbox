# Review: PR #433, llm-accounts Phase 2 (head `feat/llm-accounts-p2` @ bbba0188, base `nightly` @ 9b092376)

Line numbers are for the PR head.

## Summary

The main named-login paths keep the owner's default login out:

- `ensureClaudeVolume` / `buildCodexVolumeSyncScript` exclude the credential file when `account` is set.
- The claude finalize (`syncClaudeCredentials`) runs only when the volume is the shared one.
- `writeAccountSecret` refuses `default`.
- `--account default` resolves to the plain login.

The default `claude login` / `codex login` paths are unchanged: the same volume, the same rsync script, the same finalize, and the same custody push.

I found one real overwrite path, in the headless session handling. CI is also red.

---

## 1. BLOCKING: a headless named login can finish a pending default login, and account B overwrites the default everywhere

**Where:** `packages/agent-claude/src/cli/login-command.ts:73-87` (`startHeadlessLogin`), `:157-169` (`deliverLoginCode`).

`startHeadlessLogin(args, account)` checks `findLiveSession()` before anything else. If any headless session is pending, it prints "A login is already pending; finish it" and that session's URL and `--code` instructions, then exits 0. It never checks which account the pending session belongs to (`readLoginRequest(existing.id)?.account`). `deliverLoginCode` ignores `--account` the same way and hands the code to whatever session is pending.

**Scenario:**

1. An orchestrating agent, or the hub/tray, ran `agentbox claude login --headless` (default) and never finished it. The session stays live for up to 15 minutes.
2. The user runs `agentbox claude login --headless --account work`.
3. They get the default session's URL, sign in to account B in the browser, and run `agentbox claude login --code X --account work`.
4. The default worker then:
   - writes B into the shared `agentbox-claude-config` volume;
   - mirrors it to `~/.agentbox/claude-credentials.json` (newest-wins accepts it, since B's `expiresAt` is later);
   - pushes it to custody (`syncAgentCredentialsIfChanged`);
   - prints the generic "signed in — credentials saved for future boxes".

Every docker box on the shared volume, every later cloud box and the control box now run on account B. The owner's default login is gone.

The reverse also happens. If the pending session is named and the user runs a plain `--headless`, their default sign-in is captured as account `work`.

**Fix (small):**

- In `startHeadlessLogin`, compare `readLoginRequest(existing.id)?.account?.id` with `account?.id`. When they differ, refuse, naming the pending session's account (or "the default account"). Do not print its URL.
- In `deliverLoginCode`, take the `--account` the caller passed (`opts.loginAccount`). Refuse when it does not match the pending request's account.
- Also print the target account in `printAwaitingCode`.

## 2. BLOCKING (merge gate, test only): CI is red, and the turbo run stopped there

**Where:** `packages/agent-claude/test/account-identity.test.ts:53-61`.

`accountStateJqDelete` loads `../src/docker-sync.js` with a dynamic `import()` inside the test. That takes about 6.5 s on CI, past vitest's 5 s default, so the test fails with "Test timed out in 5000ms" (run 45045905542). `pnpm test` exits at `@agentbox/agent-claude#test`, so the test suites of the remaining packages may not have run on this PR.

**Fix:** move `accountStateJqDelete` next to `ACCOUNT_STATE_KEYS` in `hooks-filter.ts` and import it statically, or give the test a longer timeout. Then re-run the full CI.

---

## 3. LATER (must land before Phase 3): `agentbox prune --all` deletes every named account volume

**Where:** `packages/sandbox-docker/src/lifecycle.ts:897-950`. Not changed by this PR, but this PR creates the volumes it reaps.

Prune lists every `agentbox-*` volume. It deletes the ones not in `expectedVolumes`, which holds:

- the volumes of surviving boxes;
- each spec's shared `dockerVolume`.

`agentbox-claude-config-acct-<id>` and `agentbox-codex-config-acct-<id>` are in neither, so `prune --all` (CLI or hub) removes them as orphans.

- **Today:** the store still holds the captured login, so nothing is lost beyond the account's seeded config and cached profile.
- **Once Phase 3 runs boxes on these volumes:** the volume is the live, refreshed copy. Losing it leaves only the store copy, which a refresh has already revoked.

**Fix:** add `accountConfigVolume(spec.dockerVolume, a.id)` for every named row from `readAccounts()` to `expectedVolumes`. Or keep any volume containing `-acct-`, which is safe since `agent add` refuses `-acct-` in a `dockerVolume`.

## 4. LATER: the host's `settings.json` auth env still reaches a named volume

**Where:** `packages/agent-claude/src/docker-sync.ts:262-268` and `:345-358`.

The named-volume seed strips `_claude.json` account state and excludes `.credentials.json`. `settings.json` is still copied as is.

- If the owner keeps `env.ANTHROPIC_API_KEY`, `env.CLAUDE_CODE_OAUTH_TOKEN`, `env.ANTHROPIC_AUTH_TOKEN` or an `apiKeyHelper` there, the named account's volume carries the owner's credential.
- Claude prefers it in `-p` mode (Phase 0 (a′)). The warm-up turn, and in Phase 3 the box itself, would then run and bill on the owner's key instead of account B.

This breaks the plan's own rule: "the host's config but never the host's identity". It doesn't matter yet, because no box mounts the volume in Phase 2.

**Fix:** when `account` is set, drop the auth-bearing `env.*` keys and `apiKeyHelper` in the `settings.json` `maybeFilterTo` pass.

## 5. LATER: smaller items

- **A failed or cancelled first login leaves an orphan volume.** `ensureVolume` creates `…-acct-<id>`. If the sign-in then fails or is cancelled, no row is written, `accounts rm` refuses ("no account"), and the volume stays until a `prune --all`.
- **`resetVolumeAccountState` fails hard on bad JSON** (`packages/agent-claude/src/docker-sync.ts:1393-1409`). If the volume's `_claude.json` is not valid JSON, `jq … && mv` fails and execa throws. Every re-login of that account then aborts until `accounts rm`. Fall back to deleting the file, or skip with a warning.
- **A re-login can lose the email/org label** (`packages/sandbox-docker/src/sync/account-login.ts:118-130`). If the warm-up turn fails, `oauthAccount` was just reset, so the identity is plan-only and replaces the stored email/org. Display only.

## Checked, no finding

- The default `login` paths (claude guided/interactive/headless/queued-job, codex generic). They use the same volume, the same `buildCodexVolumeSyncScript` output (empty `credentialExclude`) and the same finalize and custody push. `runClaudeLogin` and `claudeLoginBinding` never had a non-shared-volume caller, so gating `syncClaudeCredentials` on `SHARED_CLAUDE_VOLUME` drops nothing.
- The codex named seed. `--exclude=/auth.json` is effective, because the only `--include` rules are `/.tmp/…` and rsync applies the first rule that matches.
- Fan-out and propagate (`planPropagateTargets`) are keyed on box records and never reach the named volumes. Custody receives only the legacy backup.
- Secrets never go on argv or into logs:
  - pasted secrets come from `password()` or stdin;
  - `dockerVolumeFileReader` reads through `cat` on stdout and does not log it;
  - error messages never include the contents;
  - the login container and warm-up forward no host auth env.
- File modes: `writeSecretAtomic` writes 0600, and `credentials/` is 0700 (Phase 1).
- `accounts rm`:
  - it refuses `default`;
  - the id must exist in the store (validated);
  - the volume name always carries `-acct-`, so it can never be the shared volume or an isolate `<volume>-<boxId>`;
  - it never forces the removal of a volume in use.
- Kind takeover is checked before OAuth, at capture and on paste.
