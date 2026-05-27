// Long-poll subscription to the host relay's `/admin/events` ring buffer.
// Used by `agentbox agent wait-for` and `agentbox queue wait-for` to block on
// state transitions without inventing a new endpoint. Polling is fine here:
// the relay buffers 1000 events in memory, and the cursor-based query is
// dependency-free (plain GET).

import { ensureRelay } from '@agentbox/sandbox-docker';

const POLL_INTERVAL_MS = 500;

export interface RelayEvent {
  id: number;
  boxId: string;
  type: string;
  receivedAt: string;
  ts?: string;
  payload?: unknown;
}

export interface SubscribeOptions {
  /** Filter to a single box id (else all). */
  boxId?: string;
  /** Wall-clock cap. Throws AbortError when reached. */
  timeoutMs?: number;
  /** Optional starting cursor; defaults to "current head" (skip historical events). */
  sinceId?: number;
}

export class WaitTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`wait-for timed out after ${String(elapsedMs)}ms`);
    this.name = 'WaitTimeoutError';
  }
}

/**
 * Block until `predicate` returns truthy for one of the events streaming out
 * of `/admin/events`. The predicate's return value is what `waitForEvent`
 * resolves to — handy for "match + decode" in one step.
 *
 * Race-handling note: when the caller doesn't pass `sinceId`, the first fetch
 * is `since=0` — which returns the whole buffer. We evaluate the predicate
 * against the LATEST event in that batch (not the rest, to avoid replaying
 * stale historical transitions) so a state change that was broadcast to the
 * ring buffer but whose `status.json` atomic write was still in flight when
 * the caller's fast-path read happened is still caught here. Subsequent
 * fetches then long-poll from the head cursor as usual.
 */
export async function waitForEvent<T>(
  predicate: (ev: RelayEvent) => T | undefined,
  opts: SubscribeOptions = {},
): Promise<T> {
  const relayUrl = await getRelayUrl();
  const start = Date.now();
  let cursor = opts.sinceId ?? 0;
  let bootstrapped = opts.sinceId !== undefined;
  while (true) {
    const remaining = opts.timeoutMs !== undefined ? opts.timeoutMs - (Date.now() - start) : Infinity;
    if (remaining <= 0) throw new WaitTimeoutError(Date.now() - start);

    const events = await fetchEvents(relayUrl, cursor, opts.boxId);

    if (!bootstrapped) {
      // First sweep with no caller-supplied cursor: only the most recent
      // event represents "current state" — older buffered events are stale
      // transitions. Match against the head, advance cursor past it, and
      // proceed to long-poll for future transitions.
      const last = events[events.length - 1];
      if (last) {
        const matched = predicate(last);
        if (matched !== undefined) return matched;
        cursor = last.id;
      }
      bootstrapped = true;
    } else {
      for (const ev of events) {
        const matched = predicate(ev);
        if (matched !== undefined) return matched;
        cursor = Math.max(cursor, ev.id);
      }
    }
    // No match in this batch — sleep and re-poll (or wake early on timeout).
    const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
    if (sleepMs > 0) await sleep(sleepMs);
  }
}

async function fetchEvents(
  relayUrl: string,
  since: number,
  boxId: string | undefined,
): Promise<RelayEvent[]> {
  const url = new URL('/admin/events', relayUrl);
  url.searchParams.set('since', String(since));
  if (boxId) url.searchParams.set('box', boxId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`relay /admin/events: HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { events?: RelayEvent[] };
  return body.events ?? [];
}

async function getRelayUrl(): Promise<string> {
  // ensureRelay is idempotent: it spawns the host relay process if it's not
  // already running. `hostUrl` is the loopback view from this side; `url` is
  // the host.docker.internal view used inside boxes.
  const ep = await ensureRelay();
  return ep.hostUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
