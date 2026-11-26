# Usage dashboard and public share — plan

Status: Phase 0, Phase 1 and Phase 2 done (2026-11-26). Design mockup approved: the Usage view in
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
- **Hours saved**: agent-hours - wall hours, at least 0, to 0.1 h (`hoursSaved()` in
  `@agentbox/usage-view`, the one definition the hub, CLI, React view and share card
  use). Time against running the same work one agent at a time, not a person's time.
  Stated in words only past a 1.1x speed-up and 1 h (`claimsHoursSaved()`). The live
  stats carry `kpis.hoursSaved` with the change from the previous window; a share
  leaves it out and derives it from the hero, so the share schema is unchanged and
  old shares show it too.
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

### Phase 1 — activity ledger (done 2026-11-26)

- A hub-owned `activity` store in `@agentbox/relay` (`src/activity/`): one table,
  sqlite at `~/.agentbox/hub/activity.db`, postgres when `ACTIVITY_STORE_URL` or
  `POSTGRES_URL` is set. It follows the relay store's dual-dialect pattern, not
  the history store's, for two reasons. The push, `gh` and create-job writers
  live in the relay package. The local create worker is a separate CLI process
  (`_run-queued-job`). The history store is hub-only, and its postgres half does
  not exist yet. Its own file: `store.db` belongs to the relay, and is in memory
  on a laptop.
- One row per event, for **every** box, in a workspace or not:
  `box.created|ready|failed|started|stopped|paused|resumed|destroyed`, `git.push`
  (`commits`, `filesChanged`, `additions`, `deletions`, `branch`, `hostOnly`) and
  `pr.opened|ready|merged|closed`. Each row carries the box's name, provider,
  agent, account (`agent/account`), repo URL and project key, workspace,
  manager, create job and actor.
