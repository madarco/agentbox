/**
 * The in-box history shipper (docs/agent-history-plan.md, Phase 1): tails the
 * sessions this box's binding log names and ships them to the hub over the
 * existing relay channel (`history.chunk` RPCs; the cloud poller drains them on
 * a cloud box). Docker boxes are shipped host-side by the relay instead, which
 * `history.config` tells us by answering `enabled: false`.
 */
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  HistoryRowCursor,
  HistoryShipper,
  createRedactor,
  parseBindingLog,
  secretValuesFromEnv,
  secretValuesFromJson,
  type HistoryConfigReply,
  type HistoryFileSource,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryRowFiles,
  type HistoryRowSource,
  type ShipStats,
  type ShippedAgent,
} from '@agentbox/core';
import { postRpcAwait, relayNotReady, type RelayRpcResult } from './relay-rpc.js';
import { resolveRelayEnv } from './relay-env.js';
import { HISTORY_BINDINGS_PATH, appendHistoryBinding, currentBoxId } from './session-pointer.js';

/** Raw frame cap: base64 of this plus the JSON envelope stays under the relay's 1 MiB `/rpc` cap. */
export const CTL_FRAME_MAX = 512 * 1024;
const RPC_TIMEOUT_MS = 60_000;

export class RpcTimeout extends Error {}

