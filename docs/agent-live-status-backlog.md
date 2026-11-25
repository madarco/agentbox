# Agent live status: backlog

Open items from [`agent-live-status-plan.md`](./agent-live-status-plan.md). Phases 1-3 are
done; Phase 4 (surfaces) tracks its own items in the plan.

## Deferred from Phase 1

- **opencode's shared `model.json` (bug 5's trigger).** opencode falls back to the last-used model in
  `.state/opencode/model.json`, which lives on the config volume every opencode box shares (and is
  synced from the host), so one box's model choice is every box's default. Phase 1 only makes the
  failure visible (sticky `error`, the `-i` verdict). Two options:
  1. a per-box `XDG_STATE_HOME` (box-local, off the volume): every box starts from the host's
     default, and a choice in one box stays there; costs the other `.state` contents the volume
     carries today;
  2. pin a model per box at create (`opencode.model` setting -> `--model` launch flag), which also
     gives the hub something to show.
- **An older-image box re-seeds old hook files.** Seeds always overwrite, from the BAKED copy of the
  box doing the seeding. On docker the codex, opencode and pi files sit on volumes shared between
  boxes, so starting an agent in a box whose image predates this change puts the old file back for
  every box, until a newer box starts that agent again. The files only regress to the old bugs
  (nothing breaks: every new flag they pass is one an older ctl already has), and a re-bake on each
  provider ends it. A content-version guard in the seed script (skip when the destination is newer)
  would stop the flip-flop.
- **pi before `agent_settled`.** `agent_end` ends the turn until the first `agent_settled` shows
  this pi emits it, so an older pi (pinned by `pi.version`, or an older-image box's reseeded
  extension) still reaches idle. On that path a failed last message reads idle, not error: the
  extension cannot tell a run that ended from one about to retry. Measured only on 1.6.0.
- **pi's error is decided at the settle.** Pi auto-retries a failed request after a backoff, and
  `auto_retry_start` is a session event extensions do not receive, so the extension holds a failed
  message and reports `error` only if it is still the run's last word at `agent_settled` (and the
  run was not aborted). A turn whose retries all fail reads `working` until then.
- **codex compaction reads `working`.** The scraper follows the title's spinner, which also shows
  during compaction, so a PreCompact `compacting` can be overwritten by the scraper's next
  transition. Cosmetic; `compacting` and `working` both count as busy for the queue gate.
- **Pane-title rules not live-verified for codex, opencode and pi.** The strip patterns follow the
  Phase 0 notes (`[ ! ] Action Required |`, ` | <cwd>`, `OC | `, `π - … - <cwd>`); the exact
  spinner glyphs and the no-name forms were not captured verbatim. The host recipe in the PR covers
  them; adjust the registry rows (no re-bake needed) if a sample disagrees.

- **codex reports no `error`.** The old pane-text rules (`Error:`, `Failed:`) were its only error
  source, and they matched prose. No codex hook maps to an error, so the `-i` first-turn error
  check catches opencode, claude (StopFailure) and pi, but not codex.
- **codex's synchronous question hooks can stall.** The `request_user_input` PreToolUse and
  PostToolUse run without `&` (so the leave cannot land after Stop); with the ctl socket dead, each
  waits out the client's connect timeout, about 3 s, before codex goes on. Buffer-and-background
  like the capture hooks would trade that for the ordering.
- **The codex title states are baked.** The scraper's spinner and `Action Required` regexes live in
  ctl, while the title cleanup is registry data. Moving them to the row (for example
  `paneTitle.states: { working, waiting }`) would let a new codex title format ship without a
  re-bake.

## Deferred from Phase 2

- **codex between a switch and the next prompt.** SessionStart fires only at the first prompt
  after `/new` or `/resume`, so the old id stays until then (accepted in the plan).
- **The opencode title match needs a title.** A brand-new session shows `OpenCode` (a
  placeholder) until its first prompt is titled, so until then the plugin's last busy id stands.
