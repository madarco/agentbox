# Hub web redesign: theme, shell, Dashboard — plan

The owner's design prototype ("AgentBox Hub Team (shadcn)", React + Babel + Tailwind CDN with
mock data) restyles the whole hub web UI and adds team features. The team features wait for
the multi-user work. Everything else (theme, sidebar, header, the Dashboard, box detail, the
restyle of every page) lands now, ported to the hub's real stack (`apps/hub`: Next.js App
Router, Tailwind v4, the hand-rolled shadcn primitives in `components/ui/`).

The prototype is not in the repo. Its files are referenced below by name
(`hub-team/app.jsx`, `views-main.jsx`, `theme.css`, `ui.jsx`, `charts.jsx`).

Open items and data gaps live in [`hub-redesign-backlog.md`](./hub-redesign-backlog.md).

## Rules

- The hub web is a pure REST client of `/api/v1`: client-side fetch, no new server actions,
  no data path that skips the API. Every number on the new Dashboard comes from an existing
  route (`/api/v1/boxes` through the layout's store, `/api/v1/usage/stats`,
  `/api/v1/activity`, `/api/v1/accounts`).
- No mock data. A design element whose data the hub does not serve is omitted or replaced
  by the real equivalent, and listed in the backlog.
- The Usage page renders `@agentbox/usage-view`, shared with the public share page on
  agent-box.sh (`apps/web`). The hub restyles around it; the package is not changed.

## What the design changes, page by page

| Design (prototype) | Hub route / component | Phase 1 |
| --- | --- | --- |
| `theme.css`: paper/ink/green tokens, light + dark, sidebar tokens, IBM Plex Sans/Mono, Instrument Serif | `app/globals.css`, `app/layout.tsx`, `components/theme-provider.tsx` | Port the tokens (light and dark), self-host Instrument Serif, theme persisted per browser (`hub-theme`, OS preference when unset). |
| `ui.jsx` primitives: Button sizes/variants, Card, Badge, Table, Tabs, Popover/menu, Kbd, Separator | `components/ui/*` | Align the existing primitives; add `Tabs`, `Popover`/`Menu*`, `Kbd`, `Separator`. |
| `app.jsx` sidebar: hub header, Platform (Boxes / Approvals / Usage), Team, You (profile / settings group), Projects with "+", Documentation / API reference, user menu | `components/app-sidebar.tsx` | Platform + Settings group + Projects (+ opens New project) + docs links + user menu (theme, docs, sign out). The Team group and the profile group are a commented slot that renders nothing. Collapsible to an icon rail with ⌘B, persisted (`hub-sidebar`); a drawer under 760 px. |
| `app.jsx` header: sidebar toggle, breadcrumbs, Search ⌘K, subscription indicator, theme toggle | `components/topbar.tsx`, `components/command-palette.tsx` | All of it. The palette searches pages, projects and boxes the hub already has in its store. |
| `views-main.jsx` Dashboard: headline, approvals banner, four KPIs, "Your day" lanes, Live now, Recent activity, Shipped this week, Needs a hand, the box table with search + Status/Project facets + All/By project | `app/(dashboard)/page.tsx` + `app/(dashboard)/_dashboard/*` | All of it on real data (below). Mine/Team scope, owner columns and "Who's shipping" wait for multi-user. |
| `views-main.jsx` BoxDetail: icon + title + status, meta row, action buttons + menu, mini stats, Details card | `app/(dashboard)/boxes/[id]/page.tsx` | Header, meta row, actions, stat row and the two-column layout. The hub's own panels (access, git, services, skills, account) keep their content. |
| `views-project.jsx` ProjectDetail | `app/(dashboard)/projects/[id]/page.tsx` | Header + stats restyle; the box table is the Dashboard's. |
| `views-hub.jsx` Settings pages, Approvals | `app/(dashboard)/settings/**`, `app/(dashboard)/approvals` | Restyle through the shared tokens and primitives only. Subscriptions, Skills and the account switcher are being changed by other PRs: minimal edits there. |
| `views-usage.jsx` + `usage.css` | `app/(dashboard)/usage` (renders `@agentbox/usage-view`) | Already the shared view; it follows the hub's `.dark` class. Only the hub chrome around it changes. |
| Team members, Triggers, Team settings, member pages, MCPs, "mine vs. all", owner/avatar columns, hub/team switcher | — | Out: multi-user. |

## Dashboard data mapping

| Element | Source |
| --- | --- |
| Headline ("N agents at work across K projects") | boxes in the store: `status === 'running'`, distinct `projectId`. |
| Working now KPI + 12 h step line | running count from the store; the line is boxes running at once, derived from the activity ledger's lifecycle rows (`/api/v1/activity?since=12h`). |
| Agent-hours today KPI + 7-day bars | `/api/v1/usage/stats?range=7d`: `daily[].agentHours`. |
| Commits today KPI (+ PRs merged, lines) + 7-day bars | `daily[].commits`, `prsMerged`, `additions`, `deletions`. |
| Tokens today KPI + 7-day line, change from yesterday | `daily[].tokens`. |
| "Your day" lanes | activity ledger, last 12 h: running intervals from `box.ready/started/resumed` to `box.paused/stopped/destroyed`, paused stretches, `git.push` dots, `pr.merged` diamonds. |
| Live now | running boxes; session title / working-on line and token figure from `agentStatus`. |
| Recent activity | activity ledger, newest pushes, PRs and lifecycle rows. |
| Shipped this week | `daily[]` commits per day with merged PRs as dots; totals for commits, PRs, agent-hours. |
| Needs a hand | boxes in `error`, and boxes whose subscription is at its limit (`/api/v1/accounts` limits + `Box.subscriptions`). |
| Box table | the store's boxes; tokens from the live usage figure. |

## Phases

### Phase 1 — theme, shell, Dashboard, token restyle (this PR)

1. Tokens (light + dark), fonts, theme toggle persisted per browser.
2. Primitives aligned with the design; hardcoded colors replaced by tokens so dark mode
   holds on every page.
3. Shell: collapsible sidebar, header with breadcrumbs, ⌘K palette, theme toggle.
4. Dashboard on real data, box table with facets and two views.
5. Box detail and project page headers/layout; every other page restyled through the
   shared tokens.
6. Public docs that describe the hub's navigation.

### Phase 2 — after multi-user (not started)

- Team group in the sidebar (Members, Triggers, Team settings), the profile group, the
  hub/team switcher in the sidebar header.
- Mine / Team scope on the Dashboard, owner columns and avatars, "Who's shipping".
- Per-member pages, MCPs settings page.

### Phase 3 — data the hub does not serve yet (not started)

Each item in the backlog's "data gaps" section needs a backend change first: per-box token
history (the table's "Last 2h" sparkline, Live now sparklines), commits/files per box on the
detail page, agent-hours "today" ratios, the box detail's tabbed Skills/MCPs/Files views.
