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
- **Cloud final flush on a paused box** is skipped rather than resuming the box
  (resume bills and boots it). A turn cut off mid-pass before the pause is lost
  with the box.
- **Prune.** `agentbox prune` removes orphans whose container is already gone,
  so nothing is flushed there. Shared-volume transcripts of those boxes stay
  unshipped (Phase 0: "an unbound session lingers forever").
- **tool-results.** claude's `<id>/tool-results/*.txt|.jpg` spill files are not
  in the `history` block yet (96 MB on the measured Mac, mostly JPEG).
- **`redaction_hint`.** Phase 0 proposed flagging shape-free leftovers (an
  ordinary-looking password in a URL or an assignment) on the turn rather than
  blanking them. Not implemented; those values are kept as they are.
- **REST ingest trusts the caller's origin.** `POST /api/v1/history/chunks`
  takes `origin.boxId` from a hub-credential holder, like every other
  `/api/v1` write. With teams (Stage 2), a device token should only write the
  boxes of its own PC.

## From the independent review of #435 (2026-11-22)

Fixed in #435: B1 (bindings stamped with the box id, foreign lines skipped,
log removed by the checkpoint cleanup), B2 (one batched scan exec per docker
box per pass; only grown files are read), R1 (ctl backs off 10 min when the
relay refuses `history.config`), flush helpers settled before the docker
teardown, and the private-key rule kept inside one line. Still open:

- **L1: destroy latency.** A paused docker box's final flush runs one helper
  container per file read (the scan is already batched). A well-used cloud box
  can reach the 90 s cap because a fresh shipper learns every file's cursor the
  expensive way (L2). Consider a 20-30 s cap once L2 lands.
- **L2: cursor probe.** A fresh shipper (ctl restart, `history flush`, hub or
  relay restart) sends a full first frame per file (512 KB on ctl, 4 MB on the
  relay) just to get `offset_mismatch`, then re-hashes the file's ingested
  prefix to fast-forward. That is one full read per bound file, 387 MB worst
  case. Fix: let `ingest` accept an empty-data probe that answers with the
  hub's offset and hash, and persist an edge cursor so the re-hash is skipped.
- **L4: parked frames while the host is offline.** `RpcTimeout` does not abort
  the HTTP request, and the in-box relay's `HostActionQueue` expires entries
  only in `drain()`. An overnight cloud box with the laptop asleep keeps about
  10 MB/h of parked frames. Fix: abort on timeout, and skip passes while an RPC
  is unanswered.
- **L5: cross-box writes and validation.**
  - The session key is global (`<agent>:<stem>`), so a malicious box can append
    records to another box's session by naming its path.
  - `chunk()` accepts docker boxes, whose transcripts are shipped host-side.
  - `agent` and `path` are not checked against `shippedAgents()` and its
    `sessionFiles` patterns. Unbound files (`sessionKey` null) are never
    reached by retention.
- **L6: docker box env not in the redactor.** Values in a docker box's env
  (model-auth `env` source, `-e`) that match no known format reach the hub
  unless they appear as `KEY=value`. Fix: feed `docker inspect` `.Config.Env`
  through `secretValuesFromEnv` into that box's redactor.
- **L7: frame-boundary misses.** A line over 512 KB is split mid-line on ctl,
  so the relay's exact-value pass can miss a host secret straddling the cut. A
  final partial line is redacted separately from its later completion.
- **L8: stale docker registrations.** A container removed by hand makes
  `docker inspect` fail and log on every pass. Skip a missing container and log
  it once.
- **L9: `projectKey` hard-coded to `-workspace`.** A claude session started from
  another cwd resolves to a path that does not exist, so nothing ships. Prefer
  the bound `transcriptPath` once it is checked to be under `configDir`.
- **L10: minor.**
  - `projectCaptureEnabled` reads state.json before its cache lookup for a
    registration with no worktrees.
  - The REST route reads the whole body before checking its size.
  - A seal failure throws out of `sweep` and skips that hour's retention.

## After Phase 1 merged (#435)

- **Post-fix e2b live leg skipped.** #435 was merged with the docker live check
  green after the review fixes. e2b is covered by unit tests plus the pre-fix
  live run: the post-fix run was blocked by an expired Claude login on the test
  machine. Next time a cloud box is at hand, check that a box-stamped binding
  ships through the ctl loop (not only `history flush`), with ctl baked into
  the snapshot.

## Phase 2 (read API + CLI)

- **Split stores.** With a control box configured, `agentbox sessions` reads the
  configured hub, while this machine's docker boxes still ingest into the local
  hub (see "Remote control box forwarding"). `--local` reads the local one.
  There is no merged view until forwarding lands.
