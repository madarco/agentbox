# Agent history — sessions, memory and usage in the hub

**Status:** plan, nothing implemented. Phase 0 (measurement) gates the rest.

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

**Done:** a table per agent + go/no-go on the attribution scheme.

### Phase 1 — store, archive, ingest (claude, boxes)

Schema + archive store + `POST /history/chunks`; claude `history` spec block +
`AgentHistoryModule`; relay shipper for docker boxes, ctl shipper for cloud
boxes; session → box binding; final flush on destroy; redaction at the edge.

**Done:** a claude turn in a docker box and in one cloud box appears in the
store with correct box attribution; destroy leaves the session intact.

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
