import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { HistoryRowCursor, type AgentHistorySqliteTable } from '@agentbox/core';
import { localRowFiles, openSqliteRowSource } from '../src/history-shipper.js';

// vite cannot resolve `node:sqlite` as an import; require it as ctl does at runtime.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

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
      readBindings: async () => [{ ts: '', boxId: 'b1', agent: 'opencode', sessionId: 'ses_aaaaaaaa1' }],
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
    expect(lines.map((l) => `${l.t}:${l.id}`)).toEqual(['session:ses_aaaaaaaa1', 'message:msg_1', 'part:prt_1']);
    expect(lines[2]!.row.data).toBe('{"type":"text","text":"hi"}');
    expect((await cursor.pass()).rows).toBe(0);
  });

  it('returns null for a missing db', () => {
    expect(openSqliteRowSource(join(dir, 'nope.db'))).toBeNull();
  });
});
