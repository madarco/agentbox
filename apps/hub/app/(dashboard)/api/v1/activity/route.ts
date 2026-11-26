// GET /api/v1/activity — the activity ledger (usage dashboard Phase 1): box
// lifecycle, pushes and PR states for every box this hub owns, oldest first.
//   since/until: ISO-8601, or a duration back from now (`30m`, `24h`, `7d`);
//                the window is [since, until)
//   type:        comma-separated event types (`box.paused,box.resumed`)
//   box:         a box id
//   limit:       rows returned (default 1000, max 50000)
// Types only from `@agentbox/relay`: a value import bundles the relay's cloud
// backend loaders into the route, which Next cannot resolve.
import type { ActivityType } from '@agentbox/relay';
import { fail, ok } from '../lib/envelope';
import { ACTIVITY_EVENT_TYPES } from '../lib/openapi';
import { intParam } from '../history/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function timeParam(raw: string, now: number): number | null {
  const rel = /^(\d+)([mhdw])$/.exec(raw.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!]!;
  const ms = Date.parse(raw);
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
  const limit = intParam(p.get('limit'), 1000, 1);
  if (limit === null) return fail('invalid_request', 'limit must be a positive integer');
  const box = str('box');

  const events = await ledger.list({
    ...window,
    ...(types.length ? { types: types as ActivityType[] } : {}),
    ...(box ? { boxId: box } : {}),
    limit,
  });
  return ok({
    since: window.sinceMs !== undefined ? new Date(window.sinceMs).toISOString() : null,
    until: window.untilMs !== undefined ? new Date(window.untilMs).toISOString() : null,
    events,
  });
}
