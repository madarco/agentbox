# Usage dashboard and public share — plan

Status: plan, not started (2026-11-26). Design mockup approved: the Usage view in
`../agentbox-design/AgentBox Control Plane (shadcn).html#/usage`
(`control-shadcn/views-usage.jsx` + `control-shadcn/usage.css`).

## Goal

1. The hub's Usage page becomes the approved design: how many agents ran side by
   side, what they shipped (PRs, commits, lines, files), and the hours and tokens
   it took. It reads the data of the hub it is served by: the laptop hub for local
   boxes, the control box for a remote hub.
2. Closing a box never loses its numbers: its history and its activity reach the
   hub that owns it before the box goes away, on every provider.
3. A user can share the page on agent-box.sh. The hub posts a metrics-only JSON
   snapshot; agent-box.sh renders it with the same layout at a public URL. No free
   text goes up, so the endpoint cannot carry spam.

Parallelism is the headline (the product's biggest advantage): peak boxes at
once, the speed-up over one agent, the biggest sessions. Output comes second.

## What the hub already has (measured 2026-11-26)

| Need | Source today | Gap |
|---|---|---|
| Tokens per day / agent / account / project | `history_usage` via `GET /api/v1/usage` | none |
| Agent active intervals, concurrency, speed-up | `history_turns.ts` per session | none. A read-only query on the live `history.db` (10-min idle gap) gave 25.7 agent-hours in 14.5 wall hours, peak 8 at once, over 73 intervals |
| PRs opened / merged | workspace `timeline.jsonl` (`pr.opened`, `pr.merged`) | **workspace boxes only** (`timelineSink().workspaceFor()` returns null otherwise) |
| Lines added / removed | `git.push` `additions`/`deletions` | workspace only, and not every push carries them |
| Commits, files changed | nothing | `git.push` records neither |
| Box lifetime (box-hours) | `box.ready` / `box.started` / `box.stopped` / `box.destroyed` in the timeline | workspace only; pause/resume not recorded |
| Sessions (boxes run together) | `managerId` on timeline events and history sessions | boxes with no manager have no session |
| Host sessions (agents on the PC, no box) | `history_sessions` with no box, when `history.hostSessions` is on | off on this machine today |

History capture started 2026-11-24, so token and concurrency data is 2 days
deep; the timelines go back to September. A year view will be sparse until the
data accumulates, and destroyed boxes' transcripts cannot be backfilled.

## Metric definitions

- **Active interval**: a run of a session's turns with no gap over 10 minutes,
  closed 1 minute after its last turn. Phase 0 checks the gap against real runs.
- **Agent-hours**: the sum of active intervals. **Wall hours**: their union.
- **Speed-up**: agent-hours / wall hours.
- **Boxes at once**: the maximum overlap of active intervals, per day and overall.
- **Box-hours**: running time from the lifecycle ledger (Phase 1). Shown as a
  KPI, never as the hero number: a box left running is not work.
- **Session**: the boxes of one manager session; for boxes with no manager, a
  connected run of overlapping intervals. The "Biggest sessions" table ranks by
  boxes, then PRs merged.
- **Shipped**: PRs merged, commits, lines +/-, files changed, all from the ledger.
- **Streak**: consecutive days with at least one commit.

## Shape

```
box / relay hooks ──► activity ledger (hub-owned, every box) ─┐
history.db (turns, usage) ────────────────────────────────────┼─► usage-stats domain ─► GET /api/v1/usage/stats ─► hub Usage page
workspace timelines (backfill only) ──────────────────────────┘                       └─► share snapshot ─► POST agent-box.sh/api/share ─► Neon ─► /u/<handle>/<n>
```

- **`UsageStats`**: one JSON shape for everything the page shows. Daily buckets
  (tokens, agent-hours, wall hours, peak, commits, PRs, +/-, files, per agent,
  per provider), the selected day's lanes for the Gantt, sessions, providers,
  streaks. Defined once with zod in a new `packages/usage-view`, with the React
  components that render it. The hub page and the agent-box.sh page both render
  `packages/usage-view` from that JSON, so the public page cannot drift from the
  hub's.
- **`UsageShare`**: the public subset of `UsageStats`. Numbers, dates, and ids
  from fixed enums (agent, provider). No project, box, branch, PR or session
  names; lanes and sessions are labeled by agent + provider ("claude on hetzner").
  The only string is the handle (`^[a-z0-9-]{1,39}$`).

## Phases

Each phase is one box session, branched from `origin/nightly`, merged into a
`feat/usage-dashboard` branch. Open items go to `docs/usage-dashboard-backlog.md`
from Phase 1 on.

### Phase 0 — measure (no product code)

- Run the metric definitions as read-only SQL against a copy of the real
  `history.db` and the real timelines. Compare the intervals with what happened
  (box creates, known parallel runs). Settle the idle gap.
- List which numbers each provider ships today: does a hetzner / e2b / vercel /
  daytona box's history reach the hub before destroy? (`history-flush.ts` skips a
  paused cloud box.) Same for a box on a remote control box.
