// Session history (docs/agent-history-plan.md, Phase 1): ingest of raw transcript
// frames from the edges (relay docker shipper in-process, `POST
// /api/v1/history/chunks`), the raw archive, the normalized projection, sealing
// small frames into big compressed chunks, and the retention sweep.
//
// Two seams keep the storage swappable: `HistoryRepo` (rows: sqlite here, the
// control box's postgres later) and `HistoryArchive` (chunk bytes: a directory
// here, object storage later). This file holds no SQL and no paths.
import { zstdCompressSync, zstdDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { repoKey } from '@agentbox/config';
import type { ZoneSegment } from '@agentbox/usage-view';
import {
  agentHistoryModule,
  agentHistoryModules,
  extractLargeStrings,
  restoreLargeStrings,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryIngestSink,
  type AgentHistoryModule,
  type HistoryLimitWindow,
  type HistoryRecord,
  type ParseState,
} from '@agentbox/core';

export interface HistoryFileRow {
  id: number;
  originKey: string;
  agent: string;
  path: string;
  /** `<agent>:<sessionId>`, or null when the head named no session. */
  sessionKey: string | null;
  generation: number;
  offset: number;
  sha256: string;
  parseState: ParseState | null;
  child: boolean;
  updatedAt: number;
}

export interface HistorySessionRow {
  key: string;
  agent: string;
  sessionId: string;
  boxId: string | null;
  boxName: string | null;
  provider: string | null;
  hostId: string | null;
  projectRepoUrl: string | null;
  /**
   * The subscription the session ran on when it was first seen, as
   * `agent/account` (a borrowed login names its lender; `<agent>/default` when
   * the box names none); null when the box was unknown. A bare id stored before
   * hub settings Phase 3a is migrated to the session agent's own at open.
   */
  account: string | null;
  parentSessionId: string | null;
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  parserVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryChunkRow {
  id: number;
  fileId: number;
  generation: number;
  start: number;
  end: number;
  key: string;
  codec: 'zstd' | 'gzip';
  sealed: boolean;
  /** Large strings were moved to `history_blobs` (sealed chunks only). */
  deduped: boolean;
  endsWithNewline: boolean;
  storedBytes: number;
}

export type NewChunk = Omit<HistoryChunkRow, 'id'>;

/** Listing filter for `GET /history/sessions`. All optional, ANDed. */
export interface HistorySessionFilter {
  agent?: string;
  /** A box id or a box name, exact. */
  box?: string;
  /** Substring of the project's repo URL. */
  project?: string;
  /**
   * Exact stored repo URLs (one repo's spellings, see `projectUrlsFor`). An
   * empty list matches nothing: it is a scope, never "no filter".
   */
  projectUrls?: readonly string[];
  /** The PC (machine id) that shipped it. */
  host?: string;
  /** Last activity (the transcript's own last timestamp) at or after this epoch-ms. */
  sinceMs?: number;
  /**
   * Full-text over the session's turns. Plain words at the service; the
   * service quotes them (`ftsQuery`) before the repo sees them.
   */
  q?: string;
  limit?: number;
}

export interface HistoryTurnRow {
  /** Position in the session's turn order (0-based), the `from`/`to` unit. */
  index: number;
  kind: 'turn' | 'tool';
  role: 'user' | 'assistant' | null;
  name: string | null;
  text: string | null;
  ts: string | null;
  /** The file (main or a subagent's) and byte offset the row came from. */
  path: string;
  at: number;
}

export interface HistorySearchHit {
  sessionKey: string;
  role: 'user' | 'assistant' | null;
  ts: string | null;
  snippet: string;
}

/** One `history_usage` row, opaque to the service (snapshot and restore only). */
export type StoredUsageRow = Record<string, unknown>;

/** Usage dimensions, for grouping and filtering (`GET /api/v1/usage`). */
export const USAGE_DIMENSIONS = [
  'day',
  'agent',
  'account',
  'box',
  'project',
  'host',
  'model',
  'session',
] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export interface UsageFilter {
  agent?: string;
  /** A subscription `agent/account`, or a bare account id (that id of any agent). */
  account?: string;
  /** A box id or a box name, exact. */
  box?: string;
  /** Substring of the project's repo URL. */
  project?: string;
  host?: string;
  model?: string;
  /** Message time window `[sinceMs, untilMs)`, epoch ms. */
  sinceMs?: number;
  untilMs?: number;
}

export interface UsageQuery extends UsageFilter {
  /** Group keys, at most two; none = totals only. */
  by: UsageDimension[];
  /** Minutes east of UTC that `day` buckets in (e.g. 60 for CET). */
  tzOffsetMin: number;
  limit: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** All four token counts summed. */
  totalTokens: number;
  /** Model responses counted (usage rows). */
  messages: number;
  sessions: number;
}

export interface UsageGroup extends UsageTotals {
  keys: Partial<Record<UsageDimension, string | null>>;
  /** Display names where the key is an id: `box` (box name), `session` (title). */
  labels: Partial<Record<UsageDimension, string | null>>;
}

export interface UsageReport {
  totals: UsageTotals;
  groups: UsageGroup[];
  /** More groups matched than `limit` returned. */
  truncated: boolean;
}

/** Turn plain words into an FTS5 query that matches them all, with no operators. */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 16)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(' ');
}

