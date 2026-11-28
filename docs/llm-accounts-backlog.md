# LLM accounts — backlog

> **2026-11-26:** `agentbox accounts` and `<agent> login --account/--setup-token/--api-key` are now `agentbox credentials` (`list`, `add`, `renew`, `use`, `rm`, `label`, `switch`); see [`credentials-tui-plan.md`](./credentials-tui-plan.md). Command names below are as they were when this was written.

Live list of open items found while building [`llm-accounts-plan.md`](./llm-accounts-plan.md).
Newest phase last.

## Closed in the 2026-11-28 sweep: listings and safety

Fixed (`fix/accounts-backlog`):

- **`default` listed from the agent's own login** too (`defaultLoginPaths`:
  the backup, then `~/.claude/.credentials.json`), so a host that signed in but
  never ran a box shows it, with `hasSecret`. A macOS keychain-only claude login
  still has no file to find.
- **`default` as a pasted kind** stays refused, by design: `default` IS the
  agent's login file. The message (CLI and `POST /api/v1/accounts`) now says to
  save it under a name and make that the default with `credentials use
  <agent>/<name> --global`.
- **A corrupt `accounts.json`** is reported by `GET /api/v1/accounts` as
  `storeError` (the file named, `mv … .bak` suggested), warned by `credentials`
  and shown on the Subscriptions page. Mutations already named it (#444).
- **(#444 c)** The label was dropped in #501; the remaining free text, the
  identity read off a login, is stripped of control characters and capped at
  120 characters where every surface reads it (`migrateAccountsFile`).
- **(#444 e)** The stale comments (`hub-worker.ts`, `backend/accounts.ts`, the
  accounts route) and the plan's `GET /accounts` shape are corrected; the CLI
  `accounts.ts` header went with the file in #499.
- **Plugin agent rows and secrets**: `agent remove` asks (or takes
  `--purge-accounts` / `--keep-accounts`) and deletes the rows, the
  `credentials/<agent>/` secrets and the `-acct-` volumes.
- **`sessionAccountPolicy` fails closed** on the suppress half: an unreadable
  registry forwards none of the agent's account keys.
- **(#442) A registration-store error** is `UNVERIFIABLE_ACCOUNT`
  (`registrationBoxAccount`); only an absent registration falls through to
  `state.json`.
- **`download codex <named-box>`** leaves `auth.json` in the box
  (`AgentPullOptions.excludeCredential`).
- **Settings from a default box reach named boxes** when the set holds only
  nested content (skills, prompts, plugins); the login file and any root config
  file (codex's `config.toml`) stay within the source box's account
  (`stagedItemsAreAccountBound`).
- **A stdin pipe that never closes** no longer hangs a pasted secret: the read
  ends once a full line has arrived and 1.5 s pass with no more data, and fails
  after 2 minutes with nothing at all.
- **A plugin credential whose `boxRelPath` contains `/`** is seeded from
  custody (`parts.slice(5).join('/')`).

Already done by later PRs:

- (#444 a) in-use list deduped by box id, and `GET /api/v1/accounts` reads the
  secrets in parallel through one `view()`: #482.
- (#444 d) `/api/v1` cookie writes need a same-origin `Origin` /
  `Sec-Fetch-Site` and a JSON body: #456.
- An `api-key` account's docker volume with the key pre-approved, and re-seeding
  passing `account` to `ensureVolume`: #437.
- `accounts default` became `credentials use [--global]`: #499.
- `credentials rm` removes the account's docker volume: #444.

Not fixed:

- **`status` reads the account store locally**: `status` is a docker-local
  inspect that does not use the hub at all, and the box and its store are on
  the same machine; switch it when `status` moves behind the hub.
- **Dropping the legacy `~/.agentbox/<agent>-credentials.json` for `default`**:
  not safe. That path is not an unreleased accounts detail. It is the login
  backup every released version (0.10 onward) writes and seeds boxes from, and
  the docker credential mirror, the relay fan-out, custody pushes and `hub
  credentials pull` all read it. Moving it would sign every existing install out
  of its boxes, or need the alias layer the project rules forbid.

## From Phase 1 (account model + store)

- **Phase 3: `prune --all` would reap per-account docker volumes.**
  `packages/sandbox-docker/src/lifecycle.ts` (~895-925) builds `expectedVolumes`
  from each spec's base `dockerVolume` plus surviving boxes' volumes, and
  `agentbox-claude-config-acct-work` matches the `agentbox-` prefix. When Phase 3
  creates those volumes, add `accountConfigVolume(spec.dockerVolume, a.id)` for
  every `readAccounts()` row to the expected set.
- **Plan's open Phase 0 items** (second OAuth login, codex symlink-on-refresh,
  revocation timing) are unchanged and still gate the docker storage choice for
  codex.

## From Phase 2 (logins)

- **Renaming an account id** is not offered: the docker volume, Daytona subpath
  and custody path all derive from it. A rename would be a copy + remove.
- **`accounts rm` does not touch custody.** Named accounts never reach custody
  until Phase 4; add the custody delete then.
- **Not live-run in Phase 2:** a named OAuth login end to end (it needs a second
  real account) and a named-volume seed against a real image (the seed is
  covered by a docker-mocked test). Steps for the coordinator are in the PR.

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

## From Phase 3 (selection + seeding)

The two Phase 3 must-fix items above are done: `prune --all` keeps every
`-acct-` volume, and the named claude seed strips `settings.json` auth env
(`env.ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`,
`apiKeyHelper`).

- ~~A named account's refresh does not travel until Phase 4~~ — done in Phase 4:
  the relay routes a refresh to its account's copy, custody path and boxes. The
  Phase 0 outage window (a refresh revokes the other holders until the fan-out
  reaches them) now applies per account; a setup token still avoids it.
- ~~The relay guard reads `~/.agentbox/state.json`~~ — it reads the box's
  REGISTRATION first now (#437-4), which also closes the cloud-create race
  (#437-5: the first credential post could beat `recordBox`), then state.json,
  failing closed when that is unreadable.
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

- ~~Settings propagate skips named boxes too (#437-8)~~ — Phase 4 scopes it to
  the source box's account instead (a pulled set can carry codex's `auth.json`).
  Since the 2026-11-28 sweep a set of only skills, prompts or plugins goes to
  every account.
- **Provider SDK republish**: community providers on the published SDK (an old
  inlined `createCloudProvider`) ignore `req.accounts` — the box comes up on the
  default login. Additive: `CreateBoxRequest.accounts`, `BoxRecord.accounts`,
  `AgentSyncSpec.accountEnv`.

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

## From the #444 review

Fixed in #444: the `POST` / `PATCH` / `DELETE /api/v1/accounts…` routes now
answer a store failure (a corrupt `accounts.json`) with the error envelope
naming the file, like `GET`, instead of a bare 500.

- **(b) MUST FIX before "accounts resolve against the requester's machine":**
  `credentials-fanout.ts` (~251) files a hub-side box's refreshed account login
  under the box's ORIGIN machine id, although the account itself came from the
  hub's own store — so it lands in PC B's custody slot. Key it by the hub's own
  machine id (or drop the update) until per-machine account lists exist. Same
  root cause: the hub accepts a remote PC's `--account` against its OWN store
  (the Phase 3 resolution), which only works because a remote hub has no rows.
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
- **A cloned box (`clone-create`) does not carry `llmProxy`** and goes direct.
  (Adopt/relaunch carry it since the #446 review: it rides the registration.)
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

### From the #446 review

Fixed in #446: B1 (`llmProxy` rides the registration, adopt and the hub
payload; a foreground create that asked for `forward` refuses to attach a box
without it) and B2 (a proxy-only HMAC credential replaces the relay token on
the unencrypted hub leg).

- **L1 An older hub silently drops `opts.llmProxy`**, so `forward` becomes
  direct with no warning on the `-i` / web paths (the foreground adopt path now
  refuses). Report unknown create opts back, or check `Box.llmProxy` after.
- **L2 `withSessionLlmProxy` fails open** when `state.json` cannot be read: the
  docker session starts unproxied. Refuse the launch instead when the read
  fails.
- **L3 (docs fixed)** The Phase 7 docs said the relay token never enters the
  agent's env; `AGENTBOX_RELAY_TOKEN` is in the container / provision env
  (pre-existing). The wording now only claims the token never goes to the
  proxy.
- **L4 Tunnels outlive a revoked token**, there is no idle timeout, and a
  client closing during the auth lookup leaks the upstream socket. Track
  tunnels per box (close on forget), add an idle timeout, destroy on client
  close before connect.
- **L5 The listener binds `0.0.0.0` even docker-only** (LAN exposure once
  opted in). Bind the docker bridge / loopback when no `llm.proxyUrl` is set.
- **L6 `llmHostsProblem` accepts IP literals**, so a plugin agent could add
  `127.0.0.1` and open the hub's loopback through the proxy. Refuse IPs and
  single-label names; resolve and refuse private addresses at connect.
- **L7 Provider SDK republish**: community providers on the old SDK have no
  `llmProxy` on `CreateBoxRequest` / the attach preamble, so their boxes go
  direct. Republish (additive, no `SDK_API_VERSION` bump).
- **L8 `create-action.ts` (~648-649) spreads `localLlmProxy()` twice** in the
  queued-create opts. Harmless (memoized, same value); drop one.
- **L9 A project-level `llm.proxyPort` / `llm.proxyUrl` is silently ignored**
  (they are global-only by design). Warn when a project config sets them.

## Closed in the 2026-11-28 sweep: docker and cloud

Fixed (`fix/accounts-backlog-docker`):

- **Shared `projects/` volume.** `sharedProjectsVolume` (core) names
  `agentbox-claude-projects`. It is mounted over `~/.claude/projects` on the
  default and every `-acct-` volume (not on `--isolate-claude-config`), so
  `--resume` works across accounts. Migration happens once per source volume:
  `ensureClaudeVolume` copies the volume's `projects/` in with `cp -a -n` (never
  over a file already there), hands it to uid 1000 and drops a
  `.agentbox-migrated-<volume>` marker. The old dir is left in place for a
  rollback. `prune --all` keeps the volume. A box still running from before
  keeps writing its own `projects/` until it is recreated; those later writes
  are not copied again.
- **An orphan `-acct-` volume after a failed first login** is removed
  (`dropOrphanAccountVolume`, only when the store has no row, retrying a few seconds while the aborted
  login container still holds it) on cancel,
  failure and capture error, in the generic login, claude's login and the
  headless worker.
- **`resetVolumeAccountState`** removes a `_claude.json` that `jq` cannot parse,
  and the login re-seeds it, instead of failing every re-login. A failed write
  (full disk) still fails the reset and keeps the file.
- **A re-login keeps the email and org** when the new identity lacks them
  (`mergeAccountIdentity`).
- **`dockerVolumeFileReader` reads every file in one container** (a base64
  line protocol), and a docker failure is its own error ("could not read the
  docker volume …"), not "the login did not leave a credential".
- **Pasted secrets off the docker argv (#437-6).** `dockerEnvByName` turns `-e
  KEY=VALUE` into `-e KEY`, with the value in the docker CLI's env, for `docker
  run` (create) and every agent's session `docker exec` (claude, codex,
  opencode, pi). Only secret-named keys (`KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`)
  move, so a box's `DOCKER_HOST` or `PATH` never reconfigures the host's docker
  client. The sync transport's `docker exec -e` (no secrets today) is unchanged.
- **A cloud box's pasted token is out of the sandbox create env.** It goes only
  to the 0600 agent env file that every launcher sources
  (`cloudAccountAuthority`). A create whose env file cannot be written then
  fails (and tears the sandbox down) instead of handing over a box with no auth. Not fixed on docker: the token stays in the
  container env, because whoever can `docker inspect` the container can also
  `docker exec` into it and read the agent's env, so it is no tighter boundary.
- **Named docker mirror.** One generic `syncNamedAccountCredential` for every
  agent replaces claude's root `cp -a` into `~/.agentbox` and codex's one-way
  seed. The volume's login goes to the store through `writeAccountSecret`
  (shape, freshness and identity gate, under the accounts lock), and the store
  seeds the volume over stdin when the volume is empty or older.
- **Codex named volume → store** is now superseded: since the hot-switch work
  (#502) every docker box has its own credential file, so a codex refresh
  reaches the store through the relay route, and the account volume is no longer
  the live copy. An agent with no freshness rule (codex) only fills a store that
  has no login yet from its volume. Mirroring "newer" from the volume can't be
  decided without a freshness field and would let a stale volume replace a
  re-login.
- **Three writers of `credentials/<agent>/<id>.json`.** The relay's named
  write and the custody seed now run under `withAccountsLock`, the lock the
  store's own writer and `accounts rm` take. The custody seed also checks the
  account's row first, so it never brings back a removed account's secret.
- **Daytona's account subpath seeded once.** With the marker present, a named
  login is reconciled newest-wins with the account's stored copy
  (`reconcileAgentCredentials`), as a wake does.

Not fixed: the remote control box message ("this machine") and every custody
item (owned by the hub subscriptions work), and the SDK republish (additive
fields only, listed in the PR).
