/**
 * Which opencode session is on screen.
 *
 * The plugin reports the root session that last went busy, but a TUI
 * `/sessions` switch and `/new` emit no event at all (Phase 0,
 * docs/agent-live-status-plan.md), so after a switch the plugin's id is stale
 * until the next prompt. The pane title does follow the switch
 * (`OC | <title, cut at about 40 chars>…`), so the reporter matches the cleaned
 * title against the titles of this box's own root sessions and prefers a hit.
 *
 * Only this box's sessions are candidates: opencode's sqlite db is on the config
 * volume every opencode box shares, so "the latest row" is another box's as
 * often as this one's. The candidates are the ids in this box's binding log.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bindingsForBox, parseBindingLog } from '@agentbox/core';
import { loadSqlite } from './history-shipper.js';
import { currentBoxId, HISTORY_BINDINGS_PATH } from './session-pointer.js';

export interface SessionCandidate {
  id: string;
  title: string;
  /** Epoch ms; larger is newer. */
  updated: number;
}

/** How many of the box's most recent sessions are considered. */
const MAX_CANDIDATES = 50;

const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

/** The pane title with opencode's truncation ellipsis removed. */
function titleStem(title: string): string {
  return title.replace(/(?:…|\.\.\.)\s*$/u, '').trim();
}

/**
 * Pure: the candidate whose title the pane shows, else `reported`.
 *
 * The pane carries a prefix of the title (opencode cuts long ones), so a
 * candidate matches when its title starts with the stem. Several can (two
 * sessions named alike): the reported one wins if it is among them, else the
 * newest.
 */
export function pickOpencodeSession(
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

/** This box's bound opencode session ids, newest binding first. */
function boundSessionIds(path: string, boxId: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const mine = bindingsForBox(parseBindingLog(text), boxId).filter((b) => b.agent === 'opencode');
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
 * any failure (no node:sqlite, no db yet, a schema this code doesn't know): the
 * caller then keeps the plugin's id.
 */
export function readOpencodeCandidates(
  opts: { db?: string; bindings?: string; boxId?: string } = {},
): SessionCandidate[] {
  const ids = boundSessionIds(opts.bindings ?? HISTORY_BINDINGS_PATH, opts.boxId ?? currentBoxId());
  if (ids.length === 0) return [];
  const mod = loadSqlite();
  if (!mod) return [];
  let db: InstanceType<typeof mod.DatabaseSync> | undefined;
  try {
    db = new mod.DatabaseSync(opts.db ?? OPENCODE_DB, { readOnly: true });
    const marks = ids.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT id, title, time_updated AS u FROM session WHERE parent_id IS NULL AND id IN (${marks})`,
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

let cache: { key: string; result: string | undefined } | null = null;

/**
 * The reporter's hook: resolve opencode's current session from its pane title.
 *
 * Runs on every snapshot (the 15s heartbeat included), so the answer is cached
 * on its inputs: the title, the reported id and the binding log's size and
 * mtime (a new session of this box appends to it). A rename shows up as a new
 * title. The log and the db are read again only when one of those moved.
 */
export function resolveOpencodeSession(
  paneTitle: string | null,
  reported: string | undefined,
): string | undefined {
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
  const result = pickOpencodeSession(paneTitle, readOpencodeCandidates(), reported);
  cache = { key, result };
  return result;
}
