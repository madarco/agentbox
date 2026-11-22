# Agent history — backlog

Live list of open items while the phases in
[agent-history-plan.md](./agent-history-plan.md) are implemented. Newest at the
bottom of each section.

## Deferred from Phase 1

- **codex capture (Phase 3).** codex's seeded SessionStart/Stop hooks still run
  backgrounded with no `--capture-session`; making them synchronous with capture
  belongs with codex's `history` block and parser.
- **Remote control box forwarding.** A laptop hub configured against a control
  box (`relay.controlPlaneUrl`) still ingests its own boxes into its local
  `history.db`. It should forward frames to the control box's
  `POST /api/v1/history/chunks`, the way timeline rows are forwarded.
- **Multi-PC host-reach path.** `history.*` RPCs that arrive through the
  host-reach executor (`daemon.ts`, a box served from another PC) answer
  `disabled`. They should be routed to the box's owning hub.
- **Opt-out for hub-built boxes.** `history.capture` is read from the project
  config on the machine running the relay (registration worktree, then the box
  record's `projectRoot`). A box a control box built from a temp clone gets
  that machine's global value. The opt-out should ride the create request the
  way other portable create options do.
- **Same session from two boxes.** On the shared docker volume, `claude
  --resume <id>` in box B binds a session box A started. Both shippers then
  ship the same file under two origins, so the session's turns are counted
  twice (usage is deduped by message id) and `box_id` stays A. Fix: key turns
  by session + line hash, or let a binding transfer a file's ownership.
- **Pass cost on long-lived boxes.** Every pass re-stats every bound session
  (one `docker exec` per stat/ls on docker). Batch them into one script per box,
  or skip sessions whose size did not change.
- **Cloud final flush on a paused box** is skipped rather than resuming the box
  (resume bills and boots it). A turn cut off mid-pass before the pause is lost
  with the box.
- **Prune.** `agentbox prune` removes orphans whose container is already gone,
  so nothing is flushed there. Shared-volume transcripts of those boxes stay
  unshipped (Phase 0: "an unbound session lingers forever").
- **Hub restart re-verification.** After a hub or relay restart, the first frame
  of every file gets `offset_mismatch`, and the edge re-hashes the file's
  ingested prefix to fast-forward. That is one full read of each bound file,
  387 MB worst case. A persisted edge cursor would avoid it.
- **tool-results.** claude's `<id>/tool-results/*.txt|.jpg` spill files are not
  in the `history` block yet (96 MB on the measured Mac, mostly JPEG).
- **`redaction_hint`.** Phase 0 proposed flagging shape-free leftovers (an
  ordinary-looking password in a URL or an assignment) on the turn rather than
  blanking them. Not implemented; those values are kept as they are.
- **REST ingest trusts the caller's origin.** `POST /api/v1/history/chunks`
  takes `origin.boxId` from a hub-credential holder, like every other
  `/api/v1` write. With teams (Stage 2), a device token should only write the
  boxes of its own PC.
