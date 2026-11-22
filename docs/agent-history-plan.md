# Agent history — sessions, memory and usage in the hub

**Status:** Phase 1 in progress (feat/agent-history-p1). Phase 0 (measurement) is done — see
[Phase 0 results](#phase-0-results-2026-11-22); its findings amend Phases 1–7.

## Goal

Every agent session the software factory runs — in any box, on any provider,
on any PC, and optionally the ones run directly on a host — lands in the hub:
its transcript, the memory it read and wrote, and the tokens it spent. The hub
serves all of it through `/api/v1`, so the CLI, an MCP server (for agents to
re-read past work), the web dashboard and the tray read one source.

Concretely:

1. **Transcripts** are captured and kept, and downloadable locally.
2. **Memory** (today only claude's, host → box at create) becomes hub-owned,
   versioned and bidirectional, for every agent that has one.
3. **Host sessions** can be uploaded by an opt-in watcher, so usage history is
   complete across PCs.
4. **CLI + MCP** expose sessions, memory and usage to people and agents.
5. **Dashboard** shows activity, sessions and tokens across boxes, projects,
   workspaces and PCs (users later — see the multi-host + teams plan).

## Shape

One new hub domain, `history`, as a backend slice
(`apps/hub/lib/backend/history.ts`, narrow `BackendDeps`; `hub-backend.ts` does
not grow). Three rules decide almost everything below:

- **Agents declare, edges tail, the hub parses.** An agent says where its
  transcripts and memory live (data on its `AgentSyncSpec`) and how to parse
  them (code on its agent module). Edges — the host relay, `agentbox-ctl` in a
  box — only ship raw bytes by byte offset. They load no agent code, so a
  community provider gets history with no change.
- **Raw is kept, normalized is derived.** The hub stores the verbatim
  transcript and a normalized projection (turns, tool calls, usage). A parser
  fix re-derives from raw; nothing is lost to a format change.
- **The API is the only surface.** CLI, MCP, web, tray are all `/api/v1`
  clients. No feature reads the store or the archive directly.

The hub already loads agent modules (`apps/hub/server.ts` →
`registerAllAgentModules()` / `registerInstalledAgentModules()`), so hub-side
parsing needs no new loading seam — only a new optional facet on the module.

## Data model

### Agent declaration

`AgentSyncSpec` gains an optional, data-only `history` block (spec purity
holds; a package agent ships it in `agents.json` like the rest):

```ts
history?: {
  transcripts: { root: string; glob: string; format: 'jsonl' | 'json-tree' | 'sqlite' }[];
  memory?: { root: string; glob: string; scope: 'project' | 'global' }[];
}
```

Roots are relative to the agent's config dir, with a `<projectKey>` token where
the agent keys by project (claude: `projects/<projectKey>/*.jsonl`,
`projects/<projectKey>/memory/**`). Each agent fills its own; an agent with no
`history` block simply isn't captured.

The agent module gains an optional facet, registered the same way the sync
module is:

```ts
interface AgentHistoryModule {
  /** Incremental: given new raw bytes for one file, emit normalized records. */
  parse(chunk: RawChunk, state: ParseState): { records: HistoryRecord[]; state: ParseState };
  /** Session id + parent (fork/teleport lineage) from a file's head. */
  identify(head: Uint8Array, path: string): { sessionId: string; parentSessionId?: string } | null;
}
```

`HistoryRecord` is a small union: `turn` (role, text, ts), `tool` (name, ok,
duration), `usage` (model, input/output/cache-read/cache-write tokens), `meta`
(cwd, model switch, compaction). Deliberately lossy — the raw is the record of
truth; the projection exists for search, MCP and the dashboard.

### Store (sqlite local, postgres on a control box)

| Table | Key | Holds |
|---|---|---|
| `history_sessions` | `(agent, session_id)` | origin, first/last ts, title, parent session, totals, parser version |
| `history_files` | `(origin, path)` | blob key, byte offset ingested, sha256 of the ingested prefix |
| `history_turns` | `(session, seq)` | normalized turn/tool rows + full-text index (FTS5 / `tsvector`) |
| `history_usage` | `(session, seq)` | per-message token counts + model |
| `memory_entries` | `(repo_url, agent, scope, path, version)` | content blob key, sha256, origin, ts |

**Origin** on every row: `host_id` (the PC), `box_id` (null for a host
session), `provider`, `project_repo_url`, `workspace_id`, `manager_id`,
`user_id` (null until teams). Rows are keyed so the same session seen from two
places merges, not duplicates.

### Archive (raw blobs)

A new blob store with custody's seam — path + bytes + sha256, filesystem now,
object storage later — but **not** custody: custody is credential-shaped with a
small-payload cap, transcripts run to tens of MB. Raw files are stored
compressed, appended as chunks (`<agent>/<session>/<n>.zst`), so an append
never rewrites a large object.

## Ingest

| Source | Shipper | Path |
|---|---|---|
| Docker box | host relay | reads the agent's config volume (shared or isolated) on a timer + on hook events |
| Remote-docker / cloud box | `agentbox-ctl` | tails declared paths, pushes chunks over the existing relay channel (`CloudBoxPoller` drains them); a `git.pushMode=direct` box with hub reach pushes to the hub directly |
| Host-local sessions | host relay watcher (opt-in) | same tailer on `~/.claude`, `~/.codex`, …; the tray toggles it and shows its status |
| Another PC | that PC's relay | same watcher, to the configured hub |

One ingest endpoint, `POST /api/v1/history/chunks`
(`{origin, agent, path, offset, sha256Prefix, bytes}`), idempotent on
`(origin, path, offset)`. The shipper keeps a per-file offset cursor and
resumes after restart; the hub rejects a chunk whose prefix hash doesn't match
(file rewritten → re-ship from 0). Chunks go through the larger-body route the
relay already uses for custody, never the 1 MiB control-plane cap.

Known traps, each with its fix:

- **Attribution on shared volumes.** Docker's shared claude-config volume pools
  every box's transcripts under `-workspace`; a path says nothing about which
  box wrote it. `ctl/src/session-pointer.ts` already captures the live
  `session_id` from claude's hooks per box — report it to the relay as a
  `session → box` binding and attribute by session id, never by path. Codex's
  pointer is presence-only, so codex attribution comes from the session file's
  own cwd/ts plus the box's running window (Phase 0 confirms whether that is
  unambiguous).
- **Destroy wipes volumes.** Destroy (and cloud delete, and prune) runs a final
  flush before teardown. A flush failure warns and proceeds — losing history
  must never block a destroy.
- **Fork / teleport copies.** `agentbox fork` and teleport upload a rewritten
  copy of a session file. Dedupe by `(agent, session_id)` + line hash, and
  record `parent_session_id` so lineage is a graph, not two unrelated sessions.
- **Secrets in transcripts.** Tool output carries env values and file
  contents. The edge runs a redaction pass (the host-tools credential deny
  list + high-entropy token patterns) before shipping; the hub never sees the
  unredacted line. Retention is a config key, swept by the existing
  `retention.ts` loop.

## Memory

Today: claude's `projects/<hostKey>/memory/` is copied into the box at create
(`agent-claude/src/docker-sync.ts`, rekeyed to `-workspace`), one-way.

Target:

- The hub owns memory, versioned, keyed by `(repo_url, agent, scope, path)`.
- **Seed** a new box from the hub, falling back to the host copy when the hub
  has none (first run, or hub unreachable).
- **Write-back** rides the same tailer: a changed memory file in a box ships
  as a new version.
- **Conflicts:** per-file last-writer-wins, every version kept. Memory is
  small markdown; history is cheap and makes a bad write reversible.
- **Host memory** joins via the host watcher when enabled; `agentbox memory
  pull` writes the hub's latest back into the host's agent dir.
- No cross-agent translation. Any agent can *read* every agent's memory
  through MCP; writing another agent's format is out of scope.

## Read surfaces

### `/api/v1`

`GET /history/sessions` (filters: agent, box, project, workspace, host, since,
q), `GET /history/sessions/{id}` (condensed), `GET …/{id}/turns?from&to`,
`GET …/{id}/raw` (streamed, reassembled from chunks), `GET /history/search`,
`GET /memory`, `GET|PUT /memory/{key}`, `GET /usage` (group-by + time buckets).

### CLI

- `agentbox sessions ls|show|search|download [--agent --box --project --since]`
- `agentbox sessions resume <id>` — start a box from a past session; reuses
  fork's create + teleport path with the transcript fetched from the hub
  instead of the host.
- `agentbox memory ls|show|pull|push`
- `agentbox usage [--by box|project|host|model] [--since]`

### MCP

The hub serves streamable-HTTP MCP at `/api/mcp`, behind the same
`apps/hub/proxy.ts` Bearer gate as `/api/v1`. Tools: `sessions_search`,
`sessions_list`, `session_get` (condensed: user prompts, final answers, tool
names, by default; raw turn ranges on request), `memory_list`, `memory_get`,
`memory_propose`, `usage_query`. Outputs are sized for a context window —
paged, with a token estimate per page.

Boxes never hold the hub token. The relay exposes a box-authenticated MCP
proxy, scoped by default to the box's project (or workspace, when it has one).
Agent packages register it in the box's MCP config at create, the same way
they already stage other MCP config. A host manager uses `/api/mcp` directly.
`memory_propose` is the only write in v1; a proposal shows up for approval
through the existing approvals flow.

### Dashboard

A hub web page, pure REST client: activity over time, sessions and tokens by
box / project / workspace / PC / model, cost from a versioned price table
(computed at read time, never stored), live sessions, tool-call and failure
rates, and drill-down into a session's condensed transcript. Users become a
dimension when teams land.

## Phases

Each phase is one session, merged to `feat/agent-history`. Keep
`docs/agent-history-backlog.md` live from Phase 1.

### Phase 0 — measure (no product code)

Answer with evidence, recorded in this doc:

- Per agent (claude, codex, pi, opencode, openclaw): transcript location,
  format, append-only or rewritten, session id source, typical and worst-case
  size; memory location and format, if any.
- Docker attribution: does the `session_id` hook binding cover every claude
  session (including `/clear`, `/branch`, subagents)? Is codex attributable?
- Redaction: run the deny list over a week of real transcripts; count misses.
- Storage budget: total transcript bytes on this Mac today, compressed.

**Done:** a table per agent + go/no-go on the attribution scheme. **Done
2026-11-22** — results below, in [Phase 0 results](#phase-0-results-2026-11-22).

### Phase 1 — store, archive, ingest (claude, boxes)

Schema + archive store + `POST /history/chunks`; claude `history` spec block +
`AgentHistoryModule`; relay shipper for docker boxes, ctl shipper for cloud
boxes; session → box binding; final flush on destroy; redaction at the edge.

**Done:** a claude turn in a docker box and in one cloud box appears in the
store with correct box attribution; destroy leaves the session intact.

#### Phase 1 implementation plan (2026-11-22)

Decisions 3 and 4 below are taken as accepted: capture is on by default with a
per-project opt-out (`history.capture`), retention 90 days (`history.retentionDays`).

- **Shared pieces in `@agentbox/core` (`src/history/`)**, pure and loaded by the
  hub, the relay and ctl alike: the `history` spec types, the
  `AgentHistoryModule` registry, the wire frame, the redactor, the 4 KB string
  extractor and the shipper engine. The engine takes a `FileSource` (list, size,
  read at an offset) and a sink, so the relay (docker) and ctl (every other
  provider) run the same code over different file access.
- **Binding log.** `--capture-session` also appends
  `{ts, agent, sessionId, transcriptPath}` to
  `~/.local/state/agentbox/history-bindings.jsonl` on the box's writable layer.
  `--clear-session` never touches it. The engine ships exactly the sessions
  in that log: `<root>/<sessionId>.jsonl` and its `<sessionId>/subagents/*.jsonl`
  children, as the spec's `sessionFiles` declare. On a shared docker volume that
  is the only safe attribution; the single-slot pointer is not read.
- **Offsets and hashes.** A frame is `{origin, agent, path, offset, sha256Prefix,
  sha256, data}`, where the hashes cover the raw file bytes and `path` is
  relative to the agent's config dir. The hub accepts a frame only at its
  recorded offset with a matching prefix hash. Otherwise it answers with what it
  holds, and the engine either fast-forwards (the prefix verifies) or re-ships
  from 0 as a new generation. That makes the hub the durable cursor, so
  neither edge persists one.
- **Redaction is length-preserving** (`[REDACTED:kind]` padded with `*`), so
  file offsets stay the same raw and redacted. It runs on whole lines. ctl
  redacts with what the box knows (relay token, agent credential values,
  secret-named env values) plus the curated format list. The host relay
  redacts every frame again with the host's exact secret values
  (`secrets.env`, hub token, admin token, credential backups) before the sink.
- **Transport.** Docker: the relay's `DockerHistoryShipper` reads the box with
  `docker exec` (offset reads), every 30 s, and hands frames to the in-process
  sink. Other providers: ctl's shipper sends `history.chunk` RPCs (frames ≤
  512 KB, under the 1 MiB `/rpc` cap) over the existing relay channel. The
  same method is handled in `server.ts` `/rpc` and in `executeCloudAction`.
  `history.config` returns whether the box is captured (project opt-out,
  read host-side from the box's project config) and the agents' `history`
  specs. A docker box gets `enabled: false` there, because the relay ships it.
- **Hub store** (`apps/hub/lib/backend/history.ts` service +
  `HistoryRepo` seam, `apps/hub/lib/history-sqlite.ts` on `node:sqlite` in
  `~/.agentbox/hub/history.db`, raw archive on the filesystem under
  `~/.agentbox/hub/history/`). Each frame is stored as an unsealed chunk.
  Unsealed runs are sealed into one zstd object once they reach 2 MB, or when
  the file has been idle for 5 min. Sealing moves strings of 4 KB or more into
  `history_blobs` and leaves a marker in their place, and a read reassembles the
  bytes exactly. The claude module parses frames into `history_turns` (FTS5),
  `history_usage` (deduped by message id) and session meta.
- **Endpoint.** `POST /api/v1/history/chunks` (Bearer-gated like the rest of
  `/api/v1`). It is the same `ingest()` the relay calls in-process.
- **Final flush on destroy.** Before `provider.destroy`, the hub backend flushes:
  docker through the relay shipper, other providers with
  `agentbox-ctl history flush` over `provider.exec`. It is time-boxed and only
  warns on failure.
- **Retention.** An hourly sweep in the history service deletes sessions idle
  past `history.retentionDays` and garbage-collects unreferenced blobs.

### Phase 2 — read API + CLI

`/api/v1/history/*`, `agentbox sessions ls|show|download|search`.

**Done:** download a destroyed box's session and diff it against the original.

### Phase 3 — other agents

`history` blocks + parsers for codex, pi, opencode (openclaw per Phase 0).
Re-parse job (raw → normalized) for parser version bumps.

**Done:** one session per agent searchable; a parser bump re-derives cleanly.

### Phase 4 — memory in the hub

`memory_entries`, seed-from-hub with host fallback, write-back, `agentbox
memory` commands; extended to every agent that declares memory.

**Done:** memory written in box A is present in a fresh box B on another
provider, and `memory pull` lands it on the host.

### Phase 5 — host sessions + multiple PCs

Opt-in relay watcher, per-project allow/deny, tray toggle + status; a second
PC pointed at the same hub.

**Done:** sessions from two PCs, host and box, in one `sessions ls`.

### Phase 6 — MCP

`/api/mcp`, relay MCP proxy for boxes, MCP registration in agent packages,
`memory_propose` via approvals.

**Done:** a box agent finds and quotes a previous box's session for the same
project, without the hub token in the box.

### Phase 7 — usage + dashboard

Usage extraction backfilled over stored sessions, `/api/v1/usage`,
`agentbox usage`, hub dashboard page; update the tray if it surfaces usage.

**Done:** dashboard totals match a hand count over one day's sessions.

Each phase updates `apps/web/content/docs/` for any new command, flag or key.

## Phase 0 results (2026-11-22)

Measured on the owner's Mac (host: claude 2.1.x CLI + desktop app, codex
0.160.1, pi 0.84.4, opencode 1.18.8, openclaw 2026.6.35) and in two throwaway
docker boxes (`ah-claude` with claude 2.1.323, `ah-codex` with codex 0.171.0),
both destroyed afterwards. **M** = measured, **C** = read from code or the
agent's own docs. No transcript content was read beyond record types, keys and
sizes; redaction results are counts only.

### Per agent

**claude**

| | |
|---|---|
| Transcript, host | `~/.claude/projects/<projectKey>/<sessionId>.jsonl` (M). Subagents: `…/<sessionId>/subagents/agent-<hex>.jsonl` + `.meta.json` (+ `.prefix.json`; workflows nest one level deeper) (M). Oversized tool output spills to `…/<sessionId>/tool-results/*.txt\|.jpg` (M, 96 MB). Most host sessions here come from the desktop app (`entrypoint: claude-desktop`), which writes the same tree. |
| Transcript, box | docker: `~/.claude/projects/-workspace/…` on the **shared** `agentbox-claude-config` volume — every docker box of every project writes into one dir (M). Cloud: same path on the box's own disk; the cloud volume holds only `.agentbox-creds/claude` (C). |
| Format | JSONL, ~30 record types (M): `attachment`, `assistant`, `user`, `api-request(-blob\|-shape)`, `file-history-snapshot`, `custom-title`, `forkedFrom`-carrying copies, … Usage is on `assistant` lines (`message.usage`). Largest single line 1.8 MB (M). |
| Append-only | Yes (M). Prefix hash stable across new turns, `/clear` (the old file gets a few closing lines), `/branch`, `/compact` (same id, appended) in the box, and across 30 min of live host files (2 appended, 0 rewritten of 160 recent). |
| Session id | The **file stem**, not the first line (M). 2 of 116 host files open with up to 62k copied lines that carry the *parent's* `sessionId` (desktop continuation). `/branch` writes a new file whose copied lines are rewritten to the new id and carry `forkedFrom: {sessionId, messageUuid}` (M). Subagent lines carry the parent's `sessionId` + `isSidechain` (M). |
| Size | Main: n=116, median 1.1 MB, p90 27 MB, max 387 MB. Subagent: n=752, median 1.1 MB, p90 5 MB, max 44 MB (M). A one-word turn costs 0.37–0.56 MB (attachments ~370 KB + api-request blobs ~185 KB) (M). |
| Host retention | claude deletes transcripts after `cleanupPeriodDays` (default 30); the oldest host file is 35 days old (M). The host is a 30-day buffer, not an archive. |
| Memory | `projects/<projectKey>/memory/*.md`: a `MEMORY.md` index plus one file per fact with YAML frontmatter (`name`, `description`, `metadata.type`) (M). 270 files in 18 projects, median 1.4 KB, max 17 KB, 0.5 MB total. In a docker box it is rekeyed to `-workspace/memory` on the shared volume and **`rm -rf` + recopied at every docker create, of any project** (C: `agent-claude/src/docker-sync.ts`), so a box's memory writes (3 seen in the shared volume) are lost at the next create. |

**codex**

| | |
|---|---|
| Transcript | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, plain JSONL while live (M, box). Every host rollout (all ≥5 weeks old) is `.jsonl.zst`; 67 more sit in `archived_sessions/` (M). What triggers the compression was not measured. Side indexes: `state_5.sqlite` `threads` (rollout_path, cwd, git branch/origin, `tokens_used`, source) and `thread_history_1.sqlite` (98 MB projection) (M). |
| Box | docker: the shared `agentbox-codex-config` volume; rollouts survive destroy (M). |
| Format | JSONL. First record `session_meta` {`id`, `session_id`, `cwd`, `git{branch,commit_hash,repository_url}`, `source`, `originator`, `cli_version`} (M), then `response_item`, `event_msg`, `turn_context`, `compacted`, `token_usage_record`. |
| Append-only | Yes across turns (M). `/new` opens a new file and leaves the old one plain (M). The later `.zst` conversion changes the path, so the tailer must treat `<f>.jsonl` → `<f>.jsonl.zst` as the same file. |
| Session id | uuidv7 in the filename = `session_meta.id` (M). Subagents are separate threads with `source.subagent.thread_spawn.parent_thread_id` (52 of 151 host threads) (M). |
| Size | Decompressed per rollout: median 199 KB, p90 3.5 MB, max 179 MB (146 MB of it tool output) (M). |
| Memory | The feature exists — `~/.codex/memories/` plus `memories_1.sqlite` `stage1_outputs` (raw memory + rollout summary per thread), `threads.memory_mode` — but both are empty here (M). Global `~/.codex/AGENTS.md` is 0 bytes. |

**pi**

| | |
|---|---|
| Transcript | `~/.pi/agent/sessions/--<cwd dashed>--/<ts>_<uuid>.jsonl` (M); box: `--workspace--/` on the shared `agentbox-pi-config` volume (M, 5 files). |
| Format | JSONL tree: header `session` {`version`, `id`, `cwd`, `parentSession?`}, then entries with `id`/`parentId`; assistant `message.usage` carries tokens **and cost** (M). |
| Append-only | Appends, but a file of an older format version is migrated (rewritten) when loaded (C: pi `docs/session-format.md`) — the prefix-hash re-ship covers it. |
| Session id | Header `id` = filename uuid (M). `/tree` branches inside the same file; `/fork` and `/clone` make a new file with `parentSession` (C). |
| Size | 3 host files, 1–7 KB (M) — too little use to size. |
| Memory | None; only `AGENTS.md`/`CLAUDE.md` context files (C). |

**opencode**

| | |
|---|---|
| Transcript | SQLite `~/.local/share/opencode/opencode.db` (+ WAL): `session` (`parent_id`, `directory`, `tokens_*`, `cost`), `message`, `part`, `event` (M). Box: the same DB on the shared `agentbox-opencode-config` volume, every session's `directory` = `/workspace` (M). |
| Append-only | No. SQLite pages and WAL change in place and rows carry `time_updated` (M, schema). Byte-offset tailing cannot work. |
| Session id | `session.id`, lineage `parent_id` (M). |
| Size | Host 4 sessions, 0.3 MB DB (M) — too little to size. |
| Memory | None (C). |

**openclaw**

| | |
|---|---|
| Transcript | Since 2026.6, per-agent SQLite `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`; the old `agents/<id>/sessions/*.jsonl` is a doctor-import input only (C: openclaw `docs/refactor/database-first.md`). The host install has no agents (M). |
| Box | Always an isolated per-box volume (C: `sandbox-docker/src/agent-isolation.ts`), so attribution is free and destroy wipes it. |
| Memory | Workspace markdown: `MEMORY.md` + `memory/YYYY-MM-DD[-slug].md` (C), and the workspace is `/workspace` (`OPENCLAW_WORKSPACE_DIR`), so memory lives in the box's repo checkout, not the volume. |

### Attribution on shared docker volumes — go, with one change

Measured in `ah-claude`:

| Action | Capture hook fired | Pointer afterwards | Transcript |
|---|---|---|---|
| launch | SessionStart | id A (no file until the first prompt) | — |
| first prompt | Stop | A | `A.jsonl` |
| `/clear` | SessionStart | B | `B.jsonl` |
| `/branch` | SessionStart | C | `C.jsonl`, `forkedFrom: B` |
| subagent | — | C | `C/subagents/agent-*.jsonl` |
| `/compact` | not isolated (id unchanged) | C | `C.jsonl` appended |
| `claude -p` alongside the TUI | SessionStart, SessionEnd | **none**: its start overwrote C, its end cleared the slot while C was still live | `D.jsonl` |

- **claude: GO on attribution by session id, NO-GO on reading the pointer.**
  Every new id passed through a capture hook, but
  `~/.local/state/agentbox/claude-session` is one slot that is overwritten
  and cleared, so a poll misses short or concurrent sessions. The binding
  must be an event: each capture appends `session_id → box` to a per-box log
  on the box's writable layer (or pushes it to the relay), and the shipper
  reads the log. Subagent files attribute through their parent's directory.
- **No path or branch fallback.** cwd is always `/workspace`; in the shared
  volume 34 of 46 session files start on a detached `HEAD` and 6 switch branch
  mid-session (M).
- **codex: GO once its hooks capture.** codex 0.171 hook payloads carry
  `session_id` and `transcript_path` on SessionStart and Stop (M, throwaway
  `CODEX_HOME`). The seeded `agentbox-codex-hooks.json` runs them in the
  background with no capture flag, so nothing records the id today, and the
  `presence` pointer predates hooks carrying it. The `session_meta` fallback
  is ambiguous: `/new` in 0.171 moved the TUI into
  `~/.codex/worktrees/<id>/workspace` on the shared volume with `git.branch:
  null` (M).
- **pi, opencode: possible, not wired.** pi extensions can read
  `ctx.sessionManager.getSessionId()` and opencode plugin events carry
  `sessionID` (C); the AgentBox extension/plugin forward state only.
- **openclaw** is isolated per box; **cloud boxes** write to their own disk (C).
- **Destroy does not remove shared-volume transcripts** (M: the probe's
  sessions remained after `destroy`). "Destroy wipes volumes" holds for
  isolated volumes and cloud boxes only; on a shared volume an unbound
  session lingers forever, unattributable.

### Redaction

Corpus: claude, last 7 days — 210 JSONL files (451k lines, 1.89 GB) plus 67
`tool-results/*.txt`; codex, all 166 rollouts (974 MB raw, none newer than
5 weeks); pi, all 3. Four detectors:

- **A** — the host-tools `CREDENTIAL_ARGV_PATTERNS`, the plan's named list.
- **B** — known secret formats (Anthropic, OpenAI, GitHub, AWS key id, Slack,
  Google, Stripe, npm, Vercel, Daytona, E2B, JWT, PEM header, `Authorization:
  Bearer`, URL with password, `*_KEY|TOKEN|SECRET|PASSWORD=` assignments), each
  hit then classed as placeholder / env reference / local-dev / real-looking.
- **C** — generic high-entropy tokens (≥24 chars, letters + digits, Shannon
  ≥ 4.0).
- **G** — ground truth: exact values of this Mac's own secrets (6 provider
  keys from `~/.agentbox/secrets.env` + the hub token).

