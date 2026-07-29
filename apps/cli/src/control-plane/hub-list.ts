/**
 * The box listing `agentbox ls` renders, sourced from the hub's public
 * `/api/v1/boxes` — the SAME wire the tray and web UI read, in BOTH modes (a
 * local hub or a remote control box; the only difference is the base URL + key).
 *
 * Why the API and not the local `~/.agentbox` files: `status.json` is written by
 * whichever relay a box reports to — on a remote hub that is the control box's
 * disk, not this laptop's — so the local files are NOT the source of truth for a
 * thin client. The hub already folds docker boxes, cloud boxes and in-flight
 * `job:` boxes into one shape (its `mapBox`/`mapRegistrationToBox`), so `ls` is a
 * single listing with no client-side merge.
 *
 * Three constraints shape this:
 *   - `ls` must stay instant. One bounded round-trip; on timeout/offline we
 *     render the last successful listing from a cache file and say so.
 *   - A local hub that isn't running is auto-started (via the shared resolver) so
 *     the listing reflects current docker state — the single-path model makes the
 *     local hub the target, not a second reader of `state.json`.
 *   - `--live` is an opt-in, expensive hub-side refresh (`?live=1`): the hub, not
 *     the laptop, now holds the provider credentials to probe cloud state.
 *
 * NOTE: {@link fetchHubListing} + the `hub-merge.ts`/`list-merged.ts` merge below
 * are the OLD `/admin/store` path, kept ONLY for `commands/dashboard.ts` (an
 * IO-plane TUI, out of this step's scope) until it is converted. `agentbox ls`
 * no longer uses them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoxRegistration } from '@agentbox/relay';
// One implementation, shared with the provider packages — see reachability.ts
// for why a plain `fetch` can't be bounded here.
import { deadlineFetch, hostReachable } from '@agentbox/sandbox-cloud';
import { HubApiClient, type HubApiBox } from './hub-api-client.js';

export { hostReachable };

/** Bound on the control-box round-trip. `ls` is interactive — never stall it. */
const HUB_LIST_TIMEOUT_MS = 1500;

/**
 * Bound on a `--live` listing. The hub probes each cloud box's SDK state, so the
 * ceiling has to cover several sequential-ish provider round-trips, not one HTTP
 * call — `--live` is the explicit opt-in slow path.
 */
const HUB_LIST_LIVE_TIMEOUT_MS = 20_000;

/**
 * How long a fetched listing is reused within one process.
 *
 * `ls --watch` redraws every 2s by default, and each redraw rebuilds the row set
 * — so without this, watching would probe + fetch the hub 30x a minute per
 * viewer, and every tick's redraw would wait on the network. Box membership
 * changes on human timescales, so serving a few seconds' old listing to a redraw
 * costs nothing. A one-shot `ls` starts a fresh process and so always fetches.
 * The memo is bypassed entirely under `--live` — each redraw must re-probe.
 */
const HUB_LIST_MEMO_MS = 10_000;

/**
 * How long a FAILED lookup is reused. Much shorter than a success: memoizing
 * "unreachable" is only meant to stop a watch loop re-probing a down hub every
 * tick, but caching it as long as a success would keep boxes hidden for 10s after
 * the hub comes back. This retries every other tick or so at the default 2s
 * interval, which recovers promptly without hammering.
 */
const HUB_LIST_FAIL_MEMO_MS = 3_000;

/** Where the last successful API listing is cached for the offline path. */
export function hubBoxesCachePath(): string {
  return join(homedir(), '.agentbox', 'hub-boxes-cache.json');
}

// ── The API listing (`agentbox ls`) ────────────────────────────────────────

