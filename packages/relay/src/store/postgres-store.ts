import type { Pool } from 'pg';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import { RELAY_EVENT_RING_SIZE } from '../types.js';
import type { CreateJobRow, PromptRow, Store } from './store.js';

/**
 * Postgres-backed {@link Store} for the hosted control plane (Vercel-managed
 * Postgres, Neon, or a self-hosted Postgres beside the app). `pg` is loaded
 * via a lazy dynamic import so the laptop relay / CLI bundle — which only ever
 * uses {@link MemoryStore} — never pulls it in (mirrors how host-actions.ts
 * lazy-loads the cloud SDKs; `pg` is in the relay tsup `external` list).
 *
 * Phase 1 covers boxes + events + status (the current {@link Store} surface).
 * The prompt mailbox, host-initiated tokens, and the create-job queue get
 * their tables + methods in their own phases.
 */

const DEFAULT_EVENT_CAP = RELAY_EVENT_RING_SIZE;

/** Idempotent DDL for the tables this store owns. Run by {@link PostgresStore.migrate}. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS boxes (
  box_id        text PRIMARY KEY,
  token         text NOT NULL,
  origin_url    text,
  data          jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boxes_token_idx ON boxes (token);

CREATE TABLE IF NOT EXISTS events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id      text NOT NULL,
  type        text NOT NULL,
  ts          text,
  payload     jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_box_idx ON events (box_id, id);

CREATE TABLE IF NOT EXISTS box_status (
  box_id        text PRIMARY KEY,
  name          text,
  project_index int,
  status        jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompts (
  id         text PRIMARY KEY,
  box_id     text NOT NULL,
  ev         jsonb NOT NULL,
  method     text NOT NULL,
  params     jsonb,
  status     text NOT NULL DEFAULT 'pending',
  answer     text,
  cancelled  boolean,
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS prompts_box_pending_idx ON prompts (box_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS create_jobs (
  id          text PRIMARY KEY,
  status      text NOT NULL DEFAULT 'queued',
  request     jsonb NOT NULL,
  result      jsonb,
  claimed_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS create_jobs_queued_idx ON create_jobs (created_at) WHERE status = 'queued';
`;

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
  private injectedPool?: Pool;
  private poolPromise: Promise<Pool> | null = null;

  constructor(opts: PostgresStoreOptions = {}) {
    this.connectionString = opts.connectionString;
    this.injectedPool = opts.pool;
    this.eventCap = opts.eventCap ?? DEFAULT_EVENT_CAP;
  }

  /** Lazily build (or reuse) the pg Pool. `pg` is imported on first use only. */
  private pool(): Promise<Pool> {
    if (this.injectedPool) return Promise.resolve(this.injectedPool);
    if (!this.poolPromise) {
      this.poolPromise = import('pg').then(({ Pool }) => new Pool({ connectionString: this.connectionString }));
    }
    return this.poolPromise;
  }

  private async query<R>(text: string, params?: unknown[]): Promise<R[]> {
    const pool = await this.pool();
    const res = await pool.query(text, params as unknown[]);
    return res.rows as R[];
  }

  /** Create the tables if absent. Call once on boot (idempotent). */
  async migrate(): Promise<void> {
    const pool = await this.pool();
    await pool.query(SCHEMA_SQL);
  }

  /** Release the pool (tests / graceful shutdown). No-op for an injected pool. */
  async close(): Promise<void> {
    if (this.injectedPool) return;
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }

  // --- boxes ---

  async registerBox(reg: BoxRegistration): Promise<void> {
    const originUrl = reg.originUrl ?? null;
    await this.query(
      `INSERT INTO boxes (box_id, token, origin_url, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (box_id) DO UPDATE
         SET token = EXCLUDED.token, origin_url = EXCLUDED.origin_url, data = EXCLUDED.data`,
      [reg.boxId, reg.token, originUrl, JSON.stringify(reg)],
    );
  }

  async getBox(boxId: string): Promise<BoxRegistration | undefined> {
    const rows = await this.query<{ data: BoxRegistration }>(
      `SELECT data FROM boxes WHERE box_id = $1`,
      [boxId],
    );
    return rows[0]?.data;
  }

  async authenticateBox(token: string): Promise<BoxRegistration | null> {
    if (token.length === 0) return null;
    const rows = await this.query<{ data: BoxRegistration }>(
      `SELECT data FROM boxes WHERE token = $1 LIMIT 1`,
      [token],
    );
    return rows[0]?.data ?? null;
  }

  async listBoxes(): Promise<BoxRegistration[]> {
    const rows = await this.query<{ data: BoxRegistration }>(
      `SELECT data FROM boxes ORDER BY registered_at`,
    );
    return rows.map((r) => r.data);
  }

  async forgetBox(boxId: string): Promise<boolean> {
    const rows = await this.query<{ box_id: string }>(
      `DELETE FROM boxes WHERE box_id = $1 RETURNING box_id`,
      [boxId],
    );
    return rows.length > 0;
  }

  async countBoxes(): Promise<number> {
    const rows = await this.query<{ n: string }>(`SELECT count(*)::text AS n FROM boxes`);
    return Number.parseInt(rows[0]?.n ?? '0', 10);
  }

  // --- events ---

  async appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    const rows = await this.query<{ id: string; received_at: Date }>(
      `INSERT INTO events (box_id, type, ts, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id, received_at`,
      [input.boxId, input.type, input.ts ?? null, input.payload === undefined ? null : JSON.stringify(input.payload)],
    );
    const id = Number(rows[0]!.id);
    if (this.eventCap > 0) {
      // Keep only the newest `eventCap` rows by id, matching the in-memory ring.
      await this.query(`DELETE FROM events WHERE id <= $1`, [id - this.eventCap]);
    }
    return {
      id,
      boxId: input.boxId,
      type: input.type,
      ts: input.ts,
      payload: input.payload,
      receivedAt: new Date(rows[0]!.received_at).toISOString(),
    };
  }

  async listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    const rows =
      boxId !== undefined
        ? await this.query<EventRow>(
            `SELECT id, box_id, type, ts, payload, received_at FROM events
             WHERE id > $1 AND box_id = $2 ORDER BY id`,
            [since, boxId],
          )
        : await this.query<EventRow>(
            `SELECT id, box_id, type, ts, payload, received_at FROM events
             WHERE id > $1 ORDER BY id`,
            [since],
          );
    return rows.map(rowToEvent);
  }

  async countEvents(): Promise<number> {
    const rows = await this.query<{ n: string }>(`SELECT count(*)::text AS n FROM events`);
    return Number.parseInt(rows[0]?.n ?? '0', 10);
  }

  // --- status ---

  async setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    await this.query(
      `INSERT INTO box_status (box_id, name, project_index, status, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (box_id) DO UPDATE
         SET name = EXCLUDED.name, project_index = EXCLUDED.project_index,
             status = EXCLUDED.status, updated_at = now()`,
      [boxId, name, projectIndex ?? null, JSON.stringify(status)],
    );
  }

  async getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    const rows = await this.query<{ status: BoxStatusSnapshot }>(
      `SELECT status FROM box_status WHERE box_id = $1`,
      [boxId],
    );
    return rows[0]?.status;
  }

  async deleteStatus(boxId: string): Promise<void> {
    await this.query(`DELETE FROM box_status WHERE box_id = $1`, [boxId]);
  }

  /**
   * All box status snapshots in one query (avoids N+1 over listBoxes +
   * per-box getStatus). Used by the hosted hub UI to render every box's live
   * status. Not on the Store interface — only the hosted Postgres path needs it.
   */
  async listStatuses(): Promise<Array<{ boxId: string; status: BoxStatusSnapshot }>> {
    const rows = await this.query<{ box_id: string; status: BoxStatusSnapshot }>(
      `SELECT box_id, status FROM box_status`,
    );
    return rows.map((r) => ({ boxId: r.box_id, status: r.status }));
  }

  // --- prompt mailbox ---

  async createPrompt(row: PromptRow): Promise<void> {
    await this.query(
      `INSERT INTO prompts (id, box_id, ev, method, params, status, answer, cancelled, result, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.boxId,
        JSON.stringify(row.ev),
        row.method,
        row.params === undefined ? null : JSON.stringify(row.params),
        row.status,
        row.answer ?? null,
        row.cancelled ?? null,
        row.result === undefined ? null : JSON.stringify(row.result),
        row.createdAt,
        row.expiresAt ?? null,
      ],
    );
  }

  async getPrompt(promptId: string): Promise<PromptRow | null> {
    const rows = await this.query<PromptDbRow>(
      `SELECT id, box_id, ev, method, params, status, answer, cancelled, result, created_at, expires_at
       FROM prompts WHERE id = $1`,
      [promptId],
    );
    return rows[0] ? rowToPrompt(rows[0]) : null;
  }

  async answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `UPDATE prompts SET status = 'answered', answer = $2, cancelled = $3
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [promptId, answer, cancelled ?? null],
    );
    return rows.length > 0;
  }

  async listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    const rows = await this.query<PromptDbRow>(
      `SELECT id, box_id, ev, method, params, status, answer, cancelled, result, created_at, expires_at
       FROM prompts WHERE box_id = $1 AND status = 'pending' ORDER BY created_at`,
      [boxId],
    );
    return rows.map(rowToPrompt);
  }

  async setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    await this.query(`UPDATE prompts SET result = $2 WHERE id = $1`, [
      promptId,
      JSON.stringify(result),
    ]);
  }

  // --- box-create job queue ---

  async enqueueCreateJob(job: CreateJobRow): Promise<void> {
    await this.query(
      `INSERT INTO create_jobs (id, status, request, result, claimed_by, created_at, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [
        job.id,
        job.status,
        JSON.stringify(job.request),
        job.result ? JSON.stringify(job.result) : null,
        job.claimedBy ?? null,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
      ],
    );
  }

  async getCreateJob(id: string): Promise<CreateJobRow | null> {
    const rows = await this.query<CreateJobDbRow>(
      `SELECT id, status, request, result, claimed_by, created_at, started_at, finished_at
       FROM create_jobs WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async claimNextCreateJob(workerId: string): Promise<CreateJobRow | null> {
    // Atomic claim: lock the oldest queued row, skip ones a sibling worker holds.
    const rows = await this.query<CreateJobDbRow>(
      `UPDATE create_jobs SET status = 'running', claimed_by = $1, started_at = now()
       WHERE id = (
         SELECT id FROM create_jobs WHERE status = 'queued'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, status, request, result, claimed_by, created_at, started_at, finished_at`,
      [workerId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async completeCreateJob(
    id: string,
    status: 'done' | 'failed',
    result: { boxId?: string; error?: string },
  ): Promise<void> {
    await this.query(
      `UPDATE create_jobs SET status = $2, result = $3, finished_at = now() WHERE id = $1`,
      [id, status, JSON.stringify(result)],
    );
  }
}

interface CreateJobDbRow {
  id: string;
  status: CreateJobRow['status'];
  request: CreateJobRow['request'];
  result: CreateJobRow['result'] | null;
  claimed_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function rowToJob(r: CreateJobDbRow): CreateJobRow {
  return {
    id: r.id,
    status: r.status,
    request: r.request,
    result: r.result ?? undefined,
    claimedBy: r.claimed_by ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : undefined,
  };
}

interface PromptDbRow {
  id: string;
  box_id: string;
  ev: PromptRow['ev'];
  method: string;
  params: unknown;
  status: 'pending' | 'answered';
  answer: 'y' | 'n' | null;
  cancelled: boolean | null;
  result: GitRpcResult | null;
  created_at: Date;
  expires_at: Date | null;
}

function rowToPrompt(r: PromptDbRow): PromptRow {
  return {
    id: r.id,
    boxId: r.box_id,
    ev: r.ev,
    method: r.method,
    params: r.params ?? undefined,
    status: r.status,
    answer: r.answer ?? undefined,
    cancelled: r.cancelled ?? undefined,
    result: r.result ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
  };
}

interface EventRow {
  id: string;
  box_id: string;
  type: string;
  ts: string | null;
  payload: unknown;
  received_at: Date;
}

function rowToEvent(r: EventRow): RelayEvent {
  return {
    id: Number(r.id),
    boxId: r.box_id,
    type: r.type,
    ts: r.ts ?? undefined,
    payload: r.payload ?? undefined,
    receivedAt: new Date(r.received_at).toISOString(),
  };
}
