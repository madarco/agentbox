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

## From Phase 3 (selection + seeding)

The two Phase 3 must-fix items above are done: `prune --all` keeps every
`-acct-` volume, and the named claude seed strips `settings.json` auth env
(`env.ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`,
`apiKeyHelper`).

- **No shared `projects/` volume yet.** A named account's volume keeps its own
  `~/.claude/projects`, so `--resume` works within an account but not across
  accounts (or between `default` and a named account). Mounting one shared
  `agentbox-claude-projects` over every volume would hide the transcripts that
  already live inside `agentbox-claude-config`; it needs a one-time migration.
- ~~A named account's refresh does not travel until Phase 4~~ — done in Phase 4:
  the relay routes a refresh to its account's copy, custody path and boxes. The
  Phase 0 outage window (a refresh revokes the other holders until the fan-out
  reaches them) now applies per account; a setup token still avoids it.
- ~~The relay guard reads `~/.agentbox/state.json`~~ — it reads the box's
  REGISTRATION first now (#437-4), which also closes the cloud-create race
  (#437-5: the first credential post could beat `recordBox`), then state.json,
  failing closed when that is unreadable.
- **A pasted account's token sits in the container env (docker) / sandbox env
  (cloud)**, visible to `docker inspect` and the provider console — the same
  exposure as today's host-key spray. A 0600 file read on demand would be
  tighter (see the "box secrets" preference); not done here.
- **Daytona: an account subpath is seeded once** (marker), like the default's.
  A later re-login in the store reaches RUNNING boxes through the Phase 4
  fan-out; a new box on that org volume still trusts the marker.
- **Codex named volume → store** is not mirrored back at start (claude's is);
  the Phase 4 relay route carries a codex refresh from the box's watcher to the
  account's copy, so only a refresh while no relay was listening is missed.
- ~~`agentbox create --account` on an agentless box~~ — now refused for any
  agent the box does not carry (only a borrowed lender can be named there);
  `agentbox <agent> --account` is the way.
- **A remote control box refuses `--account`** (it has no account store until
  Phase 5): the hub re-resolves `opts.accounts` against its own store and
  answers "no claude account 'work' on this machine". Deliberate — the CLI
  cannot hand a remote hub a secret it never received — but the message could
  say "this control box" instead of "this machine".
- **Each cloud create reads `accounts.json` once per agent** (stager, env
  policy). Correct, small; pass one read down if it ever shows up in a profile.

## From the #437 review

Fixed in the PR: `destroy` keeps `-acct-` volumes; `ensureAgentInstalled`
seeds the box's account (never the owner's default) and a pasted kind gets no
login file, with any stale one removed on cloud create; cloud named boxes get
the `_claude.json` + `settings.json` strip and API-key pre-approval; `accounts`
rides the relay registration and the hub `Box` payload; `checkpoint
--set-default` is refused from a box on a named account.

- **Pasted secrets on the docker argv** (#437-6): `docker run -e KEY=VALUE` and
  `docker exec -e` carry a pasted account's token, visible to `ps` while docker
  runs — like today's host-key spray, but the login flow kept it off argv on
  purpose. Pass `-e KEY` and the value through execa's `env`.
- ~~Settings propagate skips named boxes too (#437-8)~~ — Phase 4 scopes it to
  the source box's account instead (a pulled set can carry codex's `auth.json`).
  Settings pulled from a default box still do not reach named boxes; a
  login-free item set could go everywhere.
- **`agentbox download codex <named-box>`** copies the box's `auth.json`
  (account B) into the host's `~/.codex` when the host has none, where it
  becomes the default login. Skip `auth.json` for a named box.
- **Provider SDK republish**: community providers on the published SDK (an old
  inlined `createCloudProvider`) ignore `req.accounts` — the box comes up on the
  default login. Additive: `CreateBoxRequest.accounts`, `BoxRecord.accounts`,
  `AgentSyncSpec.accountEnv`.
- **`sessionAccountPolicy` fails open** to no policy when `state.json` cannot be
  read at session start (the host key is forwarded). Rare (atomic writes);
  consider failing closed for the suppress half.
- **The named docker mirror writes the account secret from a root container**
  (`SYNC_SCRIPT` `cp -a`), outside `writeAccountSecret`'s lock. Newest-wins like
  the default path; cosmetic.

## From Phase 4 (fan-out per account)

- **Account rows do not travel to custody** — only the secrets. A remote control
  box therefore still refuses a named create (it has no `accounts.json` row);
  Phase 5 brings the account list to the hub.
- **A pasted-kind account's secret is pushed to custody too** (so a hub can
  seed it later); it is static, so nothing ever fans it out.
- **`agentbox accounts rm` leaves the account's custody objects** on a control
  box (`agents/<agent>/accounts/<id>/…`). Add the delete when Phase 5 wires the
  hub's account list.
- **The custody push is hash-only, not newest-wins** (Phase 4 review): a PC
  holding an older copy of a named login re-uploads it over a newer one the
  hub's relay recorded from a refreshing box. The default login's push has the
  same shape today; fix both by gating the upload on the freshness field.
- **`agentbox hub credentials pull` only pulls the default objects**: a named
  account refreshed on the control box is not brought back to the PC. Mirror
  `seedAccountSecretsFromCustody` on the pull side.
- **A plugin credential whose `boxRelPath` contains `/`** is never seeded per
  account (the custody seed expects exactly `agents/<a>/accounts/<id>/<file>`).
  No built-in has one; compare `parts.slice(4).join('/')`.
- **Three writers of `credentials/<agent>/<id>.json`** (the store's
  `writeAccountSecret`, the relay, the custody seed); only the first takes the
  accounts lock. The relay now checks the row and kind first, so the window is
  an `accounts rm` landing between its check and its write.

## From the #442 review

Done in #442: `agentbox accounts rm` refuses while a box records the account
(running or borrowing it), and the propagate planner skips a named docker box
with no recorded volume instead of falling back to the shared default volume.

- ~~PHASE 5 MUST DESIGN: named custody objects are keyed by account name only~~ — designed and built in Phase 5: named logins are keyed by machine (`agents/<a>/accounts/<machine>/<id>/<file>`), pasted secrets no longer travel, a hub seeds only its own machine's. Original note:
  Account ids are local to each PC: PC A's `claude/work` and PC B's
  `claude/work` (a different subscription) both push to
  `agents/claude/accounts/work/.credentials.json`, and the push is hash-only,
  so the last pusher wins. The automatic credential sync also uploads every
  pasted API key / setup token, which nothing on the hub reads yet. Before
  Phase 5 consumes these objects: key them by owner/device (or carry the
  account identity), decide whether pasted secrets travel at all, and delete
  them on `accounts rm`.
- **A registration-store error reads as the default account** (already on
  nightly): `server.ts` maps a `store.getBox` rejection to undefined and falls
  through to `state.json`. Map it to `UNVERIFIABLE_ACCOUNT`, so a box missing
  from `state.json` too fails closed instead of routing a named login to the
  default.
- **The hub System page counts named-account custody objects as the agent's
  login** (`custody-view.ts` `summarizeAgentCredentials` groups by
  `agents/<agent>/`): a PC with only a named claude account shows Claude as
  logged in, but a hub create gets no default login. Count only
  `agents/<a>/<boxRelPath>`, and list accounts separately.

## From Phase 5 (surfaces)

- **A remote control box cannot run a PC's named account yet.** The custody
  objects are now keyed by machine, but the control box has no per-machine
  account list: a create there still resolves `--account` against the control
  box's own store and refuses. Next step: rows travel next to the secret
  (`agents/<a>/accounts/<machine>/<id>/account.json`), the control box keeps a
  per-machine account view, and a create resolves accounts against the
  REQUESTER's machine (`requester.machineId`) and seeds that machine's secret.
- **Old flat custody objects** (`agents/<a>/accounts/<id>/<file>`, pushed by a
  Phase 4 CLI) are left in place and never read again; a one-time cleanup can
  delete them.
- **`accounts rm` still leaves the machine's custody objects** on a control box.
  Add the delete with the per-machine account view above.
- **The tray** (`../agentbox-tray`) does not show accounts yet (Phase 6):
  `Box.accounts` / `Box.accountsInfo` and `/api/v1/accounts` are ready for it.
- **No docs figure for the Accounts page** yet; capture one per
  `apps/web/images.md` with the next screenshot round.
- **`agentbox status` reads the account store locally** for its ACCOUNTS
  labels instead of the hub's `Box.accountsInfo`; same data, two lookups
  (Phase 5 review). Switch it when `status` moves behind the hub.
- **`GET /api/v1/accounts` reads each secret sequentially** to set
  `hasSecret`, and the list and single-account views build the shape twice.
  Small; `Promise.all` over one `view()` when it matters.

## From the #444 review

Fixed in #444: the `POST` / `PATCH` / `DELETE /api/v1/accounts…` routes now
answer a store failure (a corrupt `accounts.json`) with the error envelope
naming the file, like `GET`, instead of a bare 500.

- **(a) The in-use list shows a docker box twice**: `hub-backend.ts` (~2162)
  feeds the accounts slice `state.json` boxes AND relay registrations, so a
  docker box present in both is named twice in `boxes`. Dedupe by box id.
- **(b) MUST FIX before "accounts resolve against the requester's machine":**
  `credentials-fanout.ts` (~251) files a hub-side box's refreshed account login
  under the box's ORIGIN machine id, although the account itself came from the
  hub's own store — so it lands in PC B's custody slot. Key it by the hub's own
  machine id (or drop the update) until per-machine account lists exist. Same
  root cause: the hub accepts a remote PC's `--account` against its OWN store
  (the Phase 3 resolution), which only works because a remote hub has no rows.
- **(c) API labels have no length or control-character limit**, and the CLI
  prints them raw (`agentbox accounts`, `status`). Cap the length and strip
  control characters at the API boundary.
- **(d) All of `/api/v1`**: a page on another `localhost` port can send a
  `text/plain`, cookie-authenticated `POST` (a "simple" request: no CORS
  preflight), because the gate checks neither `Content-Type` nor `Origin`.
  Require `application/json` or a same-origin `Origin` on writes.
- **(e) Stale text**: comments in `hub-worker.ts` (~127-133, the account seed),
  `apps/hub/lib/backend/accounts.ts` (lines 1-5, still "a remote control box
  has no account store yet (Phase 5)"), the `apps/cli/src/commands/accounts.ts`
  header; and the plan says `GET /accounts` returns `agents [{id, name,
  kinds}]` while the code returns `{id, kinds}`.
- **(f) `custody-client.ts` (~311) reads the machine id before the account
  loop**, so a failure reading it also skips the DEFAULT-login push. Read it
  lazily inside the loop (or catch it), so the default push never depends on it.

## From Phase 7 (hub egress proxy, `forward`)

- **No live egress check from a real cloud box yet.** It needs the hub's
  `llm.proxyPort` published on a public address (`llm.proxyUrl`); the local
  chain was verified live (plan, Phase 7 item 8). Steps are in the #PR body.
- **The split proxy is started at agent launch, not supervised.** If it dies
  mid-session the agent gets a refused connection (claude retries those
  silently). A relaunch restarts it. Move it under ctl's supervisor when the
  image next changes.
- **The hub allowlist is the union of every agent's `llmHosts`**, not the
  box's own agents: a claude box's token can tunnel to `chatgpt.com`, and an
  installed plugin agent (`agentbox agent add`) can add any syntactically valid
  host to it (Phase 7 review). The plugin is user-installed, but narrow the
  allowlist by the registration's agents and keep plugin hosts behind an
  explicit grant. The list is also read once per process: a plugin added after
  the hub started is not allowed until a restart.
- **A failed proxy auth is not throttled** (Phase 7 review). The listener only
  runs after a global opt-in, but a reachable `llm.proxyPort` allows unlimited
  token guesses. Rate-limit 407s per peer.
- **`llmProxy` is not on the relay registration**, so a box rebuilt from its
  registration (`hub adopt`, reverse adoption) or cloned (`clone-create`) comes
  back without it and goes direct. Carry it on the registration and the clone.
- **A control-box create resolves the mode from that hub's global
  `llm.proxy`** when the client sends none: it has no project config. The CLI
  sends `forward` when the project says so; a project's explicit `off` against
  a hub whose global is `forward` still lands on `forward`.
- **Agents without `llmHosts` (opencode, pi, plugins, the openclaw service
  units) are never proxied**, even in a box recorded `forward`, and nothing
  warns at create (Phase 7 review). Documented; warn, or refuse `forward` for
  such an agent, once more agents can declare hosts.
- **No UI for it**: the web create dialog has no LLM-proxy toggle and the
  tray shows nothing; `Box.llmProxy` is in the payload for both.
- **Successful tunnels are not logged or counted**; only refusals are.
