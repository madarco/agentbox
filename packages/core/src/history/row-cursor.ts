import { bindingsForBox } from './bindings.js';
import type { ShippedAgent } from './shipper.js';
import type {
  AgentHistorySqliteSource,
  AgentHistorySqliteTable,
  AgentHistoryTranscripts,
  HistoryBinding,
} from './types.js';

/**
 * The row cursor: turns a live sqlite store (opencode, openclaw) into one append-only
 * JSONL file per bound session, which the byte-tailing shipper then ships like
 * any other transcript. Data-driven by the agent's `sqlite` block, so the edge
 * still loads no agent code.
 *
 * Each new or changed row becomes one line `{t, id, u, row}`. Which rows were
 * written, and at which `updated` value, lives in `<sessionId>.cursor.json`
 * beside the output, so both share a fate (the same volume, the same wipe). A
 * crash between the append and the cursor write re-writes rows on the next
 * pass; parsers dedupe by id.
 */

export interface HistoryRowVersion {
  id: string;
  u: number;
  /** The `parent.column` value, when the table has a parent. */
  parent?: string;
}

/** One open db. */
export interface HistoryRowSource {
  versions(t: AgentHistorySqliteTable, sessionId: string): HistoryRowVersion[];
  /** The rows of one session with these ids (an id may repeat across sessions). */
  rows(
    t: AgentHistorySqliteTable,
    sessionId: string,
    ids: string[],
  ): Array<Record<string, unknown>>;
  /** Every distinct session id in `table.column` (a `sessions` source). */
  sessions(table: string, column: string): string[];
  close(): void;
}

export interface HistoryRowFiles {
  readText(path: string): Promise<string | null>;
  append(path: string, text: string): Promise<void>;
  /** Replace the file's content (write-then-rename). */
  writeText(path: string, text: string): Promise<void>;
  /** Move a file; a missing source is not an error. */
  rename(from: string, to: string): Promise<void>;
  /** A change marker for the db (its and its WAL's mtime/size), or null when absent. */
  stamp(path: string): Promise<string | null>;
}

export interface HistoryRowCursorOptions {
  agents: ShippedAgent[];
  boxId: string;
  readBindings(): Promise<HistoryBinding[]>;
  /** Bind a session found by a `sessions` source to this box (the binding log). */
  bind?(agent: string, sessionId: string): Promise<void> | void;
  /** Open the db read-only, or null when it cannot be (absent, no driver). */
  open(path: string): HistoryRowSource | null;
  files: HistoryRowFiles;
  now?: () => number;
}

export interface RowCursorStats {
  sessions: number;
  rows: number;
  errors: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$/;
const ROWS_PER_QUERY = 200;

/** Identifiers are interpolated into sql: a spec with anything else is refused. */
export function validSqliteSource(src: AgentHistorySqliteSource | undefined): boolean {
  if (!src || typeof src.db !== 'string' || !src.db || src.db.split('/').includes('..')) {
    return false;
  }
  if (!Array.isArray(src.tables) || src.tables.length === 0) return false;
  return (
    src.tables.every(
      (t) =>
        IDENT.test(t.name) &&
        IDENT.test(t.id) &&
        IDENT.test(t.session) &&
        IDENT.test(t.updated) &&
        (!t.parent || (IDENT.test(t.parent.column) && IDENT.test(t.parent.table))) &&
        (!t.zstd || (IDENT.test(t.zstd.column) && IDENT.test(t.zstd.into))),
    ) &&
    (!src.sessions || (IDENT.test(src.sessions.table) && IDENT.test(src.sessions.column)))
  );
}

/** The agents' snapshot sources the row cursor can run. */
export function snapshotSources(agents: ShippedAgent[]): Array<{
  agent: ShippedAgent;
  t: AgentHistoryTranscripts & { sqlite: AgentHistorySqliteSource };
}> {
  const out: Array<{
    agent: ShippedAgent;
    t: AgentHistoryTranscripts & { sqlite: AgentHistorySqliteSource };
  }> = [];
  for (const agent of agents) {
    for (const t of agent.spec.transcripts) {
      if (t.mode !== 'snapshot' || t.sessionFiles.length !== 1) continue;
      if (!validSqliteSource(t.sqlite)) continue;
      out.push({ agent, t: t as AgentHistoryTranscripts & { sqlite: AgentHistorySqliteSource } });
    }
  }
  return out;
}

type Cursor = Record<string, Record<string, number>>;

const DIGITS = /^\d{1,15}$/;

/** Integer ids (openclaw's per-session `seq`) in number order, before any other id. */
function compareIds(a: string, b: string): number {
  const da = DIGITS.test(a);
  const db = DIGITS.test(b);
  if (da && db) return Number(a) - Number(b);
  if (da !== db) return da ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function parseCursor(text: string | null): { box?: string; rows: Cursor } {
  if (!text) return { rows: {} };
  try {
    const v = JSON.parse(text) as { box?: unknown; rows?: unknown };
    return {
      ...(typeof v.box === 'string' && v.box ? { box: v.box } : {}),
      rows: v.rows && typeof v.rows === 'object' ? (v.rows as Cursor) : {},
    };
  } catch {
    return { rows: {} };
  }
}

/** JSON for a sqlite row: bigints as numbers, blobs dropped (none are transcript text). */
function rowLine(table: string, id: string, u: number, row: Record<string, unknown>): string {
  return JSON.stringify({ t: table, id, u, row }, (_k, v: unknown) => {
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Uint8Array) return null;
    return v;
  });
}

export class HistoryRowCursor {
  /**
   * Last db stamp per agent, set only when that pass left no row waiting to
   * settle: an unchanged db is then not reopened.
   */
  private readonly stamps = new Map<string, string>();

