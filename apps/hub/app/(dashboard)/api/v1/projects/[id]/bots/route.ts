// GET /api/v1/projects/:id/bots — every bot this project holds a backup of, each
// with its stamps newest first. The restore picker's source, and the box page's
// "last backed up" line.
//
// Read-only, but still host-backed: bundles live on the hub's own disk under
// `<project>/.agentbox/bots/`, which the Postgres/plane path cannot see.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.listBots(id);
  if (!res.ok) return fail('not_found', res.error);
  return ok({ bots: res.bots });
}
