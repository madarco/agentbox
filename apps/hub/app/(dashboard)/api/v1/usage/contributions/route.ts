// POST /api/v1/usage/contributions — a PC's usage metrics for this hub's Usage
// page (docs/usage-dashboard-plan.md, Phase 4b). The body is `UsageContribution`
// from `@agentbox/usage-view`: ids, enums, dates and numbers, no transcript text.
// It is size-capped and parsed strict; a push replaces what that machine sent
// for the same days. Same auth gate as the rest of `/api/v1`.
// GET lists what each machine sent (counts only).
import { CONTRIBUTION_LIMITS, parseContributionBody } from '@agentbox/usage-view';
import { ContributionLimitError } from '@/lib/backend/usage-contrib';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const store = globalThis.__AGENTBOX_HUB_USAGE_CONTRIBUTIONS;
  if (!store) return fail('backend_unavailable', 'this hub takes no usage contributions');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > CONTRIBUTION_LIMITS.bytes) {
    return fail('payload_too_large', `body over ${String(CONTRIBUTION_LIMITS.bytes)} bytes`);
  }
  const raw = await readCapped(req, CONTRIBUTION_LIMITS.bytes);
  if (raw === null) {
    return fail('payload_too_large', `body over ${String(CONTRIBUTION_LIMITS.bytes)} bytes`);
  }
  let contribution;
  try {
    contribution = parseContributionBody(raw);
  } catch (e) {
    return fail('invalid_request', `invalid contribution: ${message(e)}`.slice(0, 2000));
  }
  try {
    return ok(await store.upsert(contribution));
  } catch (e) {
    if (e instanceof ContributionLimitError) return fail('conflict', e.message);
    return fail('backend_unavailable', `contribution not stored: ${message(e)}`);
  }
}

export async function GET(): Promise<Response> {
  const store = globalThis.__AGENTBOX_HUB_USAGE_CONTRIBUTIONS;
  if (!store) return fail('backend_unavailable', 'this hub takes no usage contributions');
  return ok({ machines: await store.info() });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The body as text, or null past `max` bytes (a chunked body has no length to check first). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
