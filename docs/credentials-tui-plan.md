# `agentbox credentials`: one place for subscriptions and keys

`agentbox accounts` (list, rm, label, switch) and `agentbox <agent> login --account …`
(add a named login, setup token or API key) were two halves of one job, and
neither could tell you that a login had died. This plan folds both into
`agentbox credentials`. It has an interactive TUI when run bare in a terminal,
scriptable subcommands for agents and CI, and a hub-side "revoked" status that
the web Subscriptions page and the tray can show too.

Every action drives the hub `/api/v1` (the CLI is an `/api/v1` client; the web
UI and the tray share the same routes). The account store is per machine, so
the CLI asks its **local** hub (`withHubClient({ preferLocal: true })`), as
`accounts` did. Signing a login in is the one step that is not an API call: it
runs the agent's own OAuth flow in a throwaway container on the PC, the same
path `agentbox <agent> login` takes. A hub route then takes over from there
(fan-out).

## What was measured (Phase 0, 2026-11-26)

All of this ran against claude 2.1.326 with **fake** tokens in a scratch
`HOME`, so the owner's real login was never touched (a real refresh rotates
the refresh token and would sign every other holder out).

| Case | `claude -p` result | Transcript line | Credentials file after |
| --- | --- | --- | --- |
| Login, bogus access token, `expiresAt` in the future | `Failed to authenticate: OAuth session expired and could not be refreshed` (`terminal_reason: api_error`, exit 0) | `type: assistant`, `error: "authentication_failed"`, `isApiErrorMessage: true`, `message.model: "<synthetic>"`, zero usage | **wiped**: `accessToken: ""`, `refreshToken: ""`, `expiresAt: 0` |
| Login, bogus tokens, `expiresAt` in the past (the "refresh token rotated away" shape) | same | same | wiped |
| Setup token (`CLAUDE_CODE_OAUTH_TOKEN`) bogus | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` | `error: "authentication_failed"` | n/a |
| API key (`ANTHROPIC_API_KEY`) bogus | `Invalid API key · Fix external API key` | `error: "authentication_failed"` | n/a |

Usage endpoint (`/api/oauth/usage`, what `account-limits.ts` reads) with a
bogus bearer: **429**, not 401. It rate-limits before it authenticates, so
it can't detect a revoked login and is not used for one.

What this means for the hub:

1. **The transcript is the signal.** Every dead credential kind writes the
   same `error: "authentication_failed"` assistant line, and the hub already
   receives every box's transcripts (agent history, relay docker shipper / ctl
   shipper). The claude parser emits an `auth` history record on that line
   (never on a line copied from another session: a `/branch`, a fork). At
   ingest the hub records it in `history_auth`, keyed by **(account, box)**
   with the account the box runs on at that moment (not the session's first
   account stamp, which a `credentials switch` + `--resume` keeps), next to
   the newest successful reply (a `usage` record with output tokens).
2. **An account is `revoked`** when **any box** on it has its newest auth
   failure newer than both that same box's newest successful reply and the
   last write of the stored secret; `auth.box` names that box. So a renew
   (new secret) clears it, and so does that box getting a real answer
   again, but not another box's healthy reply (one box's refresh can rotate
   the token out from under the others). Nothing is pushed per tool call and
   nothing new runs in the box.
3. The signal needs a turn: a box nobody talks to never fails. That is when
   the user would see "Please run /login" anyway, and it is enough to badge
   the account everywhere and offer Renew.
4. Not measured, because it would need rotating the real refresh token:
   whether the old access token dies with its refresh token. It does not
   matter for 1–3.

Box-side signal kept for later (Phase 4): the wiped credentials file. ctl's
credentials watcher sees it change but ignores it (not a real blob). It could
report `credentials-dead` with no turn needed, but that needs a ctl/image
change on every provider.

## Phase 1 (done): CLI merge, TUI, revoked status, renew, defaults, `ls`

CLI:

- `agentbox accounts` is **deleted** (no alias). `agentbox credentials` takes
  over:
  - bare, on a TTY: the TUI (a cli-kit `tableSelect` table since Phase 1b).
    Without a TTY it prints the list.
  - `credentials list [--json]`: one row per account grouped by agent: kind,
    label, identity (email, plan), status (`ok` / `expiring` / `revoked` /
    `at limit` with the plan meters), the boxes on it, and `default` markers.
  - `credentials add <agent>/<name> --login | --setup-token | --api-key [--label]`.
    Pasted kinds go to `POST /api/v1/accounts` (secret from a hidden prompt or
    stdin, never argv); a login signs in on the PC (the old
    `login --account` path, `account-login.ts`).
  - `credentials renew <agent>/<name> [--skip-sign-in]`: sign in again, then
    `POST /api/v1/accounts/:agent/:id/renew`, which fans the login out to
    that account's boxes (the `credentials propagate` mechanics).
    `--skip-sign-in` pushes the stored login as it is (a box was broken but
    the store is fine).
  - `credentials rm`, `credentials label`, `credentials switch <box> <agent/account>`
    (from `accounts`).
  - `credentials use`: per agent, the account a new box in this project would
    get and where that comes from (project setting, global setting, default
    login). `use claude/work` sets it for this project; `--global` sets the
    global default; `use claude --clear` drops the project setting (or the
    global one with `--global`). Validated against the store by the hub.
  - `credentials propagate` stays (hidden; the relay spawns it).
- `agentbox <agent> login` keeps only the default-account path: `--account`,
  `--label`, `--setup-token` and `--api-key` are removed from `login`.

Hub (`/api/v1`):

- `GET /api/v1/accounts[?project=<abs path>]`: each account gains
  `auth: { state: 'ok' | 'expiring' | 'revoked', since?, box?, detail? }` and
  `default: { global?: true, project?: true }`. The payload gains
  `defaults: { <agent>: { account, source: 'project' | 'global' | 'default', global?, project? } }`.
- `GET /api/v1/accounts/default[?project=]`: the `defaults` map alone.
  `PUT /api/v1/accounts/default` `{ agent, account | null, scope?: 'global' | 'project', project? }`
  writes `<agent>.account` in that config layer (`null` clears), refusing
  an account the store does not have.
- `POST /api/v1/accounts/:agent/:id/renew`: fans the account's stored login
  out to its boxes (spawns `credentials propagate --account`), answers
  `{ pushed, failed, output }`.
- Box payload: `subscriptions: { <agent>: '<agent>/<account>' }` (pure, from
  the record's `accounts` + `borrowedCredentials` via `subscriptionOf`), so
  `agentbox ls` shows a SUBSCRIPTION column and `ls --json` carries it with no
  extra request per box.
- `expiring`: a setup token within 30 days of its one-year life (from the
  account's `createdAt`).

Web: Settings → Subscriptions shows a `Default` badge per agent's global default
and a "Make default" action on every other account card (the `PUT` route).

## Phase 1b (done): one Name per account, the table TUI

- **Name, no label.** An account has one name, its id. A new name is
  normalized by `normalizeAccountName` (`@agentbox/core`): lowercased, runs of
  spaces or `-` become `_` ("Work Max" -> `work_max`), anything else refused.
  `accountIdProblem` still accepts an existing id with `-`; only new names are
  normalized (`credentials add`, the TUI, and the hub's `POST /api/v1/accounts`,
  which matches an existing id as is). The `label` is gone from the store type,
  the CLI (`credentials label`, `add --label`, Relabel), the hub
  (`PATCH /api/v1/accounts/:agent/:id`, the POST body, `AccountView.label`,
  `Box.accountsInfo[].label`) and the web Subscriptions page. A label already in
  `~/.agentbox/accounts.json` is ignored on read, not migrated. The list
  drops its `LABEL` column; the piped table keeps the `ACCOUNT` header scripts
  match on, the TUI's table calls the same column `NAME`. The tray still reads
  `label` (it was optional, so it just stops showing).
- **Table TUI.** Bare `agentbox credentials` (and `agentbox skills`) is one
  cli-kit `tableSelect` screen: action rows above a bordered table whose rows
  are selectable; Enter on an account opens the per-account actions, and the
  table comes back refreshed after each one.

## Phase 2 (done): sign in from the hub, Renew in the web UI

- **Hub-driven sign-in.** `POST /api/v1/accounts/:agent/:id/login` starts the
  agent's own login on the hub's machine and answers a session view (never a
  secret): `starting` → `awaiting-code` (claude: open `url`, post the code to
  `…/login/code`) or `awaiting-approval` (codex device auth: open `url`, enter
  `userCode`) → `exchanging` → `pushing` → `done` (with the fan-out's
  `renew: { pushed, failed, output }`), or `error`. `GET …/login` reads it,
  `DELETE …/login` cancels. A new name adds the account; an existing login is
  renewed; one sign-in per account.
- **Shape.** PKCE needs the URL-printer to be the code-exchanger, so the hub
  slice (`apps/hub/lib/backend/account-login.ts`) spawns a detached CLI worker
  (`agentbox _account-login-worker <id>`) that holds the login container, the
  same pattern as the headless `claude login` and the create job's
  `jobs/:id/login-code`. They talk through `~/.agentbox/account-login/<id>/`
  (`request.json`, `state.json`, a 0600 `code` file consumed on read,
  `renew.json`; the contract is `@agentbox/sandbox-core`
  `account-login-session.ts`). The worker is agent-neutral: it uses the
  runtime's `loginBinding({ volume })`, `ensureVolume`, `accountIdentity` and
  the new optional `resetAccountVolume` (claude drops the cached profile), and
  stores a named login with `captureVolumeLogin` or the default one with
  `captureDefaultLogin`. On `signed-in` the hub runs the renew fan-out, so
  running boxes get the new login. Restart-safe: a session that reached
  `signed-in` with no hub watching is fanned out on the next read.
- **Identity.** A renew whose browser signed in another identity (email, else
  org) than the account holds stores nothing and ends `error` with
  `mismatch: { stored, signedIn }`; `replace: true` stores it anyway. An
  identity that cannot be read is refused the same way (fail closed). Checked
  before claude's finalize copies the default login into the backup. The
  login writes into the volume boxes mount live, so the credential and the
  identity files are snapshotted first and put back on a refusal (a file that
  was absent is removed); boxes may see the other login for the seconds
  between the login's exit and the restore. A `replace` start refuses to join
  a sign-in in flight without it.
- **Safety.** Only a pid whose command line names `_account-login-worker
  <session>` is ever signalled (a restarted control box can reuse an old pid).
  A cancel while a code is being exchanged or the login stored waits for it
  to finish (and be fanned out). The fan-out watcher starts on start, on a
  code submit and on any read, and waits through a worker that has not
  written its state yet.
- **Where it runs.** Always the hub's own machine and store: the PC's on a
  local hub, the control box's on a remote one (it has docker and the CLI).
- **Web.** Settings → Subscriptions: a `Revoked` badge from `auth.state` (and
  `Expiring`), "Seen failing in <box>" linking to the box, a Renew button on
  every login (primary when revoked), and an **Add a login** form; both open
  the sign-in dialog (URL, code field, progress, result).

## Phase 3: tray

`../agentbox-tray` is not reachable from a box; the coordinator builds it on
the contract below (also in the PR body).

- Revoked badge: `GET /api/v1/accounts` → `accounts[].auth = { state: 'ok' |
  'expiring' | 'revoked', since?, box?, detail? }`; `box` is the box name.
- Renew / add: `POST /api/v1/accounts/{agent}/{id}/login` `{ mode?: 'add' |
  'renew' }`, open `url` in the browser, then either post
  `POST …/login/code` `{ code, session }` (state `awaiting-code`) or just poll
  `GET …/login?session=` (state `awaiting-approval`, show `userCode`) until
  `done` / `error`. `DELETE …/login` on dismiss.
- Default subscription: `defaults[agent]` from the list; clicking another
  account calls `PUT /api/v1/accounts/default` `{ agent, account | null,
  scope: 'global' }`.
- Any shelled `agentbox accounts …` becomes `agentbox credentials …`.

## Phase 4 (done): detect a dead login without a turn

- **ctl credentials watcher** (`packages/ctl/src/credentials-watcher.ts`): a
  claude credential file in the wiped shape (`claudeAiOauth.accessToken: ""`
  and no refresh token, `isWipedCredentialText`) posts
  `credentials-dead` `{ schema: 1, agent, wipedAt }` (`wipedAt` = the file's
  mtime; never its contents) once per transition: it reports again only
  after a real login came back in between. A post the relay did not take is
  retried next tick. A ctl restart re-reports the same `wipedAt`, which is
  idempotent. When a real login comes back after a reported wipe (the
  fan-out repaired the box), and on the watcher's first real read (a ctl
  restart forgets a wipe it reported), it posts `credentials-alive`
  `{ schema: 1, agent, at }`, recorded as that box's newest working reply, so
  an idle repaired box does not keep the account `revoked`. A redundant one is
  a no-op (the newest time wins). The relay clamps both events' box time to
  its own receive time.
- **Relay** (`packages/relay/src/credentials-dead.ts`): a host relay hands it
  to the hub's history sink (`HistoryIngestSink.recordCredentialsDead`, direct
  POST for docker boxes, the cloud poller for cloud boxes); a box-mode relay
  lets it ride the ring to the host poller like `credentials-updated`. A
  relay with no hub sink (an HTTP forwarder) drops it with a log line.
- **Hub**: recorded in `history_auth` as a refusal keyed (account, box), the
  account from the box record (`subscriptionOf`), `error: 'credentials-dead'`,
  new column `fail_source = 'box'` (transcript refusals are `transcript`).
  `accountAuthState` treats it like any refusal, so a renew (newer secret) or
  a later real reply in that box clears it, and the account view carries
  `auth.source: 'transcript' | 'box'`.
- **Codex / opencode / pi: measured 2026-11-28** with fake credentials in a
  scratch `HOME` (codex-cli 0.172.0, opencode 1.19.6, pi via
  `@mariozechner/pi-coding-agent`). None of them rewrites its credential file
  on a refusal (`auth.json` is left byte-identical), so **there is no
  file-side signal for them**, only the transcript. Each now emits the same
  `auth` record (`error: 'unauthorized'`, never the provider's message, which
  can quote part of the key):
  - codex: `event_msg` / `task_complete` with
    `error.codex_error_info: "unauthorized"` (a ChatGPT login whose refresh
    failed: "Your access token could not be refreshed") or
    `{ http_connection_failed: { http_status_code: 401 } }` (a bogus API key).
  - opencode: the completed assistant message row carries
    `error: { name: 'APIError', data: { statusCode: 401 } }`.
  - pi: the assistant message has `stopReason: "error"` and an
    `errorMessage` starting with the provider's `401`.
  Codex and pi skip a refusal line older than the session's own start (a fork
  replaying its parent's lines). Not measured: a real codex ChatGPT refresh
  token rotated away (it would need the owner's login); the fake-token run
  hits the same refresh-failed path.

## Known gaps (from the Phase 1 review)

- **The TUI exits on a failed or cancelled sign-in.** Fixed: the login path
  (`runAgentLogin`, claude's login command) throws; the subcommands still end
  with exit 1, the menu reports it and comes back.
- **Renew runs its own propagate.** Fixed: the hub's renew runs on the relay's
  `CredentialsFanout` per-(agent, account) chain (`runExclusive`), dropping a
  refresh fan-out still in its debounce (the renew pushes a superset).
- **`ls` fallback for an older hub** derives subscriptions from `accounts`
  alone and ignores a borrowed login (`codex/…` under openclaw). A current hub
  sends `subscriptions`.
