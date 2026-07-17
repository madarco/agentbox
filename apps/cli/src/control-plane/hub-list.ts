/**
 * The control box's view of the boxes, merged into `agentbox list`.
 *
 * With a control box configured the PC is a thin client: the control box is the
 * source of truth for cloud boxes, including ones this PC never created (web-UI
 * create / `--via-hub`). `list` therefore asks it, rather than rendering only
 * what happens to be in the local `state.json`.
 *
 * Three constraints shape this:
 *   - `list` must stay instant. One bounded round-trip; on timeout/offline we
 *     render the last successful listing from a cache file and say so.
 *   - A local record is richer than a registration (endpoints, live shell
 *     sessions, agent activity), so an adopted box renders from local state and
 *     the registration only tags it.
 *   - A local cloud record the control box doesn't know about is surfaced as an
 *     orphan rather than hidden or silently pruned — it usually means the box
 *     was destroyed from the hub, and the user should see the leftover.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoxRegistration } from '@agentbox/relay';

/** Bound on the control-box round-trip. `list` is interactive — never stall it. */
const HUB_LIST_TIMEOUT_MS = 1500;

/**
 * How long a fetched listing is reused within one process.
 *
 * `list --watch` redraws every 2s by default, and each redraw rebuilds the row
 * set — so without this, watching would probe + fetch the control box 30x a
 * minute per viewer, and every tick's redraw would wait on the network. Box
 * membership changes on human timescales, so serving a few seconds' old listing
 * to a redraw costs nothing. A one-shot `ls` starts a fresh process and so
 * always fetches.
 */
const HUB_LIST_MEMO_MS = 10_000;

/** In-process memo of the last listing (see {@link HUB_LIST_MEMO_MS}). */
let memo: { at: number; listing: HubListing } | null = null;

/** Where the last successful hub listing is cached for the offline path. */
export function hubBoxesCachePath(): string {
  return join(homedir(), '.agentbox', 'hub-boxes-cache.json');
}

export interface HubListing {
  registrations: BoxRegistration[];
  /** True when these came from the cache because the control box didn't answer. */
  stale: boolean;
  /**
   * ISO time the listing was fetched (the cache's write time when `stale`).
   * Undefined when the control box didn't answer and there was no cache — we
   * have no listing at all, rather than an old one.
   */
  fetchedAt?: string;
}

interface CacheFile {
  version: 1;
  fetchedAt: string;
  registrations: BoxRegistration[];
}

/**
 * Fetch the control box's registrations, falling back to the on-disk cache.
 * Returns null when no control box is configured (the plain local path) — the
 * caller then behaves exactly as before this feature existed.
 */
export async function fetchHubListing(): Promise<HubListing | null> {
  const { resolveCustodyTarget } = await import('../commands/control-plane.js');
  const target = await resolveCustodyTarget(undefined, { quiet: true });
  if (!target) return null;

  if (memo && Date.now() - memo.at < HUB_LIST_MEMO_MS) return memo.listing;

  // ONE budget for the whole lookup, spent down by each step — `list` is
  // interactive, so the ceiling has to cover probe + fetch together, not apply
  // to each of them.
  const deadline = Date.now() + HUB_LIST_TIMEOUT_MS;
  const remaining = (): number => deadline - Date.now();
  try {
    // Probe the host before fetching. This is not an optimization: an
    // unreachable control box must not delay `list`, and a `fetch` cannot be
    // made to give up on a TCP connect — `AbortSignal` rejects the promise but
    // undici holds the connecting socket until its own 10s connectTimeout,
    // which keeps the CLI's event loop (and the user's shell) alive long after
    // the table has printed. A socket we open ourselves, we can destroy.
    if ((await hostReachable(target.url, remaining())) && remaining() > 0) {
      const { ControlPlaneAdminClient } = await import('./admin-client.js');
      const admin = new ControlPlaneAdminClient({
        ...target,
        fetchImpl: deadlineFetch(AbortSignal.timeout(remaining())),
      });
      // No race-and-walk-away: the signal aborts the request at the deadline,
      // so a slow control box throws here and we fall through to the cache.
      const registrations = await admin.listBoxes();
      const fetchedAt = new Date().toISOString();
      await writeCache({ version: 1, fetchedAt, registrations }).catch(() => {});
      return remember({ registrations, stale: false, fetchedAt });
    }
  } catch {
    // fall through to the cache
  }
  const cached = await readCache();
  // No cache either: we know nothing about the hub's boxes right now. Say that,
  // rather than presenting an empty list as a fresh-as-of-now answer. Memoized
  // like a success, so a watch loop against a down control box doesn't retry
  // (and re-probe) on every redraw.
  if (!cached) return remember({ registrations: [], stale: true });
  return remember({ registrations: cached.registrations, stale: true, fetchedAt: cached.fetchedAt });
}

/** Memoize a listing for the rest of this process's {@link HUB_LIST_MEMO_MS} window. */
function remember(listing: HubListing): HubListing {
  memo = { at: Date.now(), listing };
  return listing;
}

/** Wrap fetch so every request shares one deadline `signal`. */
function deadlineFetch(signal: AbortSignal): typeof fetch {
  return ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(url, { ...init, signal })) as typeof fetch;
}

/**
 * Whether `url`'s host accepts a TCP connection within `ms`. The socket is
 * always destroyed, so a down host leaves nothing holding the event loop.
 */
export async function hostReachable(url: string, ms: number): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: parsed.hostname, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function writeCache(data: CacheFile): Promise<void> {
  const path = hubBoxesCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(hubBoxesCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.registrations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Human age of a cached listing, e.g. `3m`. */
export function cacheAge(fetchedAt: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(fetchedAt));
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

