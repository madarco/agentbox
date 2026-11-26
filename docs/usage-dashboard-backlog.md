# Usage dashboard — backlog

Open items found while building the phases of
[`usage-dashboard-plan.md`](./usage-dashboard-plan.md). Newest phase first.

## From Phase 2 (the stats API)

- **The feed of merged PRs is empty.** `FeedItem` needs a title, and the ledger
  holds no free text, so `buildUsageStats` drops every merge from the feed
  (`feedTotal` still counts them). The hub page (Phase 3) could fetch the titles
  of the last few merges from GitHub, or the workspace timeline where one exists.
- **Session titles are not passed.** Manager sessions are named "N boxes, <date>";
  the page phase should pass `sessionTitles` from `GET /api/v1/managers`.
- **No postgres history store yet.** The span and token queries are plain SQL
  window functions and `CASE`, so a postgres `HistoryRepo` can run them as they
  are, but history is sqlite-only today (a control box keeps `history.db` too).
- **Box-hours start at the read.** The read reaches a year plus one window back. A
  box whose first row in it stops it counts nothing before that stop (it may have
  been stopped for months), and one with no row in the read is not counted, so a
  box left running for over a year undercounts. `runningNow` is the boxes whose
  newest lifecycle row is a running one, so a resume the ledger missed (see the
  Phase 1 item) reads as not running.
- **A share's zone must be one agent-box.sh also lists.** `isTimeZone` checks the
  runtime's own `Intl` list, which differs a little between ICU versions (an alias
  such as `Asia/Kolkata` is `Asia/Calcutta` on Node 24). The hub canonicalizes the
  zone it is given; the share endpoint (Phase 5) should map a zone it does not list
  to `UTC` rather than refuse the share.
- **A purged session that is shipped again** recomputes its spans from the first
  remaining turn on; a purged span that overlaps the new turns loses its purged
  part. Rare (a transcript has to come back after 90 days).
- **Ledger rows of one millisecond come back in id order.** `list` orders by
  `at, id`, and ids are random for rows with no source key, so a pause and a
  resume in the same millisecond can read reversed (box-hours then miss a
  zero-length run; harmless). An insertion sequence column would fix it.
- **Sessions purged before the spans migration have no hours.** Their turns were
  already gone when `history_spans` arrived; only sessions purged afterwards keep
  their intervals. Tokens are unaffected.
- **Spans are refreshed on the read path.** A GET recomputes the spans of every
  session that took turns since the last read (a few ms each); the first read after
  the migration does every session once (2.5 s for 1M turns). If that shows up,
  move the refresh to the ingest sweep.
- **A ledger read stops at 50 000 rows of one millisecond.** `list` has no cursor
  past `at`, so a page entirely inside one millisecond cannot be stepped over. Only
  a bulk import could write that.
- **`agentbox usage` and `usage tokens` read windows differently.** `usage` takes
  local days (`--until` included) or `<n>d`/`<n>w`; `usage tokens` keeps ISO times
  and durations (`24h`, `all`) with `--until` excluded, as before.
- **Spans are cut at one idle gap.** `history_spans` is computed at the 10-minute
  default; `usageSpans` refuses another gap. A configurable gap would need a
  recompute of every session.

## From Phase 1 (activity ledger)

- **Resumes that bypass the hub routes are not recorded.** The ledger has
  `box.paused` from the hub's pause route, docker autopause and the cloud
  keepalive's idle pause. A box woken any other way gets no `box.resumed`: an
  e2b sandbox auto-resuming on inbound traffic, or a paused docker box unpaused
  by something other than `POST /boxes/{id}/resume`. A `start` on a paused box
  resumes it but is recorded as `box.started`. Box-hours (Phase 2) count any running row after a stop, pause or failure
  as the start of a run, so `box.started` after `box.paused` works; a state change
  from the box status loop is still not read.
