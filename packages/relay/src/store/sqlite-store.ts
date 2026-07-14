import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import { RELAY_EVENT_RING_SIZE } from '../types.js';
import {
  SQLITE_SCHEMA_SQL,
  rowToEvent,
  rowToJob,
  rowToPrompt,
  sqliteBoxStatus,
  sqliteBoxes,
  sqliteCreateJobs,
  sqliteEvents,
  sqlitePrompts,
} from './schema.js';
import type { CreateJobRow, PromptRow, Store } from './store.js';

/**
 * SQLite-backed {@link Store} — the control box's default (a single always-on
 * process on a small VPS has no reason to run a Postgres container).
 *
 * Driver: `node:sqlite`'s `DatabaseSync` behind drizzle's `sqlite-proxy`
 * (bring-your-own-executor) driver. drizzle ships no `node:sqlite` driver, and
 * its `better-sqlite3` one would add a native dependency; `sqlite-proxy` gets the
 * same typed query builder over the exact driver the hub's better-auth already
 * uses (`~/.agentbox/hub/auth.db`), with no native build step. The executor
 * callback below is the whole adapter.
 *
 * `node:sqlite` (and the drizzle driver) are lazy dynamic imports so the laptop
 * CLI bundle never touches them, and so a Node < 22.5 host only fails if it
 * actually asks for a SQLite store.
 *
 * Concurrency: SQLite is single-writer. WAL + a busy timeout make concurrent
 * readers fine, but the design consequence (recorded in the plan) is that the
 * create worker must run in the hub *process*, not as a second container on the
 * same file.
 */

const DEFAULT_EVENT_CAP = RELAY_EVENT_RING_SIZE;

/** Default DB path — sibling of the hub's better-auth `auth.db`. */
export const DEFAULT_SQLITE_STORE_PATH = join(STATE_DIR, 'hub', 'store.db');

/** `node:sqlite` landed in 22.5 (the repo's engines floor is 20.10). */
const MIN_NODE_SQLITE = [22, 5] as const;

export interface SqliteStoreOptions {
  /** DB file path, or ':memory:' (tests). Default `~/.agentbox/hub/store.db`. */
  path?: string;
  /** Global event-row cap, mirroring the in-memory ring. 0 disables trimming. Default 1000. */
  eventCap?: number;
}

/** The subset of `node:sqlite`'s DatabaseSync this store drives. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  setReturnArrays?: (enabled: boolean) => void;
}

/**
 * Load `node:sqlite` without any bundler seeing the specifier.
 *
 * It is a *prefix-only* builtin, so it is absent from `module.builtinModules` —
 * and vite 5 / vite-node decide "is this a builtin?" from that list, strip the
 * `node:`, and then try to load a package called `sqlite` from disk. A plain
 * `await import('node:sqlite')` therefore breaks every vitest run that touches
 * this store. Going through `createRequire` keeps the load a runtime concern of
 * Node's own resolver, which is the only one that gets this right.
 */
function loadNodeSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  return require('node:sqlite') as typeof import('node:sqlite');
}

function assertNodeSupportsSqlite(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE_SQLITE[0] || (major === MIN_NODE_SQLITE[0] && minor >= MIN_NODE_SQLITE[1]);
  if (!ok) {
    throw new Error(
      `the SQLite store needs Node >= ${MIN_NODE_SQLITE[0]}.${MIN_NODE_SQLITE[1]} for node:sqlite (running ${process.versions.node}). ` +
        'Upgrade Node, or point the hub at a Postgres store (POSTGRES_URL).',
    );
  }
}

export class SqliteStore implements Store {
  private readonly path: string;
  private readonly eventCap: number;
  private raw: SqliteDatabase | null = null;
  private dbPromise: Promise<SqliteRemoteDatabase> | null = null;

  constructor(opts: SqliteStoreOptions = {}) {
    this.path = opts.path ?? DEFAULT_SQLITE_STORE_PATH;
    this.eventCap = opts.eventCap ?? DEFAULT_EVENT_CAP;
  }

