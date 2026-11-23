// The history repo on `node:sqlite`, in its own file (`~/.agentbox/hub/history.db`)
// for the same reason devices are: `store.db` already has an owner, and
// transcript volume would bloat it. Imported only by server.ts, dynamically.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { repoKey } from '@agentbox/config';
import type {
  HistorySearchHit,
  HistorySessionFilter,
  HistoryTurnRow,
  HistoryChunkRow,
  HistoryFileRow,
  HistoryRepo,
  HistorySessionRow,
  NewChunk,
  UsageDimension,
  UsageQuery,
  UsageReport,
  UsageTotals,
} from './backend/history';
import type { MemoryRepo, MemoryVersionRow } from './backend/history-memory';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history_sessions (
  key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  box_id TEXT, box_name TEXT, provider TEXT, host_id TEXT, project_repo_url TEXT,
  workspace_id TEXT, manager_id TEXT, user_id TEXT,
  parent_session_id TEXT,
  first_ts TEXT, last_ts TEXT, title TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent, session_id)
);
CREATE INDEX IF NOT EXISTS history_sessions_box ON history_sessions(box_id);
CREATE INDEX IF NOT EXISTS history_sessions_updated ON history_sessions(updated_at);
CREATE TABLE IF NOT EXISTS history_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  session_key TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  parse_state TEXT,
  child INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (origin_key, agent, path)
);
CREATE INDEX IF NOT EXISTS history_files_session ON history_files(session_key);
CREATE TABLE IF NOT EXISTS history_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  archive_key TEXT NOT NULL,
  codec TEXT NOT NULL,
  sealed INTEGER NOT NULL,
  deduped INTEGER NOT NULL,
  ends_nl INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_chunks_file ON history_chunks(file_id, generation, start_offset);
