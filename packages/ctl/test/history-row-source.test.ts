import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { HistoryRowCursor, type AgentHistorySqliteTable } from '@agentbox/core';
import { decodeZstdColumn, localRowFiles, openSqliteRowSource } from '../src/history-shipper.js';

// vite cannot resolve `node:sqlite` as an import; require it as ctl does at runtime.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

const dir = mkdtempSync(join(tmpdir(), 'ctl-rowsrc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TABLES: AgentHistorySqliteTable[] = [
  { name: 'session', id: 'id', session: 'id', updated: 'time_updated' },
  { name: 'message', id: 'id', session: 'session_id', updated: 'time_updated' },
  {
    name: 'part',
    id: 'id',
    session: 'session_id',
    updated: 'time_updated',
    parent: { column: 'message_id', table: 'message' },
  },
];

describe('node:sqlite row source', () => {
  it('copies a session out of an opencode-shaped db, read-only', async () => {
    const dbPath = join(dir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('ses_aaaaaaaa1', 'hello', 1), ('ses_other0001', 'x', 1);
      INSERT INTO message VALUES ('msg_1', 'ses_aaaaaaaa1', 2, '{"role":"user"}');
      INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_aaaaaaaa1', 3, '{"type":"text","text":"hi"}');`);
    const cursor = new HistoryRowCursor({
      agents: [
        {
          agent: 'opencode',
          configDir: dir,
          projectKey: '-workspace',
          spec: {
            transcripts: [
              {
                root: 'agentbox-history',
                format: 'sqlite',
                mode: 'snapshot',
                sessionFiles: ['<sessionId>.jsonl'],
                sqlite: { db: 'opencode.db', tables: TABLES },
              },
            ],
          },
        },
      ],
      boxId: 'b1',
      readBindings: async () => [
        { ts: '', boxId: 'b1', agent: 'opencode', sessionId: 'ses_aaaaaaaa1' },
      ],
      open: openSqliteRowSource,
      files: localRowFiles,
    });
    const stats = await cursor.pass();
    db.close();
    expect(stats).toMatchObject({ sessions: 1, rows: 3, errors: [] });
    const lines = readFileSync(join(dir, 'agentbox-history', 'ses_aaaaaaaa1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { t: string; id: string; row: Record<string, unknown> });
    expect(lines.map((l) => `${l.t}:${l.id}`)).toEqual([
      'session:ses_aaaaaaaa1',
      'message:msg_1',
      'part:prt_1',
    ]);
    expect(lines[2]!.row.data).toBe('{"type":"text","text":"hi"}');
    expect((await cursor.pass()).rows).toBe(0);
  });

  it('copies every session of an openclaw-shaped db, decoding zstd events', async () => {
    const SA = '7241fdc1-21e3-4d4e-929a-e49794bad4c4';
    const SB = '0bd2a7a0-0e3c-4f55-9a61-5b6f3a4c0d11';
    const base = join(dir, 'claw');
    const dbPath = join(base, 'agent.sqlite');
    mkdirSync(base, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, updated_at INTEGER);
      CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        event_json TEXT, created_at INTEGER NOT NULL, event_zstd BLOB, PRIMARY KEY (session_id, seq));`);
    db.prepare('INSERT INTO session_windows VALUES (?, 1), (?, 1)').run(SA, SB);
    const big = JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'x'.repeat(2000) },
    });
    const ins = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)');
    ins.run(SA, 0, '{"type":"session"}', 1, null);
    ins.run(SA, 1, null, 2, zstdCompressSync(Buffer.from(big)));
    // Same seq in another session: rows() must not mix them up.
    ins.run(SB, 0, '{"type":"session","id":"b"}', 1, null);
    const bound: string[] = [];
    const mk = (boxId: string) =>
      new HistoryRowCursor({
        agents: [
          {
            agent: 'openclaw',
            configDir: base,
            projectKey: '-workspace',
            spec: {
              transcripts: [
                {
                  root: 'agentbox-history',
                  format: 'sqlite',
                  mode: 'snapshot',
                  sessionFiles: ['<sessionId>.jsonl'],
                  sqlite: {
                    db: 'agent.sqlite',
                    sessions: { table: 'session_windows', column: 'session_id' },
                    tables: [
                      {
                        name: 'transcript_events',
                        id: 'seq',
                        session: 'session_id',
                        updated: 'created_at',
                        zstd: { column: 'event_zstd', into: 'event_json' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
        boxId,
        readBindings: async () => [],
        bind: (_a, sid) => {
          bound.push(sid);
        },
        open: openSqliteRowSource,
        files: localRowFiles,
      });
    const cursor = mk('b1');
    const stats = await cursor.pass();
    expect(stats).toMatchObject({ sessions: 2, rows: 3, errors: [] });
    expect(bound.sort()).toEqual([SB, SA].sort());
    const read = (sid: string) =>
      readFileSync(join(base, 'agentbox-history', `${sid}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { row: Record<string, unknown> });
    const a = read(SA);
    expect(a.map((l) => l.row.event_json)).toEqual(['{"type":"session"}', big]);
    expect(a[1]!.row).not.toHaveProperty('event_zstd');
    expect(read(SB).map((l) => l.row.event_json)).toEqual(['{"type":"session","id":"b"}']);

    // The volume restored into another box: the old output moves aside and
    // the new box's file holds only the rows it copies itself.
    ins.run(SA, 2, '{"type":"later"}', 3, null);
    expect((await mk('b2').pass()).errors).toEqual([]);
    db.close();
    expect(readFileSync(join(base, 'agentbox-history', `${SA}.jsonl.from-b1`), 'utf8')).toContain(
      '{\\"type\\":\\"session\\"}',
    );
    expect(read(SA).map((l) => l.row.event_json)).toEqual(['{"type":"later"}']);
    expect(existsSync(join(base, 'agentbox-history', `${SB}.jsonl`))).toBe(false);
    expect(existsSync(join(base, 'agentbox-history', `${SB}.jsonl.from-b1`))).toBe(true);
  });

  it('refuses to copy a compressed row empty when this node has no zstd', () => {
    const row: Record<string, unknown> = { event_json: null, event_zstd: new Uint8Array([1]) };
    expect(() => decodeZstdColumn(row, 'event_zstd', 'event_json', null)).toThrow(/no zstd/);
    const bad: Record<string, unknown> = { event_json: null, event_zstd: new Uint8Array([1, 2]) };
    decodeZstdColumn(bad, 'event_zstd', 'event_json', () => {
      throw new Error('corrupt frame');
    });
    expect(bad).toEqual({ event_json: null, event_zstd_error: 'corrupt frame' });
    const plain: Record<string, unknown> = { event_json: '{}', event_zstd: null };
    decodeZstdColumn(plain, 'event_zstd', 'event_json', null);
    expect(plain.event_json).toBe('{}');
  });

  it('returns null for a missing db', () => {
    expect(openSqliteRowSource(join(dir, 'nope.db'))).toBeNull();
  });
});
