// GET /api/v1/boxes/:id/agent — the box's in-box coding-agent status snapshot
// (Claude activity / plan / question / session title) from the persisted status
// store. Backs `agentbox agent state|wait-for|get-plan-question`. Needs the
// in-process host backend; the Postgres/plane path 503s.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.getAgentState(id);
  if (!res) return fail('not_found', `box not found: ${id}`);
  return ok(res);
}
