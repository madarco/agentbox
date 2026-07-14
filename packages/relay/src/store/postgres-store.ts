import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import { RELAY_EVENT_RING_SIZE } from '../types.js';
import {
  PG_SCHEMA_SQL,
  pgBoxStatus,
  pgBoxes,
  pgCreateJobs,
  pgEvents,
  pgPrompts,
  rowToEvent,
  rowToJob,
  rowToPrompt,
} from './schema.js';
import type { CreateJobRow, PromptRow, Store } from './store.js';

/**
 * Postgres-backed {@link Store} for the hosted control plane (Vercel-managed
 * Postgres, Neon, or a self-hosted Postgres beside the app). Queries are built
 * with drizzle over the shared schema in `./schema.ts` — the same schema the
 * SQLite store uses, so the two dialects cannot drift.
 *
 * `pg` (and drizzle's `node-postgres` driver, which statically imports it) is
 * loaded via a lazy dynamic import so the laptop relay / CLI bundle — which only
 * ever uses {@link MemoryStore} — never pulls it in (mirrors how host-actions.ts
 * lazy-loads the cloud SDKs; `pg` is in the relay tsup `external` list).
 */

const DEFAULT_EVENT_CAP = RELAY_EVENT_RING_SIZE;

export interface PostgresStoreOptions {
  /** Postgres connection string (e.g. `process.env.POSTGRES_URL`). */
  connectionString?: string;
  /** Inject a pre-built pool (tests / a shared app pool). Takes precedence over connectionString. */
  pool?: Pool;
  /**
   * Global event-row cap, mirroring the in-memory ring. Newest N kept by id;
   * older rows trimmed on append. 0 disables trimming. Default 1000.
   */
  eventCap?: number;
}

export class PostgresStore implements Store {
  private readonly eventCap: number;
  private readonly connectionString?: string;
  private readonly injectedPool?: Pool;
  private poolPromise: Promise<Pool> | null = null;
  private dbPromise: Promise<NodePgDatabase> | null = null;

  constructor(opts: PostgresStoreOptions = {}) {
    this.connectionString = opts.connectionString;
    this.injectedPool = opts.pool;
    this.eventCap = opts.eventCap ?? DEFAULT_EVENT_CAP;
  }

  /** Lazily build (or reuse) the pg Pool. `pg` is imported on first use only. */
  private pool(): Promise<Pool> {
    if (this.injectedPool) return Promise.resolve(this.injectedPool);
    this.poolPromise ??= import('pg').then(
      ({ default: pg }) => new pg.Pool({ connectionString: this.connectionString }),
    );
    return this.poolPromise;
  }

  private db(): Promise<NodePgDatabase> {
    this.dbPromise ??= (async () => {
      const pool = await this.pool();
      const { drizzle } = await import('drizzle-orm/node-postgres');
      return drizzle(pool);
    })();
    return this.dbPromise;
  }

  /** Create the tables if absent. Call once on boot (idempotent). */
  async migrate(): Promise<void> {
    const pool = await this.pool();
    await pool.query(PG_SCHEMA_SQL);
  }

