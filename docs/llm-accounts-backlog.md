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

- **The shared `projects/` volume name** (`agentbox-claude-projects`) is not
  derived in core yet; Phase 3 adds it next to `accountConfigVolume`.
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

- **Phase 3: mount the shared `projects/` volume** (`agentbox-claude-projects`)
  over a named account volume's `~/.claude/projects`, so `--resume` works
  across accounts. A named volume today has its own `projects/`.
- **Renaming an account id** is not offered: the docker volume, Daytona subpath
  and custody path all derive from it. A rename would be a copy + remove.
- **Not live-run in Phase 2:** a named OAuth login end to end (it needs a second
  real account) and a named-volume seed against a real image (the seed is
  covered by a docker-mocked test). Steps for the coordinator are in the PR.
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
  Since the 2026-11-28 sweep a set of only skills, prompts or plugins goes to
  every account.
- **Provider SDK republish**: community providers on the published SDK (an old
  inlined `createCloudProvider`) ignore `req.accounts` — the box comes up on the
  default login. Additive: `CreateBoxRequest.accounts`, `BoxRecord.accounts`,
  `AgentSyncSpec.accountEnv`.
- **The named docker mirror writes the account secret from a root container**
  (`SYNC_SCRIPT` `cp -a`), outside `writeAccountSecret`'s lock. Newest-wins like
  the default path; cosmetic.

## From Phase 4 (fan-out per account)

- **A pasted-kind account's secret is pushed to custody too** (so a hub can
  seed it later); it is static, so nothing ever fans it out.
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

## From Phase 5 (surfaces)

- **The tray** (`../agentbox-tray`) does not show accounts yet (Phase 6):
  `Box.accounts` / `Box.accountsInfo` and `/api/v1/accounts` are ready for it.
- **No docs figure for the Accounts page** yet; capture one per
  `apps/web/images.md` with the next screenshot round.

## From the #444 review

Fixed in #444: the `POST` / `PATCH` / `DELETE /api/v1/accounts…` routes now
answer a store failure (a corrupt `accounts.json`) with the error envelope
naming the file, like `GET`, instead of a bare 500.


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

## Fixed in Phase 9 (hub-owned subscriptions, 2026-11-28)

[Phase 9](./llm-accounts-plan.md#phase-9-hub-owned-subscriptions-on-a-remote-hub):
on a remote hub a subscription belongs to the hub. These items are done:

- **#444 (b)** the relay filed a hub-side box's refreshed named login under the
  box's ORIGIN machine. It now uses the hub's own machine id
  (`CredentialsFanout` `machineId`), the path the hub seeds from.
- **Account rows did not travel; a remote control box refused `--account`, or
  built a box recorded on an account it could not seed** (the 2026-11-28
  incident; also the Phase 3 "refuses `--account`" message and the Phase 5
  "cannot run a PC's named account yet"). A PC imports its logins and keys with
  `POST /api/v1/accounts/import`; the worker resolves `opts.accounts` against
  the hub's store (the requester's own name first) and fails the job when it
  cannot seed one.
- **`accounts rm` / `credentials rm` left the custody objects** (the Phase 2,
  Phase 4 and Phase 5 notes). `rm` on the hub deletes the hub's copy and every
  PC copy it was imported from, and tombstones the mappings.
- **`hub credentials pull` pulled only the default objects.** It now pulls this
  PC's named logins too (newest-wins, under the PC's own name).
- **#444 (f)** the machine id was read before the account loop: now lazily, and
  the import path never needs it for the default login's decision.
- **The custody push was hash-only, not newest-wins** (default and named): the
  import is newest-wins ON THE HUB, so a PC with only the API key (which cannot
  read custody to compare) no longer puts a revoked copy back. The custody PUT
  stays as the fallback for an older hub.
- **Old flat custody objects** (Phase 4) and the Phase 5 per-PC copies are
  deleted by the import that supersedes them.
- **#442 System page** counted named-account objects as the agent's login: it
  now counts `agents/<a>/accounts/…` apart ("no default login + N named").
- **#444 (e), part:** the stale "a remote control box has no account store"
  comments in `apps/hub/lib/backend/accounts.ts` and `hub-worker.ts`.

## From Phase 9 (hub-owned subscriptions)

- **A PC's `default` that is the subscription of a hub NAMED account** stays two
  hub accounts (the default import does not dedupe into named ones), so two
  refresh chains revoke each other. The reverse (a named login equal to the
  hub's default) is merged.
- **`agentbox create --account claude=…` (an agentless box borrowing a lender)
  still checks the PC's store** before a hub-routed create; only the agent
  commands (`agentbox claude --account`) send the bare name. Move `create` to
  `resolveBoxAccounts({ verify: false })` when its target is remote.
- **`credentials --local rm`** removes this PC's account only; the hub keeps its
  imported copy (by design: the hub owns it). An account removed on the hub
  stays on the PC until `--local rm`.
- **`credentials switch` on a PC with a remote hub** asks the remote hub, so a
  local docker box needs `credentials --local switch`.
- **An identity-less login** (no `accountUuid` in the blob, no email on the row)
  never merges: a second PC's copy of the same subscription under the same name
  gets a suffix.
- **The tray** shows nothing of `importedFrom` (optional; Swift `Codable`
  ignores unknown keys, so nothing breaks).
- **An import batch re-reads the store per item** (the rows, each row's secret,
  the default backup) inside the importer's lock (Phase 9 review). The flat
  custody sweep runs once per batch now; reading the rows and owner keys once
  per batch and updating them as items land would make a 64-item push cheaper.
  Small today (a PC has a handful of logins).
