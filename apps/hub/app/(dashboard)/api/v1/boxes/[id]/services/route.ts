// GET /api/v1/boxes/:id/services — the box's agentbox.yaml task/service/port
// status (live via `agentbox-ctl status`, or the persisted snapshot when the box
// isn't running). Needs the in-process backend; the Postgres path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const result = await backend.getServices(id);
  return ok(result);
}
