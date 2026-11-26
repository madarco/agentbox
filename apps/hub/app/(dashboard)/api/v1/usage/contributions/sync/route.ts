// POST /api/v1/usage/contributions/sync — push this PC's usage contribution to
// the configured remote hub now (the year, changed or not). `agentbox usage` calls
// it before reading a remote hub; the Usage page's "Sync this PC" button too.
// Answers what happened: `pushed`, `unchanged`, `disabled` (history.contributeUsage
// is false), `no-remote` (no control box configured, or this hub is one),
// `no-machine-id`, or `failed` with the error.
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const pusher = globalThis.__AGENTBOX_HUB_USAGE_PUSHER;
  if (!pusher) return fail('backend_unavailable', 'this hub has no usage contribution pusher');
  const r = await pusher.syncNow();
  if (r.status === 'failed') {
    return fail('backend_unavailable', `usage contribution not pushed: ${r.error}`, r);
  }
  return ok(r);
}
