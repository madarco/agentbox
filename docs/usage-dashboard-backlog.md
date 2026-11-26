# Usage dashboard — backlog

Open items found while building the phases of
[`usage-dashboard-plan.md`](./usage-dashboard-plan.md). Newest phase first.

## From Phase 1 (activity ledger)

- **Resumes that bypass the hub routes are not recorded.** The ledger has
  `box.paused` from the hub's pause route, docker autopause and the cloud
  keepalive's idle pause. A box woken any other way gets no `box.resumed`: an
  e2b sandbox auto-resuming on inbound traffic, or a paused docker box unpaused
  by something other than `POST /boxes/{id}/resume`. A `start` on a paused box
  resumes it but is recorded as `box.started`. Box-hours in Phase 2 should treat
  `box.started` after `box.paused` as a resume, and read any running/paused
  state change from the box status loop as a fallback.
- **A push's stat comes from the ref update git prints.** Every push path
  (hub route, relay docker, relay cloud, scratch repo) measures from the old
  tip in git's own `a1..b2  src -> dst` line, so nothing is read before a push.
  If that line is missing (a quiet push, or output from a git that words it
  differently), the row is written without counts rather than counting the
  whole branch. A push git reports as up to date is still a row, with no
  counts; Phase 2 should count commits, not rows.
- **An old in-box ctl does not mark a hub-route push it reports itself.** A
  direct or leased box running an image from before this change sends
  `git.pushed` without `hostInitiated`. Both rows are then keyed
  `push:<box>:<tip>`, so one survives, but it may be the box's (actor `box`)
  instead of the hub's.
- **`hostOnly` pushes are counted rows.** A `push --host-only` landing is
  recorded with `hostOnly: true`. If the same commits are pushed later, Phase 2
  must not count them twice. Count published pushes for "shipped", and
  host-only landings only when nothing published follows.
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

- **Days across a DST change.** `UsageRange.tzOffset` is one fixed offset (local minus
  UTC, minutes), so a 90-day or year window that crosses a DST change buckets the days on
  the other side of it an hour off (a 00:30 turn lands on the previous day, the punchcard
  shifts one hour). The fix is an IANA zone (`tz: 'Europe/Rome'`) and `Intl`-based day
  keys in `dayKey` / `dayStart` / `spansByDay` / the punchcard. Kept the offset for now
  because the plan's API is `?tzOffset=`; decide before the hub endpoint ships.
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