- Check the payload size of a 1-year `UsageShare` (target under 64 KB).
- Output: a "Phase 0 results" section here, and any change to the phases below.

### Phase 1 — activity ledger

- A hub-owned `activity` store, sqlite locally and postgres on a control box
  (same split as the history store). One row per event, for **every** box, in a
  workspace or not: `box.created|ready|started|stopped|paused|resumed|destroyed`
  (provider, agent, account, project key, manager id) and `git.push` (commits,
  files changed, additions, deletions, branch), `pr.opened|merged|closed`.
- Writers: the hub's lifecycle worker for box events; the relay's push hook
  (`timeline-hooks.ts`) for pushes, now computing commit and file counts next to
  the existing `pushDiff` shortstat; the GitHub PR sync for PR states.
- Backfill once from every workspace `timeline.jsonl` (idempotent on event id).
- New backend slice `apps/hub/lib/backend/activity.ts` (never `hub-backend.ts`).
- Tests: the backfill, a non-workspace box's push landing in the ledger.

### Phase 2 — `UsageStats` and the stats API

- `packages/usage-view`: the zod `UsageStats` / `UsageShare` schemas and the
  pure functions that build them (intervals, union, overlap, sessions, streaks),
  unit-tested on fixtures. **Done** (feat/usage-view): `buildUsageStats(input)`
  takes plain arrays (`SessionTurns`, `git.push` / `pr.merged` events, token rows,
  box info, box runs) that the hub adapts its rows to; `toShare(stats, handle)`
  builds the public subset. Decisions made there:
  - `tzOffset` is local time minus UTC in minutes (CET is `60`, the opposite sign
    of `Date#getTimezoneOffset`). A fixed offset is wrong across DST; see the backlog.
  - A box's sessions are unioned into one lane, so two sessions in one box count
    once in "boxes at once" and in agent-hours. Host sessions are one lane each.
  - Lines and files come from `git.push` only; a merged PR's lines were already
    pushed. `pr.merged` counts PRs and gives "biggest PR".
  - The share drops the live counters (`runningNow`, `waitingReview`) as well as
    every name. It stores `daily` and `wall` column by column (one array per
    metric) and has its own tighter bounds (`SHARE_LIMITS`: 62 days of the daily
    chart, 3 Gantt days of up to 16 lanes x 8 intervals, 10 sessions; hours to one
    decimal, counts capped per day). A share with every array full and every number
    at its longest is about 55 KB (tested); `toShare` rounds, clamps and cuts to fit.
    Every date is 2020-2100 and the range must hold `since <= today <= until` within
    367 days, so no renderer walks an unbounded run of days.
- `apps/hub/lib/backend/usage-stats.ts` reads `history.db` + the ledger and
  returns `UsageStats` for a window, a tz offset and an optional subscription.
- `GET /api/v1/usage/stats?since=&until=&tzOffset=&subscription=`; the existing
  `GET /api/v1/usage` stays for the token breakdowns.
- `agentbox usage` CLI prints the hero numbers (an `/api/v1` client, local or
  remote hub alike).

### Phase 3 — the hub Usage page

- Port the mockup to `packages/usage-view` React components (hand-drawn SVG, no
  chart library), light and dark. **Done** (feat/usage-view) as `UsageView` from
  `@agentbox/usage-view/react`, styled by its own scoped `usage.css` (the mockup's
  `.usage` variables, not the hub's tokens, so the hub and agent-box.sh render it
  the same; dark under any `.dark` ancestor). A fixture of the mockup's numbers and
  a vite preview (`pnpm --filter @agentbox/usage-view preview`) ship with it.
- `apps/hub/app/(dashboard)/usage/page.tsx` becomes a pure REST client of
  `/api/v1/usage/stats` (plus `/api/v1/usage` for the token breakdowns). Range
  control, subscription filter, Export CSV.
- The brief copies the mockup files into the box
  (`agentbox cp ../agentbox-design/control-shadcn/{views-usage.jsx,usage.css}`):
  the design repo is not in the workspace.
- Update the tray if it links to Usage; update the public docs page for Usage.

### Phase 4 — numbers survive a box closing

- Destroy and stop: record the ledger event and run the final history flush on
  every provider, including a paused cloud box (resume it briefly, or ship from
  its stopped disk where the provider allows it; Phase 0 decides per provider).
- Remote hub: a box on a control box writes to that hub's stores. A laptop that
  has local docker boxes **and** a configured control box sees both: the laptop's
  `/usage/stats` fetches the control box's stats and merges them (daily buckets
  add, intervals union). Host sessions stay on the PC's hub and are merged the
  same way.
- Close the related history backlog items (remote forwarding, split stores).
- Live check on docker, hetzner and one SDK provider (e2b or vercel): destroy a
  box mid-run and see its hours and pushes on the page.

### Phase 5 — agent-box.sh share endpoint and page