| Result | claude (7 d) | codex (all) |
|---|---|---|
| A lines matched | 129 lines / 26 files (+11 in tool-results) | 13 / 6 |
| G exact secret values found | hub token ×6 in 3 files; 0 of the 6 provider keys | 0 |
| G caught by B / by C | 6/6 / 6/6 | — |
| B real-looking hits | Anthropic 6 (1 file), AWS key id 463 (4 files), Bearer 8, PEM private key 32 (4 files), Vercel 8, URL with password 40 (2 files), `*_TOKEN=`-style 950 (103 files) | Google API key 20 (1 file), URL with password 12, assignments 39 |
| Distinct values behind the real-looking hits | Anthropic 1, AWS key id 1, Bearer 1, PEM 2, Vercel 1, URL with password 2; of 269 distinct assignments, 228 are plain identifiers and 30 paths, leaving **9 high-entropy values (32 hits)** | not counted |
| Value-only B formats (Anthropic, AWS, Vercel, PEM, Google, npm, Stripe) missed by A and C | 0 | 0 |
| C tokens flagged | ~1.13M: 445k API object ids (`toolu_`, `msg_`, `req_` …), 367k path-like, 210k slugs, 101k inline blobs | ~60k |

So about **17 distinct likely-real secret values in a week** of claude
transcripts, repeated into ~550 hits. Whether A+C would catch the compound
formats (Bearer, URL with password, assignments) could not be scored by this
method, because the match spans the key name as well as the value; the
ground-truth row above is the reliable recall figure for that class.

