# Hub settings: one Settings section, subscriptions with limits and switching, skills, files — plan

> **2026-11-26:** `agentbox accounts` and `<agent> login --account/--setup-token/--api-key` are now `agentbox credentials` (`list`, `add`, `renew`, `use`, `rm`, `label`, `switch`); see [`credentials-tui-plan.md`](./credentials-tui-plan.md). Command names below are as they were when this was written.

**Status:** Phases 1, 2, 3a, 3b, 3c and 4 done (2026-11-25, `feat/hub-settings-nav`,
`feat/hub-settings-skills`, `feat/hub-settings-subs`, `feat/hub-settings-limits`,
`feat/hub-settings-switch`, `feat/hub-settings-files`), plus the per-skill skip
(`feat/hub-settings-skill-skip`) and the fix for skill uploads over 10 MB stored truncated
(`fix/skill-upload-truncated`). 3c ships token switches on every provider and login switches on
docker for claude; cloud and codex login switches are in the backlog.

The hub web UI grew one top-level page per feature: Approvals, Custody, Skills, Accounts, Usage,
Devices, Settings, System. The design in `../agentbox-design` (`AgentBox Control Plane (shadcn).html`,
`control-shadcn/views-env.jsx` + `env-data.jsx`) groups the configuration pages under one Settings
section, adds subscriptions with plan-limit meters and account switching, and a skills table that
compares the hub with the PC.

This plan moves the hub web to that shape. Where it departs from the design, the owner's direction
wins:

- **No second sidebar.** The design's Settings page has its own left nav (`PaneLayout`). Here the
  Settings sub-pages are links **nested under Settings in the main sidebar**.
- **Accounts become Subscriptions.** Limit meters show the windows the account **actually has**, not
  the design's fixed "5-hour session + weekly" pair (see "Plan limits today").
- **Switching a box to another account is in scope**, by hand and automatically at the limit.
- **MCPs are skipped** for now (no page, no nav item).
- **Files** is new. It is the custody: what the hub holds for boxes. Read-only.
- **System and Devices** move under Settings.
- **Skills stay global.** Every box gets the whole library, whatever its agent; no per-agent
  delivery. No project picker and no per-project or per-workspace editing in the web: settings are
  edited from the CLI today, and the web follows it.
- The tray redesign of skills and subscriptions comes later. The API this plan adds is shaped so the
  tray can use it unchanged.

## What exists today

Facts the phases build on (paths under `apps/hub` unless noted):

- **Sidebar** `components/app-sidebar.tsx`: flat. One "Workspace" label over Dashboard, Approvals,
  Custody, Skills, Accounts, Usage, Devices, Settings, System, Docs, API; then one item per project.
  `SideItem` has no children. Active state is `pathname.startsWith`. Breadcrumbs
  (`components/topbar.tsx`) know only `projects/*`, `boxes/*` and `settings`.
- **Settings** `app/(dashboard)/settings/page.tsx`: sandbox providers (credentials, prepare),
  remote docker hosts, the GitHub App card and repos.
- **Accounts** `accounts/page.tsx` over `GET/POST /api/v1/accounts`, `PATCH/DELETE
  /accounts/{agent}/{id}`. An account is `{agent, id, label?, kind: login|setup-token|api-key,
  identity?{email, org, plan}, hasSecret, boxes[]}`. No limit data anywhere; per-account token
  counts exist only as `GET /usage?by=account`. A box's account is chosen at create and recorded on
  `BoxRecord.accounts`; switching a running box is in the accounts plan's backlog
  ([`llm-accounts-plan.md`](./llm-accounts-plan.md) §Backlog). A named account on docker mounts
  its own config volume (`accountConfigVolume`), on a cloud its own subpath
  (`accountCloudSubpath`): the account is baked into the box's mounts, which is what makes switching
  more than a credential swap.
- **Skills** `skills/page.tsx` (+ add-source, editor, update/diff dialogs), box detail
  `boxes/components/skills-panel.tsx`, a picker in the create modal. Hub skills plan Phases 0-7 are
  done ([`hub-skills-plan.md`](./hub-skills-plan.md)). Every skill reaches every agent of every box.
  A skill row carries `source{host, machineId, path}`: the PC dir it was imported from. **Hub vs
  PC** (`same | differs | local-only | hub-only`) exists only in the CLI TUI
  (`apps/cli/src/lib/skills/sync.ts`); the web cannot see the PC's skills.
- **Custody** `custody/page.tsx`: read-only listing of `GET /custody`, grouped by store scope
  (`agents`, `projects`, `prepared`, `skills`, `boxes`).
- **System** `system/page.tsx` (`GET /system`) and **Devices** `devices/page.tsx` (enrolled PCs,
  pending codes, approve, rename, revoke). The CLI prints the enrollment link from the hub's
  `verificationPath`, so the hub decides that URL.

### Plan limits today

Checked 2026-11-25. The windows differ by plan and change over time, so the UI must render whatever
the source reports and never assume a set:

- **Claude** ([support article](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan)):
  Pro and Max have a 5-hour session limit and a weekly limit; Max and Ultra also a separate weekly
  limit for Fable; **verified Ultra accounts have no 5-hour limit**, weekly only. No daily limit.
- **Codex:** Plus has a 5-hour window (restored 2026-08-25) and a weekly one; Pro is reported as
  weekly only. Every codex `event_msg.token_count` in the session transcript carries `rate_limits`
  (`primary` / `secondary`: `used_percent`, `window_minutes`, `resets_at`, `plan_type`), so the
  window length comes with the data. The live-status parser drops it today.
- **Claude** writes no limits to the transcript. The source is to be found in Phase 3's PoC.

