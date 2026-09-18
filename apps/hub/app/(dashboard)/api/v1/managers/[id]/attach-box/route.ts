// POST /api/v1/managers/:id/attach-box — the hub that BUILT a box says which
// manager it belongs to.
//
// Usually that is this hub, and the write never leaves the process. With a
// control box configured and `hub.mode=local` the box is built on the user's
// machine while the record lives here, and the id is a fact only the builder
// has. Narrow by design: it appends one id to a list and can neither move nor
// remove anything, which is why it is accepted from another host at all.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseManagerAttachBox, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const parsed = parseManagerAttachBox(body.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.attachManagerBox(id, parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
