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
- **Plan's open Phase 0 items** (second OAuth login, codex symlink-on-refresh,
  revocation timing) are unchanged and still gate the docker storage choice for
  codex.
