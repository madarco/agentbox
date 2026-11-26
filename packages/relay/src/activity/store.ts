// The ledger's two dialects: sqlite (`~/.agentbox/hub/activity.db`, the laptop
// and the control box) and postgres (a hub with POSTGRES_URL). One column list
// and one row mapping serve both, so they cannot drift. Plain SQL rather than
// drizzle: one table, three statements, and the backfill wants a hand-built
// multi-row insert either way.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import type { Pool } from 'pg';
import {
  ACTIVITY_QUERY_MAX,
  isActivityType,
  type ActivityEvent,
  type ActivityQuery,
  type ActivityStore,
} from './types.js';

/** Its own file, as history.db is: store.db is the relay's, and in memory on a laptop. */
export const DEFAULT_ACTIVITY_DB_PATH = join(STATE_DIR, 'hub', 'activity.db');

const COLUMNS = [
  'id',
  'type',
  'at',
  'actor',
  'box_id',
  'box_name',
  'provider',
  'agent',
  'account',
  'repo_url',
  'project_key',
  'workspace_id',
  'manager_id',
  'job_id',
  'branch',
  'commits',
  'files_changed',
  'additions',
  'deletions',
  'host_only',
  'pr_repo',
  'pr_number',
  'pr_url',
  'source',
] as const;

function schemaSql(dialect: 'sqlite' | 'postgres'): string {
  const ms = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  at ${ms} NOT NULL,
  actor TEXT,
  box_id TEXT, box_name TEXT, provider TEXT, agent TEXT, account TEXT,
  repo_url TEXT, project_key TEXT, workspace_id TEXT, manager_id TEXT, job_id TEXT,
  branch TEXT,
  commits INTEGER, files_changed INTEGER, additions INTEGER, deletions INTEGER,
  host_only INTEGER,
  pr_repo TEXT, pr_number INTEGER, pr_url TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_events_at ON activity_events(at);
CREATE INDEX IF NOT EXISTS activity_events_box ON activity_events(box_id, at);
CREATE INDEX IF NOT EXISTS activity_events_type ON activity_events(type, at);
CREATE TABLE IF NOT EXISTS activity_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;
}

type Cell = string | number | null;

function toRow(ev: ActivityEvent): Cell[] {
  const v = <T>(x: T | undefined): T | null => (x === undefined ? null : x);
  return [
    ev.id,
    ev.type,
    Date.parse(ev.at),
    v(ev.actor),
    v(ev.boxId),
    v(ev.boxName),
    v(ev.provider),
    v(ev.agent),
    v(ev.account),
    v(ev.repoUrl),
    v(ev.projectKey),
    v(ev.workspaceId),
    v(ev.managerId),
    v(ev.jobId),
    v(ev.branch),
    v(ev.commits),
    v(ev.filesChanged),
    v(ev.additions),
    v(ev.deletions),
    ev.hostOnly === undefined ? null : ev.hostOnly ? 1 : 0,
    v(ev.pr?.repo),
    v(ev.pr?.number),
    v(ev.pr?.url),
    ev.source,
  ];
}

function fromRow(r: Record<string, unknown>): ActivityEvent | null {
  const type = String(r.type);
  if (!isActivityType(type)) return null;
  const str = (k: string): string | undefined =>
    r[k] === null || r[k] === undefined ? undefined : String(r[k]);
  // pg answers BIGINT as a string.
  const num = (k: string): number | undefined =>
    r[k] === null || r[k] === undefined ? undefined : Number(r[k]);
  const out: ActivityEvent = {
    id: String(r.id),
    type,
    at: new Date(Number(r.at)).toISOString(),
    source: r.source === 'backfill' ? 'backfill' : 'live',
  };
  const set = <K extends keyof ActivityEvent>(k: K, val: ActivityEvent[K] | undefined): void => {
    if (val !== undefined) out[k] = val;
  };
  set('actor', str('actor') as ActivityEvent['actor']);
  set('boxId', str('box_id'));
  set('boxName', str('box_name'));
  set('provider', str('provider'));
  set('agent', str('agent'));
  set('account', str('account'));
  set('repoUrl', str('repo_url'));
  set('projectKey', str('project_key'));
  set('workspaceId', str('workspace_id'));
  set('managerId', str('manager_id'));
  set('jobId', str('job_id'));
  set('branch', str('branch'));
  set('commits', num('commits'));
  set('filesChanged', num('files_changed'));
  set('additions', num('additions'));
  set('deletions', num('deletions'));
  const hostOnly = num('host_only');
  if (hostOnly !== undefined) out.hostOnly = hostOnly === 1;
  const prRepo = str('pr_repo');
  const prNumber = num('pr_number');
  if (prRepo && prNumber !== undefined) {
    const url = str('pr_url');
    out.pr = { repo: prRepo, number: prNumber, ...(url ? { url } : {}) };
  }
  return out;
}

