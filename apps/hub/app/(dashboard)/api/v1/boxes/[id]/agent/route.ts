// POST /api/v1/boxes/:id/agent {agent} — add an agent to an existing box: the
// hub records it and re-registers the box with its own token, so the box's
// `agents.list` hands it that agent's units (`agentbox openclaw <box>`).
//
// GET /api/v1/boxes/:id/agent — the box's in-box coding-agent status snapshot
// (Claude activity / plan / question / session title) from the persisted status
// store. Backs `agentbox agent state|wait-for|get-plan-question`. Needs the
// in-process host backend; the Postgres/plane path 503s.
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
  const res = await backend.getAgentState(id);
  if (!res) return fail('not_found', `box not found: ${id}`);
  return ok(res);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = (await req.json().catch(() => null)) as { agent?: unknown } | null;
  if (typeof body?.agent !== 'string' || body.agent.length === 0) {
    return fail('invalid_request', 'body must be {"agent": "<agent id>"}');
  }
  const res = await backend.addBoxAgent(id, body.agent);
  if (res.kind === 'not_found') return fail('not_found', `box not found: ${id}`);
  if (res.kind === 'invalid') return fail('invalid_request', res.error);
  return ok({ boxId: res.boxId, agents: res.agents });
}
