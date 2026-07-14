import * as pg from 'drizzle-orm/pg-core';
import * as sq from 'drizzle-orm/sqlite-core';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, PromptAskEvent, RelayEvent } from '../types.js';
import type { CreateJobRow, PromptRow } from './store.js';

/**
 * The relay core's persisted schema, in both dialects.
 *
 * Drizzle types a table (and therefore every query) to its dialect, so `pg-core`
 * and `sqlite-core` each need their own table objects — but the *logical* schema
 * is one: identical table names, identical column names, identical JSON payloads.
 * Only the physical types differ (jsonb/timestamptz/bigint-identity vs
 * text-json/text-ISO/integer-autoincrement), which is what lets the existing
 * Postgres tables stay byte-compatible with what the hand-written SQL created.
 *
 * Timestamps are written as JS-side values in both dialects rather than leaning
 * on a `now()` default, so the read mappers below are shared: they normalize
 * `Date | string` to ISO-8601 whichever driver produced the row.
 *
 * DDL lives here too (see PG_SCHEMA_SQL / SQLITE_SCHEMA_SQL). Drizzle only emits
 * DDL through drizzle-kit migration folders, and a folder of .sql files does not
 * survive tsup bundling into relay's `bin.cjs` or the hub's standalone build — so
 * the boot-time `CREATE TABLE IF NOT EXISTS` stays literal SQL, colocated with
 * the schema it must match. Every *query* is drizzle-built.
 */

// --- postgres ---

export const pgBoxes = pg.pgTable('boxes', {
  boxId: pg.text('box_id').primaryKey(),
  token: pg.text('token').notNull(),
  originUrl: pg.text('origin_url'),
  data: pg.jsonb('data').$type<BoxRegistration>().notNull(),
  registeredAt: pg.timestamp('registered_at', { withTimezone: true }).notNull(),
});

export const pgEvents = pg.pgTable('events', {
  id: pg.bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  boxId: pg.text('box_id').notNull(),
  type: pg.text('type').notNull(),
  ts: pg.text('ts'),
  payload: pg.jsonb('payload'),
  receivedAt: pg.timestamp('received_at', { withTimezone: true }).notNull(),
});

