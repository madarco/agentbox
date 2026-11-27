# Usage dashboard and public share — plan

Status: Phase 0, Phase 1, Phase 2 and Phase 4b done (2026-11-26). Design mockup approved: the Usage view in
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

- **Active interval**: a turn's busy stretch, from its prompt to its last
  assistant or tool row, plus 1 minute (see "Busy spans" below). Waiting for
  input never counts.
- **Agent-hours**: the sum of active intervals. **Wall hours**: their union, the
  hours with at least one agent busy (not the hours a session was open).
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

## Busy spans (2026-11-27)

The first rule cut a session's rows at any 10-minute gap. A coordinator session
woken every few minutes by a watcher, a CI wait or a background task never left
such a gap, so a night spent waiting for the owner read as continuous work (the
owner's hub: 130 of 310 user turns start with `<task-notification>`). The rule
now measures busy time inside turns:

- **A turn** is a prompt row (`history_turns` kind `turn`, role `user`) and the
  assistant, tool and tool-result rows after it, up to the next prompt. Rows
  before a session's first prompt (a resumed or compacted file) are a turn of
  their own.
- **Its span** runs from the prompt to its last row, plus the 1-minute tail
  (`DEFAULT_TAIL_MS`). The gap from a turn's end to the next prompt is never
  counted, however long.
- **Safety cap, 10 minutes** (`DEFAULT_IDLE_GAP_MS`): two rows of one turn more
  than 10 minutes apart cut it. One tool call (a build, a test suite) writes no
  row while it runs, and Phase 0 showed 5 minutes splits real runs at builds;
  a longer silence inside a turn is a permission prompt waiting for the human
  or a hung tool.
- **A prompt continues the turn only while a tool call is still running**: the
  turn has a `tool` row with no `result` row yet, and the prompt is within the
  cap (a message queued during a build). Once every call has its result, the
  next prompt starts a new turn and the wait before it is not counted, even when
  the turn ended on a tool call (real transcripts do: a `no_reply_needed` tool,
  measured 2026-11-27). A session with no result rows at all (an agent whose
  parser records none, an old transcript) never continues a turn across a prompt.
- **Automated wakeups.** A prompt the harness injected (a `<task-notification>`,
  a `<wake …>`, a cron or `/loop` wakeup, a system event) is stored with
  `history_turns.auto = 1`, classified at ingest. A turn it starts counts only if
  it stayed busy for 30 seconds (`DEFAULT_AUTO_MIN_BUSY_MS`) or more, from the
  prompt to its last row before any cut, tool rows and results included. A
  wakeup acknowledged in seconds counts nothing, whether it replied in text or
  called a do-nothing tool (12 such wakeups 5 minutes apart counted 61 minutes
  under the first version of this rule). A wakeup that does real work runs
  longer than that: a CI check read, a PR merged.
- **A wakeup that did work counts in agent-hours and in wall hours.** It is real
  work and an agent was busy while it ran.
- Turns whose spans touch or overlap merge, so the span count stays small.
- **One implementation.** `activeIntervals` in `@agentbox/usage-view` takes the
  rows (`prompt` / `auto` / `reply` / `tool` / `result`); the hub reads a
  session's rows in `(ts_ms, id)` order and stores that function's output in
  `history_spans`, so the hub and anything that sends raw turns cut spans the
  same way.

**Classification per agent.**
- claude: a text that is an injection wins (`isInjectedPrompt` in
  `@agentbox/core`: it starts with `<task-notification>` or `<wake `, or it is
  nothing but `<system-reminder>` blocks, the last one possibly clipped); harness
  wakeups are recorded with origin `human`. Otherwise the line's `origin.kind`
  (anything but `human` is automated unless `promptSource` is `typed`), else
  `promptSource` alone (`system` is automated). A prompt with only an image or a
  file is stored as `[attachment]`, so it starts its turn too. Not prompts: a
  compact summary (`isCompactSummary`), `[Request interrupted by user…]`, and text
  riding on a tool-result line. Each `tool_result` block is a `result` row.
- codex already drops its injected user messages (`environment_context`,
  `user_instructions`, …) at parse time, so every user row it stores is typed. It
  records no `result` rows yet, so its prompts never continue a turn.
- opencode and pi have no injected prompts: every user row is typed. No `result`
  rows either.
- openclaw: its heartbeat prompts are not classified yet (backlog); its
  `custom` injected context is not a turn.
- Every agent's user rows also go through the text check at ingest.

**Migration.** The `auto` column is backfilled from the stored text of user
rows (text is kept for every turn), paged, and every non-purged session is
marked `spans_dirty` (`history_meta.spans_rule`). It runs again whenever user
rows with no `auto` exist, as an older hub writes them after a downgrade. The
background refresh recomputes spans 5 sessions at a time, yielding between
batches. A purged session keeps the spans it had: its turns are gone. claude's
parser version goes to 6, so the re-parse job re-derives `auto` from `origin` and
adds the `result` rows for the transcripts still archived. While a session is
behind its agent's parser version, the refresh leaves its spans alone (a re-parse
clears and re-inserts its turns across awaits), and a re-parse that fails puts the
session's spans back as they were, like its usage rows; the refresh runs once
the re-parse job ends.