## Target navigation

```
Dashboard            5
Approvals            2
Usage
Settings                  (expands while on /settings/*; collapsed otherwise, with a chevron)
  General                 providers, remote docker hosts, GitHub
  Subscriptions   1 at limit
  Skills          9
  Files
  Devices
  System
Docs ↗
API ↗
PROJECTS
  my-app             2
  …
```

Routes: `/settings` (General), `/settings/subscriptions`, `/settings/skills`, `/settings/files`,
`/settings/devices`, `/settings/system`. The old `/accounts`, `/custody`, `/skills`, `/devices`,
`/system` pages are deleted. Three have callers outside the hub that already shipped, so they get a
permanent redirect instead of a 404: `/skills` (the tray's "Review skills in Hub",
`AppDelegate.swift:550`), `/devices` (the enrollment `verificationPath` an older hub printed) and
`/system` (a PC hub's "Bake details on the control box" link, `<control box>/system`, which must
work against control boxes of either version).
Usage stays top-level: it is a report, not configuration.

## Phases

Each phase is one PR into `nightly`, built in an agentbox. Phase 1 goes first because it moves every
page; Phases 2, 3 and 4 then run **in parallel** (disjoint route folders and backend slices).

### Phase 1 — navigation and moves (hub web only) — done

- `SideItem` gains `children`: a nested, indented list under its parent. The parent is active on any
  child route; a child on its own subtree. `aria-current` and keyboard behave like the existing
  items. The mobile sheet shows the same tree.