async function rpc(method: string, params: unknown): Promise<RelayRpcResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcTimeout(`${method} timed out`)), RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([postRpcAwait(method, params, { quiet: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `history.config`, classified:
 *  - `ok`: the relay answered.
 *  - `unsupported`: it answered with something else (a relay predating history
 *    returns 501 and records an `rpc-unknown` event per call), so do not ask
 *    again for a while.
 *  - `unreachable`: no usable answer yet (no relay env, transport error, or a
 *    relay that does not know this box yet), so retry on the next tick.
 * A timeout throws `RpcTimeout`.
 */
export type HistoryConfigFetch =
  | { kind: 'ok'; config: HistoryConfigReply }
  | { kind: 'unsupported' }
  | { kind: 'unreachable' };

export async function fetchHistoryConfig(): Promise<HistoryConfigFetch> {
  const r = await rpc('history.config', {});
  if (relayNotReady(r)) return { kind: 'unreachable' };
  if (r.exitCode !== 0) return { kind: 'unsupported' };
  try {
    const v = JSON.parse(r.stdout) as Partial<HistoryConfigReply>;
    if (typeof v.enabled !== 'boolean') return { kind: 'unsupported' };
    return {
      kind: 'ok',
      config: {
        enabled: v.enabled,
        ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
        agents: Array.isArray(v.agents) ? v.agents : [],
        ...(Array.isArray(v.materialize) ? { materialize: v.materialize } : {}),
        credentialFiles: Array.isArray(v.credentialFiles)
          ? v.credentialFiles.filter((p): p is string => typeof p === 'string')
          : [],
      },
    };
  } catch {
    return { kind: 'unsupported' };
  }
}

export const rpcHistorySink = {
  async ingest(frame: HistoryFrame): Promise<HistoryIngestResult> {
    const r = await rpc('history.chunk', frame);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        code: 'unavailable',
        message: `relay answered exit ${String(r.exitCode)}`,
      };
    }
    try {
      return JSON.parse(r.stdout) as HistoryIngestResult;
    } catch {
      return { ok: false, code: 'unavailable', message: 'unparseable relay reply' };
    }
  },
};

export const localFileSource: HistoryFileSource = {
  async readBindings() {
    try {
      return parseBindingLog(await readFile(HISTORY_BINDINGS_PATH, 'utf8'));
    } catch {
      return [];
    }
  },
  async size(path) {
    try {
      const s = await stat(path);
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  },
  async read(path, offset, length) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return null;
    }
  },
};

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export type SqliteModule = {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
};

/**
 * `node:sqlite` when this node has it (22.5+). Through `getBuiltinModule` so the
 * Node 20 boxes some providers still bake load ctl fine and just skip the row
 * cursor.
 */
export function loadSqlite(): SqliteModule | null {
  try {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return (get?.('node:sqlite') as SqliteModule | undefined) ?? null;
  } catch {
    return null;
  }
}

type ZstdDecompress = (buf: Uint8Array, opts?: { maxOutputLength?: number }) => Buffer;

function loadZstd(): ZstdDecompress | null {
  try {
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const zlib = get?.('node:zlib') as { zstdDecompressSync?: ZstdDecompress } | undefined;
    return zlib?.zstdDecompressSync ?? null;
  } catch {
    return null;
  }
}

/** openclaw caps a compressed event at 4 MiB of text. */
const ZSTD_MAX_OUTPUT = 8 * 1024 * 1024;

const ZSTD = loadZstd();

/**
 * Replace a zstd blob with its text. Throws when this node has no zstd (added
 * in 22.15/23.8), so the pass fails and the row is retried, never copied empty.
 * A frame that does not decode is copied without its text, flagged
 * `<column>_error`: retrying it would stall every session behind it.
 */
export function decodeZstdColumn(
  row: Record<string, unknown>,
  column: string,
  into: string,
  zstd: ZstdDecompress | null = ZSTD,
): void {
  const blob = row[column];
  if (!(blob instanceof Uint8Array)) return;
  if (!zstd) throw new Error(`no zstd in this node: cannot decode ${column}`);
  try {
    row[into] = zstd(blob, { maxOutputLength: ZSTD_MAX_OUTPUT }).toString('utf8');
  } catch (e) {
    row[into] = null;
    row[`${column}_error`] = e instanceof Error ? e.message : String(e);
  }
  delete row[column];
}

/** A read-only `node:sqlite` handle behind the row cursor's seam. */
export function openSqliteRowSource(path: string): HistoryRowSource | null {
  const mod = loadSqlite();
  if (!mod) return null;
  let db: SqliteDb;
  try {
    db = new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
  // Identifiers were validated by `snapshotSources` (plain sql names only).
  return {
    versions(t, sessionId) {
      const parent = t.parent ? `, ${t.parent.column} AS p` : '';
      return db
        .prepare(
          `SELECT ${t.id} AS id, ${t.updated} AS u${parent} FROM ${t.name} WHERE ${t.session} = ?`,
        )
        .all(sessionId)
        .map((r) => ({
          id: String(r.id),
          u: Number(r.u),
          ...(t.parent && r.p !== null && r.p !== undefined ? { parent: String(r.p) } : {}),
        }));
    },
    rows(t, sessionId, ids) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM ${t.name} WHERE ${t.session} = ? AND ${t.id} IN (${marks})`)
        .all(sessionId, ...ids);
      if (t.zstd) for (const r of rows) decodeZstdColumn(r, t.zstd.column, t.zstd.into);
      return rows;
    },
    sessions(table, column) {
      return db
        .prepare(`SELECT DISTINCT ${column} AS s FROM ${table} WHERE ${column} IS NOT NULL`)
        .all()
        .map((r) => String(r.s));
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export const localRowFiles: HistoryRowFiles = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async append(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, 'utf8');
  },
  async writeText(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  },
  async rename(from, to) {
    try {
      await rename(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  },
  async stamp(path) {
    const one = async (p: string): Promise<string> => {
      try {
        const s = await stat(p);
        return `${String(s.mtimeMs)}:${String(s.size)}`;
      } catch {
        return '-';
      }
    };
    const main = await one(path);
    if (main === '-') return null;
    return `${main}|${await one(`${path}-wal`)}`;
  },
};

export function buildRowCursor(agents: ShippedAgent[]): HistoryRowCursor {
  return new HistoryRowCursor({
    agents,
    boxId: currentBoxId(),
    readBindings: () => localFileSource.readBindings(),
    bind: (agent, sessionId) => appendHistoryBinding(agent, sessionId),
    open: openSqliteRowSource,
    files: localRowFiles,
  });
}

async function boxSecrets(credentialFiles: readonly string[]): Promise<string[]> {
  const out = secretValuesFromEnv(process.env);
  const { token } = resolveRelayEnv();
  if (token) out.push(token);
  for (const p of credentialFiles) {
    try {
      out.push(...secretValuesFromJson(await readFile(p.replace(/^~(?=\/)/, homedir()), 'utf8')));
    } catch {
      /* no such file in this box */
    }
  }
  return out;
}

export async function buildShipper(cfg: HistoryConfigReply): Promise<HistoryShipper> {
  return new HistoryShipper({
    // The relay replaces the box id from the box's own token; this is a hint.
    // Must equal the box id the capture hook stamps on binding lines: the
    // shipper drops lines from other boxes (a checkpoint carries the log).
    // The relay still replaces it from the box's own token.
    origin: { boxId: currentBoxId() },
    agents: cfg.agents,
    source: localFileSource,
    sink: rpcHistorySink,
    redactor: createRedactor({ secrets: await boxSecrets(cfg.credentialFiles ?? []) }),
    frameMax: CTL_FRAME_MAX,
  });
}

/**
 * The daemon's loop. Never blocks startup and never throws. With the host
 * unreachable an RPC parks on the in-box relay with no timeout of its own, so
 * a timed-out pass backs off (up to 10 min) instead of stacking more parked
 * actions every tick.
 */
export class HistoryLoop {
  private timer: NodeJS.Timeout | null = null;
  private shipper: HistoryShipper | null = null;
  private rowCursor: HistoryRowCursor | null = null;
  private configAt = 0;
  private delayMs: number;
  private stopped = false;

  constructor(
    private readonly opts: {
      intervalMs?: number;
      log?: (line: string) => void;
      /** Tests: the config RPC and the shipper factory. */
      fetchConfig?: () => Promise<HistoryConfigFetch>;
      makeShipper?: (cfg: HistoryConfigReply) => Promise<HistoryShipper>;
      makeRowCursor?: (agents: ShippedAgent[]) => HistoryRowCursor;
    } = {},
  ) {
    this.delayMs = opts.intervalMs ?? 30_000;
  }

  start(firstDelayMs = 20_000): void {
    this.schedule(firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  async tick(final = false): Promise<ShipStats | null> {
    const base = this.opts.intervalMs ?? 30_000;
    let stats: ShipStats | null = null;
    try {
      // A disabled answer (a docker box, an opted-out project) is cached like an
      // enabled one, so it is asked again every 10 min rather than every tick.
      const stale = Date.now() - this.configAt > 10 * 60_000;
      if (stale || (this.shipper?.isDisabled ?? false)) {
        const res = await (this.opts.fetchConfig ?? fetchHistoryConfig)();
        // Only "no answer at all" is retried next tick; any answer, including
        // an older relay's refusal, is remembered for the 10-minute window.
        if (res.kind !== 'unreachable') this.configAt = Date.now();
        this.shipper =
          res.kind === 'ok' && res.config.enabled
            ? await (this.opts.makeShipper ?? buildShipper)(res.config)
            : null;
        // Snapshot sources (sqlite) are copied into append files in every box,
        // a docker one included: the host relay ships those files there.
        const snapshotAgents =
          res.kind !== 'ok'
            ? []
            : res.config.enabled
              ? res.config.agents
              : (res.config.materialize ?? []);
        const cursor = (this.opts.makeRowCursor ?? buildRowCursor)(snapshotAgents);
        this.rowCursor = cursor.active ? cursor : null;
      }
      if (this.rowCursor) {
        const r = await this.rowCursor.pass({ final });
        for (const e of r.errors) this.opts.log?.(`history: row cursor: ${e}`);
      }
      if (this.shipper) stats = await this.shipper.pass({ final });
      const timedOut = stats?.errors.some((e) => e.includes('timed out')) ?? false;
      this.delayMs = timedOut ? Math.min(this.delayMs * 2, 10 * 60_000) : base;
    } catch (e) {
      if (e instanceof RpcTimeout) this.delayMs = Math.min(this.delayMs * 2, 10 * 60_000);
      this.opts.log?.(`history: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!final) this.schedule(this.delayMs);
    return stats;
  }
}