## Shape

```
box / relay hooks ──► activity ledger (hub-owned, every box) ─┐
history.db (turns, usage) ────────────────────────────────────┼─► usage-stats domain ─► GET /api/v1/usage/stats ─► hub Usage page
workspace timelines (backfill only) ──────────────────────────┘                       └─► share snapshot ─► POST agent-box.sh/api/share ─► Neon ─► /s/<id>
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
  The only string is an optional display name (`^[a-z0-9-]{1,39}$`), plain text
  that is not an identity (see Phase 5).

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
  box info, box runs) that the hub adapts its rows to; `toShare(stats, name?)`
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
- **Done (4b, 2026-11-26)**, feat/usage-contrib:
  - The shape is `UsageContribution` in `@agentbox/usage-view`
    (`src/contribution.ts`): `machineId`, a window of local days and its zone,
    `intervals` (start, end, agent, provider, box id, or the session id of a
    host session), `tokens` per day/agent/provider/box (per session for a host
    session, so a control box that holds it counts its tokens once), `shipped` per day/box
    (pushes, commits, files, lines, merged PRs), `boxes` (agent, provider,
    manager id) and `boxRuns`. Strict zod, ids from `[A-Za-z0-9._:-]`, 8 MB and
    per-array caps, a window of at most 400 days, no prototype keys. No names,
    projects, branches or PR titles, so a PC's box reads by its id on the
    control box and the "by project" split misses PC rows.
  - `toContribution` projects the PC hub's own stats input (`loadUsageRows`,
    split out of `computeUsageStats`), so the PC sends exactly what its own page
    counts. `mergeContribution` replaces the pushed window in what that machine
    sent before; `contributionRows` turns a stored contribution back into
    `buildUsageStats` rows (a day's counts at noon of that day in the PC's zone).
  - Control box: `apps/hub/lib/backend/usage-contrib.ts` `ContributionStore`,
    one JSON file per machine in `~/.agentbox/hub/usage-contributions/` (64
    machines max, at most the schema's 400-day window kept; a merge that would not
    parse is refused, never written). The stats cache lives on `globalThis`: the
    custom server (which stores a push) and Next's route bundle (which reads stats)
    each load their own copy of the module. `POST /api/v1/usage/contributions` (size-checked
    while reading), `GET` lists counts per machine. `/usage/stats` merges every
    machine's rows except its own machine id's, and none under `?subscription=`.
    A device token may only post its own machine id. `/usage/share` (Phase 6)
    builds from the same inputs (`hubUsageStatsDeps`), so a share from the control
    box carries the PCs' numbers too, and the two routes never cache different
    answers for one window.
    Double counting is avoided per kind: a box whose sessions the control box
    holds drops the PC's intervals and tokens for it, a box with `git.push` rows
    there drops the PC's push counts, the same for merged PRs and lifecycle rows,
    and a host session id the control box holds drops the PC's copy.
  - PC: `createContributionPusher` in the hub process, every 5 minutes, only when
    the body's hash changed; the first push to a hub sends a year, later ones 35
    days (and the year again after a zone change). A body over the cap is not
    sent. `POST /api/v1/usage/contributions/sync` pushes now (`?full=1`: the year);
    `agentbox usage` calls it on the local hub before reading a remote one.
    `history.contributeUsage: false` turns it off.
  - The "Sync this PC" button on the Usage page is not wired yet; the route is
    there for it. See the backlog.
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

**4a done (2026-11-26, feat/usage-sync):**
- `flushBoxHistory` (`apps/hub/lib/backend/history-flush.ts`) takes a reason:
  the hub's `stop` and `pause` routes run it before the provider call, on every
  provider (docker: the in-box flush, then the relay's host-side read while the
  box still runs; cloud: `agentbox-ctl history flush` when the box is running).
  Bounded at 30 s (10 s in-box head start) for stop/pause, 90 s for destroy;
  only a destroy settles the relay's docker reads. A stop or pause of a box that
  is not running flushes nothing (the destroy's flush covers it). The relay skips a paused or
  stopped docker box on its 30 s tick, so before this a stop/pause left the tail
  unshipped until the destroy.
- Docker autopause flushes through the relay (`beforePause`, 30 s bound) before
  `docker pause`. The cloud keepalive's idle pause needs none: it acts after
  minutes of idle, and ctl ships every 30 s.
- After a flush the hub refreshes `history_spans` (a call that arrives mid-run
  waits for one more round) and clears the 60 s stats cache, which now lives on
  `globalThis` so the lifecycle code (server.ts) and the route (Next bundle)
  share it.
- Materialize: `apps/hub/lib/backend/history-materialize.ts`, claude only. The
  project folder is the box record's `projectRoot`, else this machine's checkouts
  of the session's repo, else a registered project with that origin. Key:
  `hostProjectKey('dashed-path', folder)`, the same as claude's (checked against
  a real `~/.claude/projects` entry; past 200 chars claude keeps the first 200
  and appends `-` plus the path's 32-bit string hash in base 36, matched against
  Claude Code 2.1.326 with a 273-char path). Runs 15 s after a session ships (debounced),
  60 s after the hub starts and daily. Writes complete lines only: a new copy
  streamed to a tmp file and `link`ed into place (fails if the path appeared), a
  grown one by one `O_APPEND` write of the new lines, read from the archive
  chunk that holds them, with the file checked (size, mtime, inode) on the
  handle before and after. Two hub files of one session that land on one path
  (a box resuming another's session on the shared docker volume) get one owner,
  the manifest's, else the longest. The manifest is written twice per run (all
  entries before any copy lands, then the results) and the daily pass drops
  entries whose hub file and copy are both gone.
  `~/.agentbox/hub/history-materialized.json` records each copy (hub file row,
  offset, size, mtime): an unchanged copy is skipped, a missing one written back,
  a file the hub did not write (a session id collision) or one changed since it
  was written (resumed on the PC) left alone and logged once; both are checked
  again right before the write. The entry is saved before the file lands, and
  the host-session watcher skips the files in that manifest. Docker autopause
  re-checks the agent state after its flush and leaves a box that started
  working running. Box transcripts record `cwd:
  /workspace`, and `claude --resume` lists them anyway (checked).
  `history.materialize` (default true, global or per project) turns it off.
- Live check (docker, in a box): stop and pause right after a turn shipped the
  tail within the call, and `/usage/stats` read 13 s earlier showed it straight
  after; the copy appeared under `-home-vscode-mtproj`, was listed by
  `claude --resume`, came back after a delete, and stopped with the key off.

### Phase 5 — agent-box.sh share endpoint and page

- `POST https://agent-box.sh/api/share`: read the body as raw text and pass it to
  `parseShareBody` from `@agentbox/usage-view`. It refuses more than 64 KB of raw
  text and any `__proto__` / `constructor` / `prototype` key, then parses with the
  strict zod schema (unknown keys rejected, every string an enum or the display-name
  regex, numbers and arrays bounded). **Store `JSON.stringify` of the parsed
  result, never the raw body**: zod drops some keys silently (`__proto__`), so
  only the re-serialized output is known to hold nothing but numbers, dates,
  enum ids and the display name. Stored in Neon Postgres (the Vercel
  Marketplace integration, `vercel integration add neon --non-interactive`):
  `shares (id pk, snapshot jsonb, delete_hash, ip_hash, created_at, deleted_at)`.
  The id is 24 random characters of `[a-z0-9]` minted by the site.