/** The plan limits a transcript last reported for an account (codex `rate_limits`). */
export interface HistoryAccountLimits {
  windows: HistoryLimitWindow[];
  reached?: string;
  plan?: string;
  /** The record's own time, when the transcript had one. */
  ts: string | null;
  /** When the hub stored it, epoch ms. */
  updatedAt: number;
}

/**
 * Credential evidence for a subscription from its sessions' transcripts
 * (docs/credentials-tui-plan.md): the newest refused credential and the newest
 * real reply. ISO times; null when no session reported one.
 */
/**
 * A subscription's credential evidence, per box: the box's newest refused
 * credential and its newest real reply, each recorded under the account the
 * box ran on when the transcript line shipped.
 */
export interface HistoryAccountAuth {
  boxes: Array<{
    box: string;
    failedAt: string | null;
    error: string | null;
    /** Where the newest refusal came from; set with `failedAt`. */
    source?: HistoryAuthSource;
    okAt: string | null;
  }>;
}

/**
 * `transcript`: the agent's own refusal line. `box`: ctl saw the login file
 * signed out (`credentials-dead`), with no turn needed.
 */
export type HistoryAuthSource = 'transcript' | 'box';

/** One auth event, as ingest records it. */
export interface HistoryAuthEvent {
  /** `<agent>/<account>`. */
  account: string;
  /** The box's name (its id when it has none). */
  box: string;
  kind: 'fail' | 'ok';
  ts: string;
  error?: string;
  /** A refusal's signal; default `transcript`. */
  source?: HistoryAuthSource;
}

/**
 * A session's live-status inputs (docs/agent-live-status-plan.md, Phase 3):
 * the newest working-on line, the plan line, context fill, the agent's own
 * cumulative totals (codex, opencode) and the sum of its usage rows.
 */
export interface HistoryLiveRow {
  activity: string | null;
  activityTs: string | null;
  /** An in-progress todo (opencode); wins over `activity` while set. */
  plan: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    costUsd?: number;
    ts?: string;
  } | null;
  sums: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number | null;
    ts: string | null;
  } | null;
  updatedAt: number;
}

/** The usage dashboard's reads (usage dashboard Phase 2): timestamps and sums, never turn text. */
export interface UsageWindow {
  /** Inclusive, epoch ms. */
  sinceMs: number;
  /** Exclusive, epoch ms. */
  untilMs: number;
  /** Only sessions on this subscription (`agent/account`). */
  account?: string;
}

/** One busy interval of a session: its first and last row, no tail added. */
export interface UsageSpanRow {
  sessionKey: string;
  start: number;
  last: number;
}

export interface UsageSessionMeta {
  key: string;
  agent: string;
  sessionId: string;
  boxId: string | null;
  boxName: string | null;
  provider: string | null;
  hostId: string | null;
  projectKey: string | null;
  account: string | null;
}

/** Tokens of one session on one local day. */
export interface UsageTokenDay {
  sessionKey: string;
  /** The local date, as days since 1970-01-01. */
  day: number;
  tokens: number;
  costUsd: number | null;
}