  /**
   * Open the DB (creating the file + tables if absent) and wrap it in drizzle.
   * Lazy + memoized: the schema is always applied before the first query, so
   * callers never have to sequence `migrate()` themselves.
   */
  private db(): Promise<SqliteRemoteDatabase> {
    this.dbPromise ??= (async () => {
      assertNodeSupportsSqlite();
      const { DatabaseSync } = loadNodeSqlite();
      const { drizzle } = await import('drizzle-orm/sqlite-proxy');
      if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
      const raw = new DatabaseSync(this.path) as unknown as SqliteDatabase;
      // WAL keeps readers off the writer's back; busy_timeout turns a concurrent
      // write into a short wait instead of an immediate SQLITE_BUSY throw.
      raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      raw.exec(SQLITE_SCHEMA_SQL);
      this.raw = raw;
      return drizzle(async (sql, params, method) => {
        const stmt = raw.prepare(sql);
        if (method === 'run') {
          stmt.run(...params);
          return { rows: [] };
        }
        // drizzle maps result columns positionally, so rows must be arrays.
        // node:sqlite grew setReturnArrays after 22.5 — fall back to key order
        // (our queries are single-table, so no duplicate-column collapse).
        let rows: unknown[][];
        if (typeof stmt.setReturnArrays === 'function') {
          stmt.setReturnArrays(true);
          rows = stmt.all(...params) as unknown[][];
        } else {
          rows = (stmt.all(...params) as Record<string, unknown>[]).map((r) => Object.values(r));
        }
        return method === 'get' ? { rows: rows[0] ?? [] } : { rows };
      });
    })();
    return this.dbPromise;
  }

  /** Open + apply the schema. Idempotent; `db()` does it lazily anyway. */
  async migrate(): Promise<void> {
    await this.db();
  }

  /** Close the underlying handle (tests / graceful shutdown). */
  async close(): Promise<void> {
    if (this.dbPromise) await this.dbPromise.catch(() => undefined);
    this.raw?.close();
    this.raw = null;
    this.dbPromise = null;
  }

  // --- boxes ---

  async registerBox(reg: BoxRegistration): Promise<void> {
    const db = await this.db();
    await db
      .insert(sqliteBoxes)
      .values({
        boxId: reg.boxId,
        token: reg.token,
        originUrl: reg.originUrl ?? null,
        data: reg,
        registeredAt: reg.registeredAt,
      })
      .onConflictDoUpdate({
        target: sqliteBoxes.boxId,
        set: { token: reg.token, originUrl: reg.originUrl ?? null, data: reg },
      });
  }

  async getBox(boxId: string): Promise<BoxRegistration | undefined> {
    const db = await this.db();
    const rows = await db
      .select({ data: sqliteBoxes.data })
      .from(sqliteBoxes)
      .where(eq(sqliteBoxes.boxId, boxId));
    return rows[0]?.data;
  }

  async authenticateBox(token: string): Promise<BoxRegistration | null> {
    if (token.length === 0) return null;
    const db = await this.db();
    const rows = await db
      .select({ data: sqliteBoxes.data })
      .from(sqliteBoxes)
      .where(eq(sqliteBoxes.token, token))
      .limit(1);
    return rows[0]?.data ?? null;
  }

  async listBoxes(): Promise<BoxRegistration[]> {
    const db = await this.db();
    const rows = await db
      .select({ data: sqliteBoxes.data })
      .from(sqliteBoxes)
      .orderBy(asc(sqliteBoxes.registeredAt));
    return rows.map((r) => r.data);
  }

  async forgetBox(boxId: string): Promise<boolean> {
    const db = await this.db();
    const rows = await db
      .delete(sqliteBoxes)
      .where(eq(sqliteBoxes.boxId, boxId))
      .returning({ boxId: sqliteBoxes.boxId });
    return rows.length > 0;
  }

  async countBoxes(): Promise<number> {
    const db = await this.db();
    return db.$count(sqliteBoxes);
  }

  // --- events ---

