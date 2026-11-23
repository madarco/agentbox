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
  - ~~The prefix lookup refuses refs containing `_`~~ — fixed in Phase 3 (`LIKE …
    ESCAPE`), since an opencode id (`ses_…`) is otherwise unreachable by the
    8-character id `sessions ls` prints.
  - `downloadTarget` skips session ids outside
    `^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$` with a misleading "outside the folder"
    message.
  - Revisit both when codex, pi and opencode ids arrive.

## Phase 3 (other agents)

- **openclaw: only the `main` agent.** The row cursor reads
  `agents/main/agent/openclaw-agent.sqlite`; sessions of any other openclaw agent
  id (`openclaw agents add`) are not captured. Fix: a `*` in the `sqlite.db`
  path, one cursor per matching db.
- **openclaw: an event rewritten in place is not re-copied.** `transcript_events`
  has no updated column, so the cursor keys a row on `created_at`; the 20 s
  settle covers a rewrite during a turn, not a later one
  (`transcript_rewrite_watermarks` suggests rewrites exist). Rewind / reset make
  a new window instead, which is captured.
- **openclaw: cold archives.** Old windows can move out of the db into
  `agents/<id>/sessions/cold/<sha256>.jsonl.zst`. Anything copied before that is
  kept; a box whose history predates capture (a restored bot) has those events
  only in the cold files, which are not read.
- **openclaw: parse state grows with the session.** The parser remembers every
  projected event `seq` to drop a re-copied row (opencode does the same per
  part), so a weeks-long daemon session carries tens of thousands of keys in
  its state. A per-session high-watermark would do, once rows are known to
  arrive in `seq` order.
