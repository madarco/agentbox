# Hub settings: one Settings section, subscriptions, skills per agent and project, files — plan

**Status:** plan (2026-11-25). Nothing implemented.

The hub web UI grew one top-level page per feature: Approvals, Custody, Skills, Accounts, Usage,
Devices, Settings, System. The design in `../agentbox-design` (`AgentBox Control Plane (shadcn).html`,
`control-shadcn/views-env.jsx` + `env-data.jsx`) groups the configuration pages under one Settings
section and adds two new things: subscriptions with plan-limit meters, and a skills table that
compares the hub with the PC per project and per agent.

This plan moves the hub web to that shape. Where it departs from the design, the owner's direction
wins:

- **No second sidebar.** The design's Settings page has its own left nav (`PaneLayout`). Here the
  Settings sub-pages are links **nested under Settings in the main sidebar**.
- **Accounts become Subscriptions.**
- **MCPs are skipped** for now (no page, no nav item).
- **Files** is new. On a remote hub it is the custody: what the hub holds for boxes.
- **System and Devices** move under Settings.
- **Skills** stay global, can be limited to some agents, and can be shown per project.
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
  identity?{email, org, plan}, hasSecret, boxes[]}`. No limit or quota data anywhere; per-account
  token counts exist only as `GET /usage?by=account`.
- **Skills** `skills/page.tsx` (+ add-source, editor, update/diff dialogs), box detail
  `boxes/components/skills-panel.tsx`, and a picker in the create modal. Backend
  `lib/backend/skill*.ts`; resolver `packages/core/src/skill-bindings.ts`; delivery
  `packages/ctl/src/skills-sync.ts`. Hub skills plan Phases 0-7 are done
  ([`hub-skills-plan.md`](./hub-skills-plan.md)).
  - **Bindings** exist at global / workspace / project (repo key) / box scope
    (`GET|PUT /skill-bindings`, `GET /skill-bindings/resolve`). The web edits only box scope and
    the create picker; global / workspace / project are CLI-only (`agentbox skills enable|disable
    --project|--workspace`).
  - **Per-agent:** not implemented. The skills plan's `agents?: string[]` allowlist and the
    `GET /skills?agent=` filter were never built: every resolved skill is linked into every agent
    whose registry spec declares `skills.inject`.
  - **Hub vs PC** (`same | differs | local-only | hub-only`) exists only in the CLI TUI
    (`apps/cli/src/lib/skills/sync.ts`). The web cannot see the PC's skills.
- **Custody** `custody/page.tsx`: read-only listing of `GET /custody`, grouped by scope (`agents`,
  `projects`, `prepared`, `skills`, `boxes`). Store: `~/.agentbox/hub/custody/` on the hub machine.
- **System** `system/page.tsx` (`GET /system`): version, deploy record, bake freshness, what this
  machine carries. **Devices** `devices/page.tsx`: enrolled PCs, pending codes, approve/deny,
  rename, revoke. The CLI prints the enrollment link from the hub's `verificationPath`, so the hub
  decides that URL.
- **Repo skills** live in the checkout and travel with git: `.claude/skills` (claude, opencode),
  `.agents/skills` (codex, opencode, pi), `.opencode/skill(s)`, `.pi/skills`. **No agent keeps
  per-project skills outside the repo** (Phase 0 of the skills plan measured every candidate dir), so
  there is no external per-project location to manage. The hub's own per-project set is the
  project-scope bindings.
- **Codex plan limits are already in the transcript:** every `event_msg.token_count` carries
  `rate_limits` (`primary` / `secondary`: `used_percent`, `window_minutes`, `resets_at`,
  `plan_type`). The live-status work drops it today. **Claude** writes no limits to the transcript.

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
`/system` pages are deleted. Two of them have callers outside the hub that already shipped, so they
get a permanent redirect instead of a 404: `/skills` (the tray's "Review skills in Hub",
`AppDelegate.swift:550`) and `/devices` (the enrollment `verificationPath` an older hub printed).
The others just go. Usage stays top-level: it is a report, not configuration. The design's
subscriptions indicator in the top bar comes with Phase 3.

## Phases

Each phase is one PR into `nightly`, built in a docker agentbox. Phase 1 goes first because it moves
every page; Phases 2, 3 and 4 then run **in parallel** (they touch disjoint route folders and
backend slices). Phase 5 follows Phase 2.

### Phase 1 — navigation and moves (hub web only)

- `SideItem` gains `children`: a nested list, indented, rendered under its parent. The parent is
  active on any child route; a child on `pathname === href` (or its subtree). Keyboard and
  `aria-current` follow the existing items. Mobile (the sheet sidebar) shows the same tree.
- Move the pages under `app/(dashboard)/settings/`: `subscriptions` (today's Accounts page, renamed,
  no behavior change yet), `skills`, `files` (today's Custody page, renamed), `devices`, `system`.
  General is today's Settings page.
- Redirects for `/skills` and `/devices` (query string preserved, so `?code=` still pre-fills).
  Point the hub's `verificationPath` at `/settings/devices`.
- Breadcrumbs: `control / settings / <sub>`.
- Every in-app link to the old paths updated (System, the skills dialogs, the custody page, the
  box detail skills panel).
- Tray: `reviewSkillsInHub` opens `/settings/skills`; one-line change on tray `nightly`.
- Public docs (`apps/web/content/docs/hub.mdx` and friends): the new paths; recapture the
  hub screenshots per `apps/web/images.md` and the catalog's hub shots (`catalog/`).

**Done:** every old page is reachable under Settings from the main sidebar with no second nav;
`/devices?code=X` lands on the approve form pre-filled; `pnpm --filter @agentbox/hub test` and a
standalone-build click-through of every item.

### Phase 2 — skills: per agent, per project, the design's table

Backend:

- **Per-skill agent allowlist.** `agents?: string[]` on the skill's library metadata (custody
  `skills/<name>/`), absent or empty = every agent. `PATCH /skills/{name}` accepts `{agents}`
  (validated against the agent registry, plugins included). `SkillRow` carries it.
- **Delivery honors it.** The resolver's output stays per box; the filter is applied where the set
  meets an agent: `skills.get` returns each skill's `agents`, and ctl's `skills sync` links a skill
  into an agent's inject dir only when that agent is allowed. One box runs one agent, but service
  agents and `agent add` can put two in a box, so filter per inject target, not per box.
- **Filters on the list.** `GET /skills?agent=<id>&project=<repoKey>&workspace=<id>`: `agent`
  drops skills that agent cannot use; `project` / `workspace` add, per row, the resolved
  `{included, from}` for a new box there (the same answer as `/skill-bindings/resolve`, one call
  instead of two).
- **Repo skills, read-only.** `GET /projects/{id}/repo-skills`: the skills committed in the
  project's checkout (`.claude/skills`, `.agents/skills`, `.opencode/skill(s)`, `.pi/skills`), name +
  description from SKILL.md frontmatter, and which agents read that dir. Answered from the local
  checkout when the hub has one (`checkouts` registry); on a remote hub without a checkout, routed to
  a PC that has it through the existing host-reach routing, else "not available". Info only: no
  edit, no sync.
- CLI: `agentbox skills agents <name> <agent…>|--all`, and `--agent` on `skills --list`.

Web (`/settings/skills`), following the design's `EnvPane`:

- Filters row: **Project** (Global + each project; workspaces too, since bindings have that scope),
  **Agent** (All agents + each registry agent), search.
- Table: name + description, **Agents** marks (or "All agents"), **Status**, **Action**. In this
  phase Status is the hub side only: included / excluded for the chosen scope and where that came
  from ("Global", "my-app", "workspace X"), pending update, update policy. Actions: enable / disable
  at the chosen scope (`PUT /skill-bindings`), edit agents, and the existing add / edit / review
  update / discard.
- Under a project: a collapsed **In the repo** group from `/projects/{id}/repo-skills`, labelled
  "committed to the repo, travels with git".
- Footer line as in the design: hidden-by-agent count, "a box in my-app also gets the Global ones".
- Box detail Skills section: group rows Global / project / box only, as `boxEnvGroups` does; hide
  skills the box's agent cannot use, with a count.
- Public docs: skills page (agents allowlist, project view, repo skills).

**Done:** a skill limited to codex is absent from a new claude box and present in a codex box (docker
live check); the project picker shows a project-disabled skill as excluded "from my-app"; the repo
skills of `examples/` show under that project.

### Phase 3 — subscriptions

**3a — the page, with data we have (no PoC needed).**

- `/settings/subscriptions` regrouped like the design: **Anthropic** (claude login / setup-token),
  **OpenAI** (codex login), **API keys** (any `api-key` kind). Each card: label, tier from
  `identity.plan`, email, the boxes on it, and this week's tokens from `GET /usage?by=account`.
  Add (paste a setup token / API key, or the `login` CLI command to copy, as today), rename, remove
  (409 while a box uses it).
- Opencode / pi boxes that borrow a claude or codex login (`--model-auth`) count under that
  account.

**3b — plan-limit meters. Phase 0 first** (load-bearing assumptions, measure before building):

1. **Codex:** confirm `rate_limits` in the latest `token_count` of a live session gives the
   5-hour (`primary`) and weekly (`secondary`) `used_percent` and `resets_at`, and that it is per
   login (two boxes on one account agree). If yes, the history parser records the last value per
   account (`history_live`, keyed by account, not by session), with no network call.
2. **Claude:** find a source that does not need a turn. Candidates: the OAuth usage endpoint
   Claude Code's `/usage` reads (with the stored login, called by the hub from custody), or the
   rate-limit headers of a real request. Measure what it returns (5-hour and weekly utilization,
   reset times), whether reading it consumes quota, and how a setup token behaves. Never log the
   token.
3. Decide refresh: at most every 5 minutes per account, and only while a box on that account is
   running (no polling of idle accounts).

Then: `Account.limits?: {session?: {pct, resetsAt}, week?: {pct, resetsAt}, updatedAt}` on
`GET /accounts`; meters on each card; "N at limit" on the Settings › Subscriptions nav item; the
design's top-bar indicator (rings for the accounts in use, popover with meters and "Manage").
Absent = no data, never 0%.

**3c — at the limit (later, separate decision).** The design's "Pause and ask me / Switch to next
available" rule and switching a running box to another account (restart the agent on the new
account, resume the session) belong with [`llm-accounts-plan.md`](./llm-accounts-plan.md). Listed
here so the page leaves room for it; not part of this plan's PRs.

**Done (3a):** the page shows each real account with its boxes and tokens. **Done (3b):** a codex
box mid-turn shows its 5-hour and weekly meters on the hub within one refresh, matching codex's own
`/status`; claude per the Phase 0 outcome.

### Phase 4 — Files

`/settings/files` replaces the Custody page and says what it is: the files the hub holds so boxes
can start without the PC.

- Grouped for people, not by store prefix: **Project files** (custody `projects/<key>/`: seeds and
  secrets carried into that project's boxes), **Agent logins** (`agents/`: one row per agent and
  account, never the bytes), **Skills library** (`skills/`, linking to Skills), **Bakes**
  (`prepared/`), **Box keys** (`boxes/`). Project picker like Skills.
- Per project, the **carry list** that applies to its boxes: the `agentbox.yaml` `carry:` requests
  and the host-side grant (`~/.agentbox/projects/<…>/carry.yaml`), read-only, with "granted / not
  granted". On a remote hub this comes from the PC through host-reach like the repo skills; when no
  PC is reachable, the custody rows alone.
- Actions only where they are safe and already exist: delete a project's stored files
  (`DELETE /custody/{path}`, confirm dialog naming what goes). No upload in this phase.
- Untracked files are copied automatically on create (stash + untracked), so they get one line of
  explanation, not a list. The design's **Shared folders** (mounted on demand) do not exist and are
  left out.

**Done:** on a local hub and on `hub expose` with a password profile, the page lists every custody
entry under a human group, a project's carry list shows its grant state, and deleting a project's
files works and is confirmed.

### Phase 5 — skills: hub ↔ PC in the web (after Phase 2)

Brings the CLI TUI's comparison to the web, as in the design's status column ("On Hub and
MacBook", "Only on MacBook" → Pull to Hub, "Only on Hub" → Send to MacBook, "differs").

- **PC inventory host action** on the PC relay: list the skills in `~/.agents/skills` and each
  agent's declared skill dirs, with the tree hash the TUI computes (`apps/cli/src/lib/skills/sync.ts`
  logic moves to a shared package so the relay and the CLI agree). The hub asks the device through
  host-reach routing; no inventory is stored on the hub.
- **Actions** run on that PC: *Pull to Hub* = the TUI's upload, *Send to MacBook* = the TUI's
  download into `~/.agents/skills/<name>` (+ the agent dir for an agent that doesn't read
  `~/.agents`). Both go through the relay's existing approval rules.
- Web: a **Machine** selector (enrolled devices; default the one this browser's hub runs on for a
  local hub). The amber banner: "Global: N skills not in sync with the Hub. my-app has N more" +
  *Sync Global*. Offline device: status column shows "MacBook offline" and the actions are disabled.

**Done:** with the PC online, a skill only in `~/.agents/skills` shows "Only on MacBook" and *Pull
to Hub* imports it; a hub-only skill *Send to MacBook* lands it on disk; the same against a remote
hub (`hub expose --tunnel cloudflare` or the test VM) with the Mac as the device.

## Parallel work

| Box | Phases | Touches | Starts |
| --- | --- | --- | --- |
| `set-nav` | 1 | sidebar, topbar, route moves, redirects, docs, catalog shots; tray one-liner (coordinator) | first |
| `set-skills` | 2, then 5 | `settings/skills`, skills backend + `skill-bindings`, ctl `skills-sync`, relay `skills-rpc`, CLI `skills` | after 1 merges |
| `set-subs` | 3a, 3b Phase 0, 3b | `settings/subscriptions`, accounts backend, history parser (codex `rate_limits`), top bar | after 1 merges |
| `set-files` | 4 | `settings/files`, a custody view helper, a carry read route | after 1 merges |

Phase 1 is small; holding the others until it merges avoids three boxes rebasing over a tree of
moved files. Only one build-heavy docker box can run at a time on the Mac's Docker VM, so the three
parallel boxes go on Hetzner (or two on Hetzner, one docker).

## Not in this plan

- MCPs (design's MCPs page and the box-detail MCPs tab).
- The design's box-page Environment section beyond the Skills grouping (files-in-this-box view,
  per-box subscription switch).
- The tray's skills and subscriptions redesign (next, against the API above).
- Shared folders; upload into custody from the web.
