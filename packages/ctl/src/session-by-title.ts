/**
 * Which agent session is on screen, matched by the pane title.
 *
 * For an agent whose TUI can switch sessions without telling its plugin (opencode:
 * a `/sessions` switch and `/new` emit no event, Phase 0 of
 * docs/agent-live-status-plan.md), the reported id is stale until the next
 * prompt. The pane title does follow the switch, so the reporter matches the
 * cleaned title against the titles of this box's own sessions and prefers a hit.
 *
 * Only this box's sessions are candidates: the agent's session store sits on a
 * config volume every box of that agent shares, so "the latest row" is another
 * box's as often as this one's. The candidates are the ids this box bound in its
 * history binding log.
 *
 * Agent-neutral on purpose: the agent id and where its titles live are
 * parameters ({@link SqliteTitleSource}); the reporter's resolver table supplies
 * them.
 */
import { readFileSync, statSync } from 'node:fs';
import { bindingsForBox, parseBindingLog } from '@agentbox/core';
import { loadSqlite } from './history-shipper.js';
import { currentBoxId, HISTORY_BINDINGS_PATH } from './session-pointer.js';

export interface SessionCandidate {
  id: string;
  title: string;
  /** Epoch ms; larger is newer. */
  updated: number;
}

/** Where an agent keeps its session titles: one sqlite table of root sessions. */
export interface SqliteTitleSource {
  /** Agent id, as it appears in the binding log. */
  agent: string;
  /** Absolute path of the sqlite db. */
  db: string;
  table: string;
  idColumn: string;
  titleColumn: string;
  updatedColumn: string;
  /** Rows with a non-null value here are subagent sessions and never shown. */
  parentColumn?: string;
}

/** How many of the box's most recent sessions are considered. */
const MAX_CANDIDATES = 50;

const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The pane title with a truncation ellipsis removed. */
function titleStem(title: string): string {
  return title.replace(/(?:…|\.\.\.)\s*$/u, '').trim();
}

/**
 * Pure: the candidate whose title the pane shows, else `reported`.
 *
 * The pane can carry only a prefix of the title (opencode cuts long ones), so a
 * candidate matches when its title starts with the stem. Several can (two
 * sessions named alike): the reported one wins if it is among them, else the
 * newest.
 */
export function pickSessionByTitle(
  paneTitle: string | null,
  candidates: readonly SessionCandidate[],
  reported: string | undefined,
): string | undefined {
  if (!paneTitle) return reported;
  const stem = titleStem(paneTitle);
  if (stem.length === 0) return reported;
  const hits = candidates.filter((c) => c.title.trim().startsWith(stem));
  if (hits.length === 0) return reported;
  if (reported && hits.some((h) => h.id === reported)) return reported;
  return [...hits].sort((a, b) => b.updated - a.updated)[0]?.id ?? reported;
}

/** This box's bound session ids for `agent`, newest binding first. */
function boundSessionIds(path: string, boxId: string, agent: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const mine = bindingsForBox(parseBindingLog(text), boxId).filter((b) => b.agent === agent);
  for (let i = mine.length - 1; i >= 0 && out.length < MAX_CANDIDATES; i--) {
    const id = mine[i]!.sessionId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Read the candidates: this box's bound root sessions with their titles. Empty on
 * any failure (no node:sqlite, no db yet, a schema the source does not match):
 * the caller then keeps the reported id.
 */
export function readSessionCandidates(
  source: SqliteTitleSource,
  opts: { bindings?: string; boxId?: string } = {},
): SessionCandidate[] {
  const cols = [source.table, source.idColumn, source.titleColumn, source.updatedColumn];
  if (source.parentColumn) cols.push(source.parentColumn);
  if (!cols.every((c) => SQL_NAME.test(c))) return [];
  const ids = boundSessionIds(
    opts.bindings ?? HISTORY_BINDINGS_PATH,
    opts.boxId ?? currentBoxId(),
    source.agent,
  );
  if (ids.length === 0) return [];
  const mod = loadSqlite();
  if (!mod) return [];
  let db: InstanceType<typeof mod.DatabaseSync> | undefined;
  try {
    db = new mod.DatabaseSync(source.db, { readOnly: true });
    const marks = ids.map(() => '?').join(', ');
    const root = source.parentColumn ? `${source.parentColumn} IS NULL AND ` : '';
    return db
      .prepare(
        `SELECT ${source.idColumn} AS id, ${source.titleColumn} AS title, ${source.updatedColumn} AS u ` +
          `FROM ${source.table} WHERE ${root}${source.idColumn} IN (${marks})`,
      )
      .all(...ids)
      .filter((r) => typeof r.title === 'string')
      .map((r) => ({ id: String(r.id), title: String(r.title), updated: Number(r.u) || 0 }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A reporter resolver for one agent's sqlite title source.
 *
 * Runs on every snapshot (the 15s heartbeat included), so the answer is cached
 * on its inputs: the title, the reported id and the binding log's size and
 * mtime (a new session of this box appends to it). A rename shows up as a new
 * title. The log and the db are read again only when one of those moved.
 */
export function sessionByTitleResolver(
  source: SqliteTitleSource,
): (paneTitle: string | null, reported: string | undefined) => string | undefined {
  let cache: { key: string; result: string | undefined } | null = null;
  return (paneTitle, reported) => {
    if (!paneTitle) return reported;
    let stamp = '';
    try {
      const st = statSync(HISTORY_BINDINGS_PATH);
      stamp = `${String(st.size)}:${String(st.mtimeMs)}`;
    } catch {
      return reported; // no bindings yet: nothing of this box's to match
    }
    const key = `${paneTitle}\0${reported ?? ''}\0${stamp}`;
    if (cache?.key === key) return cache.result;
    const result = pickSessionByTitle(paneTitle, readSessionCandidates(source), reported);
    cache = { key, result };
    return result;
  };
}
