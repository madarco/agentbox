/**
 * Agent history: the data an agent declares, the wire frame edges ship, and the
 * parser facet the hub calls. See docs/agent-history-plan.md.
 */

/** One transcript location an agent declares on its registry row. */
export interface AgentHistoryTranscripts {
  /**
   * Directory relative to the agent's box config dir. `<projectKey>` stands for
   * the agent's own project key (`-workspace` in every box).
   */
  root: string;
  format: 'jsonl' | 'json-tree' | 'sqlite';
  /**
   * `append` files are byte-tailed. A `snapshot` source (a live sqlite db) is
   * first copied row by row into an append-only file per session by the edge's
   * row cursor (`sqlite` below), and that file is byte-tailed.
   */
  mode: 'append' | 'snapshot';
  /**
   * The files that make up one session, relative to `root`. `<sessionId>` is
   * the bound id; `*` matches within one path segment and may appear in any
   * segment. For a `snapshot` source, exactly one entry: the file the row
   * cursor writes.
   */
  sessionFiles: string[];
  /** The db a `snapshot` source reads. */
  sqlite?: AgentHistorySqliteSource;
}

/** One table the row cursor copies. All names are plain sql identifiers. */
export interface AgentHistorySqliteTable {
  name: string;
  /** Primary key column. */
  id: string;
  /** Column holding the session id (the `id` column itself for the session table). */
  session: string;
  /** A column that changes whenever the row does (epoch ms). */
  updated: string;
  /** Write a row only after the row its `column` names in `table` was written. */
  parent?: { column: string; table: string };
  /** Write a row only once `updated` is this old (default 0); a final flush ignores it. */
  settleMs?: number;
}

export interface AgentHistorySqliteSource {
  /** The db, relative to the agent's config dir. */
  db: string;
  /** In write order: a parent table before its children. */
  tables: AgentHistorySqliteTable[];
}

/** Data-only `history` block on `AgentSyncSpec`. */
export interface AgentHistorySpec {
  transcripts: AgentHistoryTranscripts[];
}

/** Where a frame came from. The relay overwrites `boxId` from the box's auth. */
export interface HistoryOrigin {
  boxId: string;
  boxName?: string;
  provider?: string;
  /** The PC (machine id) whose relay shipped it. */
  hostId?: string;
  projectRepoUrl?: string;
}

/**
 * One shipped slice of a transcript file. Hashes cover the RAW file bytes, so
 * an edge can verify its prefix without the hub's (redacted) copy. Redaction is
 * length-preserving, so `offset` is valid in both.
 */
export interface HistoryFrame {
  origin: HistoryOrigin;
  agent: string;
  /** Path relative to the agent's config dir (e.g. `projects/-workspace/<id>.jsonl`). */
  path: string;
  offset: number;
  /** sha256 hex of raw bytes [0, offset); '' when offset is 0. */
  sha256Prefix: string;
  /** sha256 hex of raw bytes [0, offset + data length). */
  sha256: string;
  /** base64 of the (redacted) bytes. */
  data: string;
  /** The file was rewritten: start a new generation at offset 0. */
  reset?: boolean;
}

export type HistoryIngestResult =
  | { ok: true; offset: number; sha256: string }
  | {
      ok: false;
      code: 'offset_mismatch' | 'disabled' | 'invalid' | 'unavailable';
      message: string;
      /** What the hub holds for this file, when it holds anything. */
      offset?: number;
      sha256?: string;
    };

/** What an edge hands frames to: the hub service in-process, or an RPC. */
export interface HistoryIngestSink {
  ingest(frame: HistoryFrame): Promise<HistoryIngestResult>;
}

/** What the relay tells an in-box shipper (`history.config`). */
export interface HistoryConfigReply {
  enabled: boolean;
  reason?: string;
  agents: Array<{ agent: string; configDir: string; projectKey: string; spec: AgentHistorySpec }>;
  /**
   * Agents with a `snapshot` source whose row cursor this box must run even
   * when `enabled` is false: a docker box, whose output files the host relay
   * ships. Absent from relays that predate it.
   */
  materialize?: Array<{
    agent: string;
    configDir: string;
    projectKey: string;
    spec: AgentHistorySpec;
  }>;
  /** Box paths of agent credential files: their values seed the exact redaction list. */
  credentialFiles: string[];
}

/** A session → box binding, one line of the box's append-only binding log. */
export interface HistoryBinding {
  ts: string;
  /**
   * The box that wrote the line. The log is on the box's writable layer, so a
   * checkpoint carries it into every box made from it; shippers only ship
   * lines whose `boxId` is their own box.
   */
  boxId?: string;
  agent: string;
  sessionId: string;
  transcriptPath?: string;
}

/** Normalized projection of a transcript. Deliberately lossy; raw is the record. */
export type HistoryRecord =
  | {
      kind: 'turn';
      role: 'user' | 'assistant';
      text: string;
      ts?: string;
      /** Byte offset of the source line in the file. */
      at: number;
    }
  | { kind: 'tool'; name: string; ts?: string; at: number }
  | {
      kind: 'usage';
      messageId: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      ts?: string;
      at: number;
    }
  | { kind: 'meta'; title?: string; cwd?: string; model?: string; ts?: string; at: number };

/** New bytes of one file, line-aligned at the start (the parser buffers the tail). */
export interface RawChunk {
  path: string;
  offset: number;
  bytes: Uint8Array;
}

/** Opaque per-file parser state the hub persists between chunks (JSON-serializable). */
export interface ParseState {
  /** Bytes after the last newline seen, carried to the next chunk. */
  partial?: string;
  [key: string]: unknown;
}

export interface HistoryIdentity {
  sessionId: string;
  parentSessionId?: string;
  /** A child file of `sessionId` (claude subagent), not a session of its own. */
  child?: boolean;
}

/** Hub-side parser facet of an agent module. */
export interface AgentHistoryModule {
  readonly id: string;
  /** Bumped when the projection changes, so Phase 3's re-parse knows what to redo. */
  readonly parserVersion: number;
  parse(chunk: RawChunk, state: ParseState): { records: HistoryRecord[]; state: ParseState };
  identify(head: Uint8Array, path: string): HistoryIdentity | null;
}
