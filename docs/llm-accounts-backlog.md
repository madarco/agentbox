# LLM accounts — backlog

Live list of open items found while building [`llm-accounts-plan.md`](./llm-accounts-plan.md).
Newest phase last.

## From Phase 1 (account model + store)

- **`default` row only when the legacy backup is real.** A user who has never
  run a box has a login in `~/.claude/.credentials.json` but no
  `~/.agentbox/claude-credentials.json`, so `readAccounts` lists no `default`.
  Selection still resolves `default` (it always does), so only listings are
  affected. Phase 2/5 listings should consider `resolveHostCredential`'s tool-path
  fallback, or say "not backed up yet".
- **`default` cannot be a pasted kind.** `accountProblem` refuses `default` with
  `setup-token`/`api-key`, because its secret path is the legacy login file.
  Phase 2 decides what `agentbox claude login --setup-token` without `--account`
  does (suggest a name, or give `default` a second path).
- **The shared `projects/` volume name** (`agentbox-claude-projects`) is not
  derived in core yet; Phase 3 adds it next to `accountConfigVolume`.
- **Removing a named account does not touch its docker volume or custody
  object.** `removeAccount` drops the row and the host secret only; Phase 2
  (`agentbox accounts rm`) must also drop `<volume>-acct-<id>` and refuse while
  a box records the account.
- **Rows of an uninstalled plugin agent** are hidden from reads but kept on
  disk (mutations pass rows they cannot validate through), along with their
  secret files under `~/.agentbox/credentials/<agent>/`. `agent rm` should
  offer to clean both.
- **Phase 3: `prune --all` would reap per-account docker volumes.**
  `packages/sandbox-docker/src/lifecycle.ts` (~895-925) builds `expectedVolumes`
  from each spec's base `dockerVolume` plus surviving boxes' volumes, and
  `agentbox-claude-config-acct-work` matches the `agentbox-` prefix. When Phase 3
  creates those volumes, add `accountConfigVolume(spec.dockerVolume, a.id)` for
  every `readAccounts()` row to the expected set.
- **A corrupt `accounts.json` blocks mutations** (`AccountsFileError`) until the
  user fixes or moves it; reads still show the `default`s. Phase 2's
  `agentbox accounts` should print the error's path and suggest
  `mv accounts.json accounts.json.bak`. Rebuilding rows from the files under
  `credentials/<agent>/` is possible, but the kind/label metadata is lost.
- **Plan's open Phase 0 items** (second OAuth login, codex symlink-on-refresh,
  revocation timing) are unchanged and still gate the docker storage choice for
  codex.

## From Phase 2 (logins)

- **Phase 3: an `api-key` account has no docker volume yet.** Its volume must be
  seeded at box create with `_claude.json` `customApiKeyResponses.approved`
  holding the key's last 20 characters (Phase 0 (a′)), and it must never hold an
  OAuth `.credentials.json`. `stripAccountState` already keeps the host's
  stored answer out of a named volume.
- **Phase 3: mount the shared `projects/` volume** (`agentbox-claude-projects`)
  over a named account volume's `~/.claude/projects`, so `--resume` works
  across accounts. A named volume today has its own `projects/`.
- **Phase 3: `agentbox accounts default <agent>/<name>`** writes
  `<agent>.account`, which Phase 3 introduces; deferred with it.
- **Re-seeding a named volume on every box create** (Phase 3) must pass
  `account` to `ensureVolume`, or the host's login is rsynced into it.
- **Renaming an account id** is not offered: the docker volume, Daytona subpath
  and custody path all derive from it. A rename would be a copy + remove.
- **`accounts rm` does not touch custody.** Named accounts never reach custody
  until Phase 4; add the custody delete then.
- **Not live-run in Phase 2:** a named OAuth login end to end (it needs a second
  real account) and a named-volume seed against a real image (the seed is
  covered by a docker-mocked test). Steps for the coordinator are in the PR.
- **A pasted secret read from a stdin pipe that never closes hangs** (a driver
  that is not a TTY and never sends EOF). Feed the secret with `< file` or a
  closed pipe; a read timeout is an option if it bites.
- **`dockerVolumeFileReader` runs one container per file** and reports any
  docker failure as an absent file ("the login did not leave a credential").
  One `tar` read and a distinct docker-error message would fix both.

## From the #433 review

- **MUST FIX before Phase 3 ships: `agentbox prune --all` deletes every named
  account volume.** `packages/sandbox-docker/src/lifecycle.ts` (~897-950)
  keeps only surviving boxes' volumes plus each spec's shared `dockerVolume`, so
  `agentbox-<agent>-config-acct-<id>` is reaped as an orphan. Harmless while no
  box runs on it (the store keeps the login), but once Phase 3 mounts it, the
  volume IS the live, refreshed copy and the store's copy is already revoked.
  Fix: add `accountConfigVolume(spec.dockerVolume, a.id)` for every named
  `readAccounts()` row to `expectedVolumes` (or keep any `-acct-` volume — `agent
  add` refuses that infix in a `dockerVolume`). Supersedes the earlier Phase 1
  line about prune.
- **MUST FIX before Phase 3 ships: the host's `settings.json` auth env reaches a
  named claude volume.** The named seed strips `_claude.json` account state and
  excludes `.credentials.json`, but `settings.json` is copied as-is: an owner
  `env.ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` or
  an `apiKeyHelper` there would make the account's warm-up (and in Phase 3 the
  box) run and bill on the owner's credential (Phase 0 (a′): the key wins in
  `-p`). Fix: when `account` is set, drop the auth-bearing `env.*` keys and
  `apiKeyHelper` in the `settings.json` `maybeFilterTo` pass.
- **A failed or cancelled first login leaves an orphan volume** (`…-acct-<id>`
  exists, no row, so `accounts rm` refuses it) until a `prune --all`. Remove
  the volume when a brand-new account's login does not complete.
- **`resetVolumeAccountState` fails hard on a corrupt `_claude.json`**: `jq`
  fails, execa throws, and every re-login of that account aborts until
  `accounts rm`. Fall back to removing the file (it is reseeded) or warn and
  continue.
- **A re-login whose warm-up turn fails loses the email/org label**: the reset
  removed `oauthAccount`, so the identity is plan-only and replaces the stored
  one. Keep the stored email/org when the new identity lacks them. Display only.