- **`sessions resume <id>`** (plan, CLI section) is not in Phase 2's row; it
  reuses fork's create + teleport path and is still open.
- **Generations.** Reads serve a file's current generation only. Older
  generations (a rewritten file) stay in the archive until retention, with no
  route to them.
- **Non-FTS fallback** (review of the Phase 2 diff). On a sqlite without FTS5,
  `q` / `search` become one contiguous `LIKE '%w1 w2%'` (a phrase, not "all
  words") with `%`/`_` unescaped. Node's `node:sqlite` ships FTS5, so this
  path is untested in practice; make it a per-word `LIKE ... ESCAPE` AND.
- **Search N+1.** `GET /history/search` loads each hit's session with its own
  `getSession` round trip and returns a subset of the session shape (no
  `key`). Batch-load, or JOIN in `repo.search`, and reuse `sessionJson`;
  this matters once the postgres repo lands.

## From the review of #439 (2026-11-22)

Fixed in the follow-up: `sessions download` writes `<file>.part` and renames on
success, reporting the bytes actually written (LATER-2), and `sessions` is in
`agentbox help`'s Advanced group plus the drift test's mirror (LATER-5). Still open:

- **`/raw` across a generation change (LATER-1).** The route takes the file's
  offset, then `rawStream` re-reads the row; a `reset` frame in between moves
  the row to generation g+1, and the stream serves the new generation's bytes
  short of the announced length (reproduced: 441 B announced, 42 B sent). Pass
  the `HistoryFileRow` (generation and offset) into `rawStream` and list that
  generation's chunks; old generations stay readable until retention.
- **`show --all` cost (LATER-3).** Every `/turns` page runs the window function
  and `ORDER BY … LIMIT/OFFSET` over the whole session (about rows²/1000), and
  the CLI buffers every row before printing. Print per page, and page by key.
- **Same path from two origins (LATER-4).** A session resumed in a second docker
  box is shipped by both, so the detail lists its path twice, `download` writes
  it twice, and `?path=` serves the first (older, shorter) row. Dedupe `files`
  by path, keeping the largest offset, or add an origin selector. The real fix
  is single ownership per path (see "Same session from two boxes" above).
- **Header from an edge path (LATER-6).** `x-agentbox-history-path` is set
  verbatim; a CR/LF or a character above U+00FF in a path makes the response
  throw (500). Use `encodeURIComponent(file.path)`.
- **Phase 3 id shapes (LATER-7).**
  - The prefix lookup refuses refs containing `_`; escape with `LIKE … ESCAPE`
    instead.
  - `downloadTarget` skips session ids outside
    `^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$` with a misleading "outside the folder"
    message.
  - Revisit both when codex, pi and opencode ids arrive.

## Phase 4 (memory in the hub)

- **Boxes from older images or snapshots.** Memory sync needs the managed
  settings key (`autoMemoryDirectory`) and the ctl `MemoryLoop`, both baked in.
  An older docker box keeps writing to the shared `-workspace/memory`, which is
  no longer seeded, and nothing ships it. Cloud bases must be re-prepared.
- **No offline host fallback on cloud.** The create used to push the host copy
  straight into the box. Now it arrives via `history.memory.seed`, so a cloud
  box whose relay never answers at boot has no memory until it does. ctl
  retries every 5 s. Restoring a create-time push would race the hub seed
  (see the plan), so it needs a "seeded" handshake first.
- **No sync down into a running box.** A box seeds once. Another box's newer
  version reaches it only on the next box, and a later local edit overwrites
  the newer version (last writer wins, so the older edit is kept as a version
  and is reversible). A pull on each pass, for files unchanged locally, would
  fix it.
- **Paused docker box at destroy.** The in-box flush needs a running box, so
  up to 15 s of memory writes made just before a pause are lost if the box is
  then destroyed without being resumed. The transcript flush covers paused
  boxes with a helper container; memory could do the same.
- **Repo key of a remote-hub box.** The relay keys by the registration's
  `originUrl`, falling back to `local:<machine>:<projectRoot>`. A box with no
  origin whose project folder the hub machine does not know gets no key, so
  write-back is off for it.
- **`memory pull` writes files that differ without asking.** `--dry-run`
  previews the change. A local edit the hub never saw is overwritten (backed
  by nothing). Consider writing `<file>.local` or refusing without `--force`
  when the local file is newer than the hub's version.
- **Only claude.** codex memory exists but was empty in Phase 0, openclaw's
  lives in the workspace repo, and pi and opencode have none. Each needs a
  `history.memory` block and (codex) a per-box location.
- **Live check covered docker only.** The "fresh box B on another provider"
  leg of the plan's Done is unit-tested (`MemoryRelay` and `MemorySync` are
  provider-agnostic), not run live: e2b was off-limits this phase.
