// POST /api/v1/boxes/:id/account {account, agent?} — switch the box's agent to
// another LLM account (hub settings 3c). A setup token or API key restarts the
// agent with that token and resumes its conversation; a login is written into
// the box's own credential file and the agent keeps running (409 when the box
// cannot take it: a cloud box that is not running, a docker box without its own
// file).
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = (await req.json().catch(() => null)) as {
    account?: unknown;
    agent?: unknown;
  } | null;
  if (typeof body?.account !== 'string' || body.account.length === 0) {
    return fail('invalid_request', 'body must be {"account": "<account id>", "agent"?: "<agent>"}');
  }
  if (body.agent !== undefined && typeof body.agent !== 'string') {
    return fail('invalid_request', '"agent" must be a string');
  }
  const res = await backend.switchBoxAccount(id, {
    account: body.account,
    ...(typeof body.agent === 'string' && body.agent ? { agent: body.agent } : {}),
  });
  switch (res.kind) {
    case 'not_found':
      return fail('not_found', `box not found: ${id}`);
    case 'invalid':
      return fail('invalid_request', res.error);
    case 'refused':
      return fail('conflict', res.error);
    case 'error':
      return fail('internal', res.error);
    default:
      return ok({
        boxId: res.boxId,
        agent: res.agent,
        from: res.from,
        to: res.to,
        how: res.how,
        restarted: res.restarted,
      });
  }
}