export interface BoxListing {
  boxes: HubApiBox[];
  /** True when these came from the cache because the hub didn't answer. */
  stale: boolean;
  /**
   * Why the listing is stale, when it isn't simply unreachable. `no-token` means
   * a control box IS configured but we have no API key for it — the user needs to
   * know that, rather than watch their hub boxes quietly vanish.
   */
  reason?: 'no-token';
  /**
   * ISO time the listing was fetched (the cache's write time when `stale`).
   * Undefined when the hub didn't answer and there was no cache — we have no
   * listing at all, rather than an old one.
   */
  fetchedAt?: string;
}

interface BoxCacheFile {
  version: 1;
  fetchedAt: string;
  boxes: HubApiBox[];
}

/** In-process memo of the last non-live listing (see {@link HUB_LIST_MEMO_MS}). */
let apiMemo: { at: number; listing: BoxListing } | null = null;

/**
 * Fetch the hub's boxes over `/api/v1/boxes`, falling back to the on-disk cache
 * when the hub can't be reached. Never throws — an unreachable hub yields the
 * cached listing (or an empty one) marked `stale`, so `ls` always prints.
 */
export async function fetchBoxListing(
  opts: { url?: string; live?: boolean } = {},
): Promise<BoxListing> {
  if (!opts.live) {
    const ttl = apiMemo?.listing.stale === true ? HUB_LIST_FAIL_MEMO_MS : HUB_LIST_MEMO_MS;
    if (apiMemo && Date.now() - apiMemo.at < ttl) return apiMemo.listing;
  }

  // A configured control box we have no API key for: say so, rather than dropping
  // every hub box from `ls` with no hint. A local hub always resolves a token.
  const { resolveHubTarget } = await import('../commands/hub.js');
  const probe = await resolveHubTarget(opts.url).catch(() => null);
  if (probe && probe.mode === 'remote' && !probe.token) {
    return remember({ boxes: [], stale: true, reason: 'no-token' }, opts.live);
  }

  // Resolve the API target (autostarts a local hub that isn't running, so `ls`
  // reflects current docker state). Null on a remote missing its key, or a local
  // hub that failed to start — both fall through to the cache below.
  const { resolveHubApiTarget } = await import('../commands/control-plane.js');
  const target = await resolveHubApiTarget(opts.url).catch(() => null);
  if (target) {
    const ceiling = opts.live ? HUB_LIST_LIVE_TIMEOUT_MS : HUB_LIST_TIMEOUT_MS;
    const deadline = Date.now() + ceiling;
    const remaining = (): number => deadline - Date.now();
    try {
      // Probe the host before fetching: an unreachable hub must not delay `ls`,
      // and a `fetch` cannot be made to give up on a TCP connect (undici holds
      // the connecting socket until its own 10s connectTimeout). A socket we open
      // ourselves, we can destroy — see reachability.ts.
      if ((await hostReachable(target.url, remaining())) && remaining() > 0) {
        const client = new HubApiClient({
          ...target,
          fetchImpl: deadlineFetch(AbortSignal.timeout(remaining())),
        });
        const boxes = await client.listBoxes({ live: opts.live });
        const fetchedAt = new Date().toISOString();
        await writeBoxCache({ version: 1, fetchedAt, boxes }).catch(() => {});
        return remember({ boxes, stale: false, fetchedAt }, opts.live);
      }
    } catch {
      // fall through to the cache
    }
  }
  const cached = await readBoxCache();
  // No cache either: we know nothing about the hub's boxes right now. Say that,
  // rather than presenting an empty list as a fresh answer.
  if (!cached) return remember({ boxes: [], stale: true }, opts.live);
  return remember({ boxes: cached.boxes, stale: true, fetchedAt: cached.fetchedAt }, opts.live);
}

/** Memoize a non-live listing for the rest of this process's memo window. */
function remember(listing: BoxListing, live?: boolean): BoxListing {
  if (!live) apiMemo = { at: Date.now(), listing };
  return listing;
}

