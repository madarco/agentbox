// /api/v1/usage/share — publish the usage dashboard on agent-box.sh
// (docs/usage-dashboard-plan.md, Phase 6). The hub builds the public `UsageShare`
// and posts it to `share.endpoint` itself; the caller never talks to that site.
//   GET:  { endpoint, handles, lastHandle } — the site and the handles this hub
//         holds a claim for there (never the secrets).
//   POST: { handle, preview?, since?, until?, tz?, range?, subscription? } — the
//         window takes the same values as GET /usage/stats. `preview: true`
//         returns the share that would be sent and posts nothing; otherwise
//         returns { url, handle, n, claimedNow }.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR, loadEffectiveConfig } from '@agentbox/config';
import { parseUsageStatsQuery, usageStats } from '@/lib/backend/usage-stats';
import {
  ShareError,
  fileClaimStore,
  parseShareEndpoint,
  postUsageShare,
  previewUsageShare,
} from '@/lib/backend/usage-share';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const claims = fileClaimStore(join(STATE_DIR, 'hub', 'share.json'));

/** The hub machine's own `share.endpoint` (global config; a project's does not apply). */
async function endpoint(): Promise<string | undefined> {
  return loadEffectiveConfig(homedir())
    .then((c) => c.effective.share.endpoint)
    .catch(() => undefined);
}

function failShare(e: unknown): Response {
  if (e instanceof ShareError) {
    return fail(
      e.code,
      e.message,
      e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : undefined,
    );
  }
  return fail('internal', `usage share failed: ${e instanceof Error ? e.message : String(e)}`);
}

export async function GET(): Promise<Response> {
  try {
    const url = parseShareEndpoint(await endpoint());
    return ok({ endpoint: url.href, ...(await claims.known(url.origin)) });
  } catch (e) {
    return failShare(e);
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

export async function POST(req: Request): Promise<Response> {
  const history = globalThis.__AGENTBOX_HUB_HISTORY;
  const ledger = globalThis.__AGENTBOX_HUB_ACTIVITY;
  if (!history && !ledger) {
    return fail(
      'backend_unavailable',
      'neither session history nor the activity ledger is enabled',
    );
  }
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
    return fail('invalid_request', 'body must be a JSON object');
  }
  const b = body.value as Record<string, unknown>;
  if (b.preview !== undefined && typeof b.preview !== 'boolean') {
    return fail('invalid_request', 'preview must be a boolean');
  }
  const parsed = parseUsageStatsQuery(
    {
      since: str(b.since),
      until: str(b.until),
      tz: str(b.tz),
      range: str(b.range),
      subscription: str(b.subscription),
    },
    Date.now(),
  );
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const deps = {
    stats: () =>
      usageStats({ history: history?.repo ?? null, ledger: ledger ?? null }, parsed.query),
    endpoint,
    claims,
  };
  try {
    if (b.preview === true) return ok(await previewUsageShare(deps, b.handle));
    return ok(await postUsageShare(deps, b.handle), 201);
  } catch (e) {
    return failShare(e);
  }
}
