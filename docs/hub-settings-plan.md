# Hub settings: one Settings section, subscriptions with limits and switching, skills, files — plan

**Status:** Phases 1-2 done (2026-11-25, `feat/hub-settings-nav`, `feat/hub-settings-skills`). Phase
3a done (2026-11-25, `feat/hub-settings-subs`). Phases 3b-3c and 4 not started.

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

**Done (3a):** the page shows each real account with its boxes and tokens; a card's usage link opens
Usage filtered to that subscription, and the totals match the card. **Done (3b):** a codex box
mid-turn shows its windows matching `/status`; an Ultra claude account shows weekly meters only.
**Done (3c):** a docker claude box switched by hand continues the same conversation on the other
account; with `onLimit: switch`, a box whose account hits the limit moves to the next one on its own;
with `ask`, the approval appears in the web and the tray.

### Phase 4 — Files

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
- **Default account's boxes** (3a): `GET /accounts` lists no boxes for a `default` account (it would be
  every box without a named one); the card says so instead of listing them.
