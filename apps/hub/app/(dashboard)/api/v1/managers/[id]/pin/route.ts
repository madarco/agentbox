// POST /api/v1/managers/:id/pin — keep this session alive with no client on it.
// Without a pin, a session a client leased is stopped once that client stays
// away past the grace window (quitting the tray ends the terminals it opened).
// A pin is the user saying: leave this one running.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromManager, ok } from '../../../lib/envelope';
import { readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const body = parsedBody.value as { pinned?: unknown };
  if (typeof body.pinned !== 'boolean') {
    return fail('invalid_request', 'pinned must be a boolean');
  }
  const res = await backend.pinManager(id, body.pinned);
  if (!res.ok) return failFromManager(res);
  // The manager IS the payload, as every other manager route answers.
  return ok(res.manager);
}