- Rate limit by IP, in SQL (built): at most 10 shares per hour per IP hash
  (HMAC-SHA256 with `SHARE_IP_SALT`; the raw IP is never stored), 429 with
  `Retry-After`. Deleted shares still count. A Vercel Firewall rate-limit rule on
  `/api/share` can be added in front of it, no code.
- Ownership: the POST answers `{ url, id, deleteSecret }` and the site keeps only
  the secret's SHA-256. `DELETE /api/share/<id>` with `Authorization: Bearer
  <deleteSecret>` (constant-time compare) clears the snapshot and keeps the row as
  a tombstone (so the rate limit still counts it); the page and its images are
  revalidated and 404.
- Page `agent-box.sh/s/<id>` renders `packages/usage-view` from the stored JSON
  (`noindex`: a share is reached by its link).
- **OG image** (a first-class deliverable, not an afterthought: the link preview
  is what spreads on X, LinkedIn and Slack). `app/s/[id]/opengraph-image.tsx`
  with `next/og` `ImageResponse`, 1200x630, reusing `lib/og.ts` (`loadOgFonts`,
  the IBM Plex fonts, `boxMark`) like `app/home-og/route.tsx`. Content, all from
  the stored numbers:
  - the hero line ("9 agents at once · 612 hours of work in 211 hours · 2.9×"),
  - the shipped row (PRs merged, commits, +lines/−lines),
  - a strip of the activity wall (last ~20 weeks) drawn as flexbox squares,
  - the top-3 provider marks as round avatars, the display name, and the agent-box.sh
    mark.
  A share can be deleted, and nothing purges a browser, proxy or CDN copy on
  delete, so the image is cached by the client only and briefly
  (`Cache-Control: public, max-age=300`, no `s-maxage`). The page sets
  `og:title`, `og:description` (numbers only), `twitter:card=summary_large_image`.
  Check it with real unfurls (X card validator, LinkedIn post inspector, a Slack
  paste) and with the shortest and largest plausible numbers (1 box, 6-digit
  hours) so nothing overflows. A light and a dark variant are not needed:
  unfurls show one image, so use the paper background with the green accent.

**Share ids, not handles (2026-11-26).** The first build lived at
`/u/<handle>/<n>` with a handle claimed first-come by a claim secret. With no
account behind it, anyone could take a name (`/u/torvalds/1`) and post numbers
under it, so the handle namespace is gone: a share's URL is an unguessable id,
and the optional display name is plain text on the page ("shared by …"), never
in the URL, never unique, never claimed. `pnpm db:migrate` (`SHARE_MIGRATION`
in `db/schema.mjs`) drops the old `handles`/`shares` tables when they are empty,
under an `ACCESS EXCLUSIVE` lock taken before the check (it refuses if they hold
rows), and creates the id-keyed one; it is idempotent. The app's lazy
`SHARE_DDL` only ever creates, so a cold function never drops anything.

Built (2026-11-26): `apps/web` with the `postgres` driver (`prepare: false` for
Neon's pooler). Run `pnpm --filter @agentbox/web db:migrate` once at setup (with
the production `DATABASE_URL`): the first POST creates a missing table, but only
the migration replaces the old handle-keyed one, and until it runs on such a
database shares fail. The rate limit counts an IPv6 client
by its /64. `proxy.ts` 404s a malformed `/s/` path before anything renders or is
cached. The pages are ISR-cached forever and revalidated by the POST and the
DELETE; `/s/example` renders the fixture without a database. Env on the Vercel
project: `DATABASE_URL`
(from the Neon integration) and `SHARE_IP_SALT` (a random secret); without them
`POST /api/share` answers 503 and the share pages 404.

### Phase 6 — share from the hub

- A Share button on the Usage page opens a preview of the exact `UsageShare`
  that will be sent (the same component, public subset), an optional name to
  show, then
  posts through the hub server (`POST /api/v1/usage/share`; the browser never
  calls agent-box.sh) and shows the public URL.
- `share.endpoint` config key (default `https://agent-box.sh/api/share`) for
  testing against a preview deployment.
