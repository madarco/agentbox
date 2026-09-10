// GET /api/v1/boxes/:id/web — resolve a box's web URL AT CLICK TIME, plus a
// sign-in link when the agent's UI takes an auth token from the URL fragment
// (openclaw's Control UI).
//
// Every client that OPENS a box's web UI should come here rather than use the
// Box payload's `webUrl`, which is a RECORDED value: where the URL is an SSH
// forward (hetzner/DO), the port belongs to the forward that existed when it was
// written, and the live one differs once that session has been re-established.
// Same shape, and the same rule, as `GET /boxes/:id/vnc` — already the only way
// to open a desktop, for the same class of reason.
//
// The token is a second reason to resolve here and not on the list: reading it
// is an exec INTO the box, which the box list must not do per box per poll, and
// it is a live credential that has no business in a response clients cache.
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
    { url: res.url, signInUrl: res.signInUrl, signInPending: res.signInPending },
    { headers: { 'cache-control': 'no-store' } },
  );
}
