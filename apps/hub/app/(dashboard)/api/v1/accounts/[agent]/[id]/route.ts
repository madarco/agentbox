// DELETE /api/v1/accounts/:agent/:id — remove a named account: its stored secret
//   and its docker volume. 409 while a box still records it (running or
//   borrowing it); the default account cannot be removed.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agent: string; id: string }> };

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  try {
    const res = await backend.removeAccount(agent, id);
    if (!res.ok) return fail(res.code, res.error);
    return ok({ ok: true, ...res.value });
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