- `POST https://agent-box.sh/api/share`: read the body as raw text and pass it to
  `parseShareBody` from `@agentbox/usage-view`. It refuses more than 64 KB of raw
  text and any `__proto__` / `constructor` / `prototype` key, then parses with the
  strict zod schema (unknown keys rejected, every string an enum or the handle
  regex, numbers and arrays bounded). **Store `JSON.stringify` of the parsed
  result, never the raw body**: zod drops some keys silently (`__proto__`), so
  only the re-serialized output is known to hold nothing but numbers, dates,
  enum ids and the handle. Stored in Neon Postgres (the Vercel
  Marketplace integration, `vercel integration add neon --non-interactive`):
  `handles (handle pk, claim_hash, created_at)` and
  `shares (handle, n, snapshot jsonb, ip_hash, created_at, pk (handle, n))`.
  `n` is assigned in the insert transaction, so concurrent posts never collide.
- Rate limit by IP: a Vercel Firewall rate-limit rule on `/api/share` (for
  example 10 posts per hour per IP), no code.
- Handle claim: the first post for a handle returns a claim secret; the hub
  stores it (`~/.agentbox/hub/share.json`, 0600) and sends it on every later post
  for that handle. A post for a claimed handle without its secret is refused.
- Page `agent-box.sh/u/<handle>/<n>` renders `packages/usage-view` from the
  stored JSON. `/u/<handle>` lists that handle's shares.
- **OG image** (a first-class deliverable, not an afterthought: the link preview
  is what spreads on X, LinkedIn and Slack). `app/u/[handle]/[n]/opengraph-image.tsx`
  with `next/og` `ImageResponse`, 1200x630, reusing `lib/og.ts` (`loadOgFonts`,
  the IBM Plex fonts, `boxMark`) like `app/home-og/route.tsx`. Content, all from
  the stored numbers:
  - the hero line ("9 agents at once · 612 hours of work in 211 hours · 2.9×"),
  - the shipped row (PRs merged, commits, +lines/−lines),
  - a strip of the activity wall (last ~20 weeks) drawn as flexbox squares,
  - the top-3 provider marks as round avatars, the handle, and the agent-box.sh
    mark.
  The image is immutable per share, so it is generated once and cached
  (`Cache-Control: public, max-age=31536000, immutable`). The page sets
  `og:title`, `og:description` (numbers only), `twitter:card=summary_large_image`.
  Check it with real unfurls (X card validator, LinkedIn post inspector, a Slack
  paste) and with the shortest and largest plausible numbers (1 box, 6-digit
  hours) so nothing overflows. A light and a dark variant are not needed:
  unfurls show one image, so use the paper background with the green accent.

### Phase 6 — share from the hub

- A Share button on the Usage page opens a preview of the exact `UsageShare`
  that will be sent (the same component, public subset), a handle field, then
  posts through the hub server (`POST /api/v1/usage/share`; the browser never
  calls agent-box.sh) and shows the public URL.
- `share.endpoint` config key (default `https://agent-box.sh/api/share`) for
  testing against a preview deployment.
- `agentbox usage share` for the CLI.

## Phase 0 results (2026-11-26, history-side only)

Read-only SQL on a copy of the live `history.db` (30 sessions, 7,033 turns,
2026-11-24 to 26, claude/codex/opencode/pi on docker and hetzner):

| idle gap | agent-hours | intervals | peak at once | wall hours | speed-up |
|---|---|---|---|---|---|
| 5 min | 18.8 | 142 | 8 | 11.4 | 1.65x |
| **10 min** | **25.7** | **73** | **8** | **14.5** | **1.77x** |
| 15 min | 30.0 | 47 | 8 | 16.5 | 1.82x |
| 30 min | 33.2 | 37 | 8 | 18.0 | 1.84x |

- The peak is stable across gaps (8 on 24 Nov, 5 on 25 Nov); the speed-up moves
  little. 10 min stays the default: 5 min splits runs at long tool calls (builds),
  30 min counts idle waiting as work.
- `history_sessions.manager_id` is never set (0 of 30), so sessions cannot come
  from history. Group boxes into sessions by the `managerId` the ledger records
  per box (Phase 1), falling back to overlapping intervals.
- Still open, moved to Phase 4's live check: which providers lose history on
  destroy (a paused cloud box is skipped by `history-flush.ts` today), and the
  `UsageShare` size for a full year (checked in the usage-view PR).

## Decisions (defaults proposed, to confirm)

1. **URL**: `agent-box.sh/u/<handle>/<n>` rather than `/sessions/…`, since
   "sessions" already names agent transcripts in the hub. Proposed: `/u/`.
2. **Identity**: claim-on-first-post secret, no account. Later option: verify a
   GitHub login so the handle is the real GitHub user and the page shows the
   avatar.
3. **Storage**: Neon Postgres on the agent-box.sh Vercel project (decided
   2026-11-26). It also gives a later gallery or leaderboard for free, and a
   per-IP count in SQL as a backstop to the firewall rule.
4. **Host sessions**: counted as a provider named "this PC", off in the share
   unless the user keeps it.
5. **Hero number**: agent-hours from transcripts, not box-hours.