- `agentbox usage share` for the CLI.

**Done (2026-11-26).** `apps/hub/lib/backend/usage-share.ts` builds the share with
`toShare` over the same `usageStats` the page reads and posts it from the hub
(`POST /api/v1/usage/share`; `preview: true` returns the share and posts nothing;
`GET` gives the endpoint and the shares this hub made). Each share's delete secret
lives in `~/.agentbox/hub/share.json` (0600) with its endpoint, origin, id, URL and
time; `DELETE /api/v1/usage/share/<id>` sends it to the site that minted it and
forgets the share (a site 404 forgets it too). The last display name is
remembered. `share.endpoint` is read from the hub machine's global config only,
and an unreadable config is a 503, never a silent fall back to agent-box.sh. The
site's 429 maps to `rate_limited` (with `Retry-After`), 503 to
`backend_unavailable`, 400/unreachable/a URL on another origin to
`upstream_error` (502). If the secret can't be saved after the site stored the
share, it is written to a file of its own and the error names the public URL.
The Usage page's Share opens a dialog that renders the preview with `UsageView`
(public variant), an optional name checked with `SHARE_NAME_RE`, then the URL
with Copy link, and lists the hub's past shares with Delete.
`agentbox usage share [--name] [--since …] [--dry-run] [-y]`, `agentbox usage
share list` and `agentbox usage share rm <id>`.
Checked live against a local `next dev` of `apps/web` with a scratch Postgres (see
the PR); the open items are in the backlog.

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

1. **URL**: `agent-box.sh/s/<id>`, an unguessable id (decided 2026-11-26; the
   first build's `/u/<handle>/<n>` let anyone post under someone else's name).
2. **Identity**: none. A share carries an optional display name as plain text and
   a delete secret that only proves ownership of that one share. Later option:
   verify a GitHub login so a page can show a real, verified user.
3. **Storage**: Neon Postgres on the agent-box.sh Vercel project (decided
   2026-11-26). It also gives a later gallery or leaderboard for free, and a
   per-IP count in SQL as a backstop to the firewall rule.
4. **Host sessions**: counted as a provider named "this PC", off in the share
   unless the user keeps it.
5. **Hero number**: agent-hours from transcripts, not box-hours.
