// GET /api/v1/usage — token usage from the recorded sessions (agent-history
// Phase 7), summed per model response and grouped.
//   by:        up to two of day, agent, account, box, project, host, model, session
//              (comma-separated; none = totals only)
//   since/until: ISO-8601, or a duration back from now (`30m`, `24h`, `7d`);
//              the window is [since, until) on each response's own time
//   tzOffset:  minutes east of UTC that `day` buckets in (default 0)
//   filters:   agent, account, box (id or name), project (repo URL substring),
//              host (machine id), model
//   limit:     groups returned (default 200, max 1000)
import { USAGE_DIMENSIONS, type UsageDimension } from '@/lib/backend/history';
import { fail, ok } from '../lib/envelope';
import { historyOrFail, intParam } from '../history/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** An ISO time or a duration back from `now`, as epoch ms; null when unparseable. */
function timeParam(raw: string, now: number): number | null {
  const rel = /^(\d+)([mhdw])$/.exec(raw.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!]!;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(req: Request): Promise<Response> {
  const history = historyOrFail();
  if (history instanceof Response) return history;
  const p = new URL(req.url).searchParams;
  const str = (k: string): string | undefined => p.get(k)?.trim() || undefined;

  const by = (str('by') ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const bad = by.find((d) => !(USAGE_DIMENSIONS as readonly string[]).includes(d));
  if (bad) {
    return fail('invalid_request', `by: unknown dimension "${bad}"`, {
      dimensions: USAGE_DIMENSIONS,
    });
  }
  if (new Set(by).size > 2) return fail('invalid_request', 'by takes at most two dimensions');

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

  const tz = Number(str('tzOffset') ?? 0);
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) {
    return fail('invalid_request', 'tzOffset must be whole minutes between -840 and 840');
  }
  const limit = intParam(p.get('limit'), 200, 1);
  if (limit === null) return fail('invalid_request', 'limit must be a positive integer');

  const filters: Record<string, string> = {};
  for (const k of ['agent', 'account', 'box', 'project', 'host', 'model'] as const) {
    const v = str(k);
    if (v) filters[k] = v;
  }
  const report = await history.usage({
    ...filters,
    ...window,
    by: by as UsageDimension[],
    tzOffsetMin: tz,
    limit,
  });
  return ok({
    by,
    since: window.sinceMs !== undefined ? new Date(window.sinceMs).toISOString() : null,
    until: window.untilMs !== undefined ? new Date(window.untilMs).toISOString() : null,
    tzOffset: tz,
    ...report,
  });
}
