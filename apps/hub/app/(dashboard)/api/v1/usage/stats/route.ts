// GET /api/v1/usage/stats — the usage dashboard's `UsageStats` for a window
// (docs/usage-dashboard-plan.md, Phase 2): agent-hours and parallelism from the
// recorded sessions, shipped work and box-hours from the activity ledger.
//   since:        a local day (YYYY-MM-DD) or a number of days or weeks back (`30d`, the default, `2w`)
//   until:        a local day, inclusive (default today)
//   tz:           IANA time zone the days are in (default UTC)
//   range:        7d | month | 90d | year, the page's label (default from the length)
//   subscription: only sessions and boxes on this `<agent>/<account>`
// The window is checked against the schema's bounds (2020-2100, at most a year)
// before any day is walked. Other PCs' usage contributions (Phase 4b) are merged
// in, except under a subscription filter (a contribution carries no account).
import { tryGetMachineId } from '@agentbox/config';
import { parseUsageStatsQuery, usageStats } from '@/lib/backend/usage-stats';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const history = globalThis.__AGENTBOX_HUB_HISTORY;
  const ledger = globalThis.__AGENTBOX_HUB_ACTIVITY;
  const contributions = globalThis.__AGENTBOX_HUB_USAGE_CONTRIBUTIONS;
  if (!history && !ledger) {
    return fail(
      'backend_unavailable',
      'neither session history nor the activity ledger is enabled',
    );
  }
  const p = new URL(req.url).searchParams;
  const str = (k: string): string | undefined => p.get(k)?.trim() || undefined;
  try {
    const parsed = parseUsageStatsQuery(
      {
        since: str('since'),
        until: str('until'),
        tz: str('tz'),
        range: str('range'),
        subscription: str('subscription'),
      },
      Date.now(),
    );
    if (!parsed.ok) return fail('invalid_request', parsed.message);
    const stats = await usageStats(
      {
        history: history?.repo ?? null,
        ledger: ledger ?? null,
        contributions: contributions ?? null,
        ...(selfMachineId() ? { selfMachineId: selfMachineId() } : {}),
      },
      parsed.query,
    );
    return ok(stats);
  } catch (e) {
    return fail(
      'backend_unavailable',
      `usage stats could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const selfMachineId = (): string | undefined => tryGetMachineId();
