# Usage dashboard — backlog

Open items found while building the phases of
[`usage-dashboard-plan.md`](./usage-dashboard-plan.md). Newest phase first.

## From Phase 6 (share from the hub)

- **A stale claim secret has no UI.** If a site's shares are reset (a preview
  deployment's database), the hub keeps sending the old secret and every share of
  that handle is refused; the error says to remove the `<origin> <handle>` entry
  from `~/.agentbox/hub/share.json`. A "forget this handle" action (API + dialog)
  would replace the hand edit.
- **No delete or update of a posted share.** The hub keeps the secret so a later
  `DELETE`/`PUT` on agent-box.sh can prove ownership, but the site has neither yet.
- **The preview is built once.** The dialog renders the share of the window at the
  moment it opens; the post rebuilds it, so a turn finished in between can move a
  number by a minute's work. Posting the previewed share instead would make them
  identical but let the browser send any schema-valid body.
- **The dialog follows the hub's light-only theme** (see Phase 3: the hub has no
  dark tokens yet). It uses the hub's own tokens, so it needs nothing when they land.
- **Live check was against a local `next dev`**, not a Vercel preview: previews sit
  behind Vercel login and the box has no bypass token. Repeat it once against the
  preview (`share.endpoint=https://<preview>/api/share`) or production after the
  Neon setup.

## From Phase 3 (the hub Usage page)

- **The default window is the last 30 days**, to match the tray's header pill
  (hours saved over `since=30d`). The mockup's ranges have no 30-day option and
  select "This month"; the page adds **30 days** (`RangeId` `30d`) and opens on it.
  The stats endpoint names a window with no `range` by its length and start: a
  window from the 1st is `month`, any other up to 31 days `30d` (so `agentbox usage`'s
  default reads "Last 30 days", not "November so far").
- **The hub has no dark theme.** `ThemeProvider` is light-only and the hub defines
  no `.dark` tokens, so the view's dark styles (checked by forcing `.dark`) show on a
  light shell. When the hub gets a dark theme, the page needs nothing more.
- **Instrument Serif is not loaded in the hub.** The view's italic accents fall back
  to Georgia; the hub self-hosts only IBM Plex. Add the font file under `app/fonts`
  if the serif matters.
- **The Recently merged feed and session titles are still empty / generic** (the
  Phase 2 items): the page passes nothing extra yet.
- **Agent logos are still duplicated** between the hub and `usage-view`.
- **"This month" is computed from the browser's clock.** The page sends the month's
  first and last day; a browser clock past midnight on the last day of a month, ahead
  of the hub's, asks for a `since` in the hub's future and gets a 400 until the hub's
  day turns. The rolling ranges send no `until` and are safe. A `since=month` form on
  the endpoint would remove it.
- **`range.id` gained `30d`.** A client that decodes `range.id` with a closed enum
  (the tray, an older agent-box.sh share endpoint) must accept it; deploy apps/web
  before hubs share a `30d` window.
- **CSV is per day only.** Sessions, boxes and projects are not exported; the token
  breakdown has its own view but no export.

## From Phase 4a (flush on stop/pause, materialize)

- **Codex, opencode and pi sessions are not materialized.** Claude only
  (`MATERIALIZED_AGENTS`). Codex keeps date folders with no project key, pi a
  `--<path>--` key, opencode a sqlite store; each needs its own host layout.
- **A box session resumed on the PC keeps its new turns local.** The copy is left
  alone once claude appends to it, and the host-session watcher skips it, so the
  PC-side turns never reach the hub. Shipping them would need the watcher to send
  only the bytes past the materialized offset under the box session.
- **A rewrite of our own copy is a check then a `rename`.** A new copy is
  `link`ed (fails if claude created it meanwhile) and an append is checked on the
  open handle, but replacing a copy whose hub file changed generation (the box
  rewrote it) leaves a short window between the check and the rename.
- **A re-created copy gets a fresh mtime**, so the resume picker shows an old box
  session as recent, and claude's cleanup deletes it again 30 days later (the
  daily pass writes it back). Setting the mtime to the session's last turn would
  make the cleanup delete it at once.
- **A box whose project folder the hub does not know is not materialized** (a
  control box's box, a destroyed box from a repo with no checkout reported). The
  remote-hub case is Phase 4b's.
- **The cloud keepalive's idle pause does not flush.** ctl ships every 30 s and
  the pause comes after minutes of idle, so only a memory write in the last 30 s
  of an idle box could be missed.
- **A stop or pause flush ships opencode rows before they settle.** The final
  pass ignores the row cursor's settle wait (as the destroy's flush always has,
  see the agent-history backlog). A row that changes after the resume is written
  again, so the history holds both versions.
- **A stop/pause flush that times out keeps running.** Unlike a destroy, it is
  not settled (the box comes back, so its reads must go on); the relay's next
  pass for that box waits behind it.
- **Autopause flushes transcripts, not the in-box pass.** The relay's read covers
  claude/codex/pi transcripts; opencode's row cursor and memory run in the box's
  own 30 s loop, which the pause freezes until the box resumes.

## From Phase 5 (agent-box.sh share endpoint and page)

- **Owner setup before it works in production**: add Neon to the Vercel project
  (`DATABASE_URL`) and set `SHARE_IP_SALT` to a random secret. Until then the
  endpoint answers 503 and `/u/<handle>/<n>` 404s; `/u/example` works without either.
  Run `DATABASE_URL=… pnpm --filter @agentbox/web db:migrate` once at setup: the first
  POST also creates the tables, but two cold functions doing it at once can race.
- **A lost claim secret can't be recovered**, and a share can't be deleted. Both need an
  identity later (the plan's GitHub-login option) or a manual SQL delete plus
  `revalidatePath`.
- **404s are cached too.** `/u/<handle>/<n>` is ISR with no expiry, so a request for a
  share that does not exist yet caches the 404 until the POST revalidates that path
  (it does). `proxy.ts` refuses malformed handles and numbers uncached, but a crawler
  guessing well-formed paths still fills the ISR cache with 404 entries; a firewall
  rule on `/u/*` request volume would bound it.
- **Provider marks are copied a third time** into `apps/web/lib/share/og.tsx` (satori
  needs plain SVG and usage-view's `ProviderLogo` is client code). The e2b mark is three
  bars there, since satori does not render SVG text. If usage-view exported its marks
  as data (bg + SVG children) from the non-client entry, the OG image could import them.
- **The rate limit counts by the IP Vercel reports** (`x-real-ip`, else the first
  `x-forwarded-for`). A hub behind one NAT shares the limit with its neighbours; 10
  shares an hour is plenty for one person.
- **Refused posts are not counted.** A 403 (wrong claim secret) is checked before any
  lock and writes nothing, so it does not count toward the per-IP limit: guessing a
  secret costs one indexed read per try (a 256-bit secret is not guessable). A
  Vercel Firewall rule on `/api/share` is the throttle for that.
- **The DB tests need a Postgres.** `apps/web/test/share.test.ts` runs against
  `SHARE_TEST_DATABASE_URL` and skips without it, so CI does not run the claim,
  rate-limit and concurrency tests. A `postgres` service container in the CI job
  would.
- **Unfurl checks with the real validators** (X card validator, LinkedIn post inspector,
  a Slack paste) need the production domain; done locally only against the rendered PNGs.

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
- **New turns reach the dashboard within a minute.** Spans are refreshed by the
  history service's minute sweep (and a background backfill at start), not on the
  read, so a turn taken seconds ago is not in the stats yet. One session with
  millions of turns would still block one batch; split a session's refresh if that
  shows up.
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