  /** Release the pool (tests / graceful shutdown). No-op for an injected pool. */
  async close(): Promise<void> {
    if (this.injectedPool) return;
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
      this.dbPromise = null;
    }
  }

  // --- boxes ---

  async registerBox(reg: BoxRegistration): Promise<void> {
    const db = await this.db();
    await db
      .insert(pgBoxes)
      .values({
        boxId: reg.boxId,
        token: reg.token,
        originUrl: reg.originUrl ?? null,
        data: reg,
        registeredAt: new Date(reg.registeredAt),
      })
      .onConflictDoUpdate({
        target: pgBoxes.boxId,
        set: { token: reg.token, originUrl: reg.originUrl ?? null, data: reg },
      });
  }

  async getBox(boxId: string): Promise<BoxRegistration | undefined> {
    const db = await this.db();
    const rows = await db.select({ data: pgBoxes.data }).from(pgBoxes).where(eq(pgBoxes.boxId, boxId));
    return rows[0]?.data;
  }

  async authenticateBox(token: string): Promise<BoxRegistration | null> {
    if (token.length === 0) return null;
    const db = await this.db();
    const rows = await db
      .select({ data: pgBoxes.data })
      .from(pgBoxes)
      .where(eq(pgBoxes.token, token))
      .limit(1);
    return rows[0]?.data ?? null;
  }

  async listBoxes(): Promise<BoxRegistration[]> {
    const db = await this.db();
    const rows = await db.select({ data: pgBoxes.data }).from(pgBoxes).orderBy(asc(pgBoxes.registeredAt));
    return rows.map((r) => r.data);
  }

  async forgetBox(boxId: string): Promise<boolean> {
    const db = await this.db();
    const rows = await db
      .delete(pgBoxes)
      .where(eq(pgBoxes.boxId, boxId))
      .returning({ boxId: pgBoxes.boxId });
    return rows.length > 0;
  }

  async countBoxes(): Promise<number> {
    const db = await this.db();
    return db.$count(pgBoxes);
  }

  // --- events ---

  async appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    const db = await this.db();
    const rows = await db
      .insert(pgEvents)
      .values({
        boxId: input.boxId,
        type: input.type,
        ts: input.ts ?? null,
        payload: input.payload ?? null,
        receivedAt: new Date(),
      })
      .returning({ id: pgEvents.id, receivedAt: pgEvents.receivedAt });
    const row = rows[0]!;
    if (this.eventCap > 0) {
      // Keep only the newest `eventCap` rows by id, matching the in-memory ring.
      await db.delete(pgEvents).where(lte(pgEvents.id, row.id - this.eventCap));
    }
    return {
      id: row.id,
      boxId: input.boxId,
      type: input.type,
      ts: input.ts,
      payload: input.payload,
      receivedAt: row.receivedAt.toISOString(),
    };
  }

  async listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    const db = await this.db();
    const where =
      boxId === undefined
        ? gt(pgEvents.id, since)
        : and(gt(pgEvents.id, since), eq(pgEvents.boxId, boxId));
    const rows = await db.select().from(pgEvents).where(where).orderBy(asc(pgEvents.id));
    return rows.map(rowToEvent);
  }

  async countEvents(): Promise<number> {
    const db = await this.db();
    return db.$count(pgEvents);
  }

  // --- status ---

  async setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    const db = await this.db();
    const updatedAt = new Date();
    await db
      .insert(pgBoxStatus)
      .values({ boxId, name, projectIndex: projectIndex ?? null, status, updatedAt })
      .onConflictDoUpdate({
        target: pgBoxStatus.boxId,
        set: { name, projectIndex: projectIndex ?? null, status, updatedAt },
      });
  }

  async getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    const db = await this.db();
    const rows = await db
      .select({ status: pgBoxStatus.status })
      .from(pgBoxStatus)
      .where(eq(pgBoxStatus.boxId, boxId));
    return rows[0]?.status;
  }

  async deleteStatus(boxId: string): Promise<void> {
    const db = await this.db();
    await db.delete(pgBoxStatus).where(eq(pgBoxStatus.boxId, boxId));
  }

  /**
   * All box status snapshots in one query (avoids N+1 over listBoxes +
   * per-box getStatus). Used by the hosted hub UI to render every box's live
   * status. Not on the Store interface — only the hosted stores need it.
   */
  async listStatuses(): Promise<Array<{ boxId: string; status: BoxStatusSnapshot }>> {
    const db = await this.db();
    return db.select({ boxId: pgBoxStatus.boxId, status: pgBoxStatus.status }).from(pgBoxStatus);
  }

  // --- prompt mailbox ---

  async createPrompt(row: PromptRow): Promise<void> {
    const db = await this.db();
    await db
      .insert(pgPrompts)
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
        createdAt: new Date(row.createdAt),
        expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
      })
      .onConflictDoNothing({ target: pgPrompts.id });
  }

  async getPrompt(promptId: string): Promise<PromptRow | null> {
    const db = await this.db();
    const rows = await db.select().from(pgPrompts).where(eq(pgPrompts.id, promptId));
    return rows[0] ? rowToPrompt(rows[0]) : null;
  }

  async answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    const db = await this.db();
    const rows = await db
      .update(pgPrompts)
      .set({ status: 'answered', answer, cancelled: cancelled ?? null })
      .where(and(eq(pgPrompts.id, promptId), eq(pgPrompts.status, 'pending')))
      .returning({ id: pgPrompts.id });
    return rows.length > 0;
  }

  async listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    const db = await this.db();
    const rows = await db
      .select()
      .from(pgPrompts)
      .where(and(eq(pgPrompts.boxId, boxId), eq(pgPrompts.status, 'pending')))
      .orderBy(asc(pgPrompts.createdAt));
    return rows.map(rowToPrompt);
  }

  async setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    const db = await this.db();
    await db.update(pgPrompts).set({ result }).where(eq(pgPrompts.id, promptId));
  }

  // --- box-create job queue ---

  async enqueueCreateJob(job: CreateJobRow): Promise<void> {
    const db = await this.db();
    await db
      .insert(pgCreateJobs)
      .values({
        id: job.id,
        status: job.status,
        request: job.request,
        result: job.result ?? null,
        claimedBy: job.claimedBy ?? null,
        createdAt: new Date(job.createdAt),
        startedAt: job.startedAt ? new Date(job.startedAt) : null,
        finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
      })
      .onConflictDoNothing({ target: pgCreateJobs.id });
  }

  async getCreateJob(id: string): Promise<CreateJobRow | null> {
    const db = await this.db();
    const rows = await db.select().from(pgCreateJobs).where(eq(pgCreateJobs.id, id));
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async claimNextCreateJob(workerId: string): Promise<CreateJobRow | null> {
    const db = await this.db();
    // Atomic claim: lock the oldest queued row, skip ones a sibling worker holds.
    const oldestQueued = db
      .select({ id: pgCreateJobs.id })
      .from(pgCreateJobs)
      .where(eq(pgCreateJobs.status, 'queued'))
      .orderBy(asc(pgCreateJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const rows = await db
      .update(pgCreateJobs)
      .set({ status: 'running', claimedBy: workerId, startedAt: new Date() })
      .where(inArray(pgCreateJobs.id, oldestQueued))
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
      .update(pgCreateJobs)
      .set({ status, result, finishedAt: new Date() })
      .where(eq(pgCreateJobs.id, id));
  }

  // --- retention (timestamptz columns compare against a Date) ---

  async prunePrompts(beforeIso: string): Promise<number> {
    const db = await this.db();
    const before = new Date(beforeIso);
    const rows = await db
      .delete(pgPrompts)
      .where(
        or(
          and(eq(pgPrompts.status, 'answered'), lt(pgPrompts.createdAt, before)),
          and(isNotNull(pgPrompts.expiresAt), lt(pgPrompts.expiresAt, before)),
        ),
      )
      .returning({ id: pgPrompts.id });
    return rows.length;
  }

  async pruneCreateJobs(beforeIso: string): Promise<number> {
    const db = await this.db();
    const before = new Date(beforeIso);
    const rows = await db
      .delete(pgCreateJobs)
      .where(
        and(
          inArray(pgCreateJobs.status, ['done', 'failed']),
          isNotNull(pgCreateJobs.finishedAt),
          lt(pgCreateJobs.finishedAt, before),
        ),
      )
      .returning({ id: pgCreateJobs.id });
    return rows.length;
  }
}
