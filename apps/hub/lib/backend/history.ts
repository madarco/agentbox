// Session history (docs/agent-history-plan.md, Phase 1): ingest of raw transcript
// frames from the edges (relay docker shipper in-process, `POST
// /api/v1/history/chunks`), the raw archive, the normalized projection, sealing
// small frames into big compressed chunks, and the retention sweep.
//
// Two seams keep the storage swappable: `HistoryRepo` (rows: sqlite here, the
// control box's postgres later) and `HistoryArchive` (chunk bytes: a directory
// here, object storage later). This file holds no SQL and no paths.
import { zstdCompressSync, zstdDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import {
  agentHistoryModule,
  agentHistoryModules,
  extractLargeStrings,
  restoreLargeStrings,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryIngestSink,
  type AgentHistoryModule,
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
   * The box's named LLM account for this agent when the session was first
   * seen (`default` when the box names none); null when the box was unknown.
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
  usage(q: UsageQuery): Promise<UsageReport>;
  /** Delete blobs no chunk references; returns how many. */
  gcBlobs(): Promise<number>;
  /** Keys of `agent`'s sessions projected by a parser older than `version`. */
  staleParserSessions(agent: string, version: number, limit: number): Promise<string[]>;
  /** Forget a session's title (a re-parse derives it again). */
  clearSessionTitle(key: string): Promise<void>;
  setSessionParserVersion(key: string, version: number): Promise<void>;

  // ---- reads (Phase 2) ----
  querySessions(filter: HistorySessionFilter): Promise<HistorySessionRow[]>;
  /** Keys matching a reference: the exact key, an exact session id, or an id prefix. */
  matchSessionKeys(ref: string): Promise<string[]>;
  filesOfSession(key: string): Promise<HistoryFileRow[]>;
  countTurns(key: string): Promise<number>;
  /** Turn/tool rows in session order, `limit` from `from`. */
  turns(key: string, from: number, limit: number): Promise<HistoryTurnRow[]>;
  toolCounts(key: string): Promise<Array<{ name: string; count: number }>>;
  /** FTS hits for an already-quoted query (see `ftsQuery`). */
  search(fts: string, limit: number): Promise<HistorySearchHit[]>;
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
   * The named LLM account `agent` runs on in box `boxId` (`default` when the
   * box names none), or null when the box is unknown here.
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
  /** The same bytes, chunk by chunk, for a streamed download. */
  /** The same bytes, chunk by chunk, up to `endOffset` (default: what is ingested now). */
  rawStream(fileId: number, endOffset?: number): AsyncGenerator<Buffer>;
  listSessions(filter: HistorySessionFilter): Promise<HistorySessionRow[]>;
  resolveSession(ref: string): Promise<ResolvedSession>;
  sessionDetail(key: string): Promise<HistorySessionDetail | null>;
  sessionTurns(key: string, from: number, limit: number): Promise<HistoryTurnRow[]>;
  /** The file to download: `path` when it belongs to the session, else its main file. */
  sessionFile(key: string, path?: string): Promise<HistoryFileRow | null>;
  search(q: string, limit: number): Promise<HistorySearchHit[]>;
  /** Token usage, grouped and filtered (limits clamped here). */
  usage(q: UsageQuery): Promise<UsageReport>;
  /** Stamp the account on sessions stored without one whose box is still known. */
  backfillAccounts(): Promise<number>;
  /**
   * Re-derive the projection of every session whose parser is older than its
   * agent module's, from the raw archive. Returns how many sessions it redid.
   */
  reparse(): Promise<number>;
  /** Seal idle files and apply retention. */
  sweep(opts?: {
    retention?: boolean;
  }): Promise<{ sealed: number; expired: number; blobs: number }>;
  start(): void;
  stop(): void;
  repo: HistoryRepo;
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const { repo, archive } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  // One writer: frames for one file must apply in order, and sqlite is
  // single-writer anyway.
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
        await repo.refreshSessionTotals(file.sessionKey, now());
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
    for (const f of files) await repo.clearFileRecords(f.id);
    await repo.clearSessionTitle(key);
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

    async readRaw(fileId) {
      const parts: Buffer[] = [];
      for await (const b of service.rawStream(fileId)) parts.push(b);
      return Buffer.concat(parts);
    },

    async *rawStream(fileId, endOffset) {
      const file = await repo.getFileById(fileId);
      if (!file) throw new Error(`history file ${String(fileId)} not found`);
      // A fixed end: a file still being appended to would otherwise stream
      // past the length the caller announced (content-length).
      const end = Math.min(endOffset ?? file.offset, file.offset);
      let chunks = await repo.listChunks(fileId, file.generation);
      let pos = 0;
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

    async search(q, limit) {
      const fts = ftsQuery(q);
      if (!fts) return [];
      return repo.search(fts, Math.min(Math.max(limit, 1), 200));
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
        if (done > 0) log(`history: re-parsed ${String(done)} session(s)`);
        return done;
      })();
      return reparsing;
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
      const a = setInterval(() => run(false), 60_000);
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