  async appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    const db = await this.db();
    const receivedAt = new Date().toISOString();
    const rows = await db
      .insert(sqliteEvents)
      .values({
        boxId: input.boxId,
        type: input.type,
        ts: input.ts ?? null,
        payload: input.payload ?? null,
        receivedAt,
      })
      .returning({ id: sqliteEvents.id });
    const id = rows[0]!.id;
    if (this.eventCap > 0) {
      // Keep only the newest `eventCap` rows by id, matching the in-memory ring.
      await db.delete(sqliteEvents).where(lte(sqliteEvents.id, id - this.eventCap));
    }
    return {
      id,
      boxId: input.boxId,
      type: input.type,
      ts: input.ts,
      payload: input.payload,
      receivedAt,
    };
  }

  async listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    const db = await this.db();
    const where =
      boxId === undefined
        ? gt(sqliteEvents.id, since)
        : and(gt(sqliteEvents.id, since), eq(sqliteEvents.boxId, boxId));
    const rows = await db.select().from(sqliteEvents).where(where).orderBy(asc(sqliteEvents.id));
    return rows.map(rowToEvent);
  }

  async countEvents(): Promise<number> {
    const db = await this.db();
    return db.$count(sqliteEvents);
  }

  // --- status ---

  async setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    const db = await this.db();
    const updatedAt = new Date().toISOString();
    await db
      .insert(sqliteBoxStatus)
      .values({ boxId, name, projectIndex: projectIndex ?? null, status, updatedAt })
      .onConflictDoUpdate({
        target: sqliteBoxStatus.boxId,
        set: { name, projectIndex: projectIndex ?? null, status, updatedAt },
      });
  }

  async getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    const db = await this.db();
    const rows = await db
      .select({ status: sqliteBoxStatus.status })
      .from(sqliteBoxStatus)
      .where(eq(sqliteBoxStatus.boxId, boxId));
    return rows[0]?.status;
  }

  async deleteStatus(boxId: string): Promise<void> {
    const db = await this.db();
    await db.delete(sqliteBoxStatus).where(eq(sqliteBoxStatus.boxId, boxId));
  }

  /** All box status snapshots in one query (see PostgresStore.listStatuses). */
  async listStatuses(): Promise<Array<{ boxId: string; status: BoxStatusSnapshot }>> {
    const db = await this.db();
    return db
      .select({ boxId: sqliteBoxStatus.boxId, status: sqliteBoxStatus.status })
      .from(sqliteBoxStatus);
  }

  // --- prompt mailbox ---

  async createPrompt(row: PromptRow): Promise<void> {
    const db = await this.db();
    await db
      .insert(sqlitePrompts)
      .values({
        id: row.id,
        boxId: row.boxId,
        ev: row.ev,
        method: row.method,
        params: row.params ?? null,
        status: row.status,
        answer: row.answer ?? null,
        cancelled: row.cancelled ?? null,
        result: row.result ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
      })
      .onConflictDoNothing({ target: sqlitePrompts.id });
  }

  async getPrompt(promptId: string): Promise<PromptRow | null> {
    const db = await this.db();
    const rows = await db.select().from(sqlitePrompts).where(eq(sqlitePrompts.id, promptId));
    return rows[0] ? rowToPrompt(rows[0]) : null;
  }

  async answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    const db = await this.db();
    const rows = await db
      .update(sqlitePrompts)
      .set({ status: 'answered', answer, cancelled: cancelled ?? null })
      .where(and(eq(sqlitePrompts.id, promptId), eq(sqlitePrompts.status, 'pending')))
      .returning({ id: sqlitePrompts.id });
    return rows.length > 0;
  }

  async listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    const db = await this.db();
    const rows = await db
      .select()
      .from(sqlitePrompts)
      .where(and(eq(sqlitePrompts.boxId, boxId), eq(sqlitePrompts.status, 'pending')))
      .orderBy(asc(sqlitePrompts.createdAt));
    return rows.map(rowToPrompt);
  }

  async setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    const db = await this.db();
    await db.update(sqlitePrompts).set({ result }).where(eq(sqlitePrompts.id, promptId));
  }

  // --- box-create job queue ---

  async enqueueCreateJob(job: CreateJobRow): Promise<void> {
    const db = await this.db();
    await db
      .insert(sqliteCreateJobs)
      .values({
        id: job.id,
        status: job.status,
        request: job.request,
        result: job.result ?? null,
        claimedBy: job.claimedBy ?? null,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      })
      .onConflictDoNothing({ target: sqliteCreateJobs.id });
  }

  async getCreateJob(id: string): Promise<CreateJobRow | null> {
    const db = await this.db();
    const rows = await db.select().from(sqliteCreateJobs).where(eq(sqliteCreateJobs.id, id));
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async claimNextCreateJob(workerId: string): Promise<CreateJobRow | null> {
    const db = await this.db();
    // No SKIP LOCKED in SQLite — but the claim is one statement, and node:sqlite
    // executes it synchronously, so no second claimer can interleave between the
    // subquery and the update. The `status = 'queued'` guard is belt-and-braces.
    const oldestQueued = db
      .select({ id: sqliteCreateJobs.id })
      .from(sqliteCreateJobs)
      .where(eq(sqliteCreateJobs.status, 'queued'))
      .orderBy(asc(sqliteCreateJobs.createdAt))
      .limit(1);
    const rows = await db
      .update(sqliteCreateJobs)
      .set({ status: 'running', claimedBy: workerId, startedAt: new Date().toISOString() })
      .where(
        and(inArray(sqliteCreateJobs.id, oldestQueued), eq(sqliteCreateJobs.status, 'queued')),
      )
      .returning();
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async completeCreateJob(
    id: string,
    status: 'done' | 'failed',
    result: { boxId?: string; error?: string },
  ): Promise<void> {
    const db = await this.db();
    await db
      .update(sqliteCreateJobs)
      .set({ status, result, finishedAt: new Date().toISOString() })
      .where(eq(sqliteCreateJobs.id, id));
  }
}
