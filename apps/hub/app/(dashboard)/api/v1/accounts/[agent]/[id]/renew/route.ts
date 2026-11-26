// POST /api/v1/accounts/:agent/:id/renew — fan the account's stored LOGIN out to
//   every box on it (what the relay does after a box refreshes, run on demand):
//   `{ pushed, failed, output: string[] }`. The new sign-in itself happens on
//   the machine first (`agentbox credentials renew`); a pasted kind is refused.
import { backendOrNull } from '../../../../lib/backend';
import { fail, ok } from '../../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agent: string; id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  try {
    const r = await backend.renewAccount(agent, id);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
