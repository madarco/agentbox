// GET /api/v1/activity — the activity ledger (usage dashboard Phase 1): box
// lifecycle, pushes and PR states for every box this hub owns, oldest first.
//   since/until: ISO-8601 (a date at least), or a duration back from now
//                (`30m`, `24h`, `7d`); the window is [since, until)
//   type:        comma-separated event types (`box.paused,box.resumed`)
//   box:         a box id
//   order:       `asc` (default) keeps the oldest `limit` rows of the window,
//                `desc` the newest; either way they come back oldest first
//   limit:       rows returned (default 1000, max 50000)
// Types only from `@agentbox/relay`: a value import bundles the relay's cloud
// backend loaders into the route, which Next cannot resolve. The store is the
// one the custom server opened (`__AGENTBOX_HUB_ACTIVITY`).
import type { ActivityType } from '@agentbox/relay';
import { fail, ok } from '../lib/envelope';
import { ACTIVITY_EVENT_TYPES } from '../lib/openapi';
import { intParam } from '../history/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const MAX_LIMIT = 50_000;

/** A duration back from `now`, or an ISO-8601 time; null for anything else (a bare `7`). */
function timeParam(raw: string, now: number): number | null {
  const v = raw.trim();
  const rel = /^(\d+)([mhdw])$/.exec(v);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!]!;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(req: Request): Promise<Response> {
  const ledger = globalThis.__AGENTBOX_HUB_ACTIVITY;
  if (!ledger) return fail('backend_unavailable', 'the activity ledger is not enabled on this hub');
  const p = new URL(req.url).searchParams;
  const str = (k: string): string | undefined => p.get(k)?.trim() || undefined;

  const now = Date.now();
  const window: { sinceMs?: number; untilMs?: number } = {};
  for (const k of ['since', 'until'] as const) {
    const raw = str(k);
    if (!raw) continue;
    const ms = timeParam(raw, now);
    if (ms === null) {
      return fail('invalid_request', `${k} must be an ISO-8601 time or a duration like 7d`);
    }
    window[k === 'since' ? 'sinceMs' : 'untilMs'] = ms;
  }
  const types = (str('type') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const bad = types.find((t) => !ACTIVITY_EVENT_TYPES.includes(t));
  if (bad) {
    return fail('invalid_request', `type: unknown event type "${bad}"`, {
      types: ACTIVITY_EVENT_TYPES,
    });
  }
  const order = str('order') ?? 'asc';
  if (order !== 'asc' && order !== 'desc') {
    return fail('invalid_request', 'order must be asc or desc');
  }
  const limit = intParam(p.get('limit'), 1000, 1);
  if (limit === null || limit > MAX_LIMIT) {
    return fail('invalid_request', `limit must be an integer from 1 to ${String(MAX_LIMIT)}`);
  }
  const box = str('box');

  try {
    const events = await ledger.list({
      ...window,
      ...(types.length ? { types: types as ActivityType[] } : {}),
      ...(box ? { boxId: box } : {}),
      order,
      limit,
    });
    return ok({
      since: window.sinceMs !== undefined ? new Date(window.sinceMs).toISOString() : null,
      until: window.untilMs !== undefined ? new Date(window.untilMs).toISOString() : null,
      events,
      truncated: events.length === limit,
    });
  } catch (e) {
    return fail(
      'backend_unavailable',
      `the activity ledger could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