- **openclaw: a shared volume.** Every session in the db is bound to the box
  that reads it, which is right for the default per-box volume. An explicit
  `isolate: false` override (warned at create) puts two boxes on one db: both
  bind every session, and each takes the per-session cursor over from the
  other (moving the other's output aside), so turns land under both boxes.
  Restores and boxes made from a checkpoint are handled (the cursor names its
  box; an inherited output is moved aside and only new rows are copied).
  `bot clone` never copies the config volume, so it is not affected.
- **openclaw: redaction misses its own secrets.** The exact-value list does not
  hold the gateway token, `~/.openclaw/.env` or the host's
  `~/.agentbox/openclaw/<box>.env` values, and Telegram bot tokens match no
  format rule. Escaped JSON inside `event_json` also slips past the
  `KEY: value` rule (as codex's, #447 L2).
- **openclaw: cost grows with the db.** Every pass lists every session and
  their row versions; the full `session_windows` row (last-message preview
  included) is re-copied on every change; whole sessions are held in memory
  in 200-row batches.
- **openclaw: the decompressed copy is never cleaned.** `agentbox-history/`
  (and `*.from-<box>` files after a restore) grows with the db and rides every
  bot backup.
- **openclaw: a stopped daemon.** A read-only reader leaves `-shm`/`-wal`
  behind when openclaw is not running; harmless only while ctl and openclaw
  run as the same user.
- **codex `.jsonl` → `.jsonl.zst`.** Codex compresses cold rollouts and the
  shipper does not follow the rename. A rollout compressed before its tail was
  shipped loses that tail (the hub keeps what it has). Boxes ship every 30 s,
  so only a session that went cold inside one pass is at risk. Fix: treat
  `<f>.jsonl.zst` as `<f>.jsonl` and decompress at the edge.
- **codex sub-agent threads.** They are rollouts of their own and ship only
  when a hook fires with their own `session_id`. Not verified; if hooks only
  name the root thread, sub-agent rollouts are never bound.
- **opencode streaming rows.** The row cursor writes a message/part row once it
  has been quiet for 20 s, and the parser projects a part the first time it
  sees it. A text part that paused longer than that mid-stream is projected
  with its early text. Usage is only taken from a completed message, so it is
  not affected.
- **Row cursor on a paused docker box.** The destroy flush runs the box's
  `agentbox-ctl history flush` only when the box is running; a paused box's
  unsettled opencode rows (the last ~20 s) are not copied out.
- **Row cursor needs Node ≥ 22.5** (`node:sqlite`) in the box. On an older base
  it is a no-op and opencode is not captured until the provider is re-baked.
- **`agentbox-history/` on the shared opencode volume** grows with every bound
  session and is never cleaned.
- **Re-parse keeps identity.** The job re-derives turns, usage and title, not
  `sessionKey`, parent or `child`, which are fixed at a file's first frame. A
  change to `identify()` needs its own migration.
- **Re-parse blocks ingest per session.** Each session is re-derived inside the
  ingest queue, so a very large session holds frames back while it runs.
- **From the Phase 3 review, not fixed:**
  - *opencode final flush ships unsettled parts.* A destroy's flush ignores
    `settleMs`, so a part still streaming is written, projected with its
    partial text, and its complete copy is skipped as seen. Fix: let a later,
    longer copy of a text part replace the turn (needs a record update path).
  - *Rows that never become due* (a NULL parent column, a parent from an
    unbound session, a NULL `updated`) keep the row cursor's stamp cache off,
    so the db is reopened and scanned every pass. Drop such rows from
    `pending`.
  - *Glob expansion cost on clouds.* ctl expands codex's
    `*/*/*/rollout-*-<id>.jsonl` with a `readdir` per wildcard segment, per
    bound session, per pass. Cache the resolved path per session id, or list
    the root once per pass as the docker `scan` does.
  - *Session-id regex in three places* (`row-cursor.ts`, `shipper.ts`, ctl's
    `appendHistoryBinding`). Export one constant from `core/history`.
- **codex hooks in the TUI: they fire (checked 2026-11-23).** One interactive
  codex 0.171 TUI turn (`--enable hooks --dangerously-bypass-hook-trust`, as
  agentbox launches it) ran SessionStart/Stop, the session bound and shipped,
  and `sessions search` found it. `ctl/src/codex-scraper.ts`'s note that
  hooks.json often does not fire in TUI mode predates this codex; the scraper
  stays the activity source, but history attribution does not depend on it.
  The hooks now buffer stdin and background ctl (#447 review R1): with the
  in-box daemon stopped a hook returned in 10 ms and still wrote the binding.
- **From the review of #447 (2026-11-23), deferred:**
  - *L2: opencode rows reach the redactor double-escaped.* A row's JSON
    columns (`data`) are written as strings inside the line, so a quoted
    `"API_KEY": "…"` inside them is `\"API_KEY\": \"…\"` and the
    `KEY: value` rule misses it (exact host-secret values and known formats
    still match). Fix: parse JSON columns in `rowLine` and write them as
    objects.
  - *L3: the first copy of a session is synchronous and in memory.* The row
    cursor reads every due row of a session, builds all its lines and appends
    them in one write, inside the ctl daemon's event loop. A large first copy
    (an old session bound late) blocks the daemon and holds it all in memory.
    Batch the append per query page.
  - *L4: the cursor temp file is always `<path>.tmp`.* Two writers (a destroy's
    `history flush` racing the daemon's tick, or the same opencode session in
    two boxes on the shared volume) can rename each other's temp. Harmless
    today (the parser dedupes), but use a unique temp name.
  - *L5: opencode binds at its first `session.idle`.* A session whose first
    turn is still running at a destroy or a crash is never bound, so nothing
    of it ships.
  - *L6: a failed re-parse saves the parse state at the failure point.* The
    next ingest frame then parses from a state that does not match the file's
    offset. Do not save the state of a file whose re-parse failed (the session
    stays stale and is redone anyway).
  - *L7: opencode revert.* A revert deletes message/part rows in the db; the row
    cursor only sees rows that exist, so the hub keeps the reverted turns.
  - *L8: smaller items.*
    - `agentbox-ctl history flush` builds its `HistoryLoop` with no logger, so
      row-cursor errors during a destroy are silent.
    - opencode's parse state (seen parts, roles) grows with the session and is
      rewritten with every frame.
    - The docker `scan` lists every codex and pi rollout on the shared volume
      on every pass (5 levels deep), not just the bound sessions'.
    - The `session` table has no settle time, so a busy session's row (its
      `time_updated` moves with every message) is re-copied on every pass.
- **Boxes built before Phase 3** bind claude sessions only. Codex, pi and
  opencode report their session ids from hooks baked into the image (docker)
  or the provider's base snapshot (clouds); rebuild or re-bake to capture them.

## Phase 4 (memory in the hub)

- **Boxes from older images or snapshots.** Memory sync needs the managed
  settings key (`autoMemoryDirectory`) and the ctl `MemoryLoop`, both baked in.
  An older box keeps the old behaviour: it is seeded from the host into
  `-workspace/memory` at create (docker volume rekey, cloud dynamic seed), and
  nothing ships its writes. Those two legacy seeds stay until old bakes are
  gone; then delete them. Cloud bases must be re-prepared to get sync.
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
- **Only claude.** codex memory exists but was empty in Phase 0, openclaw's
  lives in the workspace repo, and pi and opencode have none. Each needs a
  `history.memory` block and (codex) a per-box location.
- **Live check covered docker only.** The "fresh box B on another provider"
  leg of the plan's Done is unit-tested (`MemoryRelay` and `MemorySync` are
  provider-agnostic), not run live: e2b was off-limits this phase.
- **From the Phase 4 review, not fixed:**
  - *`local:` key spelling.* For a repo with no origin, the CLI keys by the
    realpath of the git toplevel, while the relay uses the registration's
    `hostMainRepo` as given. A symlinked path (macOS `/var`) or a linked
    worktree names a different key, and `memory ls` finds nothing.
  - *Version scan per put.* `append` loads a path's full version list to read
    the last row. Add a `latestOf` repo method (`ORDER BY version DESC LIMIT 1`)
    before memory files reach thousands of versions.
  - *Two copies of claude's project-key rule.* `hostProjectKey('dashed-path')`
    in core duplicates `encodeClaudeProjectsKey` in sandbox-core. Make
    sandbox-core use the core helper.
- **From the Phase 4 live check (docker, isolated hub):**
  - *claude honouring `autoMemoryDirectory` is not yet observed live.* The
    box's claude login had expired, so the memory file was written as the box
    user in claude's place. Seed, write-back, the destroy, box B and `pull`
    were all real. claude 2.1.323's own code reads the key from policy
    settings. Re-check with a logged-in turn.
  - *Seeded by a hubless relay.* Box A's first boot reached a standalone
    `agentbox-relay` (no hub) that the hub replaced a minute later. It got
    the host copy, and write-back stayed off for the 10-minute backoff,
    then shipped normally. A box seeded that way misses the hub's newer
    versions. Re-asking for the seed when write-back first succeeds would
    fix it.
  - *Transcripts have the same `originUrl` gap.* A registration re-pushed
    after a relay restart has no `originUrl`, so `HistoryRelay` stamps no
    `projectRepoUrl` on that box's sessions. Memory now reads the folder's
    `origin` (fixed in this phase); transcripts should do the same.
- **From the review of #443 (2026-11-22), deferred:**
  - *A late seed deletes box-local writes (3).* **Fixed** (plan, "Backlog
    fixes"): the seed merges last-writer-wins. Original note: when the seed is delayed
    (relay unreachable, older relay backoff) and claude writes memory first,
    `placeSet` removes those never-baselined files. The same happens on a ctl
    restart after a checkpoint dropped the state while write-back was off.
    Fix: keep local files absent from the set, with no baseline, so the next
    pass ships them.
  - *A failed scan becomes a mass tombstone (4).* A readdir error on the
    memory dir (or the dir removed) makes one pass ship every baseline path
    as deleted. Report a root readdir failure from `scanMemoryDir` and skip
    deletions that pass. The host-as-writer fix (#2) at least lets an edited
    host file bring a path back.
  - *Host import stored unredacted (5).* `memorySeed` stores host files byte
    for byte; puts are redacted. Pass `hostFiles` through `deps.redact` in
    `MemoryRelay.seed`, and compare the host-version sha on the redacted
    bytes.
  - *Smaller items (6):*
    - A path live as both a file (`sub`) and a dir (`sub/x`) makes every
      later seed throw ENOTDIR and retry forever. Skip the conflicting
      entries, or refuse the put.
    - `pull` in a linked worktree lands in the worktree's key, not the
      main repo's. Use the parent of `--git-common-dir`.
    - Leftover `*.agentbox-tmp` / `*.agentbox-part` files after a crash are
      scanned and shipped. Skip those suffixes.
    - The docker destroy's in-box flush exits non-zero on pre-Phase-1
      images: one harmless log line.
    - A seed reply of 1000 x 256 KB could exceed the cloud bridge's body cap
      and fail forever. Real sets are KBs.

## Phase 5 (host sessions + multiple PCs)

- **Tray toggle against a remote hub.** `GET|PUT /api/v1/history/host` reads and
  writes the watcher of the machine the hub runs on. A tray pointed at a
  control box therefore toggles the control box's watcher, not the PC's. A
  per-device setting carried by the hub (the PC's relay reading it back) would
  fix it; `agentbox sessions host` on the PC works today.
- **Only claude is host-watched.** A host agent needs a `hostKey` on its
  transcripts entry. codex keys rollouts by date, not by project, so its host
  filter has to read `session_meta.cwd` (Phase 3 territory); pi keys by
  `--<cwd dashed>--`, which is a second `hostKey` kind.
- **Sessions started below the project root.** claude keys a transcript by the
  cwd it was launched in, so a session run in `repo/sub` lives under another
  key and is not shipped. Same for a path claude spells differently from the
  registered one (macOS `/private/var` realpath), and for long paths claude
  truncates and hashes. Fix: match keys by prefix, or read each file's `cwd`.
- **Host memory.** The watcher ships transcripts only. Host memory still reaches
  the hub only as the hub machine's own import at a box seed (Phase 4); a
  second PC's host memory never does.
- **Restart cost (L2 again).** After every relay restart the watcher re-learns
  each host file's cursor: one first frame, then a re-hash of the ingested
  prefix. On a PC like the one measured in Phase 0 that is ~2 GB read once per
  restart. The empty-data probe + persisted edge cursor from L2 fixes it.
- **Same session on the host and in a box.** `agentbox fork` copies a host
  session into a box under the same id. With both shipped, the session's turns
  count twice and its row keeps the first origin (the "same session from two
  boxes" item, with a host origin as one side).
- **Admin-key callers name their own `hostId`.** A device-token caller's host
  frames are stamped with the verified device; a caller with the shared admin
  key or API key is trusted, like box frames (see "REST ingest trusts the
  caller's origin").
- **`PC` column shows a machine-id prefix,** not the device label the hub has
  in its devices table.
- **Per-pass cost with the feature off (review of this phase).** Every 60 s the
  watcher loads the effective config of every known folder, even when nothing
  is allowed, and lists each allowed project dir twice. Cheap at tens of
  folders. Skip folders with no project override while the global toggle is
  off, and count sessions from the shipper's own listing.
- **`sessions host` acts locally, not through `/api/v1/history/host`** (review
  of this phase). Deliberate: the watcher and its config are this PC's, and a
  PC on a remote hub may run no local hub to ask. Both paths share
  `host-settings.ts`, so the rules cannot drift; only the folder argument is
  resolved by the CLI (project root of the cwd).

## From the review of #449 (2026-11-23)

Fixed in #449: B1 (a refusing or unreachable hub is backed off for 10
minutes per target, shown as `backoffUntil` in the status, instead of every
session being re-read and re-posted each pass) and B2 (claude's dashed key is
lossy, so a session ships only when its transcript's first `cwd` is the allowed
folder). Still open:

- **L1: PUT/tray allow below an `agentbox.yaml`.** The project key is written
  to the nearest project root, so allowing a subfolder of a project writes the
  allow on the parent while reporting the subfolder. PUT also accepts a folder
  that does not exist.
- **L2: global off is not a kill switch.** A project `allow` ships with the
  global toggle off (by design, it is the per-project opt-in). The tray must
  not present "off" as "nothing ships": show the allowed projects next to it.
- **L3: origin URL shipped raw.** `projectRepoUrl` comes from `.git/config`
  verbatim, so an `https://user:token@…` origin reaches the hub and the status
  file. Box sessions have the same gap. Strip userinfo at the edge.
- **L4: host secrets miss the control-plane credentials.** `collectHostSecrets`
  does not read `control-plane.env` (API key, admin token, admin password) or
  this PC's `abdev_` device token, and falls back to formats-only redaction if
  it throws.
- **L5: status file rewritten every 60 s** even with the feature off.
- **L6: `GET /history/host` answers device-token callers** with the hub
  machine's project folder list. Refuse it for devices like the PUT.
- **L7: `stop()` does not await a running pass.**
- **L8: a project's `relay.controlPlaneUrl` is ignored.** The watcher always
  ships to the global hub (the daemon's), not a per-project one.

## Phase 6 (MCP)

- **Workspace scope.** A box is scoped to its repository only. The plan says
  "project, or workspace when it has one", but sessions carry no workspace id
  yet (`history_sessions` has no `workspace_id`), so there is nothing to scope
  a workspace by. Add the column at ingest, then widen a box's scope to its
  workspace's repos.
- **Sessions with no repo URL are invisible to boxes.** A session is matched by
  `repoKey(project_repo_url)`. `HistoryRelay` stamps that URL from the
  registration's `originUrl` only, so a session shipped after a relay restart
  (registration re-pushed without `originUrl`, see Phase 4's live-check note)
  has none and no box can find it. Use the same folder-`origin` fallback the
  memory relay uses (`MemoryRelay.boxIdentity`) when stamping transcripts.
- **`local:` repos.** A repo with no `origin` keys as `local:<machine>:<root>`
  for memory, but its sessions carry no URL, so such a box sees no sessions.
- **`usage_query`.** In the plan's tool list; it waits for Phase 7's usage API.
- **Repo URLs with embedded userinfo are kept raw.** An origin like
  `https://user:<token>@host/owner/repo` is stored as the session's
  `projectRepoUrl` as written (host watcher, `HistoryRelay`, plane registration),
  and MCP `sessions_list` returns it as `repo` to any box of the same repo. Kept
  as-is on purpose (the owner's decision, 2026-11-23): the user chose that URL.
  Revisit if it becomes a problem; the fix would be one strip-userinfo helper
  applied where the URL is stored, registered or returned, plus sanitize-on-read
  for rows already stored.
- **Registration timing on a fresh cloud box.** ctl writes the MCP entries when
  `agents.list` first answers (retried with backoff). An agent launched before
  that starts without the server until its next launch. Docker is unaffected
  after the first box (the entry is on the shared config volume).
- **Older images on a shared docker volume.** claude's and codex's MCP files are
  on the shared config volume, so a box from an image older than this phase
  sees the `agentbox` entry too, and its ctl has no `mcp` command: the agent
  shows one failed MCP server. Harmless; goes away with a rebuild.
- **openclaw** gets no registration. It is a service agent with its own MCP
  config layer; needs an `mcp` spec kind for its config file.
- **Host-reach path.** `mcp.*` from a box served through another PC's
  host-reach executor (`daemon.ts`) is not routed (answers unknown method),
  like `history.*`.
- **Hub-scope proposals.** `memory_propose` from `/api/mcp` parks its approval
  under the pseudo box id `hub`; the web approvals list shows it, the tray may
  group it under no box. Its content is not redacted (the caller holds the hub
  token already).
- **No approval id in the reply.** `memory_propose` returns `pending` without
  the approval id (`askPrompt` mints it internally), so an agent cannot poll
  the outcome. A `memory_get` later shows whether it landed.
- **`session_get` pages by turn index, not tokens.** A page stops at ~48k
  characters; a single huge turn in `detail: full` is still returned whole.
- **From the Phase 6 review, not fixed:**
  - *Registration for agents the box does not run.* `agents.list` carries
    `mcp` for every agent, so a claude-only box also gets
    `~/.codex/config.toml` and `~/.config/opencode/opencode.json` written. Gate
    it on `runsHere` like `service`, and register on `agent add` too (ctl only
    reconciles at start).
  - *`~/.claude.json` write race.* ctl's read-modify-rename can drop a write
    claude made in the same few milliseconds, and a running claude that later
    saves its in-memory copy drops the entry until ctl's next start. On docker
    the file is shared by every box. A re-check on an interval, or a flag
    injection (`--mcp-config`) at every launch path, would remove the race.
  - *`projectUrlsFor` scans every distinct URL* on each box-scoped list or
    search. Cache it, or store a `repo_key` column on sessions.
- **Fixed in the Phase 6 review:** `sessions_list` paging past the 500-row
  listing, `memory_propose` applying over a newer version (it now records its
  base version and an approval of a superseded proposal writes nothing),
  `session_get` dropping `nextFrom` for a capped `to`, other TOML spellings of
  an existing `agentbox` server (no duplicate table), a box config pulled to a
  host that had none carrying the box-only server (`agentPull` strips it), and
  one `git remote get-url` per MCP message (since removed: the scope reads the registration only).
- **From the review of #450 (2026-11-23), deferred:**
  - *Inline `mcp_servers = { … }` in codex's config.toml.* Appending a
    `[mcp_servers.agentbox]` table after an inline `mcp_servers` table makes
    the file invalid TOML. The check now skips an inline table that names
    `agentbox`; one that does not should be skipped too (with a log line).
  - *`initialize` and `tools/list` go to the host.* Each is a relay round trip
    with a 60 s timeout, so a cloud box whose PC is off shows a slow, then
    failed, MCP server on every agent launch. ctl could answer both locally
    and forward only `tools/call`.
  - *`memory_propose` gaps.* `agent` is free-form (any name creates a memory
    set); it ignores the project's `history.capture` opt-out; the approver sees
    only the first 1,500 characters; a box with `autoApproveHostActions`
    auto-approves it; a pending approval is lost on a hub restart (the
    proposal is then neither applied nor reported).
  - *Small items.* The hub logs one `rpc box=… method=mcp.message` line per MCP
    message; the reply duplicates its payload (`content[0].text` and
    `structuredContent`).
  - *Re-registration without a repo.* The scope uses only the registration's
    `repoKey`/`originUrl`. A registration re-pushed with neither (after a
    relay restart, see Phase 4) leaves the box with no repo, so it sees
    nothing until it registers again. Fail-closed by design.
- **Fixed in the review of #450:** the host-side setup no longer puts the hub
  token in an agent config (`agentbox mcp`, a stdio proxy that reads it at run
  time), and staging `_claude.json` for a box (docker seed and cloud overlay)
  drops any MCP server carrying the hub token or pointing at a hub `/api/mcp`.
  The box scope no longer falls back to a live `git remote get-url`.

## Phase 7 (usage + dashboard)

- **No cost.** The plan's dashboard shows cost from a versioned price table,
  computed at read time. Not built: tokens only, in the API, CLI and page. pi
  and opencode already compute a cost in their own records; we still store
  tokens only.
- **Day buckets use one UTC offset.** `tzOffset` is the caller's offset now,
  so a window that spans a DST change puts the hour around the switch in the
  neighbouring day. An IANA zone would need the bucketing in JS or a calendar
  table.
- **Account is stamped once, from this hub's box record.** A session's account
  is read from `record.accounts` when its first file arrives (backfilled at
  hub start for sessions whose box is still in `state.json`). Sessions of boxes
  destroyed before Phase 7, or of boxes this hub has no record of (another PC
  ingesting over REST, a remote-hub split store), stay `unknown`. A session
  resumed in a box on another account keeps the first one.
- **Purged sessions are not re-parsed.** Retention keeps a session's usage
  rows but deletes its raw, so a later parser fix (like claude v2's copied-usage
  rule) cannot reach usage older than `history.retentionDays`.
- **Copied usage, other agents.** claude drops usage on `/branch` and
  desktop-continuation copies (parser v2). pi `/fork`/`/clone` and codex
  `fork` were not measured: if they copy entries with usage into the new file,
  that usage counts twice.
- **Dashboard scope.** Not in this phase: live sessions, tool-call and failure
  rates, a workspace dimension (sessions carry no workspace id yet), and a
  drill-down into a session's transcript (the hub has no sessions page; the
  session breakdown links nowhere).
- **Usage query cost.** Every page load runs eight grouped queries over
  `history_usage` joined to sessions, with a time filter on an expression
  (`COALESCE(ts_ms, …)`) that the `ts_ms` index does not serve. Fine at
  hundreds of thousands of rows; a daily rollup table is the fix if it shows.
- **From the Phase 7 review, not fixed:**
  - *Store-only boxes have no account.* `accountOf` reads this hub's
    `state.json`. A box a control box knows only from a Store registration
    (`reg.accounts`, another PC's box) is stamped unknown, and the backfill
    cannot reach it either. Read the registration's accounts too.
  - *A purged session named by usage cannot be opened.* `usage --by session`
    and the page's Top sessions list sessions whose transcript retention
    deleted; `sessions show <id>` then answers "not found" with no hint why.
    Say "purged by retention" instead.
  - *Shared shapes copied.* `shortRepo` and the dimension list exist in the CLI
    (`usage-format.ts`), the hub backend and the page. A nested GitLab path
    (`group/sub/repo`) shortens to `sub/repo` in both copies.
- **From the review of #452 (2026-11-23), deferred:**
  - *L1: the `ts_ms` fill runs once.* It runs only in the migration that adds
    the column, so a crash between the two statements, or an older hub writing
    to a migrated db, leaves rows with no `ts_ms` for good (they fall back to
    the session's last activity). Fill `ts_ms IS NULL AND ts IS NOT NULL` on
    every open.
  - *L2: the Usage page's cost.* It refreshes every 30 s even in a hidden tab.
    At 1M usage rows its 8 queries take about 5.7 s, because the time filter is
    an expression the `ts_ms` index cannot serve. That stalls the hub process,
    which also runs the relay. Pause on `document.hidden`, and filter on
    `ts_ms` directly with the fallback only for rows without one (or a daily
    rollup).
  - *L3: a huge duration is a 500.* `since=100000000000d` makes an invalid
    date and the route answers 500 instead of `invalid_request`. Bound the
    duration.
  - *L5: a purged session that is shipped again keeps its v1 usage.* The
    re-parse skips purged sessions; when the file comes back, its new rows are
    `INSERT OR IGNORE`d next to the old ones, so v1's copied usage stays.
  - *L6: smaller items.*
    - `project_key` is computed once; a change to `repoKey`'s rules needs a
      recompute.
    - A date-only `--since 2026-11-22` starts at UTC midnight, while days
      bucket in local time.
    - Host sessions (Phase 5) show account `unknown`; they run on the PC's
      own login, which is the `default` account.

## Cloud sign-off (2026-11-23)

Fixed in this pass: a cloud box's first RPCs got `401 unknown box token`
(ctl starts before the hub registers the box) and ctl parked memory and history
for 10 minutes as if the relay lacked the methods; the late memory seed then
deleted what the agent had written (plan, "Cloud sign-off"). Still open:

- **Fixed (plan, "Backlog fixes"):** ~~The seed still replaces a dir the agent already wrote.~~ The fix closes the
  401 window, but a box whose hub is unreachable at boot for longer (tunnel
  down, hub restarting) seeds whenever the relay first answers, and
  `placeSet` replaces the dir: memory written before that is lost. Merging
  (keep local paths the seed set does not name, ship them as new versions)
  would close it without losing the "a checkpoint's carried dir is replaced"
  property only if the carried dir is told apart, e.g. by the state's box id.
- **From the review of this pass, not fixed:**
  - A 401 on a stale-config refresh (or any unreachable answer) drops a
    working history shipper and row cursor until the next tick rebuilds them
    (pre-existing for transport errors).
  - Only a bodyless 401 is recognised; a 401 behind a proxy that returns an
    `{exitCode}` body, or on the parked `/rpc/status` poll, still reads as
    `unsupported`.
  - Other ctl callers (skills sync, tool links, the MCP bridge) log the boot
    401 as a failure and wait for their next pass; `agents.list` has its own
    retry schedule. One shared "not registered yet" retry in `relay-rpc.ts`
    would serve them all.
  - `memory-sync.ts` `call` and `history-shipper.ts` `rpc` are two timeout
    wrappers around `postRpcAwait` with different timeout behavior (exit 126
    vs a thrown `RpcTimeout`).
- **Not checked live on vercel or daytona.** vercel's auth here is a Vercel CLI
  session in the owner's HOME (not copied into a scratch HOME). The daytona
  bake from a scratch HOME failed after ~25 min at the seed layer's
  `chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex
  /home/vscode/.local` (`packages/sandbox-daytona/src/prepare.ts`, exit 1,
  likely a seed path missing on a sparse host config; not a history change).
  The fix in this pass is in ctl and shared by every cloud provider.
- **Phase 7 usage on cloud.** #452 had not merged during the pass.
- **Found while testing, outside history (for their own backlogs):**
  - `agentbox codex <box>` takes the box name as the initial prompt and
    creates a new box, and `agentbox codex start <box>` on a box created for
    claude does not install codex, though `docs/agents.md` ("Adding an agent
    to a running box") says both do.
  - `agentbox prepare --provider e2b` from a scratch HOME rebuilds the shared
    template by name (`agentbox-base:latest`), the same template id the
    owner's own `e2b-prepared.json` points at. Harmless for a nightly bake, but
    a scratch-HOME test is not isolated on e2b.
  - Under `hub expose --tunnel cloudflare`, `hub restart` gets a new quick-tunnel
    URL; cloud boxes created before it keep the old, dead URL. Known shape of
    quick tunnels, worth a line in `hub-testing.md`'s gotchas.
  - Testing inside an AgentBox box: the exposed hub's own creates clone the repo
    with `git`, which the box's git shim refuses (`git.clone: not yet
    implemented`); `--local` sidesteps it.

## Backlog fixes: late seed + re-registration (2026-11-23)

Fixed (plan, "Backlog fixes"): the late memory seed, an added agent lost on
re-registration, and a box losing its repo (`originUrl`/`repoKey`) on every
re-registration. Left open:

- **From the review of this pass, deferred:**
  - *Past the file-count cap the merge cannot read a box file.* A box holding
    more than `MEMORY_MAX_FILES` memory files has files that are present but
    unread; the merge treats them as the box's own (like an over-size file),
    so the hub's version is not placed and the file never converges.
  - *A time order is not a write order.* The hub's `updatedAt` is when the
    version was stored, not written: an edit made in a box before another
    box's older edit reached the hub loses the late-seed comparison.
- **From the live check: a hub that is DOWN parks the seed for 10 minutes.**
  The in-box forwarder answers an `ECONNREFUSED` upstream with a non-zero
  exit that `relayNotReady` does not recognise, so ctl reads it as
  `unsupported` and backs off (same family as the #454 "bodyless 401 only"
  note). The merge then lands when the backoff ends; nothing is lost, it is
  just late. Treat a forwarder upstream error as `unreachable`.
- **Clock skew decides a late-seed tie.** The merge compares a box file's
  mtime (box clock) with the hub version's `updatedAt` (hub clock). Docker
  shares the clock; a cloud box with a skewed clock can keep an older file
  or lose a newer one. Only the late-seed window is affected; later passes
  compare content, not time.
- **A checkpoint-carried file the hub never saw is shipped.** It used to be
  deleted by the seed. Owner direction is last-writer-wins, so it now becomes
  a version (it was written by the parent box); a tombstone newer than it
  still deletes it.
- **Boxes created before the fix have no recorded repo.** Their record has no
  `originUrl`/`repoKey`, so after a relay or hub restart they still register
  without one (MCP scope empty, skill bindings off) until recreated. A one-time
  backfill could read it from a docker box's host repo while no box process
  runs, but that is the `.git` the box can write, so it is not done
  automatically.
- **Cloud start still falls back to the host folder's `origin`** for a record
  without `originUrl` (pre-existing behavior; a cloud box has no write access
  to the host `.git`).
- **Transcripts' `projectRepoUrl` (Phase 4/6 notes)** now gets the registered
  `originUrl` after a restart for new boxes; the folder fallback for old boxes
  is still open.

### LATER, from the independent review of #457 (2026-11-23)

Fixed in the PR: R1. Every docker create rehydrates every cloud record (as
stored, since #457, so with its preview URL and bridge token), and that
started a `CloudBoxPoller` for paused boxes too, waking E2B ones. A rehydrate
now leaves the poller fields out for a paused, stopped or control-plane box
(`shouldPollOnRehydrate`), which also covers a hub or relay restart. Left for
later:

- **L1: a late seed still loses to a host copy of the same file.** A host
  import is stored with the seed time as its `createdAt`
  (`history-memory.ts`, `append` from `memorySeed`), so a box's `MEMORY.md`
  written before the seed looks older than the host's and is overwritten.
  Stamp a host import with the host file's mtime instead.
- **L2: the hosted plane's register handler** (`core/handler.ts`, the
  control-plane `/admin/register-box`) ignores `agents` and does not keep a
  stored `originUrl` when a re-register omits it, unlike the relay's.
- **L3: `registrationAgents` should put the primary agent first** in every
  case; today it only prepends it when the list lacks it, so a list that
  names it later keeps that order.
- **L5: `MemoryRelay.keyOf` ignores `reg.repoKey`,** re-deriving the key from
  `originUrl`, and still falls back to the live `git remote get-url` of the
  project folder for boxes created before #457 (the record has no repo).
- **L6: a newer ctl against an older relay gets no tombstones** in the seed,
  so a hub deletion never removes a box file during a late seed there; and
  files past `MEMORY_MAX_FILES` never converge (see above).

