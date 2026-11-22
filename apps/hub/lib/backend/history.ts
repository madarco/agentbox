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
  extractLargeStrings,
  restoreLargeStrings,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryIngestSink,
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
  /** Delete blobs no chunk references; returns how many. */
  gcBlobs(): Promise<number>;
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
  now?: () => number;
  log?: (line: string) => void;
}

export interface HistoryService extends HistoryIngestSink {
  /** Reassemble a file's current generation byte for byte (Phase 2's `/raw`). */
  readRaw(fileId: number): Promise<Buffer>;
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

  const mismatch = (file: HistoryFileRow | null, message: string): HistoryIngestResult => ({
    ok: false,
    code: 'offset_mismatch',
    message,
    offset: file?.offset ?? 0,
    sha256: file?.sha256 ?? '',
  });

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
    const boxId = frame.origin?.boxId ?? '';
    if (!boxId || !frame.agent || !frame.path) {
      return { ok: false, code: 'invalid', message: 'frame needs origin.boxId, agent and path' };
    }
    const data = Buffer.from(frame.data, 'base64');
    if (data.length === 0 || data.length > MAX_FRAME_BYTES) {
      return { ok: false, code: 'invalid', message: 'frame data is empty or too large' };
    }
    const originKey = `box:${boxId}`;
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
        await repo.upsertSession({
          key: sessionKey,
          agent: frame.agent,
          sessionId: id.sessionId,
          boxId: existing?.boxId ?? o.boxId,
          boxName: existing?.boxName ?? o.boxName ?? null,
          provider: existing?.provider ?? o.provider ?? null,
          hostId: existing?.hostId ?? o.hostId ?? null,
          projectRepoUrl: existing?.projectRepoUrl ?? o.projectRepoUrl ?? null,
          parentSessionId: existing?.parentSessionId ?? id.parentSessionId ?? null,
          firstTs: existing?.firstTs ?? null,
          lastTs: existing?.lastTs ?? null,
          title: existing?.title ?? null,
          turns: existing?.turns ?? 0,
          inputTokens: existing?.inputTokens ?? 0,
          outputTokens: existing?.outputTokens ?? 0,
          parserVersion: mod?.parserVersion ?? 0,
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
      const file = await repo.getFileById(fileId);
      if (!file) throw new Error(`history file ${String(fileId)} not found`);
      const chunks = await repo.listChunks(fileId, file.generation);
      const parts: Buffer[] = [];
      for (const c of chunks) {
        const bytes = decompress(c.codec, await archive.get(c.key));
        if (!c.deduped) {
          parts.push(bytes);
          continue;
        }
        const blobs = new Map<string, Buffer>();
        for (const m of bytes.toString('latin1').matchAll(/@@agentbox-blob:([0-9a-f]{64})@@/g)) {
          const sha = m[1]!;
          if (!blobs.has(sha)) {
            const b = await repo.getBlob(sha);
            if (b) blobs.set(sha, b);
          }
        }
        parts.push(restoreLargeStrings(bytes, (sha) => blobs.get(sha)));
      }
      return Buffer.concat(parts);
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
          for (const key of await repo.expiredSessions(cutoff)) {
            for (const k of await repo.deleteSession(key)) {
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
      const a = setInterval(() => run(false), 60_000);
      const b = setInterval(() => run(true), 60 * 60_000);
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
