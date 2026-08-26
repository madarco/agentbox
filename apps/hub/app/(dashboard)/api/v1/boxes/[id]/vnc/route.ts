// GET /api/v1/boxes/:id/vnc — mint a ready-to-open noVNC viewer URL.
//
// Cloud signed preview URLs expire (default 3600s), so the URL can't ride the
// Box payload's `vncUrl` — which is why that stays null for daytona/vercel/e2b
// and every client calls this at click time instead. Docker/hetzner boxes get
// their stable Portless/OrbStack/loopback URL from the same call.
//
// Needs the in-process host backend for provider credentials; the Postgres/plane
// path 503s like the other provider-driven routes.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction } from '../../../lib/envelope';
import { parseVncTtl } from '@/lib/boxes/vnc-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; its desktop is not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const params = new URL(req.url).searchParams;
  const ttl = parseVncTtl(params.get('ttl'));
  if (!ttl.ok) return fail('invalid_request', ttl.message);
  const loopback = params.get('loopback') === '1';

  const res = await backend.vncUrl(id, {
    ...(ttl.ttl === undefined ? {} : { ttl: ttl.ttl }),
    loopback,
  });
  if (!res.ok) return failFromAction(res.error);
  // The URL carries the box's VNC password in its query string — never cache it.
  return Response.json(
    { url: res.url, ...(res.ttl === undefined ? {} : { ttl: res.ttl }) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