Conclusions:

1. **A is the wrong tool for content.** It matches the *command* that printed
   a credential, not the credential (129 lines in a week, all commands). Keep
   it at the host-tools boundary.
2. **C cannot be the redactor.** It catches every high-entropy secret, but at
   ~1.1M flags a week it would shred tool ids, paths and hashes, i.e. most of
   what makes a transcript searchable.
3. **The leaks that happened are the host's own secrets.** The only
   ground-truth value present — the hub token — appeared in 3 files in one
   week. The edge knows these values (secrets.env, hub and device tokens, the
   agent credential files it syncs), so **exact-value redaction is precise and
   catches exactly this class.**
4. **Redactor = exact host-secret values + a curated format list (B) with the
   placeholder/reference/local-dev filters + an entropy check applied only to
   the value side of a `KEY=`/`KEY:` assignment, no free-floating entropy
   rule.** The B filters matter: 666 of 950 assignment hits were identifiers
   and 252 paths. What this still misses is shape-free: an ordinary-looking
   password inside a URL or an assignment. Those are kept and flagged (a
   `redaction_hint` on the turn) rather than blanked.

### Storage budget

| Agent | Files | Raw on disk | Compressed |
|---|---|---|---|
| claude main | 116 | 1,971 MB | 427 MB (zstd-3 per file, 4.6x) |
| claude subagents | 752 | 1,816 MB | 501 MB (3.6x) |
| claude tool-results | 987 | 96 MB | not measured (mostly JPEG) |
| claude memory | 270 | 0.5 MB | — |
| codex rollouts | 166 | 601 MB as stored (`.zst`), 974 MB raw | 601 MB (1.6x, base64 payloads) |
| codex sqlite (thread_history + state) | 4 | 104 MB | — (derived, not shipped) |
| pi / opencode / openclaw | 3 / 1 DB / 1 DB | <2 MB together | — |

