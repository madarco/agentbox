// The devices table on `node:sqlite`, in its own file next to `auth.db` and
// `store.db`. Its own file rather than a table in `store.db`: that database
// already has an owner (the relay's store), and a second `DatabaseSync` handle on
// it would contend without a busy timeout.
//
// Imported only by server.ts (dynamically, password profile), never by a Next
// route — those reach the service through `globalThis.__AGENTBOX_HUB_DEVICES`.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceRecord, DeviceRepo } from './backend/devices';

interface Row {
  id: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  user_id: string | null;
}

const toRecord = (r: Row): DeviceRecord => ({
  id: r.id,
  label: r.label,
  createdAt: Number(r.created_at),
  lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  userId: r.user_id,
});

const COLS = 'id, label, created_at, last_seen_at, revoked_at, user_id';

export async function openSqliteDeviceRepo(path: string): Promise<DeviceRepo> {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER,
    user_id TEXT
  )`);

  const getStmt = db.prepare(`SELECT ${COLS} FROM devices WHERE id = ?`);
  const listStmt = db.prepare(`SELECT ${COLS} FROM devices ORDER BY created_at`);
  const byHashStmt = db.prepare(`SELECT ${COLS} FROM devices WHERE token_hash = ?`);
  const upsertStmt = db.prepare(
    `INSERT INTO devices (id, label, token_hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, token_hash = excluded.token_hash,
       revoked_at = NULL`,
  );
  const labelStmt = db.prepare('UPDATE devices SET label = ? WHERE id = ?');
  const revokeStmt = db.prepare(
    'UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ? AND revoked_at IS NULL',
  );
  const touchStmt = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');

  const get = (id: string): DeviceRecord | null => {
    const r = getStmt.get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  };

  return {
    get,
    list: () => (listStmt.all() as unknown as Row[]).map(toRecord),
    findByTokenHash: (hash) => {
      const r = byHashStmt.get(hash) as Row | undefined;
      return r ? toRecord(r) : null;
    },
    enroll: ({ id, label, tokenHash, now }) => {
      upsertStmt.run(id, label, tokenHash, now);
      return get(id)!;
    },
    setLabel: (id, label) => Number(labelStmt.run(label, id).changes) > 0,
    revoke: (id, now) => {
      if (Number(revokeStmt.run(now, id).changes) > 0) return 'revoked';
      return get(id) ? 'already' : 'missing';
    },
    touch: (id, now) => {
      touchStmt.run(now, id);
    },
  };
}
