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
