// GET /boxes/:id/vnc — a browser-openable redirect to the box's noVNC viewer.
//
// Cloud signed URLs expire, so they can't be baked into a link `agentbox ls`
// printed minutes ago. This mints one at CLICK time and 302s to it, which is
// what makes the terminal's OSC-8 `(VNC)` hyperlink work for daytona/vercel/e2b.
//
// Deliberately a page route rather than /api/v1: proxy.ts accepts `?token=<hub
// token>` on page routes (swapping it for the session cookie and redirecting to
// the clean URL), so a click that carries no Authorization header can still
// authenticate itself. Under /api/v1 the gate answers a JSON 401 a browser
// cannot follow.
import { backendOrNull } from '../../../api/v1/lib/backend';
import { parseVncTtl } from '@/lib/boxes/vnc-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function problem(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) {
    return problem(503, 'AgentBox hub backend unavailable — this hub cannot mint box URLs.');
  }
  const ttl = parseVncTtl(new URL(req.url).searchParams.get('ttl'));
  if (!ttl.ok) return problem(400, ttl.message);

  const res = await backend.vncUrl(id, ttl.ttl === undefined ? {} : { ttl: ttl.ttl });
  if (!res.ok) {
    const notFound = /\b(not found|no such|does not exist)\b/i.test(res.error);
    return problem(notFound ? 404 : 409, `Can't open the desktop for ${id}: ${res.error}`);
  }

  // Best-effort prep: point the in-box browser at the box's web app so the
  // desktop isn't a blank X screen. Not awaited — a slow in-box exec must not
  // stall the redirect the user is waiting on.
  void backend.screen(id).catch(() => {});

  return new Response(null, {
    status: 302,
    headers: {
      location: res.url,
      'cache-control': 'no-store',
      // Without this the noVNC page would receive this URL — which may carry
      // `?token=<hub token>` — as its Referer.
      'referrer-policy': 'no-referrer',
    },
  });
}
