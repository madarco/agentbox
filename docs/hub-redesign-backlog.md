# Hub web redesign — backlog

Live list for [`hub-redesign-plan.md`](./hub-redesign-plan.md): design elements left out of
Phase 1, why, and what each needs.

## Waits for multi-user

- Sidebar: Team group (Members, Triggers, Team settings), the "My profile" group, the
  hub/team switcher popover in the sidebar header. The slot is a comment in
  `components/app-sidebar.tsx`; the header shows the hub's name and mode with no switcher.
- Dashboard: the Mine / Team scope toggle, the "for N people" headline, owner avatars in
  Live now and Recent activity, "Who's shipping" card, the "N more on the team" footer.
- Box table: Owner column. Box detail: owner in the meta row, "Running as" card.
- Approvals: "Waiting on teammates" section, "Approve as admin".
- Settings: MCPs page, Team settings General/System split, GitHub App card as shown.

## Data gaps (the hub does not serve it yet)

- Box table "Last 2h" sparkline and the Live now sparklines: no per-box activity or token
  series. Omitted.
- KPI "Agent-hours today" sub line in the design compares against "hours since 9:00": no
  such definition in the stats; the hub shows agent-hours over the day's wall-clock hours
  with any box running (`agentHours / wallHours`), the same side-by-side ratio the Usage page
  uses.
- "Your day" lanes: the design separates "working" from "waiting / limit". The ledger knows
  box lifecycle (running / paused), not agent state over time, so lanes show running and
  paused only.
- Recent activity: the design mixes commits, tests, triggers and approvals. The ledger has
  lifecycle, pushes and PR states; the feed shows those. Tests and triggers have no source.
- Box detail: "Files touched" and "Commits" have no host-side source on most providers
  (`null` → "—"), the agent output terminal (no streamed output API on the box page; the
  hub has an attach flow instead), the Skills / MCPs / Files tabs (the hub shows skills as a
  panel; MCPs and files per box have no API).
- Box source tags (Linear / Slack / GitHub trigger icons): no trigger source on `Box`.
- Search palette: only pages, projects and boxes. No sessions or skills search yet.

## Docs figures

- `hub-dashboard.png` (hub.mdx hero): recaptured in Phase 1 from a fresh test hub, so the
  lanes, week bars and figures are nearly empty and one lane is a failed create. Recapture
  after a day of real work, agents mid-turn, per `apps/web/images.md`.
- No other docs figure shows the hub web UI (`dashboard.png` is the `agentbox dashboard`
  TUI, not the hub).

## Found while redesigning

- A dismissed failed create still draws its lane in Your day for the rest of the 12 h
  window (the ledger keeps the row; the lane has no box to open). Harmless, but the lane
  could fade or drop once the `job:` row is gone from the store.
