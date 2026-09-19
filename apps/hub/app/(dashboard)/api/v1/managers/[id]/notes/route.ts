// POST /api/v1/managers/:id/notes — record why the manager did something
// (`{ text, kind? }`, kind `note` | `replan` | `plan`). Stamped with the
// manager's current turn and that turn's prompt when its transcript is on this
// hub's disk.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { timelineMeta } from '../../../lib/actor';
import { parseManagerNote, readJson } from '../../../lib/validate';

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
  const parsed = parseManagerNote(body.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.addManagerNote(id, parsed.value, await timelineMeta(req, backend));
  if (!res.ok) return failFromAction(res.error);
  return ok(res.event, 201);
}