- **`claude -p` in the box takes over the session id.** Its capture hooks move the one current-id
  slot (and the resume pointer) to the `-p` session, and its SessionEnd then clears it, so the box
  reports no session until the TUI's next Stop. The hook payload does not say which process it
  came from; the TUI's pid (or `CLAUDE_CODE_ENTRYPOINT`, if it is set in the hook env) could tell
  them apart.
- **No push on a TUI-only switch.** The opencode match runs on each 15s snapshot; a `/sessions`
  switch with no new state change shows up on the next periodic push, not at once.

## From Phase 3 (hub-side)

- **Codex session names need a re-bake.** The `format: 'jsonl'` row source lives in `@agentbox/core`,
  which ctl inlines, so a box's ctl reads `session_index.jsonl` only after a re-bake on every
  provider. An older ctl receives the new codex source over `history.config`, tries to open the
  file as a sqlite db, and records an error for that source on every pass (opencode and openclaw
  are unaffected). Until then a codex box's title falls back to its first prompt.
- **The `sessionId` fallback.** `currentSessionKey` falls back to the box's most recent session of
  that agent while ctl reports no `sessionId` (Phase 2). It prefers sessions with no parent, so a
  claude `/branch` session is never picked by the fallback, and it skips a latest session whose last
  line is more than 90s (`FALLBACK_STALE_MS`) older than the agent's last state report, so after a
  `/clear` the old session can still show for up to that long. The grace cannot be zero: every hook
  report moves `updatedAt` while the transcript ships up to 60s behind. Drop the fallback once every
  supported box reports `sessionId`.
- **The slice's per-box maps** (`current`, `lastNotify`) keep an entry per box ever listed while the
  hub runs; `seen` is capped at 5000 sessions. Prune destroyed boxes if a long-lived hub shows it.
- **An idle claude or pi box's `activity` is its final reply**, since the plan takes the last
  assistant text when it is newer than the last tool call (codex uses commentary only). Phase 4
  hides it outside `working`/`waiting`/`question` on every surface, but the payload still carries
  it; a client that ignores the rule shows the reply. Dropping text-only final turns in the parser
  would fix it at the source.
- **`session_index.jsonl` is read whole** on every change of its stamp, and its rows are keyed by line
  number. Fine at its size today; if codex ever rewrites or compacts it, a rename between the
  rewrite and the next pass is skipped.
- **The Postgres box source** (`apps/hub/lib/boxes/postgres-source.ts`, the hosted plane path) does
  not enrich `agentStatus`: it has no history store.
- **Cost for claude** is still absent (the plan's open question).
- **opencode tool parts settle for 20s** before the cursor copies them, so opencode's working-on
  line lags more than the other agents'. The in-progress todo is copied without a settle delay.
- **Ship cadence.** The docker host watcher ships every 60s, so a docker box's working-on line can be
  a minute old. Lowering it for `working` boxes is the plan's open question.

## From Phase 4 (surfaces)

- **Two copies of the presentation rules.** The hub's client bundle cannot value-import
  `@agentbox/core`, so `apps/hub/lib/live-status-view.ts` mirrors `sync/live-status-view.ts`;
  `apps/hub/test/live-status-view.test.ts` fails on drift. A client-safe subpath export of core
  (`@agentbox/core/view`) would remove the copy.
- **`inspect` reads the whole box listing** to find one row (`fetchBoxListing`, memoized). A
  `GET /api/v1/boxes/{id}` client call would be cheaper on a big fleet.
- **The dashboard TUI and the cmux dock** do not show the working-on line or tokens yet.
- **The project page's box list** uses the same `BoxTable`, so it shows the live line too; the
  workspace timeline and the manager view do not.
- **The title-vs-task check is a string compare.** `task` falls back to a session title, so the row
  and the detail card hide a title equal to it (trimmed). The Box payload does not say where `task`
  came from; a `taskSource` field would make this exact when the hub picked another agent's title.
- **The catalog fixture's `fix-webhooks` box reports `thinking`**, not an `AgentActivityState`
  (pre-existing); align it with the tray's fixture when that story is next retold.