/** Rows. Async so a postgres implementation fits the same seam. */
export interface HistoryRepo {
  getFile(originKey: string, agent: string, path: string): Promise<HistoryFileRow | null>;
  getFileById(id: number): Promise<HistoryFileRow | null>;
  createFile(row: Omit<HistoryFileRow, 'id'>): Promise<HistoryFileRow>;
  updateFile(
    id: number,
    patch: Partial<
      Pick<HistoryFileRow, 'generation' | 'offset' | 'sha256' | 'parseState' | 'updatedAt'>
    >,
  ): Promise<void>;
  /** Drop a file's projection (a reset re-derives it from the new generation). */
  clearFileRecords(fileId: number): Promise<void>;
  getSession(key: string): Promise<HistorySessionRow | null>;
  upsertSession(row: HistorySessionRow): Promise<void>;
  listSessions(): Promise<HistorySessionRow[]>;
  addChunk(row: NewChunk): Promise<number>;
  listChunks(fileId: number, generation: number): Promise<HistoryChunkRow[]>;
  /** Swap `removeIds` for one sealed chunk referencing `blobShas`, atomically. */
  replaceChunks(removeIds: number[], sealed: NewChunk, blobShas: string[]): Promise<void>;
  putBlob(sha256: string, bytes: Buffer): Promise<void>;
  getBlob(sha256: string): Promise<Buffer | null>;
  insertRecords(sessionKey: string, fileId: number, records: HistoryRecord[]): Promise<void>;
  /** Recompute turns/token totals and first/last ts from the projection. */
  refreshSessionTotals(sessionKey: string, nowMs: number): Promise<void>;
  /** Files with unsealed chunks last written before `beforeMs`. */
  idleUnsealedFiles(beforeMs: number): Promise<number[]>;
  /** Sessions untouched since `beforeMs`. */
  expiredSessions(beforeMs: number): Promise<string[]>;
  /** Delete a session with its files, chunks and projection; returns archive keys to delete. */
  deleteSession(key: string): Promise<string[]>;
  /**
   * Retention: delete a session's files, chunks and turns, keep the session row
   * (stamped purged) and its usage rows. Returns archive keys to delete.
   */
  purgeSession(key: string, nowMs: number): Promise<string[]>;
  /** Sessions with no account stamped yet, that name a box, keyed after `afterKey`. */
  sessionsWithoutAccount(
    afterKey: string,
    limit: number,
  ): Promise<Array<{ key: string; boxId: string; agent: string }>>;
  setSessionAccount(key: string, account: string): Promise<void>;
  /** A session's usage rows as stored, for a re-parse to put back if it fails. */
  usageRowsOf(key: string): Promise<StoredUsageRow[]>;
  /** Replace a session's usage rows with `rows`, atomically. */
  replaceUsage(key: string, rows: StoredUsageRow[]): Promise<void>;
  usage(q: UsageQuery): Promise<UsageReport>;
  /**
   * The stored busy intervals (`activeIntervals`, cut at `idleGapMs` inside a turn) overlapping
   * the window. Reads only: sessions whose turns changed since are brought up to
   * date by `refreshSpans`, off the request path.
   */
  usageSpans(q: UsageWindow & { idleGapMs: number }): Promise<UsageSpanRow[]>;
  /**
   * Tokens per session per local day in the window; `zone` is the zone's offsets
   * over the window (`zoneSegments`), so the store needs no zone support.
   */
  usageTokens(q: UsageWindow & { zone: readonly ZoneSegment[] }): Promise<UsageTokenDay[]>;
  usageSessions(keys: readonly string[]): Promise<UsageSessionMeta[]>;
  /**
   * Recompute the intervals of up to `limit` sessions whose turns changed; returns
   * how many. A session whose `parser_version` is below its agent's entry in
   * `parserVersions` is skipped: a re-parse is pending or in flight.
   */
  refreshSpans(limit: number, parserVersions?: Readonly<Record<string, number>>): Promise<number>;
  /** A session's stored intervals, to put back if its re-parse fails. */
  sessionSpans(key: string): Promise<UsageSpanRow[]>;
  /** Replace a session's intervals with `spans` and mark them current. */
  restoreSpans(key: string, spans: readonly UsageSpanRow[]): Promise<void>;
  /** Delete blobs no chunk references; returns how many. */
  gcBlobs(): Promise<number>;
  /** Keys of `agent`'s sessions projected by a parser older than `version`. */
  staleParserSessions(agent: string, version: number, limit: number): Promise<string[]>;
  /** Forget a session's title (a re-parse derives it again). */
  clearSessionTitle(key: string): Promise<void>;
  setSessionParserVersion(key: string, version: number): Promise<void>;
  /** Forget a session's live row (a re-parse derives it again). */
  clearLive(key: string): Promise<void>;
  /**
   * The newest plan limits a session on subscription `account`
   * (`agent/account`) reported, or null (hub settings Phase 3b).
   */
  accountLimits(account: string): Promise<HistoryAccountLimits | null>;
  /** Credential evidence for subscription `account` (`agent/account`). */
  accountAuth(account: string): Promise<HistoryAccountAuth>;
  recordAuth(e: HistoryAuthEvent): Promise<void>;
  /** A session's live-status inputs, or null when it has none. */
  liveRow(key: string): Promise<HistoryLiveRow | null>;
  /** The most recent session `agent` ran in box `boxId`, by its own last activity. */
  latestBoxSession(boxId: string, agent: string): Promise<string | null>;

  // ---- reads (Phase 2) ----
  querySessions(filter: HistorySessionFilter): Promise<HistorySessionRow[]>;
  /** Keys matching a reference: the exact key, an exact session id, or an id prefix. */
  matchSessionKeys(ref: string): Promise<string[]>;
  filesOfSession(key: string): Promise<HistoryFileRow[]>;
  countTurns(key: string): Promise<number>;
  /** Turn/tool rows in session order, `limit` from `from`. */
  turns(key: string, from: number, limit: number): Promise<HistoryTurnRow[]>;
  toolCounts(key: string): Promise<Array<{ name: string; count: number }>>;
  /** FTS hits for an already-quoted query (see `ftsQuery`), optionally within these repo URLs. */
  search(fts: string, limit: number, projectUrls?: readonly string[]): Promise<HistorySearchHit[]>;
  /** Every distinct `project_repo_url` stored. */
  projectUrls(): Promise<string[]>;
}