CREATE TABLE IF NOT EXISTS history_blobs (
  sha256 TEXT PRIMARY KEY,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS history_chunk_blobs (
  chunk_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (chunk_id, sha256)
);
CREATE INDEX IF NOT EXISTS history_chunk_blobs_sha ON history_chunk_blobs(sha256);
CREATE TABLE IF NOT EXISTS history_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  name TEXT,
  text TEXT,
  ts TEXT,
  UNIQUE (file_id, at, seq)
);
CREATE INDEX IF NOT EXISTS history_turns_session ON history_turns(session_key);
CREATE TABLE IF NOT EXISTS history_usage (
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  ts TEXT,
  PRIMARY KEY (session_key, message_id)
);
`;

interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { lastInsertRowid: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
}

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toFile(r: Row): HistoryFileRow {
  return {
    id: n(r.id),
    originKey: String(r.origin_key),
    agent: String(r.agent),
    path: String(r.path),
    sessionKey: s(r.session_key),
    generation: n(r.generation),
    offset: n(r.byte_offset),
    sha256: String(r.sha256 ?? ''),
    parseState: r.parse_state
      ? (JSON.parse(String(r.parse_state)) as HistoryFileRow['parseState'])
      : null,
    child: n(r.child) === 1,
    updatedAt: n(r.updated_at),
  };
}

function toSession(r: Row): HistorySessionRow {
  return {
    key: String(r.key),
    agent: String(r.agent),
    sessionId: String(r.session_id),
    boxId: s(r.box_id),
    boxName: s(r.box_name),
    provider: s(r.provider),
    hostId: s(r.host_id),
    projectRepoUrl: s(r.project_repo_url),
    account: s(r.account),
    parentSessionId: s(r.parent_session_id),
    firstTs: s(r.first_ts),
    lastTs: s(r.last_ts),
    title: s(r.title),
    turns: n(r.turns),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    parserVersion: n(r.parser_version),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function toChunk(r: Row): HistoryChunkRow {
  return {
    id: n(r.id),
    fileId: n(r.file_id),
    generation: n(r.generation),
    start: n(r.start_offset),
    end: n(r.end_offset),
    key: String(r.archive_key),
    codec: r.codec === 'gzip' ? 'gzip' : 'zstd',
    sealed: n(r.sealed) === 1,
    deduped: n(r.deduped) === 1,
    endsWithNewline: n(r.ends_nl) === 1,
    storedBytes: n(r.stored_bytes),
  };
}

/** Epoch ms of an ISO timestamp, or null. */
function epochMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function columns(db: Db, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)),
  );
}

/**
 * Phase 7 columns on a store created before it. `ts_ms` is filled from `ts` in
 * SQL (julianday reads the parsers' ISO strings), so no re-parse is needed.
 */
function migrateUsage(db: Db): void {
  const sessions = columns(db, 'history_sessions');
  if (!sessions.has('account')) db.exec('ALTER TABLE history_sessions ADD COLUMN account TEXT');
  if (!sessions.has('purged_at')) {
    db.exec('ALTER TABLE history_sessions ADD COLUMN purged_at INTEGER');
  }
  if (!sessions.has('project_key')) {
    db.exec('ALTER TABLE history_sessions ADD COLUMN project_key TEXT');
  }
  // One repo spelled ssh and https is one project (`repoKey`).
  const setKey = db.prepare(
    'UPDATE history_sessions SET project_key = ? WHERE project_repo_url = ? AND project_key IS NULL',
  );
  for (const r of db
    .prepare(
      'SELECT DISTINCT project_repo_url AS u FROM history_sessions WHERE project_key IS NULL AND project_repo_url IS NOT NULL',
    )
    .all() as Row[]) {
    const key = repoKey(String(r.u));
    if (key) setKey.run(key, String(r.u));
  }
  if (!columns(db, 'history_usage').has('ts_ms')) {
    db.exec('ALTER TABLE history_usage ADD COLUMN ts_ms INTEGER');
    db.exec(
      `UPDATE history_usage SET ts_ms = CAST(ROUND((julianday(ts) - 2440587.5) * 86400000) AS INTEGER)
       WHERE ts IS NOT NULL`,
    );
  }
  db.exec('CREATE INDEX IF NOT EXISTS history_usage_ts ON history_usage(ts_ms)');
}

/** A usage row's time: its own, else its session's last activity, else ingest time. */
const USAGE_TIME = `COALESCE(u.ts_ms,
  CAST(ROUND((julianday(s.last_ts) - 2440587.5) * 86400000) AS INTEGER), s.updated_at)`;

const DIMENSION_SQL: Record<Exclude<UsageDimension, 'day'>, string> = {
  agent: 's.agent',
  account: 's.account',
  box: 's.box_id',
  project: 'COALESCE(s.project_key, s.project_repo_url)',
  host: 's.host_id',
  model: 'u.model',
  session: 's.key',
};

const LABEL_SQL: Partial<Record<UsageDimension, string>> = {
  box: 'MAX(s.box_name)',
  project: 'MAX(s.project_repo_url)',
  session: 'MAX(s.title)',
};

const SUMS = `COALESCE(SUM(u.input_tokens), 0) AS input, COALESCE(SUM(u.output_tokens), 0) AS output,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read, COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write,
  COUNT(*) AS messages, COUNT(DISTINCT u.session_key) AS sessions`;

function totalsOf(r: Row): UsageTotals {
  const t = {
    inputTokens: n(r.input),
    outputTokens: n(r.output),
    cacheReadTokens: n(r.cache_read),
    cacheWriteTokens: n(r.cache_write),
  };
  return {
    ...t,
    totalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
    messages: n(r.messages),
    sessions: n(r.sessions),
  };
}

/** `GET /api/v1/usage`: totals plus groups, over the usage rows joined to their session. */
function usageReport(db: Db, q: UsageQuery): UsageReport {
  const where: string[] = [];
  const args: unknown[] = [];
  const eq = (col: string, v: string | undefined): void => {
    if (v === undefined) return;
    where.push(`${col} = ?`);
    args.push(v);
  };
  eq('s.agent', q.agent);
  eq('s.account', q.account);
  eq('s.host_id', q.host);
  eq('u.model', q.model);
  if (q.box !== undefined) {
    where.push('(s.box_id = ? OR s.box_name = ?)');
    args.push(q.box, q.box);
  }
  if (q.project !== undefined) {
    const like = `%${q.project.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(s.project_repo_url LIKE ? ESCAPE '\\' OR s.project_key LIKE ? ESCAPE '\\' OR s.project_key = ?)",
    );
    args.push(like, like, repoKey(q.project) ?? q.project);
  }
  if (q.sinceMs !== undefined) {
    where.push(`${USAGE_TIME} >= ?`);
    args.push(q.sinceMs);
  }
  if (q.untilMs !== undefined) {
    where.push(`${USAGE_TIME} < ?`);
    args.push(q.untilMs);
  }
  const from = `FROM history_usage u JOIN history_sessions s ON s.key = u.session_key
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const totals = totalsOf(db.prepare(`SELECT ${SUMS} ${from}`).get(...args) as Row);
  if (q.by.length === 0) return { totals, groups: [], truncated: false };

  // The offset is a clamped integer (the service), so it is inlined.
  const offsetMs = Math.trunc(q.tzOffsetMin) * 60_000;
  const exprOf = (d: UsageDimension): string =>
    d === 'day'
      ? `strftime('%Y-%m-%d', (${USAGE_TIME} + ${String(offsetMs)}) / 1000, 'unixepoch')`
      : DIMENSION_SQL[d];
  const keyCols = q.by.map((d, i) => `${exprOf(d)} AS k${String(i)}`);
  const labelCols = q.by.flatMap((d, i) =>
    LABEL_SQL[d] ? [`${LABEL_SQL[d]!} AS l${String(i)}`] : [],
  );
  const groupBy = q.by.map((_, i) => `k${String(i)}`).join(', ');
  // Days read in time order; everything else by size.
  const order = [
    ...q.by.flatMap((d, i) => (d === 'day' ? [`k${String(i)}`] : [])),
    '(input + output + cache_read + cache_write) DESC',
    groupBy,
  ].join(', ');
  const rows = db
    .prepare(
      `SELECT ${[...keyCols, ...labelCols, SUMS].join(', ')} ${from}
       GROUP BY ${groupBy} ORDER BY ${order} LIMIT ?`,
    )
    .all(...args, q.limit + 1) as Row[];
  const groups = rows.slice(0, q.limit).map((r) => {
    const keys: Partial<Record<UsageDimension, string | null>> = {};
    const labels: Partial<Record<UsageDimension, string | null>> = {};
    q.by.forEach((d, i) => {
      keys[d] = s(r[`k${String(i)}`]);
      if (LABEL_SQL[d]) labels[d] = s(r[`l${String(i)}`]);
    });
    return { keys, labels, ...totalsOf(r) };
  });
  return { totals, groups, truncated: rows.length > q.limit };
}

export async function openSqliteHistoryRepo(path: string): Promise<HistoryRepo> {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path) as unknown as Db;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateUsage(db);
  // Full-text over turn text, for Phase 2's search. Optional: a node built
  // without FTS5 still ingests.
  let fts = true;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS history_turns_fts USING fts5(text, content='history_turns', content_rowid='id')`,
    );
  } catch {
    fts = false;
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const insertChunk = db.prepare(
    `INSERT INTO history_chunks (file_id, generation, start_offset, end_offset, archive_key, codec, sealed, deduped, ends_nl, stored_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dropSameStart = db.prepare(
    'DELETE FROM history_chunks WHERE file_id = ? AND generation = ? AND start_offset = ?',
  );
  // Idempotent on (file, generation, start): a frame retried after a failure
  // between this insert and the offset update replaces its earlier row
  // instead of duplicating its bytes.
  const addChunkSync = (c: NewChunk): number => {
    dropSameStart.run(c.fileId, c.generation, c.start);
    return Number(
      insertChunk.run(
        c.fileId,
        c.generation,
        c.start,
        c.end,
        c.key,
        c.codec,
        c.sealed ? 1 : 0,
        c.deduped ? 1 : 0,
        c.endsWithNewline ? 1 : 0,
        c.storedBytes,
      ).lastInsertRowid,
    );
  };

  const deleteTurnsOfFile = (fileId: number, usage = true): void => {
    if (fts) {
      db.prepare(
        `INSERT INTO history_turns_fts(history_turns_fts, rowid, text)
         SELECT 'delete', id, text FROM history_turns WHERE file_id = ? AND text IS NOT NULL`,
      ).run(fileId);
    }
    db.prepare('DELETE FROM history_turns WHERE file_id = ?').run(fileId);
    if (usage) db.prepare('DELETE FROM history_usage WHERE file_id = ?').run(fileId);
  };

  /** Delete a session's files with their chunks and turns (its usage stays). */
  const dropFilesOf = (key: string): string[] => {
    const files = (
      db.prepare('SELECT id FROM history_files WHERE session_key = ?').all(key) as Row[]
    ).map((r) => n(r.id));
    const keys: string[] = [];
    for (const id of files) {
      for (const c of db
        .prepare('SELECT id, archive_key FROM history_chunks WHERE file_id = ?')
        .all(id) as Row[]) {
        keys.push(String(c.archive_key));
        db.prepare('DELETE FROM history_chunk_blobs WHERE chunk_id = ?').run(n(c.id));
      }
      db.prepare('DELETE FROM history_chunks WHERE file_id = ?').run(id);
      deleteTurnsOfFile(id, false);
      db.prepare('DELETE FROM history_files WHERE id = ?').run(id);
    }
    return keys;
  };

  return {
    async getFile(originKey, agent, p) {
      const r = db
        .prepare('SELECT * FROM history_files WHERE origin_key = ? AND agent = ? AND path = ?')
        .get(originKey, agent, p) as Row | undefined;
      return r ? toFile(r) : null;
    },
    async getFileById(id) {
      const r = db.prepare('SELECT * FROM history_files WHERE id = ?').get(id) as Row | undefined;
      return r ? toFile(r) : null;
    },
    async createFile(f) {
      const id = Number(
        db
          .prepare(
            `INSERT INTO history_files (origin_key, agent, path, session_key, generation, byte_offset, sha256, parse_state, child, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            f.originKey,
            f.agent,
            f.path,
            f.sessionKey,
            f.generation,
            f.offset,
            f.sha256,
            f.parseState ? JSON.stringify(f.parseState) : null,
            f.child ? 1 : 0,
            f.updatedAt,
          ).lastInsertRowid,
      );
      return { ...f, id };
    },
    async updateFile(id, patch) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const col = (c: string, v: unknown): void => {
        sets.push(`${c} = ?`);
        vals.push(v);
      };
      if (patch.generation !== undefined) col('generation', patch.generation);
      if (patch.offset !== undefined) col('byte_offset', patch.offset);
      if (patch.sha256 !== undefined) col('sha256', patch.sha256);
      if (patch.parseState !== undefined) {
        col('parse_state', patch.parseState ? JSON.stringify(patch.parseState) : null);
      }
      if (patch.updatedAt !== undefined) col('updated_at', patch.updatedAt);
      if (sets.length === 0) return;
      db.prepare(`UPDATE history_files SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    },
    async clearFileRecords(fileId) {
      tx(() => deleteTurnsOfFile(fileId));
    },
    async getSession(key) {
      const r = db.prepare('SELECT * FROM history_sessions WHERE key = ?').get(key) as
        | Row
        | undefined;
      return r ? toSession(r) : null;
    },
    async upsertSession(x) {
      db.prepare(
        `INSERT INTO history_sessions (key, agent, session_id, box_id, box_name, provider, host_id, project_repo_url,
           project_key, account, parent_session_id, first_ts, last_ts, title, turns, input_tokens, output_tokens,
           parser_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET box_id = excluded.box_id, box_name = excluded.box_name,
           provider = excluded.provider, host_id = excluded.host_id, project_repo_url = excluded.project_repo_url,
           project_key = excluded.project_key, account = COALESCE(history_sessions.account, excluded.account),
           parent_session_id = excluded.parent_session_id, parser_version = excluded.parser_version,
           purged_at = NULL, updated_at = excluded.updated_at`,
      ).run(
        x.key,
        x.agent,
        x.sessionId,
        x.boxId,
        x.boxName,
        x.provider,
        x.hostId,
        x.projectRepoUrl,
        x.projectRepoUrl ? (repoKey(x.projectRepoUrl) ?? null) : null,
        x.account,
        x.parentSessionId,
        x.firstTs,
        x.lastTs,
        x.title,
        x.turns,
        x.inputTokens,
        x.outputTokens,
        x.parserVersion,
        x.createdAt,
        x.updatedAt,
      );
    },
    async listSessions() {
      return (
        db.prepare('SELECT * FROM history_sessions ORDER BY updated_at DESC').all() as Row[]
      ).map(toSession);
    },
    async addChunk(c) {
      return addChunkSync(c);
    },
    async listChunks(fileId, generation) {
      return (
        db
          .prepare(
            'SELECT * FROM history_chunks WHERE file_id = ? AND generation = ? ORDER BY start_offset',
          )
          .all(fileId, generation) as Row[]
      ).map(toChunk);
    },
    async replaceChunks(removeIds, sealed, blobShas) {
      tx(() => {
        const del = db.prepare('DELETE FROM history_chunks WHERE id = ?');
        const delRefs = db.prepare('DELETE FROM history_chunk_blobs WHERE chunk_id = ?');
        for (const id of removeIds) {
          del.run(id);
          delRefs.run(id);
        }
        const id = addChunkSync(sealed);
        const ref = db.prepare(
          'INSERT OR IGNORE INTO history_chunk_blobs (chunk_id, sha256) VALUES (?, ?)',
        );
        for (const sha of blobShas) ref.run(id, sha);
      });
    },
    async putBlob(sha, bytes) {
      db.prepare('INSERT OR IGNORE INTO history_blobs (sha256, bytes) VALUES (?, ?)').run(
        sha,
        bytes,
      );
    },
    async getBlob(sha) {
      const r = db.prepare('SELECT bytes FROM history_blobs WHERE sha256 = ?').get(sha) as
        | Row
        | undefined;
      return r ? Buffer.from(r.bytes as Uint8Array) : null;
    },
    async insertRecords(sessionKey, fileId, records) {
      tx(() => {
        const turn = db.prepare(
          `INSERT OR IGNORE INTO history_turns (session_key, file_id, at, seq, kind, role, name, text, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const ftsIns = fts
          ? db.prepare('INSERT INTO history_turns_fts (rowid, text) VALUES (?, ?)')
          : null;
        const usage = db.prepare(
          `INSERT OR IGNORE INTO history_usage (session_key, message_id, file_id, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, ts, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const meta = db.prepare('UPDATE history_sessions SET title = ? WHERE key = ?');
        const seqAt = new Map<number, number>();
        for (const r of records) {
          if (r.kind === 'usage') {
            usage.run(
              sessionKey,
              r.messageId,
              fileId,
              r.model ?? null,
              r.inputTokens,
              r.outputTokens,
              r.cacheReadTokens,
              r.cacheWriteTokens,
              r.ts ?? null,
              epochMs(r.ts),
            );
            continue;
          }
          if (r.kind === 'meta') {
            if (r.title) meta.run(r.title, sessionKey);
            continue;
          }
          const seq = seqAt.get(r.at) ?? 0;
          seqAt.set(r.at, seq + 1);
          const res = turn.run(
            sessionKey,
            fileId,
            r.at,
            seq,
            r.kind,
            r.kind === 'turn' ? r.role : null,
            r.kind === 'tool' ? r.name : null,
            r.kind === 'turn' ? r.text : null,
            r.ts ?? null,
          ) as { changes?: number | bigint; lastInsertRowid: number | bigint };
          if (ftsIns && r.kind === 'turn' && Number(res.changes ?? 0) > 0) {
            ftsIns.run(Number(res.lastInsertRowid), r.text);
          }
        }
      });
    },
    async refreshSessionTotals(key, nowMs) {
      db.prepare(
        `UPDATE history_sessions SET
           turns = (SELECT COUNT(*) FROM history_turns WHERE session_key = ?1 AND kind = 'turn'),
           input_tokens = COALESCE((SELECT SUM(input_tokens) FROM history_usage WHERE session_key = ?1), 0),
           output_tokens = COALESCE((SELECT SUM(output_tokens) FROM history_usage WHERE session_key = ?1), 0),
           first_ts = COALESCE((SELECT MIN(ts) FROM history_turns WHERE session_key = ?1), first_ts),
           last_ts = COALESCE((SELECT MAX(ts) FROM history_turns WHERE session_key = ?1), last_ts),
           title = COALESCE(title, (SELECT substr(text, 1, 120) FROM history_turns
             WHERE session_key = ?1 AND kind = 'turn' AND role = 'user' ORDER BY file_id, at LIMIT 1)),
           updated_at = ?2
         WHERE key = ?1`,
      ).run(key, nowMs);
    },
    async idleUnsealedFiles(beforeMs) {
      return (
        db
          .prepare(
            `SELECT DISTINCT f.id FROM history_files f JOIN history_chunks c
               ON c.file_id = f.id AND c.generation = f.generation AND c.sealed = 0
             WHERE f.updated_at < ?`,
          )
          .all(beforeMs) as Row[]
      ).map((r) => n(r.id));
    },
    async expiredSessions(beforeMs) {
      return (
        db
          .prepare('SELECT key FROM history_sessions WHERE updated_at < ? AND purged_at IS NULL')
          .all(beforeMs) as Row[]
      ).map((r) => String(r.key));
    },
    async purgeSession(key, nowMs) {
      return tx(() => {
        const keys = dropFilesOf(key);
        db.prepare('DELETE FROM history_turns WHERE session_key = ?').run(key);
        db.prepare('UPDATE history_sessions SET purged_at = ? WHERE key = ?').run(nowMs, key);
        return keys;
      });
    },
    async sessionsWithoutAccount(limit) {
      return (
        db
          .prepare(
            'SELECT key, box_id, agent FROM history_sessions WHERE account IS NULL AND box_id IS NOT NULL ORDER BY key LIMIT ?',
          )
          .all(limit) as Row[]
      ).map((r) => ({ key: String(r.key), boxId: String(r.box_id), agent: String(r.agent) }));
    },
    async setSessionAccount(key, account) {
      db.prepare('UPDATE history_sessions SET account = ? WHERE key = ? AND account IS NULL').run(
        account,
        key,
      );
    },
    async usage(q) {
      return usageReport(db, q);
    },
    async deleteSession(key) {
      return tx(() => {
        const keys = dropFilesOf(key);
        db.prepare('DELETE FROM history_turns WHERE session_key = ?').run(key);
        db.prepare('DELETE FROM history_usage WHERE session_key = ?').run(key);
        db.prepare('DELETE FROM history_sessions WHERE key = ?').run(key);
        return keys;
      });
    },
    async staleParserSessions(agent, version, limit) {
      return (
        db
          .prepare(
            'SELECT key FROM history_sessions WHERE agent = ? AND parser_version < ? AND purged_at IS NULL ORDER BY updated_at DESC LIMIT ?',
          )
          .all(agent, version, limit) as Row[]
      ).map((r) => String(r.key));
    },
    async clearSessionTitle(key) {
      db.prepare('UPDATE history_sessions SET title = NULL WHERE key = ?').run(key);
    },
    async setSessionParserVersion(key, version) {
      db.prepare('UPDATE history_sessions SET parser_version = ? WHERE key = ?').run(version, key);
    },
    async gcBlobs() {
      const r = db
        .prepare(
          'DELETE FROM history_blobs WHERE sha256 NOT IN (SELECT DISTINCT sha256 FROM history_chunk_blobs)',
        )
        .run() as { changes?: number | bigint };
      return Number(r.changes ?? 0);
    },

    async querySessions(f: HistorySessionFilter) {
      const where: string[] = ['purged_at IS NULL'];
      const args: unknown[] = [];
      if (f.agent) {
        where.push('agent = ?');
        args.push(f.agent);
      }
      if (f.box) {
        where.push('(box_id = ? OR box_name = ?)');
        args.push(f.box, f.box);
      }
      if (f.project) {
        where.push("project_repo_url LIKE ? ESCAPE '\\'");
        args.push(`%${f.project.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      if (f.host) {
        where.push('host_id = ?');
        args.push(f.host);
      }
      if (f.sinceMs !== undefined) {
        // Activity is the transcript's own last timestamp; ingest time only
        // stands in for a session whose records carry none.
        where.push('(last_ts >= ? OR (last_ts IS NULL AND updated_at >= ?))');
        args.push(new Date(f.sinceMs).toISOString(), f.sinceMs);
      }
      if (f.q) {
        if (fts) {
          where.push(
            `key IN (SELECT DISTINCT t.session_key FROM history_turns t
               JOIN history_turns_fts x ON x.rowid = t.id WHERE history_turns_fts MATCH ?)`,
          );
          args.push(f.q);
        } else {
          where.push(`key IN (SELECT DISTINCT session_key FROM history_turns WHERE text LIKE ?)`);
          args.push(`%${f.q.replace(/"/g, '')}%`);
        }
      }
      const sql = `SELECT * FROM history_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(last_ts, '') DESC, updated_at DESC LIMIT ?`;
      return (db.prepare(sql).all(...args, f.limit ?? 50) as Row[]).map(toSession);
    },

    async matchSessionKeys(ref) {
      if (!ref) return [];
      const exact = db
        .prepare(
          'SELECT key FROM history_sessions WHERE (key = ? OR session_id = ?) AND purged_at IS NULL',
        )
        .all(ref, ref) as Row[];
      if (exact.length > 0) return exact.map((r) => String(r.key));
      if (ref.length < 8) return [];
      // opencode ids carry `_` (`ses_…`): escape LIKE's wildcards instead of
      // refusing them.
      const pattern = `${ref.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return (
        db
          .prepare(
            "SELECT key FROM history_sessions WHERE session_id LIKE ? ESCAPE '\\' AND purged_at IS NULL ORDER BY updated_at DESC LIMIT 11",
          )
          .all(pattern) as Row[]
      ).map((r) => String(r.key));
    },

    async filesOfSession(key) {
      return (
        db
          .prepare('SELECT * FROM history_files WHERE session_key = ? ORDER BY child, id')
          .all(key) as Row[]
      ).map(toFile);
    },

    async countTurns(key) {
      const r = db
        .prepare('SELECT COUNT(*) AS n FROM history_turns WHERE session_key = ?')
        .get(key) as Row;
      return n(r.n);
    },

    async turns(key, from, limit) {
      // Session order: by timestamp where the agent wrote one, then by file and
      // position, so a subagent's turns interleave with the parent's.
      const rows = db
        .prepare(
          // A row without a timestamp takes the last one before it in its own
          // file (ISO strings order correctly under MAX), so it stays where it
          // was written instead of sorting ahead of everything.
          `SELECT * FROM (
             SELECT t.kind, t.role, t.name, t.text, t.ts, t.at, t.seq, t.file_id, f.path,
               MAX(t.ts) OVER (PARTITION BY t.file_id ORDER BY t.at, t.seq
                               ROWS UNBOUNDED PRECEDING) AS order_ts
             FROM history_turns t JOIN history_files f ON f.id = t.file_id
             WHERE t.session_key = ?)
           ORDER BY COALESCE(order_ts, ''), file_id, at, seq LIMIT ? OFFSET ?`,
        )
        .all(key, limit, from) as Row[];
      return rows.map(
        (r, i): HistoryTurnRow => ({
          index: from + i,
          kind: r.kind === 'tool' ? 'tool' : 'turn',
          role: r.role === 'user' || r.role === 'assistant' ? r.role : null,
          name: s(r.name),
          text: s(r.text),
          ts: s(r.ts),
          path: String(r.path),
          at: n(r.at),
        }),
      );
    },

    async toolCounts(key) {
      return (
        db
          .prepare(
            `SELECT name, COUNT(*) AS c FROM history_turns WHERE session_key = ? AND kind = 'tool'
             GROUP BY name ORDER BY c DESC, name`,
          )
          .all(key) as Row[]
      ).map((r) => ({ name: String(r.name), count: n(r.c) }));
    },

    async search(q, limit) {
      const rows = fts
        ? (db
            .prepare(
              `SELECT t.session_key, t.role, t.ts,
                 snippet(history_turns_fts, 0, '[', ']', '…', 16) AS snip
               FROM history_turns_fts x JOIN history_turns t ON t.id = x.rowid
               WHERE history_turns_fts MATCH ? ORDER BY rank LIMIT ?`,
            )
            .all(q, limit) as Row[])
        : (db
            .prepare(
              `SELECT session_key, role, ts, substr(text, 1, 200) AS snip FROM history_turns
               WHERE text LIKE ? LIMIT ?`,
            )
            .all(`%${q.replace(/"/g, '')}%`, limit) as Row[]);
      return rows.map(
        (r): HistorySearchHit => ({
          sessionKey: String(r.session_key),
          role: r.role === 'user' || r.role === 'assistant' ? r.role : null,
          ts: s(r.ts),
          snippet: String(r.snip ?? ''),
        }),
      );
    },
  };
}

const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS history_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  box_id TEXT, box_name TEXT, provider TEXT, host_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_key, agent, scope, path, version)
);
`;

function toMemory(r: Row): MemoryVersionRow {
  return {
    id: n(r.id),
    repoKey: String(r.repo_key),
    agent: String(r.agent),
    scope: r.scope === 'global' ? 'global' : 'project',
    path: String(r.path),
    version: n(r.version),
    sha256: String(r.sha256),
    size: n(r.size),
    deleted: n(r.deleted) === 1,
    boxId: s(r.box_id),
    boxName: s(r.box_name),
    provider: s(r.provider),
    hostId: s(r.host_id),
    createdAt: n(r.created_at),
  };
}

const MEMORY_COLS =
  'id, repo_key, agent, scope, path, version, sha256, size, deleted, box_id, box_name, provider, host_id, created_at';

/** Memory versions in `history.db`, on their own connection (WAL). */
export async function openSqliteMemoryRepo(path: string): Promise<MemoryRepo> {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path) as unknown as Db;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(MEMORY_SCHEMA);
  return {
    async latest(k) {
      return (
        db
          .prepare(
            `SELECT ${MEMORY_COLS} FROM history_memory m
             WHERE repo_key = ? AND agent = ? AND scope = ?
               AND version = (SELECT MAX(version) FROM history_memory x
                 WHERE x.repo_key = m.repo_key AND x.agent = m.agent AND x.scope = m.scope AND x.path = m.path)
             ORDER BY path`,
          )
          .all(k.repoKey, k.agent, k.scope) as Row[]
      ).map(toMemory);
    },
    async versions(k, p) {
      return (
        db
          .prepare(
            `SELECT ${MEMORY_COLS} FROM history_memory
             WHERE repo_key = ? AND agent = ? AND scope = ? AND path = ? ORDER BY version`,
          )
          .all(k.repoKey, k.agent, k.scope, p) as Row[]
      ).map(toMemory);
    },
    async content(id) {
      const r = db.prepare('SELECT content FROM history_memory WHERE id = ?').get(id) as
        | Row
        | undefined;
      return r?.content ? Buffer.from(r.content as Uint8Array) : null;
    },
    async insert(row, content) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const max = db
          .prepare(
            'SELECT MAX(version) AS v FROM history_memory WHERE repo_key = ? AND agent = ? AND scope = ? AND path = ?',
          )
          .get(row.repoKey, row.agent, row.scope, row.path) as Row | undefined;
        const version = n(max?.v) + 1;
        const r = db
          .prepare(
            `INSERT INTO history_memory (repo_key, agent, scope, path, version, sha256, size, deleted, content,
               box_id, box_name, provider, host_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.repoKey,
            row.agent,
            row.scope,
            row.path,
            version,
            row.sha256,
            row.size,
            row.deleted ? 1 : 0,
            content,
            row.boxId,
            row.boxName,
            row.provider,
            row.hostId,
            row.createdAt,
          );
        db.exec('COMMIT');
        return { ...row, id: Number(r.lastInsertRowid), version };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async sets() {
      return (
        db
          .prepare(
            `SELECT repo_key, agent, scope, COUNT(*) AS versions, MAX(created_at) AS updated,
               (SELECT COUNT(*) FROM history_memory l
                 WHERE l.repo_key = m.repo_key AND l.agent = m.agent AND l.scope = m.scope AND l.deleted = 0
                   AND l.version = (SELECT MAX(version) FROM history_memory x
                     WHERE x.repo_key = l.repo_key AND x.agent = l.agent AND x.scope = l.scope AND x.path = l.path)
               ) AS files
             FROM history_memory m GROUP BY repo_key, agent, scope ORDER BY updated DESC`,
          )
          .all() as Row[]
      ).map((r) => ({
        repoKey: String(r.repo_key),
        agent: String(r.agent),
        scope: r.scope === 'global' ? ('global' as const) : ('project' as const),
        files: n(r.files),
        versions: n(r.versions),
        updatedAt: n(r.updated),
      }));
    },
  };
}