- **Total today: ~4.9 GB raw, ~1.6 GB compressed per file**, of which claude
  is 3.8 GB covering only 30 days (the host's own sweep) — about 125 MB of raw
  transcript a day on this PC.
- **Large strings dominate.** Strings ≥ 4 KB are 53% of claude's bytes, and
  34% of all claude bytes are exact duplicates of a string seen earlier
  (re-sent images, copied subagent prefixes, per-session attachment lists).
  Base64 blobs alone are ~48% in a 60-file sample (M).
- **Dedupe + compress: 3,791 MB → 652 MB (5.8x)** — 199 MB of transcripts with
  big strings replaced by a hash, plus 453 MB of unique blobs, both zstd-3
  (M). Per-file zstd alone gives 4.1x; gzip-6 gives 2.2x vs zstd-3 3.3x on the
  sample.
- **Small chunks compress badly**: independent zstd-3 chunks give 1.9x at
  16 KB, 2.2x at 256 KB, 3.2x at 4 MB (M).
- At 90-day retention a PC like this one needs **~2 GB** of hub storage with
  dedupe (~2.8 GB without), plus codex.

### Changes this implies for Phases 1–7

- **Data model.** The session id is the file stem for claude, `session_meta.id`
  for codex, the header id for pi. `identify()` must not trust a claude
  file's first line; lineage comes from `forkedFrom.sessionId` (`/branch`),
  from a foreign-id head (desktop continuation), from codex
  `thread_spawn.parent_thread_id`, from pi `parentSession`. Claude subagents
  are child files of their parent session, not sessions of their own.
- **`history` spec block.** `format: 'sqlite'` is real (opencode, openclaw,
  codex's index) and cannot be byte-tailed. Phase 3 needs a second shipper
  mode: a row cursor (`time_updated`/`seq`) through `node:sqlite`, or the
  agent's own export (`opencode export`, openclaw `/export-session`), with the
  SQLite backup API rather than a copy of a live WAL DB. Declare per entry
  whether it is `append` or `snapshot`; transcripts may also move
  (`.jsonl` → `.jsonl.zst` for codex), so the cursor follows the file id.
- **Phase 1.** Replace "report the pointer" with an append-only binding log
  written by the capture hook (`--capture-session` appends, never clears),
  read by the relay shipper; make codex's SessionStart/Stop hooks synchronous
  with capture in the same change. Destroy's final flush matters for cloud
  and isolated volumes; for shared docker volumes the bigger risk is the
  opposite — an unbound session that never leaves. Ship chunks of ≥ 1–4 MB
  (or re-compact small chunks into one object when a session goes idle), and
  move strings ≥ 4 KB into a content-addressed blob table at the hub
  (`history_blobs(sha256, bytes)`), referenced from the raw chunk. A single
  line reaches 1.8 MB, well under the 32 MiB custody body cap.
- **Phase 1 redaction.** Exact host-secret values + curated formats with the
  false-positive filters; no entropy rule; argv list stays at host tools.
- **Phase 3.** codex: ship the rollout, ignore `thread_history_1.sqlite` (a
  projection the parser can rebuild); handle the `.zst` rename. pi: a
  migrated file re-ships from 0. Add the session-id binding to the pi
  extension and the opencode plugin, or accept "unattributed" for them in
  shared volumes.
- **Phase 4 (memory).** Today's docker seed **deletes** box-written memory at
  the next create, and memory files carry no session id, so tailing the
  shared `-workspace/memory` dir cannot attribute a write to a box or project.
  Either seed memory into a per-box path (isolated memory dir symlinked into
  `-workspace/memory`) or derive memory versions from the bound transcript's
  `Write`/`Edit` tool calls. codex memory exists but is empty here; openclaw
  memory is in the workspace repo; pi and opencode have none, so Phase 4 is
  claude-first and then openclaw.
- **Phase 5.** Host watcher: the host already drops claude transcripts after
  30 days, so a PC that enables upload late has at most a month to backfill.
  Host sessions also include the Claude desktop app (`entrypoint:
  claude-desktop`), which the "projects agentbox knows" filter must allow or
  deny explicitly.
- **Phase 7.** Usage lives on claude `assistant.message.usage`, codex
  `token_usage_record` (and `threads.tokens_used`), pi `message.usage` (with
  cost), opencode `session.tokens_*`/`cost`. pi and opencode already compute
  a cost; still store tokens only and derive cost, per the plan.

## Decisions (defaults proposed, to confirm)

1. **Host-session upload** — opt-in, off by default; when on, limited to
   projects agentbox knows (registered projects / workspace folders), not all
   of `~/.claude/projects`.
2. **Memory authority** — the hub, with the host as fallback seed.
3. **Retention** — transcripts 90 days, usage rows forever, memory versions
   forever; config keys, not env vars.
4. **Box capture default** — on for every box (it is the factory's record);
   per-project opt-out key.

## Explicitly not doing

- Live streaming transcripts to the dashboard (polling the session row is
  enough until proven otherwise).
- Cross-agent memory translation.
- Storing cost (only tokens; cost is derived).
- A parallel box → hub channel: box traffic rides the relay.