/** Chunk bytes. */
export interface HistoryArchive {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const SEAL_BYTES = 2 * 1024 * 1024;
export const SEAL_IDLE_MS = 5 * 60_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const hasZstd = typeof zstdCompressSync === 'function';

function compress(bytes: Buffer): { codec: 'zstd' | 'gzip'; bytes: Buffer } {
  return hasZstd
    ? { codec: 'zstd', bytes: zstdCompressSync(bytes) }
    : { codec: 'gzip', bytes: gzipSync(bytes) };
}

function decompress(codec: 'zstd' | 'gzip', bytes: Buffer): Buffer {
  return codec === 'zstd' ? zstdDecompressSync(bytes) : gunzipSync(bytes);
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || '_';
}

export interface HistoryServiceDeps {
  repo: HistoryRepo;
  archive: HistoryArchive;
  retentionDays: number;
  /**
   * The subscription `agent`'s sessions in box `boxId` count under, as
   * `agent/account` (the lender's for a borrowed login), or null when the box
   * is unknown here.
   */
  accountOf?: (boxId: string, agent: string) => Promise<string | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface HistorySessionDetail {
  session: HistorySessionRow;
  files: Array<{ path: string; child: boolean; bytes: number }>;
  turns: number;
  tools: Array<{ name: string; count: number }>;
  firstPrompt: string | null;
  lastReply: string | null;
}

export type ResolvedSession =
  | { ok: true; key: string }
  | { ok: false; code: 'not_found' | 'ambiguous'; candidates: string[] };

export interface HistoryService extends HistoryIngestSink {
  /** Reassemble a file's current generation byte for byte. */
  readRaw(fileId: number): Promise<Buffer>;
  /**
   * The same bytes, chunk by chunk, from `startOffset` (default 0) up to
   * `endOffset` (default: what is ingested now). Starts at the chunk holding
   * `startOffset`, so a tail read does not decompress the whole file.
   */
  rawStream(fileId: number, endOffset?: number, startOffset?: number): AsyncGenerator<Buffer>;
  listSessions(filter: HistorySessionFilter): Promise<HistorySessionRow[]>;
  resolveSession(ref: string): Promise<ResolvedSession>;
  sessionDetail(key: string): Promise<HistorySessionDetail | null>;
  sessionTurns(key: string, from: number, limit: number): Promise<HistoryTurnRow[]>;
  /** The file to download: `path` when it belongs to the session, else its main file. */
  sessionFile(key: string, path?: string): Promise<HistoryFileRow | null>;
  search(
    q: string,
    limit: number,
    opts?: { projectUrls?: readonly string[] },
  ): Promise<HistorySearchHit[]>;
  /** The stored repo URLs whose `repoKey` is `key` (ssh and https spellings of one repo). */
  projectUrlsFor(key: string): Promise<string[]>;
  /** Token usage, grouped and filtered (limits clamped here). */
  usage(q: UsageQuery): Promise<UsageReport>;
  /** Stamp the account on sessions stored without one whose box is still known. */
  backfillAccounts(): Promise<number>;
  /**
   * Re-derive the projection of every session whose parser is older than its
   * agent module's, from the raw archive. Returns how many sessions it redid.
   */
  reparse(): Promise<number>;
  /**
   * Called after a frame added records to a session, with the session's key and
   * the box it ran in (null for a host session). Returns an unsubscribe fn.
   */
  onSessionUpdated(fn: (sessionKey: string, boxId: string | null) => void): () => void;
  /**
   * Bring the usage dashboard's stored intervals up to date (sessions that took turns
   * since, or every session after the migration), in batches. Run at start and with
   * the minute sweep; returns how many sessions it redid.
   */
  refreshUsageSpans(): Promise<number>;
  /** Seal idle files and apply retention. */
  sweep(opts?: {
    retention?: boolean;
  }): Promise<{ sealed: number; expired: number; blobs: number }>;
  start(): void;
  stop(): void;
  repo: HistoryRepo;
}

// Small: sqlite blocks the event loop the relay and web server share while a
// batch runs, and a long session's recompute is a few milliseconds.
const SPAN_BATCH = 5;

/** Each agent's current parser version, for `refreshSpans`. */
function parserVersions(): Record<string, number> {
  return Object.fromEntries(agentHistoryModules().map((m) => [m.id, m.parserVersion]));
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const { repo, archive } = deps;
  let spansRun: Promise<number> | null = null;
  let spansAgain = false;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  // One writer: frames for one file must apply in order, and sqlite is
  // single-writer anyway.
  const updateListeners = new Set<(sessionKey: string, boxId: string | null) => void>();
  const sessionUpdated = (key: string, boxId: string | null): void => {
    for (const fn of updateListeners) {
      try {
        fn(key, boxId);
      } catch {
        /* a listener must not fail an ingest */
      }
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const timers: NodeJS.Timeout[] = [];

  const accountFor = async (boxId: string, agent: string): Promise<string | null> => {
    if (!deps.accountOf) return null;
    try {
      return await deps.accountOf(boxId, agent);
    } catch {
      return null;
    }
  };

  /**
   * Credential evidence off freshly shipped records: a refusal, or a real reply
   * (output tokens). Keyed by the account the box runs on now, which is the
   * one it ran on when the line was written (lines ship as they land). A
   * re-parse never comes here: its lines are old, the box's account may not be.
   */
  const recordAuthOf = async (
    records: readonly HistoryRecord[],
    origin: { boxId?: string; boxName?: string },
    agent: string,
  ): Promise<void> => {
    const events = records.filter(
      (r) => r.kind === 'auth' || (r.kind === 'usage' && r.outputTokens > 0),
    );
    if (events.length === 0 || !origin.boxId) return;
    const account = await accountFor(origin.boxId, agent);
    if (!account) return;
    const box = origin.boxName ?? origin.boxId;
    // A line without its own time is dated by its arrival, so it still orders
    // against the stored secret's write time.
    const at = (ts: string | undefined): string => ts ?? new Date(now()).toISOString();
    for (const r of events) {
      if (r.kind === 'auth') {
        await repo.recordAuth({ account, box, kind: 'fail', ts: at(r.ts), error: r.error });
      } else if (r.kind === 'usage') {
        await repo.recordAuth({ account, box, kind: 'ok', ts: at(r.ts) });
      }
    }
  };

  const mismatch = (file: HistoryFileRow | null, message: string): HistoryIngestResult => ({
    ok: false,
    code: 'offset_mismatch',
    message,
    offset: file?.offset ?? 0,
    sha256: file?.sha256 ?? '',
  });

  /** One stored chunk back to the original bytes (large strings restored). */
  async function restoreChunk(c: HistoryChunkRow): Promise<Buffer> {
    const bytes = decompress(c.codec, await archive.get(c.key));
    if (!c.deduped) return bytes;
    const blobs = new Map<string, Buffer>();
    for (const m of bytes.toString('latin1').matchAll(/@@agentbox-blob:([0-9a-f]{64})@@/g)) {
      const sha = m[1]!;
      if (!blobs.has(sha)) {
        const b = await repo.getBlob(sha);
        if (b) blobs.set(sha, b);
      }
    }
    return restoreLargeStrings(bytes, (sha) => blobs.get(sha));
  }

  async function seal(file: HistoryFileRow): Promise<boolean> {
    const chunks = (await repo.listChunks(file.id, file.generation)).filter((c) => !c.sealed);
    let last = -1;
    chunks.forEach((c, i) => {
      if (c.endsWithNewline) last = i;
    });
    const run = chunks.slice(0, last + 1);
    if (run.length === 0) return false;
    const raw = Buffer.concat(
      await Promise.all(run.map(async (c) => decompress(c.codec, await archive.get(c.key)))),
    );
    const ex = extractLargeStrings(raw);
    for (const b of ex.blobs) await repo.putBlob(b.sha256, b.bytes);
    const packed = compress(ex.bytes);
    const start = run[0]!.start;
    const end = run[run.length - 1]!.end;
    const key = `${run[0]!.key.replace(/\/[^/]*$/, '')}/g${String(file.generation)}-${String(start)}-${String(end)}.s.${packed.codec}`;
    await archive.put(key, packed.bytes);
    await repo.replaceChunks(
      run.map((c) => c.id),
      {
        fileId: file.id,
        generation: file.generation,
        start,
        end,
        key,
        codec: packed.codec,
        sealed: true,
        deduped: ex.deduped,
        endsWithNewline: true,
        storedBytes: packed.bytes.length,
      },
      ex.blobs.map((b) => b.sha256),
    );
    for (const c of run) await archive.delete(c.key).catch(() => undefined);
    return true;
  }

  async function ingestOne(frame: HistoryFrame): Promise<HistoryIngestResult> {
    const host = frame.origin?.kind === 'host';
    const boxId = host ? '' : (frame.origin?.boxId ?? '');
    const hostId = frame.origin?.hostId ?? '';
    if ((host ? !hostId : !boxId) || !frame.agent || !frame.path) {
      return {
        ok: false,
        code: 'invalid',
        message: 'frame needs origin.boxId (or kind host + hostId), agent and path',
      };
    }
    const data = Buffer.from(frame.data, 'base64');
    if (data.length === 0 || data.length > MAX_FRAME_BYTES) {
      return { ok: false, code: 'invalid', message: 'frame data is empty or too large' };
    }
    // A host session (Phase 5) is keyed by the PC that ran it.
    const originKey = host ? `host:${hostId}` : `box:${boxId}`;
    const mod = agentHistoryModule(frame.agent);
    let file = await repo.getFile(originKey, frame.agent, frame.path);

    if (!file) {
      if (frame.offset !== 0) return mismatch(null, 'unknown file: ship from offset 0');
      const id = mod?.identify(data, frame.path) ?? null;
      const sessionKey = id ? `${frame.agent}:${id.sessionId}` : null;
      file = await repo.createFile({
        originKey,
        agent: frame.agent,
        path: frame.path,
        sessionKey,
        generation: 0,
        offset: 0,
        sha256: '',
        parseState: null,
        child: id?.child === true,
        updatedAt: now(),
      });
      if (id && sessionKey) {
        const existing = await repo.getSession(sessionKey);
        const o = frame.origin;
        const account = existing?.account ?? (host ? null : await accountFor(o.boxId, frame.agent));
        await repo.upsertSession({
          key: sessionKey,
          agent: frame.agent,
          sessionId: id.sessionId,
          boxId: existing?.boxId ?? (host ? null : o.boxId),
          boxName: existing?.boxName ?? (host ? null : (o.boxName ?? null)),
          provider: existing?.provider ?? (host ? 'host' : (o.provider ?? null)),
          hostId: existing?.hostId ?? o.hostId ?? null,
          projectRepoUrl: existing?.projectRepoUrl ?? o.projectRepoUrl ?? null,
          account,
          parentSessionId: existing?.parentSessionId ?? id.parentSessionId ?? null,
          firstTs: existing?.firstTs ?? null,
          lastTs: existing?.lastTs ?? null,
          title: existing?.title ?? null,
          turns: existing?.turns ?? 0,
          inputTokens: existing?.inputTokens ?? 0,
          outputTokens: existing?.outputTokens ?? 0,
          // An existing session keeps its version: a new file must not mark
          // the older files' projection current before the re-parse job runs.
          parserVersion: existing?.parserVersion ?? mod?.parserVersion ?? 0,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        });
      }
    } else if (frame.reset && frame.offset === 0) {
      // The edge saw the file rewritten. Old generations stay in the archive
      // until retention; the projection is re-derived from the new one.
      await repo.clearFileRecords(file.id);
      // The live row is derived from every file of the session; the rewritten
      // one's values must not outlive it. The other files refill it as they ship.
      if (file.sessionKey) await repo.clearLive(file.sessionKey);
      file = { ...file, generation: file.generation + 1, offset: 0, sha256: '', parseState: null };
      await repo.updateFile(file.id, {
        generation: file.generation,
        offset: 0,
        sha256: '',
        parseState: null,
      });
    } else if (frame.offset !== file.offset) {
      return mismatch(file, `hub holds ${String(file.offset)} bytes`);
    } else if (file.offset > 0 && frame.sha256Prefix !== file.sha256) {
      return mismatch(file, 'prefix hash differs');
    }

    const packed = compress(data);
    const sessionSeg = file.sessionKey ? file.sessionKey.slice(frame.agent.length + 1) : 'unbound';
    const key = [
      safeSegment(frame.agent),
      safeSegment(sessionSeg),
      `f${String(file.id)}`,
      `g${String(file.generation)}-${String(frame.offset)}.${packed.codec}`,
    ].join('/');
    await archive.put(key, packed.bytes);
    await repo.addChunk({
      fileId: file.id,
      generation: file.generation,
      start: frame.offset,
      end: frame.offset + data.length,
      key,
      codec: packed.codec,
      sealed: false,
      deduped: false,
      endsWithNewline: data[data.length - 1] === 0x0a,
      storedBytes: packed.bytes.length,
    });

    let parseState = file.parseState;
    if (mod && file.sessionKey) {
      try {
        const r = mod.parse(
          { path: frame.path, offset: frame.offset, bytes: data },
          parseState ?? {},
        );
        parseState = r.state;
        if (r.records.length > 0) await repo.insertRecords(file.sessionKey, file.id, r.records);
        if (!host) await recordAuthOf(r.records, frame.origin, frame.agent);
        await repo.refreshSessionTotals(file.sessionKey, now());
        if (r.records.length > 0) sessionUpdated(file.sessionKey, host ? null : boxId);
      } catch (e) {
        // A parser bug must not lose raw bytes: the projection is re-derivable.
        log(`history: parse ${frame.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const offset = frame.offset + data.length;
    await repo.updateFile(file.id, { offset, sha256: frame.sha256, parseState, updatedAt: now() });

    const unsealed = (await repo.listChunks(file.id, file.generation)).filter((c) => !c.sealed);
    const pending = unsealed.reduce((n, c) => n + (c.end - c.start), 0);
    if (pending >= SEAL_BYTES) await seal({ ...file, offset });
    return { ok: true, offset, sha256: frame.sha256 };
  }

  /** One session's projection, from raw. Runs inside the ingest queue. */
  async function reparseSession(key: string, mod: AgentHistoryModule): Promise<boolean> {
    const session = await repo.getSession(key);
    const files = await repo.filesOfSession(key);
    // Usage outlives the transcript (Decision 3): a failed re-parse must not
    // lose the rows the previous parser stored.
    const usageBefore = await repo.usageRowsOf(key);
    // Spans too: a half re-parsed session must not recompute them from part of its turns.
    const spansBefore = await repo.sessionSpans(key);
    for (const f of files) await repo.clearFileRecords(f.id);
    await repo.clearSessionTitle(key);
    await repo.clearLive(key);
    let ok = true;
    for (const f of files) {
      let state: ParseState = {};
      let pos = 0;
      try {
        for await (const bytes of service.rawStream(f.id, f.offset)) {
          const r = mod.parse({ path: f.path, offset: pos, bytes }, state);
          state = r.state;
          pos += bytes.length;
          if (r.records.length > 0) await repo.insertRecords(key, f.id, r.records);
        }
      } catch (e) {
        // The raw is intact; the session stays stale so a later run redoes it.
        ok = false;
        log(`history: re-parse ${f.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await repo.updateFile(f.id, { parseState: state });
    }
    if (!ok) {
      await repo.replaceUsage(key, usageBefore);
      await repo.restoreSpans(key, spansBefore);
    }
    // Keep the session's activity time: a re-parse is not activity (ordering,
    // retention).
    await repo.refreshSessionTotals(key, session?.updatedAt ?? now());
    if (ok) await repo.setSessionParserVersion(key, mod.parserVersion);
    return ok;
  }

  let reparsing: Promise<number> | null = null;

  const service: HistoryService = {
    repo,
    ingest: (frame) =>
      serialized(() =>
        ingestOne(frame).catch(
          (e: unknown): HistoryIngestResult => ({
            ok: false,
            code: 'unavailable',
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),

    // Same evidence as a refusal line, from ctl's credentials watcher: keyed by
    // the account the box runs on now (the file it watches is that login's).
    recordCredentialsDead: (e) =>
      serialized(async () => {
        const account = await accountFor(e.boxId, e.agent);
        if (!account) {
          log(`history: credentials-dead from unknown box ${e.boxId} (${e.agent}); not recorded`);
          return;
        }
        await repo.recordAuth({
          account,
          box: e.boxName ?? e.boxId,
          kind: 'fail',
          ts: e.ts,
          error: 'credentials-dead',
          source: 'box',
        });
      }),

    async readRaw(fileId) {
      const parts: Buffer[] = [];
      for await (const b of service.rawStream(fileId)) parts.push(b);
      return Buffer.concat(parts);
    },

    async *rawStream(fileId, endOffset, startOffset) {
      const file = await repo.getFileById(fileId);
      if (!file) throw new Error(`history file ${String(fileId)} not found`);
      // A fixed end: a file still being appended to would otherwise stream
      // past the length the caller announced (content-length).
      const end = Math.min(endOffset ?? file.offset, file.offset);
      let chunks = await repo.listChunks(fileId, file.generation);
      let pos = Math.max(0, Math.min(startOffset ?? 0, end));
      let retries = 0;
      while (pos < end) {
        const c = chunks.find((x) => x.start <= pos && pos < x.end);
        let bytes: Buffer | null = null;
        if (c) {
          try {
            bytes = await restoreChunk(c);
          } catch (e) {
            // A seal replaced it meanwhile (small chunks merged, objects
            // deleted): re-list and find this position again.
            if (++retries > 3) throw e;
          }
        } else if (++retries > 3) {
          throw new Error(`history file ${String(fileId)} has no chunk at byte ${String(pos)}`);
        }
        if (!c || !bytes) {
          chunks = await repo.listChunks(fileId, file.generation);
          continue;
        }
        retries = 0;
        const stop = Math.min(c.end, end);
        yield bytes.subarray(pos - c.start, stop - c.start);
        pos = stop;
      }
    },

    listSessions(filter) {
      const { q, ...rest } = filter;
      const fts = q ? ftsQuery(q) : null;
      // A query with no words matches nothing (as `search` does), not everything.
      if (q && !fts) return Promise.resolve([]);
      if (filter.projectUrls && filter.projectUrls.length === 0) return Promise.resolve([]);
      return repo.querySessions({
        ...rest,
        ...(fts ? { q: fts } : {}),
        limit: Math.min(Math.max(filter.limit ?? 50, 1), 500),
      });
    },

    async resolveSession(ref) {
      const keys = await repo.matchSessionKeys(ref.trim());
      if (keys.length === 1) return { ok: true, key: keys[0]! };
      return {
        ok: false,
        code: keys.length === 0 ? 'not_found' : 'ambiguous',
        candidates: keys.slice(0, 10),
      };
    },

    async sessionDetail(key) {
      const session = await repo.getSession(key);
      if (!session) return null;
      const files = await repo.filesOfSession(key);
      const total = await repo.countTurns(key);
      const head = await repo.turns(key, 0, 50);
      const tail = total > 50 ? await repo.turns(key, Math.max(0, total - 50), 50) : head;
      const firstPrompt = head.find((t) => t.kind === 'turn' && t.role === 'user')?.text ?? null;
      const lastReply =
        [...tail].reverse().find((t) => t.kind === 'turn' && t.role === 'assistant')?.text ?? null;
      return {
        session,
        files: files.map((f) => ({ path: f.path, child: f.child, bytes: f.offset })),
        turns: total,
        tools: await repo.toolCounts(key),
        firstPrompt,
        lastReply,
      };
    },

    sessionTurns: (key, from, limit) =>
      repo.turns(key, Math.max(0, from), Math.min(Math.max(limit, 1), 1000)),

    async sessionFile(key, path) {
      const files = await repo.filesOfSession(key);
      if (path) return files.find((f) => f.path === path) ?? null;
      return files.find((f) => !f.child) ?? files[0] ?? null;
    },

    async search(q, limit, opts) {
      const fts = ftsQuery(q);
      if (!fts) return [];
      if (opts?.projectUrls && opts.projectUrls.length === 0) return [];
      return repo.search(fts, Math.min(Math.max(limit, 1), 200), opts?.projectUrls);
    },

    async projectUrlsFor(key) {
      return (await repo.projectUrls()).filter((u) => u === key || repoKey(u) === key);
    },

    usage: (q) =>
      repo.usage({
        ...q,
        by: [...new Set(q.by)].slice(0, 2),
        tzOffsetMin: Math.min(Math.max(Math.trunc(q.tzOffsetMin) || 0, -14 * 60), 14 * 60),
        limit: Math.min(Math.max(q.limit, 1), 1000),
      }),

    async backfillAccounts() {
      let done = 0;
      // A key cursor: sessions of boxes this hub no longer knows stay null and
      // are walked once per run.
      let after = '';
      for (;;) {
        const rows = await repo.sessionsWithoutAccount(after, 200);
        if (rows.length === 0) break;
        for (const r of rows) {
          const account = await accountFor(r.boxId, r.agent);
          if (account) {
            await repo.setSessionAccount(r.key, account);
            done++;
          }
        }
        after = rows[rows.length - 1]!.key;
      }
      return done;
    },

    reparse() {
      // One job at a time; each session is its own turn in the ingest queue,
      // so frames keep landing between sessions.
      reparsing ??= (async () => {
        let done = 0;
        try {
          for (const mod of agentHistoryModules()) {
            // A session that failed stays stale for the next run, not this one.
            const failed = new Set<string>();
            for (;;) {
              const keys = (
                await repo.staleParserSessions(mod.id, mod.parserVersion, 50 + failed.size)
              ).filter((k) => !failed.has(k));
              if (keys.length === 0) break;
              for (const key of keys) {
                if (await serialized(() => reparseSession(key, mod))) done++;
                else failed.add(key);
              }
            }
          }
        } finally {
          reparsing = null;
        }
        if (done > 0) {
          log(`history: re-parsed ${String(done)} session(s)`);
          // Their spans waited for the re-parse (`refreshSpans` skips stale sessions).
          void service.refreshUsageSpans().catch(() => undefined);
        }
        return done;
      })();
      return reparsing;
    },

    refreshUsageSpans() {
      // A caller arriving mid-run (a box's final flush) may hold turns the run
      // already went past: it waits for one more round, which picks them up.
      if (spansRun) {
        spansAgain = true;
        return spansRun;
      }
      const run = (async () => {
        let done = 0;
        try {
          do {
            spansAgain = false;
            // Small batches with a turn of the event loop between them: the hub's relay
            // and web server share this process, and sqlite blocks while it works.
            for (;;) {
              const n = await repo.refreshSpans(SPAN_BATCH, parserVersions());
              done += n;
              if (n < SPAN_BATCH) break;
              await new Promise((r) => setImmediate(r));
            }
          } while (spansAgain);
          return done;
        } finally {
          spansRun = null;
        }
      })();
      spansRun = run;
      return run;
    },

    onSessionUpdated(fn) {
      updateListeners.add(fn);
      return () => updateListeners.delete(fn);
    },

    sweep: (opts = {}) =>
      serialized(async () => {
        let sealed = 0;
        for (const id of await repo.idleUnsealedFiles(now() - SEAL_IDLE_MS)) {
          const file = await repo.getFileById(id);
          if (file && (await seal(file))) sealed++;
        }
        let expired = 0;
        let blobs = 0;
        if (opts.retention) {
          const cutoff = now() - deps.retentionDays * 24 * 60 * 60_000;
          // Usage rows are kept forever (plan, Decision 3); only the transcript goes.
          for (const key of await repo.expiredSessions(cutoff)) {
            for (const k of await repo.purgeSession(key, now())) {
              await archive.delete(k).catch(() => undefined);
            }
            expired++;
          }
          blobs = await repo.gcBlobs();
        }
        return { sealed, expired, blobs };
      }),

    start() {
      const spans = (): void => {
        service.refreshUsageSpans().then(
          (n) => {
            if (n > 50)
              log(`history: usage intervals of ${String(n)} session(s) brought up to date`);
          },
          (e: unknown) =>
            log(`history: usage intervals failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      };
      spans();
      const run = (retention: boolean): void => {
        void service.sweep({ retention }).then(
          (r) => {
            if (r.sealed || r.expired || r.blobs) {
              log(
                `history: sealed ${String(r.sealed)}, expired ${String(r.expired)} session(s), ${String(r.blobs)} blob(s)`,
              );
            }
          },
          (e: unknown) =>
            log(`history: sweep failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      };
      const redo = (): void => {
        service
          .reparse()
          .catch((e: unknown) =>
            log(`history: re-parse failed: ${e instanceof Error ? e.message : String(e)}`),
          );
      };
      // A parser bump takes effect at the first start that carries it.
      redo();
      service
        .backfillAccounts()
        .then((n) => {
          if (n > 0) log(`history: stamped the account on ${String(n)} session(s)`);
        })
        .catch((e: unknown) =>
          log(`history: account backfill failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      const a = setInterval(() => {
        run(false);
        spans();
      }, 60_000);
      const b = setInterval(() => {
        run(true);
        redo();
      }, 60 * 60_000);
      a.unref();
      b.unref();
      timers.push(a, b);
    },

    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
  return service;
}
