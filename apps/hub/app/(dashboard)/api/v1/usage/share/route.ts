// /api/v1/usage/share — publish the usage dashboard on agent-box.sh
// (docs/usage-dashboard-plan.md, Phase 6). The hub builds the public `UsageShare`
// and posts it to `share.endpoint` itself; the caller never talks to that site.
//   GET:  { endpoint, shares, lastName } — the site, and the shares this hub made
//         (never their delete secrets).
//   POST: { name?, preview?, since?, until?, tz?, range?, subscription? } — the
//         window takes the same values as GET /usage/stats. `preview: true`
//         returns the share that would be sent and posts nothing; otherwise
//         returns { url, id, createdAt }.
// DELETE /usage/share/<id> lives in ./[id]/route.ts.
import { homedir } from 'node:os';
import { loadEffectiveConfig } from '@agentbox/config';
import { parseUsageStatsQuery, usageStats } from '@/lib/backend/usage-stats';
import {
  ShareError,
  listUsageShares,
  parseShareEndpoint,
  postUsageShare,
  previewUsageShare,
} from '@/lib/backend/usage-share';
import { failShare, shareStore } from './store';
import { fail, ok } from '../../lib/envelope';
import { readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The hub machine's own `share.endpoint`, from its global config only: an
 * agentbox.yaml found above $HOME must not redirect a share. A config that
 * can't be read is an error, never a silent fall back to the public site.
 */
async function endpoint(): Promise<string | undefined> {
  try {
    const c = await loadEffectiveConfig(homedir());
    return c.layers.global.values.share?.endpoint;
  } catch (e) {
    throw new ShareError(
      'backend_unavailable',
      `the hub's config could not be read, so share.endpoint is unknown: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    const url = parseShareEndpoint(await endpoint());
    return ok({
      endpoint: url.href,
      shares: await listUsageShares(shareStore),
      lastName: await shareStore.lastName(),
    });
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
    store: shareStore,
  };
  try {
    if (b.preview === true) return ok(await previewUsageShare(deps, b.name));
    return ok(await postUsageShare(deps, b.name), 201);
  } catch (e) {
    return failShare(e);
  }
}
