// POST /api/v1/usage/contributions/sync — push this PC's usage contribution to
// the configured remote hub now: the recent weeks (the year on a first push),
// skipped when unchanged; `?full=1` sends the year whatever changed. `agentbox
// usage` calls it before reading a remote hub; the "Sync this PC" button too.
// Answers what happened: `pushed`, `unchanged`, `disabled` (history.contributeUsage
// is false), `no-remote` (no control box configured, or this hub is one),
// `no-machine-id`, or `failed` with the error.
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const pusher = globalThis.__AGENTBOX_HUB_USAGE_PUSHER;
  if (!pusher) return fail('backend_unavailable', 'this hub has no usage contribution pusher');
  const full = new URL(req.url).searchParams.get('full') === '1';
  const r = await pusher.syncNow({ full });
  if (r.status === 'failed') {
    return fail('backend_unavailable', `usage contribution not pushed: ${r.error}`, r);
  }
  return ok(r);
}