- Move the pages under `app/(dashboard)/settings/`: `subscriptions` (today's Accounts page, renamed,
  no behavior change yet), `skills`, `files` (today's Custody page, renamed), `devices`, `system`.
  General is today's Settings page.
- Redirects for `/skills`, `/devices` and `/system`, query string kept (so `?code=` still pre-fills). The hub's
  `verificationPath` points at `/settings/devices`.
- Breadcrumbs: `control / settings / <sub>`. Every in-app link to the old paths updated (System, the
  skills dialogs, the custody page, the box detail skills panel).
- Tray: `reviewSkillsInHub` opens `/settings/skills` (one line, tray `nightly`, coordinator).
- Public docs (`apps/web/content/docs/hub.mdx` and friends): the new paths; recapture the hub
  screenshots per `apps/web/images.md` and the catalog's hub shots (`catalog/`).

**Built:** as above, with two notes. The breadcrumb root stays `hub` (`hub / settings / <sub>`),
matching every other page. The CLI's control-box hint prints `<hub>/settings/devices`; `hub login` takes
the path from `verificationPath`. `/accounts` and `/custody` have no redirect.
`hub-dashboard.png` in the public docs still needs real boxes to recapture (marked stale in
`apps/web/images.md`); the catalog's hub shots are retaken.

**Done:** every old page is reachable under Settings from the main sidebar with no second nav;
`/devices?code=X` lands on the approve form pre-filled; hub tests; a standalone-build click-through.

### Phase 2 — skills: the design's table, hub ↔ PC — done

- **Table** like the design's `EnvList`: name + description, **Agents**, **Status**, **Action**, with
  search and an **Agent** filter. Delivery is unchanged (all skills to all boxes), so Agents is
  information: the agents whose PC skill dirs the skill came from (`source.path` matched against each
  registry agent's `skills.dirs`; `~/.agents/skills` = every agent that reads it). The filter is a
  view over that.
- **PC inventory host action** on the PC relay: the skills in `~/.agents/skills` and each agent's
  declared skill dirs, with the tree hash the TUI uses. The TUI's comparison
  (`apps/cli/src/lib/skills/sync.ts`) moves to a shared package so the relay and the CLI agree. The
  hub asks the device through host-reach routing; nothing about the PC is stored on the hub.
- **Status** per row: "On Hub and MacBook", "Only on MacBook", "Only on Hub", "Differs", plus the
  existing pending update. **Actions** run on that PC through the relay's approval rules: *Pull to
  Hub* (the TUI's upload) and *Send to MacBook* (the TUI's download into `~/.agents/skills/<name>`,
  plus the agent dir for an agent that doesn't read `~/.agents`). The existing add / edit / review
  update / discard stay.
- **Machine** selector over enrolled devices (default: the hub's own machine on a local hub). Amber
  banner "N skills not in sync with the Hub" + *Sync all*. An offline device shows "MacBook offline"
  and disables the PC actions.
- Public docs: the skills page.

**Done:** with the PC online, a skill only in `~/.agents/skills` shows "Only on MacBook" and *Pull to
Hub* imports it; a hub-only skill *Send to MacBook* lands it on disk; the same against a remote hub
(`hub expose --tunnel cloudflare` or the test VM) with the Mac as the device.

**Built:**

- **Shared code** in `@agentbox/sandbox-core`: `skills/compare.ts` (`compareSkills`, agents by
  `skills.dirs`, `skillDirOfPath`) and `skills/pc.ts` (the PC inventory, `installSkillFiles` with a
  link for every agent that doesn't read `~/.agents/skills`, `uploadBlocker`). The CLI's
  `lib/skills/sync.ts` delegates to it, so `agentbox skills` and the page agree.
- **Relay host actions** `pcskills.inventory | export | install` (`packages/relay/src/pc-skills.ts`).
  The hub's own machine runs them in-process with no confirm (the click is the owner's act on that
  machine). An enrolled device gets them through the host-reach queue, routed to that device only
  (`boxId` `pc:<deviceId>`); export and install raise a confirm on the PC (`noAutoApprove`), mirrored
  to the hub's approvals like a `cp` confirm. An unrouted `pcskills.*` action is declined. The
  host-reach result route accepts a body up to the custody blob cap, since an export carries the
  tarball (base64).
- **Hub slice** `lib/backend/skills-pc.ts` (+ `skills-pc-wiring.ts` for the relay seams) and routes
  `GET /api/v1/skill-machines`, `GET …/{id}/compare`, `POST …/{id}/pull`, `POST …/{id}/send`. Pull
  re-derives the tree hash hub-side before importing. Compare, pull and send take the owner: a session, the admin token, or loopback on a
  token hub (`skillMachineActAuthorized`); an enrolled device's own token is refused. The hub offers
  itself as a machine only when it runs on a PC, decided from its own env: a `localhost` hub, or a
  password hub that `hub expose` started (`AGENTBOX_HUB_EXPOSED=1`); a deployed hetzner/vercel hub
  never. A device gets 20 s to answer an inventory and 3 min per pull or send; its confirm turns
  into a no after 2 min (`PC_SKILLS_CONFIRM_TTL_MS`), and after one timeout the rest of a batch is
  not sent. A PC copy without a tree hash (too big, unreadable) is `unknown`, and no path replaces
  a copy that can't be read. The poller names the action in the result URL, so the hub checks the
  id and caller before buffering a body, sizes the cap from `skills.maxSkillBytes` only for a
  `pcskills.export`, and settles an oversize result as failed.
- **Page**: one table over the library plus the machine's own skills, toolbar with Machine, Agent and
  search, the out-of-sync banner with *Sync all* (moves each differing skill from the side that
  changed last; skips skills with problems or secret-scan findings), offline note. Add / edit /
  review update / refresh / policy / discard kept per row.
- **Live check** (in an agentbox, its own hub on 8787, scratch `HOME`): the three states, Pull to Hub,
  Send (landed on disk), and a nested docker claude box from `examples/express-ready` received every
  library skill in `/etc/claude-code/.claude/skills`. The remote-hub half of "Done" was not run (see
  Backlog).
- **Fix: uploads over 10 MB were stored truncated.** `proxy.ts` gates `/api/v1`, so Next buffers
  every request body for it and kept only the first 10 MB (`experimental.proxyClientMaxBodySize`);
  a 17.8 MB skill was stored as a 10,483,944-byte tarball that failed gzip and every box sync. The
  cap is now 110 MB (just above the route's 100 MiB custody blob cap; it is held before auth), and `importSkill` buffers
  the whole body and checks it before storing: the length against `Content-Length`, then gunzip +
  tar + tree hash against the named version (400 otherwise, 413 over the cap). A current version
  stored before this is checked once on the next listing and marked `verified` or `broken`; a
  broken one shows as "broken copy" on the page, compares `differs` (PC newer) so a Pull replaces
  it, and Send refuses it. A repair (same current version, rewritten tarball) re-syncs every box
  holding the skill, since a box whose install failed is not `behind`. Content over 100 MiB unpacked
  (what a box installs) is its own 413. Box sync already fails only that skill.

### Phase 2b — a persistent "skip" per skill — done

The design's **Sync** column (`EnvList` / `hubRow`, `S.envToggleSkip`): each row has a checkbox,
ticked by default; unticking means "never sync this skill", and the hub remembers it.

**Built:**

- **Store**: `skills/.skipped.json` (`{schema: 1, skipped: {<name>: {at}}}`) next to `.bindings.json`
  in the custody `skills` scope, so it lives on the hub that owns the library (local or a control
  box). Keyed by name, so a skill only on a PC can be skipped. `@agentbox/core` `skill-skips.ts`
  (parse, lenient/strict read, apply); hub slice `lib/backend/skill-skips.ts` (serialized writes,
  `assertNotSkipped`).
- **Fail closed**: a missing `.skipped.json` is "nothing skipped"; one that exists but can't be read,
  isn't JSON or has no `skipped` object throws `SkillSkipsUnreadableError` everywhere. `skills.get`
  refuses with the reason (the box keeps what it has), the hub's gates, listing and comparison answer
  500 with it (the page shows the error, never "everything synced"), and the fan-out does nothing.
  Pull re-checks the skip right before each import, since a device confirm can take minutes. A skip
  refusal is a 409 `conflict` with `details: {reason: 'skipped', names}`, which the CLI's first
  seed reads instead of the message.
- **Not a global `exclude` binding**: a box or project `include`, or `--skills`, overrides that, and
  bindings say nothing about PC sync. A skip wins over every binding and create flag.
- **Every path honours it**: the relay's `skills.get` drops skipped names before the bindings
  (so `skills.blob` refuses them too); the hub's box MCP view and the create-time preview leave them
  out; `boxSkillsStatus` marks a box that holds one as `behind`, and skipping fans out a sync, so a
  running box drops it now (ctl's sync already removes skills that left the set). `compareSkills`
  (shared, `@agentbox/sandbox-core`) takes the skipped names: status `skipped`, never counted by
  `isOutOfSync`. Pull, send and the PC upload route (`PUT /skills/{name}`, which the TUI and the
  first seed use) answer 409 for a skipped name. `GET /skills` carries `skipped`, which the CLI's
  first seed filters out silently.
- **API**: `GET /api/v1/skill-skips`, `PUT|DELETE /api/v1/skill-skips/{name}` (same gate as the
  bindings writes), in the OpenAPI spec.
- **CLI**: the TUI shows `skipped, not synced`, never uploads or downloads it, and has a "Choose which
  skills sync" action; `agentbox skills skip|unskip <names...>` (the `enable|disable` style).
- **Page**: the Sync column, a struck-through muted row with a pause icon and "Skipped, not synced",
  no Pull/Send, not in the banner or *Sync all*; the footnote says the hub remembers it.
- Unskipping syncs every box that ever pulled from the hub (`syncSkillBoxes({recorded: true})`),
  since an unskipped skill is in no box's record and "behind" can't find them. The tarball route
  (`agentbox skills --download`) answers 409 too. Adding a skipped name from git or a marketplace, or
  editing it on the hub, is not blocked: those are explicit hub-side acts, and delivery still skips it.

**Live check** (in an agentbox, its own hub on 8787, the box's relay as the PC): `skip-probe` only in
`~/.agents/skills`, skipped before the first seed: the seed imported the other 20 and not it, the
page showed "Skipped, not synced", pull answered 409; after `hub restart` and a cleared `.seeded`
marker a fresh seed again left it out; ticking Sync on the page turned it into "Only on <machine>".
A hub skill (`unslop`) skipped: a nested docker claude box from `examples/express-ready` got every
other library skill and not it; unskip reached that running box in ~9 s, a re-skip removed it in ~9 s,
and a new box after the unskip had it.

### Phase 3 — subscriptions: page, limits, switching

**3a — the page, with data we have.** `/settings/subscriptions` regrouped like the design:
**Anthropic** (claude login / setup-token), **OpenAI** (codex login), **API keys**. Each card: label,
tier from `identity.plan`, email, the boxes on it, this week's tokens (`GET /usage?by=account`). Add
(paste a setup token / API key, or the `login` command to copy, as today), rename, remove (409 while
a box uses it). An opencode / pi box that borrows a login (`--model-auth`) counts under the lender.

**Usage per subscription** (part of 3a). The Usage page can already narrow to one account, but only
by clicking a row of its "By account" breakdown, and an account id alone (`default`) is ambiguous
across agents. Add a **Subscription** filter to the page's filter bar: a selector of `agent/account`
pairs labelled like the cards ("Personal · Anthropic"), kept in the URL (`/usage?subscription=
claude/personal`) so each subscription card links to its usage. The breakdown is renamed "By
subscription" and shows the same labels. `GET /usage` takes the pair (`account=<agent>/<id>`),
and a borrowed login's usage counts under the lender, as on the cards.

**Built (3a):** as above, with these notes. A session is stamped with its subscription,
`agent/account`, in the existing `history_sessions.account` column; bare ids stamped before are
rewritten to the session agent's own once, when the store opens, except for an agent that can borrow
a login (`borrowingAgentIds`): its bare ids are cleared so the backfill restamps them from the box
record. A borrower counts under the lender
only when that login is the one source of the box the agent consumes (`subscriptionOf`,
`lib/backend/accounts.ts`), so another agent in the same box keeps its own. `GET /usage?account=`
takes `<agent>/<account>`, and a bare id still matches that id of any agent. The cards show the last 7
days, the Usage page's default window, so a card's figure matches the page it links to. The
default account's card says "every box without a named account" (the API returns no boxes for it, as
before).

**3b — limits. Phase 0 first** (measure before building):

1. **Codex:** confirm `rate_limits` in the last `token_count` of a live session matches codex's own
   `/status`, gives each window's length, and is per login (two boxes on one account agree).
2. **Claude:** find a source that needs no turn and costs no quota: the OAuth usage endpoint Claude
   Code's `/usage` reads (called hub-side with the stored login), or the rate-limit headers of a
   real request. Record what an Ultra, a Max and a setup-token account return. Never log a token.
3. Refresh at most every 5 minutes per account, and only while a box on that account runs.

Then `Account.limits?: {windows: [{id, label, pct, resetsAt?, windowMinutes?}], atLimit, updatedAt}`
on `GET /accounts`, one meter per window the source reports (an Ultra account shows weekly + Fable
weekly; a Plus account 5-hour + weekly). Codex limits come from the history parser (last value per
account), claude's per the PoC. "N at limit" on the Subscriptions nav item and the design's top-bar
indicator (one ring per account in use, popover with the meters and "Manage"). Absent = no data,
never 0%.

**Design scope for 3b (owner-approved, `../agentbox-design` control-shadcn `views-env.jsx`
`SubscriptionsPane` / `SubsIndicator`):**

1. **The page:** cards grouped by provider (Anthropic, OpenAI Codex, then API keys), each with its
   mark, label, plan badge, provider + account line, box count, an *ok* / *at limit* badge, and
   remove. One meter per window the account reports (`Account.limits`), never a fixed 5-hour +
   weekly pair; at the limit, an amber note naming the boxes on it. Left out: the API-key monthly
   budget (not in this plan) and a key's spend (usage has no cost per key yet); the "When a box hits
   its limit" card comes with 3c.
2. **The header meter** in the top bar: the two in-use subscriptions closest to a limit, one thin
   bar per window (at most two), the highest % or "limit" in red, "+n" for the rest. Hover, focus or
   click opens a card: each in-use subscription's windows with % and reset, box count, an at-limit
   line, the updated time, and *Manage* to `/settings/subscriptions`. "Quota" when no box uses a
   subscription.

**Phase 0 findings (2026-11-25, this box's own logins; tokens never printed, values redacted):**

- **Claude:** `GET https://api.anthropic.com/api/oauth/usage` with the login's OAuth access token and
  `anthropic-beta: oauth-2025-04-20` answers 200 with no turn and no quota, and does not refresh the
  login. Besides fixed fields (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`: each
  `{utilization, resets_at}` or null when the plan has no such window) it carries a generic
  `limits[]`: `{kind, group, percent, severity, resets_at, scope: {model: {display_name}} | null,
  is_active}`. A **Max 20x** login (`rateLimitTier: default_claude_max_20x`) reported
  `five_hour: null` and two weekly windows, `weekly_all` and a `weekly_scoped` one for **Fable**: so
  this Max account has no 5-hour window either, and the windows must come from the data. The
  rate-limit headers of a real request (`anthropic-ratelimit-unified-7d-*`, `...-status`,
  `...-representative-claim`) cost quota and report only the binding window, not the Fable one. A
  **setup-token** account was not measured (minting one needs an interactive browser login): its
  scope is `user:inference`, so the endpoint may refuse it; the hub then shows no data. An Ultra
  account was not available.
- **Codex:** the transcript's `token_count.rate_limits` (`primary` / `secondary`: `used_percent`,
  `window_minutes`, `resets_at`; `plan_type`; `rate_limit_reached_type`) carries each window's length.
  A Pro login has one window, `window_minutes: 10080`, `secondary: null`. The same values come from
  `GET https://chatgpt.com/backend-api/wham/usage` (access token + `ChatGPT-Account-Id`) with no turn:
  `primary_window.limit_window_seconds: 604800`, `secondary_window: null`. Not checked: codex's own
  `/status` side by side, and two boxes on one login (no codex box was run: the only codex login here
  is a copy whose refresh would log out its other holders).

**Built (3b):**

- **Codex** (`packages/agent-codex/src/history.ts`, parser v3): `token_count.rate_limits` becomes a
  `limits` history record; the hub keeps the newest per session on its live row and answers an
  account's limits from the newest session on that subscription (`HistoryRepo.accountLimits`). No
  network call.
- **Claude** (`packages/agent-claude/src/limits.ts`, the module's `planLimits` reader, which
  `apps/hub/lib/backend/account-limits.ts` caches): the usage endpoint, called with the stored
  login's access token while it is valid (a setup token as is), at most every 5 minutes per account
  and only while a box on it runs (a cloud box's `lastState`; a docker record counts as running). The
  hub never refreshes the token. An API key, an expired login or a refusal is no data.
- `GET /accounts`: `Account.limits?: {windows: [{id, label, pct, resetsAt?, windowMinutes?}],
  atLimit, updatedAt, source}`, and `boxes` now lists a default account's boxes too (every box whose
  usage counts under it, borrowers included), which is what "in use" means for the header meter.
- Ageing: a window drops out once it resets (codex's older `resets_in_seconds` counts from the record
  time), or a full window length after its read when the source gave no reset time; values with no
  newer read for 10 minutes are `stale` and each card shows their age. A failed claude read keeps
  the last good values, which age the same way.
- The page and the header meter as in the design scope above; the sidebar's Subscriptions item shows
  "N at limit". The web polls `GET /accounts` once a minute, shared by the three.

**3c — switching.**

- **By hand:** the box page's subscription card gets a selector of the accounts its agent can use;
  `POST /api/v1/boxes/{id}/account {agent, account}` switches. CLI: `agentbox account switch <box>
  <account>` (name to settle with the accounts plan's surface).
- **At the limit:** a global config key `accounts.onLimit: ask | switch` (default `ask`; CLI and
  General settings). `ask` pauses the agent's work and raises a host approval "box X is at the limit
  on A: switch to B?" (the existing approvals, so web, tray and CLI all answer it). `switch` moves to
  the next account of the same agent that is not at its limit, and notifies. With nothing available,
  the box waits and the approval says when the first window resets. The trigger is `atLimit` from 3b
  or the agent's own limit error, whichever comes first.
- **Phase 0 for the switch itself** (the hard part): the account is baked into the box's mounts (a
  per-account docker volume, a per-account cloud subpath), and the session transcript lives in that
  same config dir. Measure per provider (docker first, then one cloud): whether to recreate the
  container on the new account's volume and copy the session's transcript across, or keep the
  volume and swap only the credential (and what that does to the two accounts' refresh tokens,
  given the "one refresh logged out every other holder" incident in the accounts plan). The agent
  restarts on the new account and resumes the same session (`--resume <id>` / the agent's
  equivalent). Pick per kind: a `setup-token` / `api-key` account is env-only, so may switch
  without touching mounts.
- Box record and payload: `BoxRecord.accounts` updated on switch, plus a short switch history for
  the box page.

**3c Phase 0 findings (docker, 2026-11-25, Claude Code 2.1.326):** run in this box's own dockerd on a
nested box from `examples/express-ready` and on scratch containers and volumes holding only made-up
tokens. The real login was never copied, refreshed or used outside its own box. One account here
is a login; there is no second real login, so a login-to-login switch was measured with a stand-in
target (a fake token on a fresh volume): it proves the session is found, not that a second
subscription runs it.

- **Where a session lives (measured).** The account's config volume (`agentbox-claude-config` or
  `...-acct-<id>`) is `~/.claude`, and it holds the credentials, `_claude.json` **and** the
  transcripts, under `projects/<cwd key>/<session>.jsonl`. The key is the cwd, `-workspace` in every
  docker box, so all boxes on one account share one directory. A short session is that one file; a
  longer one also has a `<session>/` directory (subagents), which a copy must carry.
  `sessions/<pid>.json` is a per-process index and need not move. The shared
  `agentbox-claude-projects` volume the llm-accounts plan recommended was never built.
- **`--resume` across volumes works (measured).** With the transcript absent, `claude -p --resume <id>`
  answers "No conversation found". Copied into another volume under the same cwd key, the same command
  finds it and proceeds to authenticate with whatever that container has. Nothing in the transcript
  is bound to the account.
- **Auth precedence (measured, `claude auth status`).** Credentials file only → `claude.ai`.
  The file plus `CLAUDE_CODE_OAUTH_TOKEN` → `oauth_token` (the env token wins). The file plus
  `ANTHROPIC_API_KEY` → `api_key` (the key wins, as in the llm-accounts plan's (a′)). The file
  was not modified in any of these runs. A malformed `CLAUDE_CODE_OAUTH_TOKEN` is ignored outright
  ("Not logged in"), so a switch must check the token's shape, not just that one exists.
- **A docker container's env and mounts are fixed (code + measured).** A pasted account's token is
  injected into the container env at create (`accountEnvPolicy`); a default login is read from the
  volume and the container env carries no auth at all. Changing either means recreating the
  container, **or** passing the env per exec: the agent's process is started by `docker exec` into
  tmux, and an exec with a different `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` resumed the
  same session on the other token in the same container (measured with made-up tokens: a 401 from
  the API, not "No conversation found").
- **Recreate cost (measured on the nested box).** `/workspace` sits on the container's writable layer
  (8 MB here, no volume), so a recreate has to keep that layer: `docker commit` took 1.2 s, and a
  container run from the commit on another config volume had the uncommitted workspace file and
  resumed the copied session, 7.4 s in all. There is no in-place recreate today: `create` builds the
  run args (relay socket, binds, ports) and the checkpoint path makes a new box, so a switch needs a
  "recreate this box from its own commit with another account volume, same id and name" step.

**Recommendation (for the OK):**

| Switch | How | Mounts |
| --- | --- | --- |
| to a **setup token** or **API key** | keep the container and the current volume; restart the agent's tmux session with the target's env var set on the exec (and the other auth var unset), `--resume <id>` | unchanged |
| to a **login** (incl. `default`) | stop the agent; copy the session's `.jsonl` (+ its directory) into the target account's volume under the same cwd key; `docker commit` the box, recreate it on the target volume with the same id, name and run args; start the agent with `--resume <id>` | the target account's volume |

- Never put the target login's credentials into the current volume: that switches every other box
  on that volume too, and makes a second holder of the target's refresh token, which the
  llm-accounts incident shows logs the other holders out on the first refresh.
- The env-only switch leaves the box's transcripts in the old account's volume, so later sessions
  of that box land there; the box's `accounts` record must still change, and usage is attributed
  from the record (3a), not the volume.
- **Not measured:** a real login-to-login switch (needs a second, throwaway login), codex (a resume
  is `codex resume <id>` from `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` plus its
  `state_*.sqlite` index, so the copy is the rollout file plus a re-index; code only, no codex box
  was run), the agent's own limit error text (needs an account at its limit), and any cloud
  provider (the plan's "then one cloud").


**Built (3c, `feat/hub-settings-switch`):**

- `POST /api/v1/boxes/{id}/account {account, agent?}` (slice `apps/hub/lib/backend/account-switch.ts`),
  `agentbox accounts switch <box> <agent>/<account>`, and the box page's account selector with the
  last switches under it. `BoxRecord.accounts` moves and `BoxRecord.accountSwitches` keeps the last
  10 `{at, agent, from, to, how, reason}`; the relay registration is refreshed from the record.
- **Token (setup token, API key), every provider.** The record moves, then the hub restarts the
  agent's tmux session and it resumes (`apps/hub/lib/backend/agent-restart.ts`, the hub twin of the
  CLI's `restoreAgentSessions`, through `loadAgentCliModule` in `@agentbox/agent-modules`). Docker's
  session exec blanks a suppressed key the account does not inject (`-e KEY=`, `accountEnvClears`),
  since an exec only adds to a container's env. A cloud box's `/run/agentbox/agent.env` now ends with
  the record's account keys written unconditionally (`export` / `unset`), so they beat the sandbox
  env the box was created with; create, wake and the switch (`rewriteCloudAgentEnv`) all write it.
  The stored token's shape is checked first (`accountTokenPattern` on the agent spec).
- **Login, docker, claude.** `recreateBoxOnAccount` (sandbox-docker): checks the target volume holds
  a login file, stops the in-box dockerd cleanly (a killed one leaves containerd task dirs that the
  commit would carry, and the inner containers then cannot start), stops the box, commits it
  (labelled `agentbox.switch.box`), copies the session's files (`sessionFiles` on the agent spec:
  claude's `projects/*/{id}.jsonl` and `projects/*/{id}`) from the mounted volume into the target,
  renames the old container aside, creates the new one from `docker inspect` (same name, mounts,
  ports, env, limits, init) with only the config volume swapped and the account env keys replaced,
  and starts it through `startBox` (worktree binds, dockerd, ctl, VNC, sshd, portless, relay). Any
  failure puts the old container back. The previous switch image is removed on the next switch and
  on destroy. When the box already mounts the target's volume (back to the login it was created on
  after a token switch), it is a token-style restart, no recreate.
- Refused with a message: a cloud box to a login ("switching a cloud box to another login is not
  supported yet; use a setup token or API key"), a paused docker box to a login, an agent with no
  `sessionFiles` (codex) to a login, a malformed token.
- **At the limit.** `accounts.onLimit: ask | switch` (default `ask`; `GET/PUT /api/v1/accounts/policy`,
  Settings → General, `agentbox config set accounts.onLimit`). The hub checks once a minute
  (`account-limit-watch.ts`): a running box whose agent's account has `atLimit` (not stale) gets a
  confirm approval "box X is at the limit on A: switch to B?" (`ask`, never auto-approved) or is
  moved (`switch`) to the first other account of that agent not at its limit and usable by the box
  (a login only on docker, a token only with its secret). Once per box, account and reset time.
- **Review fixes (#486):** the relay registration drops a named account when the box goes back to
  `default` (or a switch is reverted), so a later login refresh is not filed under the account it
  left; the limit watch only moves this hub's own boxes, holds one approval per box and agent, and
  on a yes re-checks the box and re-picks the target; `nextAccount` skips a login the switch would
  refuse (codex); a recreate puts the box back on any failure after the stop, writes only the
  account onto the record as it is then (a box removed meanwhile stays removed), and a container
  parked by an interrupted switch is brought back on the next start or switch and removed on
  destroy; start, stop, pause, resume and destroy are refused while a switch runs; a cloud box can
  go back to `default` when it was created on it.
- **Live check (nested docker box from `examples/express-ready`, made-up tokens only):** a malformed
  setup token was refused (400). The switch to a made-up setup token restarted claude with
  `--resume` in 0.7 s: the conversation was there, the token was in the agent's env with
  `ANTHROPIC_API_KEY` blank, and the next turn got "401 OAuth access token is invalid" (no setup
  token was available here, so the 401 is the proof, not a real turn). Two login switches to
  stand-in volumes holding a fake credentials file took 9 s and 16 s: the conversation was found,
  claude used the stand-in login, both workspace edits were kept, the mounts were identical except
  the config volume, the inner postgres and the web service came back ready, the portless URL
  answered 200 and the box kept pushing status with its relay token. The `onLimit` loop is
  unit-tested only (no account here is at a real limit).

**Done (3a):** the page shows each real account with its boxes and tokens; a card's usage link opens
Usage filtered to that subscription, and the totals match the card. **Done (3b):** a codex box
mid-turn shows its windows matching `/status`; an Ultra claude account shows weekly meters only.
**Done (3c):** a docker claude box switched by hand continues the same conversation on the other
account; with `onLimit: switch`, a box whose account hits the limit moves to the next one on its own;
with `ask`, the approval appears in the web and the tray.

### Phase 4 — Files — done

`/settings/files` replaces the Custody page and says what it is: the files the hub holds so boxes can
start without the PC. Read-only.

- Grouped for people, not by store prefix: **Project files** (custody `projects/<key>/`: seeds and
  secrets carried into that project's boxes, one section per project), **Agent logins** (`agents/`:
  one row per agent and account, never the bytes), **Skills library** (`skills/`, linking to Skills),
  **Bakes** (`prepared/`), **Box keys** (`boxes/`). Size and last update per row.
- One line explains that untracked files are copied on create (stash + untracked) and are not stored
  here. The design's carry editor and **Shared folders** are left out (settings stay CLI-edited;
  shared folders do not exist).

**Done:** on a local hub and on `hub expose` with a password profile, every custody entry shows under
a human group and nothing exposes file contents.

**Built:** `lib/files-view.ts` regroups the manifest; the page joins it client-side with the store's
projects and boxes, `GET /accounts` and `GET /devices`, so no new route. Notes:

- A project section is named after the hub projects whose custody slugs include it. The hub puts
  `custodySlugs` on every project (`seedSlugsFor`: repo key, alias-expanded with `repoKeyAtEdge` for a
  folder on the hub's machine, else the key a registration carries; origin; registered slug; legacy
  `owner__repo`), so the browser never re-derives repo keys. All folders of one repo are listed; a
  folder name is used only for a project with no git identity. Files under a scope the page does not
  know go to an **Other** group, one row per file.
- Named-account logins live per machine (`agents/<agent>/accounts/<machine>/<id>/`), and an account
  label belongs to one machine's store. `GET /accounts` gained `machine` (this hub's machine id) so a
  label is shown only on that machine's entries; another PC's account shows its id and the PC's name.
- A box's SSH key (under its sandbox id) and its served-skills record (under its box id) merge into
  one row. `cp/` and `cp-out/` roll up to one row each. Group counts exclude bookkeeping files
  (`skills/.seeded`, `skills/.bindings.json`).
- The unused scope grouping (`groupCustody`, `SCOPE_META`, `shortSha`) left `lib/custody-view.ts`.

## Parallel work

| Box | Phases | Touches | Starts |
| --- | --- | --- | --- |
| `set-nav` | 1 | sidebar, topbar, route moves, redirects, docs, catalog shots; tray one-liner (coordinator) | first |
| `set-skills` | 2 | `settings/skills`, a shared skills-compare package, PC relay host actions, CLI TUI on the shared code | after 1 merges |
| `set-subs` | 3a → 3b PoC → 3b → 3c PoC → 3c | `settings/subscriptions`, Usage filter, accounts backend, history parser (codex `rate_limits`), top bar, box account switch across providers | after 1 merges |
| `set-files` | 4 | `settings/files`, a custody view helper | after 1 merges |

Phase 1 is small; holding the others until it merges avoids three boxes rebasing over moved files.
Only one build-heavy docker box runs at a time on the Mac's Docker VM, so the parallel boxes go on
Hetzner. Phase 3 is the long one: it may split into a second box for 3c once 3a lands.

## Not in this plan

- MCPs (design's MCPs page and box-detail MCPs tab).
- Per-agent skill delivery, the skills project picker, per-project / per-workspace binding edits in
  the web (the CLI has them), and the read-only "skills committed to the repo" list.
- The design's box-page Environment section beyond what Phase 3c adds (files-in-this-box view).
- The tray's skills and subscriptions redesign (next, against the API above).
- Shared folders; upload into custody from the web.

## Backlog

- **Login switch on cloud providers** (3c): refused today. A cloud Phase 0 must measure, per provider
  (Daytona first, it has the per-account credentials subpath; then a VPS one): where the session
  files live (the box's `~/.claude` on the sandbox disk, or the credentials volume), whether swapping
  the credentials mount means a new sandbox (Daytona volumes are fixed at create) or can be a file
  swap on a VPS without making a second refresh-token holder, and whether a snapshot + recreate keeps
  the preview URLs, the bridge relay registration and the workspace.
- **Codex login switch** (3c): codex has no `sessionFiles`, so a switch to a codex login is refused.
  The copy is the rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`) plus a re-index
  of `state_*.sqlite`; needs a codex box run to measure. A token switch (API key) works today.
- **The agent's own limit error as a trigger** (3c): `onLimit` reacts to `atLimit` from the limits
  only. Reading the agent's limit message from its session needs an account at its limit to see it.
- **`ask` does not pause the agent** (3c): the plan says ask pauses the agent's work; the approval is
  raised while the agent is (usually) already stopped by the limit. With no other account available,
  the hub logs it and raises nothing; the plan's "the approval says when the first window resets"
  is not built.
- **Hub-side session start and `AGENTBOX_HUB_BIN`** (3c): the hub restarts a docker agent with
  `runtime.startSession`, which forwards the HUB's env (`ANTHROPIC_API_KEY` etc.) for a default
  account, where the CLI forwards the user's shell env. Same for every hub-driven start today.
- **The switch runs in the request, not the queue worker** (3c review): `POST /boxes/{id}/account`
  does the whole switch inline (a docker recreate took 9-16 s live). A client that times out loses
  the answer while the switch finishes. A job the client polls, like create, would fix it.
- **`default` with no store row** (3c review): the limit watch reads limits per account row, so a box
  on a `default` login the store has no row for is never matched, and such a `default` is never
  offered as the next account. A default login normally has a row (the store migrates it).
- **A new named login volume made by hand** (3c live check): the stand-in volume held only the
  credentials, so the box's in-box hooks and settings were missing after the switch. A real one made
  by `agentbox claude login --account` is seeded from the host config, so this only bites a volume
  made outside agentbox.

- **Phase 2 against a remote hub.** The device path (host-reach routing, PC-side confirm mirrored to
  the hub) is unit-tested but not run live. Sign-off per the remote-hub rule: `hub expose --tunnel
  cloudflare` (or the test VM) with the Mac enrolled as the device.
- **Big skills over host-reach.** An export rides the host-action result as base64 and an install the
  action params; both are capped near the custody blob cap. A skill near `skills.maxSkillBytes`
  (50 MiB) on a remote device should stream through custody instead.
- **Device pull/send is synchronous.** One request waits on each skill's confirm in turn (bounded:
  2 min per confirm, 3 min per skill). Making it a job the page polls would free the request.
- **A send leaves an agent's own different copy in place** (e.g. a real folder in `~/.claude/skills`):
  the install lands in `~/.agents/skills`, discovery reads that first, and the row then says "same"
  with only a "different copies" note. A per-dir view of the PC side would make this visible.
- **Pull of a differing skill overwrites the hub's current version** without showing the diff first
  (the TUI does the same). A "compare" view of PC vs hub content would help before *Sync all*.
- **Pre-auth body buffer (known trade-off).** `experimental.proxyClientMaxBodySize: '110mb'` lets Next
  buffer up to 110 MB of a request body before `proxy.ts` checks auth, on every proxied route. On an
  exposed hub or a control box, a few concurrent unauthenticated large bodies cost that much memory
  each. The alternative is a skill upload route outside the proxy matcher with its own auth.
- **Tray**: the skills redesign can use `/api/v1/skill-machines` unchanged; pull/send need the admin
  token there (the API key is refused).
- **Vendor per agent** (3a): the Anthropic / OpenAI grouping is a map in `apps/hub/lib/subscriptions.ts`
  (claude, codex); any other agent is grouped under its own id. A `vendor` field on the agent registry
  row would cover `agentbox agent add` agents.
- **Mixed model-auth sources** (3a): an agent consuming more than one of its box's sources (two
  lenders, or a lender plus an `env:` key, e.g. `--model-auth codex,env:ANTHROPIC_API_KEY`) is
  counted under its own key, not guessed. Per-turn attribution needs the provider that served each
  turn from the transcript.
- **Host sessions on the default card** (3a): a session from a host (not a box) has no account
  stamped (`account` null), so it counts under no subscription, and the default card's tokens leave
  it out.
- **Pre-3a sessions of a destroyed borrowing box** (3a): the migration clears a borrowing agent's
  bare account id for the backfill to restamp from the box record; a box this hub no longer records
  leaves it null (not counted under any subscription) rather than guessed.
- **Docker box state for the claude refresh** (3b): a docker box record carries no running state, so
  a stopped docker box still lets the hub read its account's usage (at most every 5 minutes).
- **Claude limits need a running box** (3b): after a hub restart, a claude account shows no meters
  until a box on it runs. Persisting the last read would keep them.
- **Setup-token and Ultra accounts on the usage endpoint** (3b): not measured; check with a real one.
- **Codex limits without a session** (3b): `wham/usage` would give a codex login's limits before its
  first session; the transcript is the only source today.
- **Key spend** (3b): the design's "this month" for an API key needs a cost per account in usage.
- **Store-only boxes and limits** (3b review): a box known only from its relay registration (a
  control box's adopted boxes) carries its named accounts but no agents or state, so it never counts
  under a `default` account and never triggers a claude limits read.
- **One secret read per listing** (3b review): `GET /accounts` reads a claude account's secret file
  for `hasSecret` and again for the usage token; the limits source also ignores a custom `store`.