export const pgBoxStatus = pg.pgTable('box_status', {
  boxId: pg.text('box_id').primaryKey(),
  name: pg.text('name'),
  projectIndex: pg.integer('project_index'),
  status: pg.jsonb('status').$type<BoxStatusSnapshot>().notNull(),
  updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const pgPrompts = pg.pgTable('prompts', {
  id: pg.text('id').primaryKey(),
  boxId: pg.text('box_id').notNull(),
  ev: pg.jsonb('ev').$type<PromptAskEvent>().notNull(),
  method: pg.text('method').notNull(),
  params: pg.jsonb('params'),
  status: pg.text('status').$type<PromptRow['status']>().notNull(),
  answer: pg.text('answer').$type<'y' | 'n'>(),
  cancelled: pg.boolean('cancelled'),
  result: pg.jsonb('result').$type<GitRpcResult>(),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: pg.timestamp('expires_at', { withTimezone: true }),
});

export const pgCreateJobs = pg.pgTable('create_jobs', {
  id: pg.text('id').primaryKey(),
  status: pg.text('status').$type<CreateJobRow['status']>().notNull(),
  request: pg.jsonb('request').$type<CreateJobRow['request']>().notNull(),
  result: pg.jsonb('result').$type<NonNullable<CreateJobRow['result']>>(),
  claimedBy: pg.text('claimed_by'),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull(),
  startedAt: pg.timestamp('started_at', { withTimezone: true }),
  finishedAt: pg.timestamp('finished_at', { withTimezone: true }),
});

/** Idempotent DDL for the Postgres tables. Unchanged from the pre-drizzle store. */
export const PG_SCHEMA_SQL = `
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

// --- sqlite ---

export const sqliteBoxes = sq.sqliteTable(
  'boxes',
  {
    boxId: sq.text('box_id').primaryKey(),
    token: sq.text('token').notNull(),
    originUrl: sq.text('origin_url'),
    data: sq.text('data', { mode: 'json' }).$type<BoxRegistration>().notNull(),
    registeredAt: sq.text('registered_at').notNull(),
  },
  (t) => [sq.index('boxes_token_idx').on(t.token)],
);

export const sqliteEvents = sq.sqliteTable(
  'events',
  {
    id: sq.integer('id').primaryKey({ autoIncrement: true }),
    boxId: sq.text('box_id').notNull(),
    type: sq.text('type').notNull(),
    ts: sq.text('ts'),
    payload: sq.text('payload', { mode: 'json' }),
    receivedAt: sq.text('received_at').notNull(),
  },
  (t) => [sq.index('events_box_idx').on(t.boxId, t.id)],
);

export const sqliteBoxStatus = sq.sqliteTable('box_status', {
  boxId: sq.text('box_id').primaryKey(),
  name: sq.text('name'),
  projectIndex: sq.integer('project_index'),
  status: sq.text('status', { mode: 'json' }).$type<BoxStatusSnapshot>().notNull(),
  updatedAt: sq.text('updated_at').notNull(),
});

export const sqlitePrompts = sq.sqliteTable(
  'prompts',
  {
    id: sq.text('id').primaryKey(),
    boxId: sq.text('box_id').notNull(),
    ev: sq.text('ev', { mode: 'json' }).$type<PromptAskEvent>().notNull(),
    method: sq.text('method').notNull(),
    params: sq.text('params', { mode: 'json' }),
    status: sq.text('status').$type<PromptRow['status']>().notNull(),
    answer: sq.text('answer').$type<'y' | 'n'>(),
    cancelled: sq.integer('cancelled', { mode: 'boolean' }),
    result: sq.text('result', { mode: 'json' }).$type<GitRpcResult>(),
    createdAt: sq.text('created_at').notNull(),
    expiresAt: sq.text('expires_at'),
  },
  (t) => [sq.index('prompts_box_status_idx').on(t.boxId, t.status)],
);

export const sqliteCreateJobs = sq.sqliteTable(
  'create_jobs',
  {
    id: sq.text('id').primaryKey(),
    status: sq.text('status').$type<CreateJobRow['status']>().notNull(),
    request: sq.text('request', { mode: 'json' }).$type<CreateJobRow['request']>().notNull(),
    result: sq.text('result', { mode: 'json' }).$type<NonNullable<CreateJobRow['result']>>(),
    claimedBy: sq.text('claimed_by'),
    createdAt: sq.text('created_at').notNull(),
    startedAt: sq.text('started_at'),
    finishedAt: sq.text('finished_at'),
  },
  (t) => [sq.index('create_jobs_status_idx').on(t.status, t.createdAt)],
);

/** Idempotent DDL for the SQLite tables (mirror of {@link PG_SCHEMA_SQL}). */
export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS boxes (
  box_id        text PRIMARY KEY,
  token         text NOT NULL,
  origin_url    text,
  data          text NOT NULL,
  registered_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS boxes_token_idx ON boxes (token);

CREATE TABLE IF NOT EXISTS events (
  id          integer PRIMARY KEY AUTOINCREMENT,
  box_id      text NOT NULL,
  type        text NOT NULL,
  ts          text,
  payload     text,
  received_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_box_idx ON events (box_id, id);

CREATE TABLE IF NOT EXISTS box_status (
  box_id        text PRIMARY KEY,
  name          text,
  project_index integer,
  status        text NOT NULL,
  updated_at    text NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id         text PRIMARY KEY,
  box_id     text NOT NULL,
  ev         text NOT NULL,
  method     text NOT NULL,
  params     text,
  status     text NOT NULL DEFAULT 'pending',
  answer     text,
  cancelled  integer,
  result     text,
  created_at text NOT NULL,
  expires_at text
);
CREATE INDEX IF NOT EXISTS prompts_box_status_idx ON prompts (box_id, status);

CREATE TABLE IF NOT EXISTS create_jobs (
  id          text PRIMARY KEY,
  status      text NOT NULL DEFAULT 'queued',
  request     text NOT NULL,
  result      text,
  claimed_by  text,
  created_at  text NOT NULL,
  started_at  text,
  finished_at text
);
CREATE INDEX IF NOT EXISTS create_jobs_status_idx ON create_jobs (status, created_at);
`;

// --- shared row mappers (either dialect) ---

/** A timestamp column as returned by pg (Date) or sqlite (ISO text). */
export type DbTimestamp = Date | string;

export function toIso(value: DbTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toIsoOrUndefined(value: DbTimestamp | null): string | undefined {
  return value === null ? undefined : toIso(value);
}

export interface EventRow {
  id: number;
  boxId: string;
  type: string;
  ts: string | null;
  payload: unknown;
  receivedAt: DbTimestamp;
}

export function rowToEvent(r: EventRow): RelayEvent {
  return {
    id: Number(r.id),
    boxId: r.boxId,
    type: r.type,
    ts: r.ts ?? undefined,
    payload: r.payload ?? undefined,
    receivedAt: toIso(r.receivedAt),
  };
}

export interface PromptDbRow {
  id: string;
  boxId: string;
  ev: PromptAskEvent;
  method: string;
  params: unknown;
  status: PromptRow['status'];
  answer: 'y' | 'n' | null;
  cancelled: boolean | null;
  result: GitRpcResult | null;
  createdAt: DbTimestamp;
  expiresAt: DbTimestamp | null;
}

export function rowToPrompt(r: PromptDbRow): PromptRow {
  return {
    id: r.id,
    boxId: r.boxId,
    ev: r.ev,
    method: r.method,
    params: r.params ?? undefined,
    status: r.status,
    answer: r.answer ?? undefined,
    cancelled: r.cancelled ?? undefined,
    result: r.result ?? undefined,
    createdAt: toIso(r.createdAt),
    expiresAt: toIsoOrUndefined(r.expiresAt),
  };
}

export interface CreateJobDbRow {
  id: string;
  status: CreateJobRow['status'];
  request: CreateJobRow['request'];
  result: NonNullable<CreateJobRow['result']> | null;
  claimedBy: string | null;
  createdAt: DbTimestamp;
  startedAt: DbTimestamp | null;
  finishedAt: DbTimestamp | null;
}

export function rowToJob(r: CreateJobDbRow): CreateJobRow {
  return {
    id: r.id,
    status: r.status,
    request: r.request,
    result: r.result ?? undefined,
    claimedBy: r.claimedBy ?? undefined,
    createdAt: toIso(r.createdAt),
    startedAt: toIsoOrUndefined(r.startedAt),
    finishedAt: toIsoOrUndefined(r.finishedAt),
  };
}