- Writers:
  - The hub's box routes (`withBoxActivity` in `apps/hub/lib/backend/activity.ts`):
    create, start, stop, pause, resume, destroy, host-initiated pushes.
  - Create jobs: `recordCreateJobTimeline` (the queue worker) and
    `recordCreateJobRowTimeline` (the control box's worker).
  - The relay's push hook (`timeline-hooks.ts`): `pushLineStat` /
    `boxPushLineStat` now also count commits (`rev-list --count`) and files
    changed.
  - The `gh` shim.
  - Docker autopause and the cloud keepalive's idle pause.
  - The workspace GitHub sync, plus a PR sweep (every 5 minutes) for the open
    branches the ledger knows (`ActivityStore.openBranches`, one aggregate
    query) in repos no workspace names.
- One writer per push. A push or landing the hub's route drives carries a
  host-initiated token (host-only landings now too), and the relay skips it;
  the box's own pushes and landings are the relay's. A direct or leased box's
  report of a hub-route push says so (`git.pushed` `hostInitiated`), and both
  sides key that push `push:<box>:<tip>`. Every path measures the push from
  the old tip in git's own ref update line, so nothing is read before a push,
  and the timeline and the ledger share one measurement per route call.
- Dedupe: a row reuses the timeline's key when its source has one
  (`job:<id>:ready`, `pr:<repo>#<n>:merged`, `push:<box>:<sha>`). The backfill
  imports a workspace `timeline.jsonl` line under its key (or `tl:<id>`), and only
  if it is older than the ledger's `created_at`: anything later was written
  live. The hub runs the backfill once at start (`timeline_backfill_at` meta);
  rerunning it is a no-op.
- Read: `ActivityStore.list` and
  `GET /api/v1/activity?since=&until=&type=&box=&order=&limit=`.
- Open items: [`usage-dashboard-backlog.md`](./usage-dashboard-backlog.md).

### Phase 2 — `UsageStats` and the stats API

- `packages/usage-view`: the zod `UsageStats` / `UsageShare` schemas and the
  pure functions that build them (intervals, union, overlap, sessions, streaks),
  unit-tested on fixtures. **Done** (feat/usage-view): `buildUsageStats(input)`
  takes plain arrays (`SessionTurns`, `git.push` / `pr.merged` events, token rows,
  box info, box runs) that the hub adapts its rows to; `toShare(stats, handle)`
  builds the public subset. Decisions made there:
  - Days are local days in a named IANA zone (`range.tz`, e.g. `Europe/Rome`),
    bucketed with `Intl`, so a window across a DST change keeps 23- and 25-hour days
    whole. The zone is a closed value: `isTimeZone` accepts only a name the
    runtime's `Intl.supportedValuesOf('timeZone')` lists (plus `UTC`), at most 64
    characters. (It replaced the first cut's fixed `tzOffset`.)
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
- **Done** (feat/usage-stats): `apps/hub/lib/backend/usage-stats.ts` reads
  `history.db` + the ledger and returns `UsageStats` for a window, an IANA zone
  and an optional subscription (`agent/account`).
  - Active intervals are cut in SQL (window functions over `history_turns.ts_ms`)
    and kept per session in `history_spans`; a write marks the session dirty, and
    the history service recomputes dirty sessions in small batches at start and
    with its minute sweep, never on a request (the relay and the web server share
    the hub process). A read uses the spans stored, so a turn shows up within a
    minute. Retention keeps a purged
    session's spans, so a year view keeps its hours past `history.retentionDays`.
  - Tokens are summed per session per local day in SQL, from the zone's offset
    segments over the window (`zoneSegments`), so the store needs no zone support.
  - Measured on 1M turns and 200k usage rows (2000 sessions over a year): a year
    view in about 0.4 s, a week in 0.2 s, most of it `buildUsageStats` in JS;  after
    the migration the hub backfills every session's spans in the background once
    (2.5 s of sqlite work per 1M turns, in batches of 50 sessions).
    Answers are cached for a minute per (window, zone, subscription).
  - Sessions group by the `managerId` the ledger records per box, else by overlap.
    Commits come from `git.push` counts, never rows; a `hostOnly` landing counts
    only when no published push of the same box follows it. Box-hours run from
    `box.created`/`ready`/`started`/`resumed` to `stopped`/`paused`/`destroyed`/`failed`.
- `GET /api/v1/usage/stats?since=&until=&tz=&range=&subscription=`: `since` is a
  day or `<n>d`; the window is checked with `UsageRange` (2020-2100, at most a
  year) before any day is walked. The existing `GET /api/v1/usage` stays for the
  token breakdowns.
- `agentbox usage` prints the hero numbers (`--json` the whole `UsageStats`); the
  token breakdown that was `agentbox usage` is now `agentbox usage tokens`.

### Phase 3 — the hub Usage page (done 2026-11-26)

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
- **Done** (feat/usage-page): `/usage` renders `UsageView`; the range (`?range=`,
  default `30d` to match the tray's pill) and `?subscription=` live in the URL;
  Export CSV is one row per day; the token breakdown moved to `/usage?view=tokens`.

### Phase 4 — where sessions live, and how they reach the usage page

Decided 2026-11-26 with the owner.

**What happens today** (measured 2026-11-26):
- Docker boxes: the relay reads their transcripts host-side from the box's
  config volume (`agentbox-claude-config`, shared by every docker box, or a
  per-box volume with `--isolate-claude-config`, which `destroy` deletes) in
  any box state. Cloud boxes: `agentbox-ctl` ships new transcript bytes every
  30 s over the relay channel to the hub that owns the box.
- The only final flush is on `destroy` (`history-flush.ts`, 90 s, best effort).
  `stop` and `pause` flush nothing; a cloud box already paused or stopped at
  destroy is skipped, so its last <30 s is lost.
- A laptop hub with a configured control box keeps two stores: cloud boxes
  built through the control box ship there, local docker boxes and host
  sessions stay in the laptop's `history.db`. No forwarding, no merged view
  (agent-history backlog: "Remote control box forwarding", "Split stores").
- `history.db` is not a plain copy of `~/.claude/projects`: it holds the raw
  bytes zstd-chunked and deduplicated (251 MB of raw transcripts stored as
  about 70 MB on disk), redacted of secret values, plus the parsed turns,
  per-message usage, FTS search and memory, for every agent (codex, opencode,
  pi and openclaw included, whose native stores are not JSONL trees). Claude
  Code itself deletes transcripts older than `cleanupPeriodDays` (default 30),
  so the agents' native folders are not a durable archive.

**No remote hub (default install).**
- Every box's sessions come back to the PC's hub, continuously and on close:
  add a final flush on `stop` and `pause` (not only `destroy`). A cloud box
  already paused or stopped at destroy is not woken: its last <30 s is an
  accepted loss.
- `history.db` stays the one durable store and the usage page reads only it.
- New: **materialize box sessions where the agents look.** After a session
  ships, write it into the PC's native location for the box's project
  (`~/.claude/projects/<host project key>/<session>.jsonl`, codex/opencode/pi
  equivalents later), so the host agent finds past box sessions the way it
  finds its own (`/resume`, reading old transcripts). **Automatic**, on by
  default for every box session of a project with a known host checkout.
  Written from `history.db` (one source), rewritten only when it changes, and
  **re-created when missing**, including after the agent's own cleanup
  deleted it: everything `history.db` holds is materialized. A re-created file
  gets a fresh mtime, so Claude's `cleanupPeriodDays` removes it again after
  30 days and the next pass writes it back; that churn is cheap (missing
  files only, one pass a day plus after each ship). Redaction stays: the
  materialized copy is the redacted one. A config key turns it off.
- Not proposed: dropping `history.db` for the native folders. It would lose
  compression, redaction, the other agents' formats, search and the usage
  index, and Claude's 30-day cleanup would delete the history.

**With a remote hub.**
- Cloud boxes built through the control box sync to it exactly as above.
- Local docker boxes and host sessions stay in the PC's hub. Their **sessions
  are not uploaded**; their **metrics are**: the PC's hub pushes a usage
  contribution to the control box, `POST /api/v1/usage/contributions`, keyed
  by machine id, holding only what the dashboard needs (active intervals with
  agent, provider and box id; token totals per day and agent; ledger counts).
  No transcript text. Pushed every few minutes while anything changed, and on
  demand by `agentbox usage` and a "Sync this PC" button on the local hub's
  page. The control box's `/usage/stats` merges contributions with its own
  rows (intervals union, so concurrency is right across machines).
- Downloading sessions to the PC stays optional (`agentbox sessions download`,
  plus the materialize step above when the user turns it on).
- Considered and rejected: the remote hub's page calling the local relay from
  the browser. It works only in a browser on that PC (not the CLI or tray), and
  an https page calling `http://127.0.0.1` hits private-network-access and CORS
  rules.

**Live check:** docker, hetzner and one SDK provider (e2b or vercel): stop,
pause and destroy boxes mid-run and see their hours, pushes and tokens on the
page; on a laptop + control box pair (`hub expose`), see a local docker box's
hours on the control box's page with no transcript on the control box.

This phase is large enough to split into 4a (flush on stop/pause, materialize)
and 4b (contributions to a remote hub).

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
- Rate limit by IP, in SQL (built): at most 10 shares per hour and 3 new handles
  per day per IP hash (HMAC-SHA256 with `SHARE_IP_SALT`; the raw IP is never
  stored), 429 with `Retry-After`. A Vercel Firewall rate-limit rule on
  `/api/share` can be added in front of it, no code.
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

Built (2026-11-26): `apps/web` with the `postgres` driver (`prepare: false` for
Neon's pooler). Run `pnpm --filter @agentbox/web db:migrate` once at setup (with
the production `DATABASE_URL`): the first POST also creates the tables, but two
cold functions doing it at once can race. Handles that would read as official
(`agentbox`, `madarco`, `anthropic`, …) are reserved, and the rate limit counts
an IPv6 client by its /64. `proxy.ts` 404s a malformed `/u/` path before
anything renders or is cached. The pages are ISR-cached forever and
revalidated by the POST; `/u/example` renders the fixture without a database.
The handle `example` is reserved. Env on the Vercel project: `DATABASE_URL`
(from the Neon integration) and `SHARE_IP_SALT` (a random secret); without them
`POST /api/share` answers 503 and the share pages 404.

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