/** The WHERE clause and its params, with the dialect's placeholder. */
function whereOf(q: ActivityQuery, ph: (i: number) => string): { sql: string; params: Cell[] } {
  const parts: string[] = [];
  const params: Cell[] = [];
  const add = (clause: (p: string) => string, value: Cell): void => {
    params.push(value);
    parts.push(clause(ph(params.length)));
  };
  if (q.sinceMs !== undefined) add((p) => `at >= ${p}`, q.sinceMs);
  if (q.untilMs !== undefined) add((p) => `at < ${p}`, q.untilMs);
  if (q.boxId) add((p) => `box_id = ${p}`, q.boxId);
  if (q.types?.length) {
    const marks = q.types.map((t) => {
      params.push(t);
      return ph(params.length);
    });
    parts.push(`type IN (${marks.join(', ')})`);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function limitOf(q: ActivityQuery): number {
  const n = q.limit ?? 1000;
  return Math.max(1, Math.min(ACTIVITY_QUERY_MAX, Math.floor(n)));
}

const CREATED_AT = 'created_at';

// ── sqlite ──

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Cell[]): { changes: number | bigint };
    all(...params: Cell[]): unknown[];
    get(...params: Cell[]): unknown;
  };
  close(): void;
}

/** Same reason as the relay's SqliteStore: vite strips `node:` off a prefix-only builtin. */
function loadNodeSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  return require('node:sqlite') as typeof import('node:sqlite');
}

export class SqliteActivityStore implements ActivityStore {
  readonly kind = 'sqlite' as const;
  private db: SqliteDatabase | null = null;

  constructor(private readonly path: string = DEFAULT_ACTIVITY_DB_PATH) {}

