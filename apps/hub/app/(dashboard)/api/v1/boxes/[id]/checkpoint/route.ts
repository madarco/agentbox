// POST /api/v1/boxes/:id/checkpoint — capture the box state as a durable project
// checkpoint (docker commit / cloud snapshot) via provider.checkpoint.*. Needs the
// in-process host backend; the Postgres/plane path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseCheckpointCreate, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; checkpoint is not available yet`);
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const raw = await readJson(req);
  if (!raw.ok) return fail('invalid_request', raw.message);
  const parsed = parseCheckpointCreate(raw.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.createCheckpoint(id, parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok(res);
}
