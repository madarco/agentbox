// GET /boxes/:id/web — a browser-openable redirect to the box's web UI, signed
// in when the box runs a service agent whose UI wants a token.
//
// The twin of the `vnc` route beside it, and it exists for the same two reasons:
// the URL has to be resolved at CLICK time (a service agent's token lives in the
// box, and an SSH-forward URL names a port that belongs to whatever forward was
// current when it was recorded), and a fetch-then-`window.open` would lose the
// user-activation token across the await and be popup-blocked. An `<a href>` to
// this route navigates synchronously and the 302 does the rest.
//
// Deliberately a page route rather than /api/v1: proxy.ts accepts `?token=<hub
// token>` on page routes, so a click carrying no Authorization header can still
// authenticate itself. Under /api/v1 the gate answers a JSON 401 a browser
// cannot follow.
import { backendOrNull } from '../../../api/v1/lib/backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function problem(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) {
    return problem(503, 'AgentBox hub backend unavailable — this hub cannot mint box URLs.');
  }

  const res = await backend.webUrl(id);
  if (!res.ok) {
    const notFound = /\b(not found|no such|does not exist)\b/i.test(res.error);
    return problem(notFound ? 404 : 409, `Can't open the web UI for ${id}: ${res.error}`);
  }
  return new Response(null, {
    status: 302,
    headers: {
      // The sign-in link when there is one: it is the same URL with the token in
      // its fragment, which a browser keeps to itself.
      location: res.signInUrl ?? res.url,
      'cache-control': 'no-store',
      // Without this the box's own UI would receive this URL — which may carry
      // `?token=<hub token>` — as its Referer.
      'referrer-policy': 'no-referrer',
    },
  });
}