  private open(): SqliteDatabase {
    if (this.db) return this.db;
    const { DatabaseSync } = loadNodeSqlite();
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path) as unknown as SqliteDatabase;
    // The hub and a queue worker process both write this file.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(schemaSql('sqlite'));
    db.prepare('INSERT OR IGNORE INTO activity_meta (key, value) VALUES (?, ?)').run(
      CREATED_AT,
      String(Date.now()),
    );
    this.db = db;
    return db;
  }

  migrate(): Promise<void> {
    this.open();
    return Promise.resolve();
  }

  append(events: readonly ActivityEvent[]): Promise<number> {
    if (events.length === 0) return Promise.resolve(0);
    const db = this.open();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO activity_events (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    );
    let inserted = 0;
    db.exec('BEGIN');
    try {
      for (const ev of events) inserted += Number(stmt.run(...toRow(ev)).changes);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve(inserted);
  }

  list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const db = this.open();
    const { sql, params } = whereOf(query, () => '?');
    const rows = db
      .prepare(`SELECT * FROM activity_events ${sql} ORDER BY at ASC, id ASC LIMIT ?`)
      .all(...params, limitOf(query)) as Record<string, unknown>[];
    return Promise.resolve(rows.map(fromRow).filter((e): e is ActivityEvent => e !== null));
  }

  getMeta(key: string): Promise<string | undefined> {
    const row = this.open().prepare('SELECT value FROM activity_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return Promise.resolve(row?.value);
  }

  setMeta(key: string, value: string): Promise<void> {
    this.open()
      .prepare(
        'INSERT INTO activity_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db?.close();
    this.db = null;
    return Promise.resolve();
  }
}

// ── postgres ──

/** Rows per INSERT: 24 columns, well under pg's 65 535-parameter cap. */
const PG_INSERT_CHUNK = 500;

export class PostgresActivityStore implements ActivityStore {
  readonly kind = 'postgres' as const;
  private poolPromise: Promise<Pool> | null = null;
  private migrated: Promise<void> | null = null;

  constructor(private readonly opts: { connectionString?: string; pool?: Pool }) {}

  private pool(): Promise<Pool> {
    if (this.opts.pool) return Promise.resolve(this.opts.pool);
    this.poolPromise ??= import('pg').then(
      ({ default: pg }) => new pg.Pool({ connectionString: this.opts.connectionString }),
    );
    return this.poolPromise;
  }

  private ready(): Promise<Pool> {
    this.migrated ??= (async () => {
      const pool = await this.pool();
      await pool.query(schemaSql('postgres'));
      await pool.query(
        'INSERT INTO activity_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [CREATED_AT, String(Date.now())],
      );
    })();
    return this.migrated.then(() => this.pool());
  }

  async migrate(): Promise<void> {
    await this.ready();
  }

  async append(events: readonly ActivityEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const pool = await this.ready();
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < events.length; i += PG_INSERT_CHUNK) {
        const chunk = events.slice(i, i + PG_INSERT_CHUNK);
        const params: Cell[] = [];
        const tuples = chunk.map((ev) => {
          const row = toRow(ev);
          const marks = row.map((cell) => {
            params.push(cell);
            return `$${String(params.length)}`;
          });
          return `(${marks.join(', ')})`;
        });
        const r = await client.query(
          `INSERT INTO activity_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO NOTHING`,
          params,
        );
        inserted += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return inserted;
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEvent[]> {
    const pool = await this.ready();
    const { sql, params } = whereOf(query, (i) => `$${String(i)}`);
    const r = await pool.query(
      `SELECT * FROM activity_events ${sql} ORDER BY at ASC, id ASC LIMIT $${String(params.length + 1)}`,
      [...params, limitOf(query)],
    );
    return (r.rows as Record<string, unknown>[])
      .map(fromRow)
      .filter((e): e is ActivityEvent => e !== null);
  }

  async getMeta(key: string): Promise<string | undefined> {
    const pool = await this.ready();
    const r = await pool.query('SELECT value FROM activity_meta WHERE key = $1', [key]);
    const row = r.rows[0] as { value?: string } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      'INSERT INTO activity_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value],
    );
  }

  async close(): Promise<void> {
    if (this.opts.pool || !this.poolPromise) return;
    const pool = await this.poolPromise;
    this.poolPromise = null;
    this.migrated = null;
    await pool.end();
  }
}

/**
 * The store a spec names: `postgres://…` (or `postgresql://`), `sqlite:<path>`,
 * or a bare path / `:memory:`. Unset is the default sqlite file.
 */
export function activityStoreFromSpec(spec?: string): ActivityStore {
  if (!spec) return new SqliteActivityStore();
  if (spec.startsWith('postgres://') || spec.startsWith('postgresql://')) {
    return new PostgresActivityStore({ connectionString: spec });
  }
  if (spec.startsWith('sqlite:')) {
    const path = spec.slice('sqlite:'.length).replace(/^\/\//, '');
    if (!path) throw new Error(`activity store spec has no path: ${spec}`);
    return new SqliteActivityStore(path);
  }
  return new SqliteActivityStore(spec);
}

/**
 * The spec this process uses: an explicit `ACTIVITY_STORE_URL`, else the hub's
 * own `POSTGRES_URL` (the same database a hosted hub's relay store is in), else
 * the sqlite file. The hub and its queue worker run with the same environment,
 * so both resolve the same store.
 */
export function activityStoreSpec(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ACTIVITY_STORE_URL || env.POSTGRES_URL || undefined;
}
