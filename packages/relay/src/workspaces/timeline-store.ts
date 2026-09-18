import { randomBytes } from 'node:crypto';
import { appendFile, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { withFileLock } from '@agentbox/config';
import {
  canonicalWorkspaceRoot,
  listWorkspaces,
  resolveWorkspaceDir,
  timelineFile,
  workspaceForBox,
  WORKSPACE_LOCK,
  type BoxWorkspaceKey,
} from './workspace-store.js';
import type { TimelineEvent, TimelineStamp, WorkspaceRecord } from './types.js';

/** Compaction triggers past this many lines, and keeps the newest `TIMELINE_KEEP_LINES`. */
export const TIMELINE_MAX_LINES = 5000;
/**
 * Below the trigger on purpose: compacting back to exactly the limit would
 * rewrite the whole file on every append once a workspace reached it.
 */
export const TIMELINE_KEEP_LINES = 4000;
export const TIMELINE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** What a writer supplies; `id` and `at` are stamped when absent. */
export type TimelineEventInput = Omit<TimelineEvent, 'id' | 'at'> & { id?: string; at?: string };

let lastIdMs = -1;
let lastIdSeq = 0;

/**
 * Zero-padded so ids sort lexicographically in time order, like the events they
 * name. Within ONE millisecond the suffix counts up, because a reader breaks a
 * timestamp tie with the id and the row written second is the newer one — a
 * purely random suffix put two rows of the same millisecond in either order.
 * Each millisecond starts from a random point, so two processes appending to one
 * log still do not collide.
 */
export function newTimelineEventId(ms: number = Date.now()): string {
  if (ms === lastIdMs) lastIdSeq = (lastIdSeq + 1) % 0x1000000;
  else {
    lastIdMs = ms;
    lastIdSeq = randomBytes(3).readUIntBE(0, 3);
  }
  return `${ms.toString(36).padStart(9, '0')}-${lastIdSeq.toString(16).padStart(6, '0')}`;
}

/** The actor fields of an event, from a mutation's stamp. */
export function stampFields(
  stamp: TimelineStamp | undefined,
  fallback: TimelineStamp['actor'] = 'human',
): Pick<TimelineEventInput, 'actor' | 'managerId' | 'turn' | 'prompt'> {
  if (!stamp) return { actor: fallback };
  return {
    actor: stamp.actor,
    ...(stamp.managerId ? { managerId: stamp.managerId } : {}),
    ...(stamp.turn !== undefined ? { turn: stamp.turn } : {}),
    ...(stamp.prompt ? { prompt: stamp.prompt } : {}),
  };
}

/**
 * What is known about one log file without re-reading it. The log is written by
 * several processes (the hub, the relay, a queue worker), so the index is
 * refreshed from the file's size on every use: the bytes past the indexed
 * offset are the other writers' appends, and a new inode is a compaction.
 */
interface FileIndex {
  ino: number;
  offset: number;
  lines: number;
  oldestMs: number;
  keys: Set<string>;
}

const indexes = new Map<string, FileIndex>();

function emptyIndex(ino = 0): FileIndex {
  return { ino, offset: 0, lines: 0, oldestMs: Number.POSITIVE_INFINITY, keys: new Set() };
}

function absorb(idx: FileIndex, line: string): void {
  if (!line.trim()) return;
  try {
    const ev = JSON.parse(line) as Partial<TimelineEvent>;
    idx.lines += 1;
    const at = typeof ev.at === 'string' ? Date.parse(ev.at) : Number.NaN;
    if (!Number.isNaN(at) && at < idx.oldestMs) idx.oldestMs = at;
    if (typeof ev.key === 'string') idx.keys.add(ev.key);
  } catch {
    // A torn line from a crashed writer: skipped, and dropped by the next compaction.
  }
}

async function indexOf(file: string): Promise<FileIndex> {
  let st: { ino: number; size: number };
  try {
    st = await stat(file);
  } catch {
    indexes.delete(file);
    return emptyIndex();
  }
  let idx = indexes.get(file);
  if (!idx || idx.ino !== st.ino || st.size < idx.offset) {
    idx = emptyIndex(st.ino);
    indexes.set(file, idx);
  }
  if (st.size === idx.offset) return idx;
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - idx.offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, idx.offset);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    // Only whole lines: a writer mid-append is picked up on the next refresh.
    const end = text.lastIndexOf('\n');
    if (end === -1) return idx;
    for (const line of text.slice(0, end).split('\n')) absorb(idx, line);
    idx.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
  } finally {
    await fh.close();
  }
  return idx;
}

