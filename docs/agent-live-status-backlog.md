# Agent live status: backlog

Open items from [`agent-live-status-plan.md`](./agent-live-status-plan.md). Phases 1-2 (box side) are
done; Phase 3 (hub side) and Phase 4 (surfaces) track their own items in the plan.

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
- **pi before `agent_settled`.** The extension no longer maps `agent_end` to idle, as the plan asks.
  A pi build older than `agent_settled` (pre-1.6) would stay `working` after a turn until the next
  `session_start`. Measured only on 1.6.0.
- **codex compaction reads `working`.** The scraper follows the title's spinner, which also shows
  during compaction, so a PreCompact `compacting` can be overwritten by the scraper's next
  transition. Cosmetic; `compacting` and `working` both count as busy for the queue gate.
- **Pane-title rules not live-verified for codex, opencode and pi.** The strip patterns follow the
  Phase 0 notes (`[ ! ] Action Required |`, ` | <cwd>`, `OC | `, `π - … - <cwd>`); the exact
  spinner glyphs and the no-name forms were not captured verbatim. The host recipe in the PR covers
  them; adjust the registry rows (no re-bake needed) if a sample disagrees.

## Deferred from Phase 2

- **codex between a switch and the next prompt.** SessionStart fires only at the first prompt
  after `/new` or `/resume`, so the old id stays until then (accepted in the plan).
- **The opencode title match needs a title.** A brand-new session shows `OpenCode` (a
  placeholder) until its first prompt is titled, so until then the plugin's last busy id stands.
- **No push on a TUI-only switch.** The opencode match runs on each 15s snapshot; a `/sessions`
  switch with no new state change shows up on the next periodic push, not at once.