  constructor(private readonly opts: HistoryRowCursorOptions) {}

  get active(): boolean {
    return snapshotSources(this.opts.agents).length > 0;
  }

  async pass(opts: { final?: boolean } = {}): Promise<RowCursorStats> {
    const stats: RowCursorStats = { sessions: 0, rows: 0, errors: [] };
    const sources = snapshotSources(this.opts.agents);
    if (sources.length === 0) return stats;
    let bindings: HistoryBinding[];
    try {
      bindings = bindingsForBox(await this.opts.readBindings(), this.opts.boxId);
    } catch (e) {
      stats.errors.push(`bindings: ${e instanceof Error ? e.message : String(e)}`);
      return stats;
    }
    for (const { agent, t } of sources) {
      const ids = [
        ...new Set(
          bindings
            .filter((b) => b.agent === agent.agent && SESSION_ID.test(b.sessionId))
            .map((b) => b.sessionId),
        ),
      ];
      const discover = t.sqlite.sessions;
      if (ids.length === 0 && !discover) continue;
      const dbPath = join(agent.configDir, t.sqlite.db);
      const stampKey = `${agent.agent}\0${dbPath}\0${String(ids.length)}`;
      const stamp = await this.opts.files.stamp(dbPath).catch(() => null);
      if (stamp === null) continue;
      if (!opts.final && this.stamps.get(stampKey) === stamp) continue;
      let db: HistoryRowSource | null = null;
      try {
        db = this.opts.open(dbPath);
        if (!db) continue;
        const found = new Set<string>();
        if (discover) {
          const known = new Set(ids);
          for (const id of db.sessions(discover.table, discover.column)) {
            if (!SESSION_ID.test(id) || known.has(id)) continue;
            known.add(id);
            found.add(id);
            ids.push(id);
          }
        }
        let pending = false;
        for (const sessionId of ids) {
          const r = await this.copySession(agent, t, db, sessionId, opts.final === true);
          // Bound only after the copy: an output inherited from another box
          // has been moved aside by then, so no shipper sees it as this box's.
          if (found.has(sessionId)) await this.opts.bind?.(agent.agent, sessionId);
          pending ||= r.pending;
          if (r.written > 0) {
            stats.sessions++;
            stats.rows += r.written;
          }
        }
        // Rows settling since this pass change nothing on disk: keep polling.
        if (pending) this.stamps.delete(stampKey);
        else this.stamps.set(stampKey, stamp);
      } catch (e) {
        stats.errors.push(`${agent.agent}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        db?.close();
      }
    }
    return stats;
  }

  private async copySession(
    agent: ShippedAgent,
    t: AgentHistoryTranscripts & { sqlite: AgentHistorySqliteSource },
    db: HistoryRowSource,
    sessionId: string,
    final: boolean,
  ): Promise<{ written: number; pending: boolean }> {
    const root = t.root.replace(/<projectKey>/g, agent.projectKey);
    const out = join(agent.configDir, root, t.sessionFiles[0]!.replace(/<sessionId>/g, sessionId));
    const cursorPath = out.replace(/\.jsonl$/, '') + '.cursor.json';
    const parsed = parseCursor(await this.opts.files.readText(cursorPath));
    const cursor = parsed.rows;
    const writeCursor = () =>
      this.opts.files.writeText(
        cursorPath,
        JSON.stringify({ v: 1, box: this.opts.boxId, rows: cursor }),
      );
    if (parsed.box !== this.opts.boxId) {
      // A restored backup or a box made from a checkpoint carries another
      // box's output and cursor. That box already shipped those rows: move its
      // file aside (out of the session glob) and keep the row map, so this
      // box's file holds only rows it copies itself. A cursor with no box
      // predates the field and is this box's own.
      if (parsed.box) {
        await this.opts.files.rename(out, `${out}.from-${parsed.box}`);
      }
      await writeCursor();
    }
    const now = (this.opts.now ?? Date.now)();
    const lines: string[] = [];
    let pending = false;
    for (const table of t.sqlite.tables) {
      const seen = (cursor[table.name] ??= {});
      const parentSeen = table.parent ? (cursor[table.parent.table] ?? {}) : null;
      const settle = table.settleMs ?? 0;
      const changed = db.versions(table, sessionId).filter((v) => seen[v.id] !== v.u);
      const due = changed
        .filter(
          (v) =>
            (final || now - v.u >= settle) &&
            (!parentSeen || (v.parent !== undefined && parentSeen[v.parent] !== undefined)),
        )
        .sort((a, b) => a.u - b.u || compareIds(a.id, b.id));
      for (let i = 0; i < due.length; i += ROWS_PER_QUERY) {
        const batch = due.slice(i, i + ROWS_PER_QUERY);
        const rowsById = new Map(
          db
            .rows(
              table,
              sessionId,
              batch.map((v) => v.id),
            )
            .map((r) => [String(r[table.id]), r]),
        );
        for (const v of batch) {
          const row = rowsById.get(v.id);
          if (!row) continue;
          lines.push(rowLine(table.name, v.id, v.u, row));
          seen[v.id] = v.u;
        }
      }
      if (due.length < changed.length) pending = true;
    }
    if (lines.length === 0) return { written: 0, pending };
    await this.opts.files.append(out, `${lines.join('\n')}\n`);
    await writeCursor();
    return { written: lines.length, pending };
  }
}
