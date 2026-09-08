// GET /api/v1/boxes/:id/web — the box's web URL, plus a sign-in link when its
// agent's UI takes an auth token from the URL fragment (openclaw's Control UI).
//
// A separate call rather than a field on the Box payload, for the same two
// reasons `vnc` is one: reading the token is an exec INTO the box, which the
// box list must not do per box per poll, and the token is a live credential
// that has no business in a response every client caches.
//
// Needs the in-process host backend for provider access; the Postgres/plane
// path 503s like the other provider-driven routes.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; it has no URL yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const res = await backend.webUrl(id);
  if (!res.ok) return failFromAction(res.error);
  // The sign-in URL carries the gateway token in its fragment — never cache it.
  return Response.json(
    { url: res.url, signInUrl: res.signInUrl },
    { headers: { 'cache-control': 'no-store' } },
  );
}