async function writeBoxCache(data: BoxCacheFile): Promise<void> {
  const path = hubBoxesCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

async function readBoxCache(): Promise<BoxCacheFile | null> {
  try {
    const raw = await readFile(hubBoxesCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as BoxCacheFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.boxes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── The legacy `/admin/store` registration listing (dashboard only) ─────────
// Kept until `commands/dashboard.ts` is converted to `/api/v1`. Its cache is a
// SEPARATE file so it doesn't collide with the API listing's `hub-boxes-cache.json`.

/** Bound on the control-box round-trip. `list` is interactive — never stall it. */
const HUB_LIST_REG_TIMEOUT_MS = 1500;

/** In-process memo of the last registration listing. */
let memo: { at: number; listing: HubListing } | null = null;

/** Where the last successful registration listing is cached (dashboard offline path). */
function hubRegistrationsCachePath(): string {
  return join(homedir(), '.agentbox', 'hub-registrations-cache.json');
}

export interface HubListing {
  registrations: BoxRegistration[];
  /** True when these came from the cache because the control box didn't answer. */
  stale: boolean;
  /**
   * Why the listing is stale, when it isn't simply unreachable. `no-token` means
   * a control box IS configured but we have no admin bearer for it.
   */
  reason?: 'no-token';
  /** ISO time the listing was fetched (the cache's write time when `stale`). */
  fetchedAt?: string;
}

interface CacheFile {
  version: 1;
  fetchedAt: string;
  registrations: BoxRegistration[];
}

/**
 * Fetch the control box's registrations, falling back to the on-disk cache.
 * Returns null when no control box is configured (the plain local path).
 *
 * @deprecated The `/admin/store` path — kept only for `commands/dashboard.ts`
 * until it is converted to `/api/v1`. `agentbox ls` uses {@link fetchBoxListing}.
 */
export async function fetchHubListing(): Promise<HubListing | null> {
  const { resolveCustodyTarget } = await import('../commands/control-plane.js');
  const target = await resolveCustodyTarget(undefined, { quiet: true });
  if (!target) {
    const { loadEffectiveConfig } = await import('@agentbox/config');
    const { remoteHubConfigured } = await import('./remote-hub.js');
    const configured = await loadEffectiveConfig(process.cwd())
      .then((c) => remoteHubConfigured(c.effective))
      .catch(() => false);
    return configured ? { registrations: [], stale: true, reason: 'no-token' } : null;
  }

  const memoTtl = memo?.listing.stale === true ? HUB_LIST_FAIL_MEMO_MS : HUB_LIST_MEMO_MS;
  if (memo && Date.now() - memo.at < memoTtl) return memo.listing;

  const deadline = Date.now() + HUB_LIST_REG_TIMEOUT_MS;
  const remaining = (): number => deadline - Date.now();
  try {
    if ((await hostReachable(target.url, remaining())) && remaining() > 0) {
      const { ControlPlaneAdminClient } = await import('./admin-client.js');
      const admin = new ControlPlaneAdminClient({
        ...target,
        fetchImpl: deadlineFetch(AbortSignal.timeout(remaining())),
      });
      const registrations = await admin.listBoxes();
      const fetchedAt = new Date().toISOString();
      await writeCache({ version: 1, fetchedAt, registrations }).catch(() => {});
      return rememberReg({ registrations, stale: false, fetchedAt });
    }
  } catch {
    // fall through to the cache
  }
  const cached = await readCache();
  if (!cached) return rememberReg({ registrations: [], stale: true });
  return rememberReg({
    registrations: cached.registrations,
    stale: true,
    fetchedAt: cached.fetchedAt,
  });
}

function rememberReg(listing: HubListing): HubListing {
  memo = { at: Date.now(), listing };
  return listing;
}

async function writeCache(data: CacheFile): Promise<void> {
  const path = hubRegistrationsCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(hubRegistrationsCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.registrations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Human age of a cached listing, e.g. `3m ago`. */
export function cacheAge(fetchedAt: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(fetchedAt));
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}