function parseLines(raw: string): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TimelineEvent;
      if (typeof ev.id === 'string' && typeof ev.at === 'string' && typeof ev.type === 'string') {
        out.push(ev);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function byTime(a: TimelineEvent, b: TimelineEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function compact(file: string, now: number): Promise<void> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  const kept = parseLines(raw)
    .filter((ev) => {
      const at = Date.parse(ev.at);
      return Number.isNaN(at) || now - at <= TIMELINE_RETENTION_MS;
    })
    .sort(byTime)
    .slice(-TIMELINE_KEEP_LINES);
  const tmp = `${file}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  await writeFile(tmp, kept.map((ev) => JSON.stringify(ev)).join('\n') + (kept.length ? '\n' : ''));
  await rename(tmp, file);
  indexes.delete(file);
}

async function fileFor(wsId: string): Promise<string | null> {
  const dir = await resolveWorkspaceDir(wsId);
  return dir ? timelineFile(dir) : null;
}

/**
 * Append one event. `null` when the workspace is unknown or the event's `key` is
 * already in the log — the same PR reported by the in-box `gh` shim and by the
 * GitHub sync lands once.
 */
export async function appendTimelineEvent(
  wsId: string,
  input: TimelineEventInput,
  now: () => number = Date.now,
): Promise<TimelineEvent | null> {
  const file = await fileFor(wsId);
  if (!file) return null;
  return withFileLock(
    file,
    async () => {
      const idx = await indexOf(file);
      if (input.key && idx.keys.has(input.key)) return null;
      const ms = now();
      const ev = {
        ...input,
        id: input.id ?? newTimelineEventId(ms),
        at: input.at ?? new Date(ms).toISOString(),
      } as TimelineEvent;
      await appendFile(file, JSON.stringify(ev) + '\n', 'utf8');
      const after = await indexOf(file);
      if (
        after.lines > TIMELINE_MAX_LINES ||
        (Number.isFinite(after.oldestMs) && ms - after.oldestMs > TIMELINE_RETENTION_MS)
      ) {
        await compact(file, ms);
      }
      return ev;
    },
    WORKSPACE_LOCK,
  );
}

/**
 * `appendTimelineEvent` for a writer whose real work already succeeded: a log
 * failure is reported and swallowed, never turned into a failed mutation.
 */
export async function recordTimelineEvent(
  wsId: string,
  input: TimelineEventInput,
): Promise<TimelineEvent | null> {
  try {
    return await appendTimelineEvent(wsId, input);
  } catch (err) {
    console.warn(
      `[timeline] could not record ${input.type} in ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface ReadTimelineOptions {
  /** Only events strictly older than this ISO time. */
  before?: string;
  /** Only events at or after this ISO time. */
  since?: string;
  limit?: number;
}

/** The log, newest first. Ordered by `at`, not by append order: a synced merge lands late. */
export async function readTimeline(
  wsId: string,
  opts: ReadTimelineOptions = {},
): Promise<TimelineEvent[]> {
  const file = await fileFor(wsId);
  if (!file) return [];
  const raw = await readFile(file, 'utf8').catch(() => '');
  let events = parseLines(raw).sort(byTime).reverse();
  if (opts.before) events = events.filter((ev) => ev.at < opts.before!);
  if (opts.since) events = events.filter((ev) => ev.at >= opts.since!);
  return opts.limit !== undefined ? events.slice(0, opts.limit) : events;
}

export async function hasTimelineKey(wsId: string, key: string): Promise<boolean> {
  const file = await fileFor(wsId);
  if (!file) return false;
  return (await indexOf(file)).keys.has(key);
}

/**
 * The workspace a box belongs to, for writers that know its origin and/or the
 * folder its project sits in. A folder is canonicalised first (the records hold
 * realpath'd roots) and only when it is on this machine — another host's path
 * means nothing to `realpath` here.
 */
export async function readWorkspaceForBox(
  key: BoxWorkspaceKey,
  localHost: string = hostname(),
): Promise<WorkspaceRecord | null> {
  return workspaceForBoxIn(await listWorkspaces(), key, localHost);
}

/**
 * `readWorkspaceForBox` over an already-fetched listing, so a reader whose
 * records come from somewhere else (a control box's `GET /workspaces`) makes the
 * identical join, canonicalisation included.
 */
export async function workspaceForBoxIn<
  T extends {
    projects: readonly { repoUrl?: string }[];
    hosts: Record<string, { root: string }>;
  },
>(records: readonly T[], key: BoxWorkspaceKey, localHost: string = hostname()): Promise<T | null> {
  if (records.length === 0) return null;
  const projectRoot =
    key.projectRoot && (key.host ?? localHost) === hostname()
      ? await canonicalWorkspaceRoot(key.projectRoot)
      : key.projectRoot;
  return workspaceForBox(records, { ...key, ...(projectRoot ? { projectRoot } : {}) }, localHost);
}