- **A push's stat comes from the ref update git prints.** Every push path
  (hub route, relay docker, relay cloud, scratch repo) measures from the old
  tip in git's own `a1..b2  src -> dst` line, so nothing is read before a push.
  If that line is missing (a quiet push, or output from a git that words it
  differently), the row is written without counts rather than counting the
  whole branch. A push git reports as up to date is still a row, with no
  counts; Phase 2 counts commits, not rows.
- **An old in-box ctl does not mark a hub-route push it reports itself.** A
  direct or leased box running an image from before this change sends
  `git.pushed` without `hostInitiated`. Both rows are then keyed
  `push:<box>:<tip>`, so one survives, but it may be the box's (actor `box`)
  instead of the hub's.
- **`hostOnly` pushes are counted rows.** A `push --host-only` landing is
  recorded with `hostOnly: true`. Phase 2 counts a host-only landing only when no
  published push of the same box follows it, so the same commits never count
  twice.
- **Backfilled rows carry less.** A workspace timeline has no provider or
  account, and its repo is the workspace project's (or the PR's). Destroyed
  boxes' rows can't be enriched afterwards.
- **A Store-only box (a PC's box on a control box) has no account.** The context
  comes from its registration: name, origin, and `backend` as the provider.
- **The PR sweep covers GitHub repos only, for 30 days.** It polls
  `gh pr list --repo` for every repo with a box branch in the ledger whose PR is
  not merged or closed yet. A box branch older than 30 days drops out of it.
- **The ledger is never trimmed.** It is one small row per event (a busy month is
  a few thousand rows). If it grows, add a retention sweep like history's.
- **A laptop with a control box configured writes its own boxes to its own
  ledger.** The control box's boxes are in the control box's ledger. Merging the
  two is Phase 4's job (the laptop's stats fetch the control box's and merge).
- **`box.failed` carries no reason.** Deliberately: the ledger holds no free text
  (the share snapshot must not leak any). The create job's log has it.

## From the `packages/usage-view` work (Phase 2 package half, Phase 3 components)

- **Box-hours vs agent-hours in the daily chart.** The mockup's "Box-hours" metric on the
  daily chart, the punchcard and the providers card is drawn from agent-hours (active
  intervals), because those are what split by agent and provider. Box-hours (ledger
  running time) is only the KPI card and `daily[].boxHours`. If the ledger gives
  per-provider box-hours, the providers card could offer both.
- **Wall "tasks".** The mockup's wall tooltip had "Tasks done"; there is no task count in
  `UsageStats` yet. Add one when workspace tasks reach the ledger.
- **Forecast.** The hatched forecast bars use the average per day so far. A weekday-aware
  pace would be closer for windows with quiet weekends.
- **Agent logos are duplicated.** `packages/usage-view/src/components/agent-logos.ts` is a
  copy of `apps/hub/components/agent-logos.ts`. Once the hub depends on `usage-view`, the
  hub should import `AGENT_LOGOS` from it and drop its copy.
- **Provider marks are stand-ins.** As in the mockup: a round brand-colour mark per
  provider (plus new ones for digitalocean, host and other). Swap in the real logo files
  when they are added to the design repo.
- **Session titles.** `buildUsageStats` names a manager session from `sessionTitles`
  (by manager id), else "N boxes, <date>". The hub has to pass the manager session's title
  (from `GET /api/v1/managers`) for the table to read like the mockup.
- **Range control and header actions.** `UsageView` takes `onRangeChange` and an
  `actions` slot (subscription filter, Export CSV, Share); the hub page wires them in the
  page phase. The CSV export itself is not built.
- **Leaderboard click-to-filter.** The mockup's "Click a row to filter the page" is not
  implemented; it needs a filter parameter on the stats endpoint.
- **Share keeps fewer details than the page.** `toShare` keeps 62 days of the daily
  chart, the 3 Gantt days, the 16 busiest lanes a day (neighbouring intervals merged
  down to 8) and 10 sessions, so a maximal share fits 64 KB. If shares need more,
  drop a column (per-provider splits) before raising a limit, and rerun the
  maximal-share size test.
