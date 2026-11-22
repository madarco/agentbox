// PATCH  /api/v1/accounts/:agent/:id — `{ label: string | null }` → the account.
// DELETE /api/v1/accounts/:agent/:id — remove a named account: its stored secret
//   and its docker volume. 409 while a box still records it (running or
//   borrowing it); the default account cannot be removed.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agent: string; id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const value = body.value as Record<string, unknown> | null;
  // `label` must be present (a string, or null to clear): a body without it is
  // a mistake, never an instruction to wipe the label.
  if (!value || !('label' in value)) {
    return fail('invalid_request', 'body must be { label: string | null }');
  }
  const res = await backend.labelAccount(agent, id, value.label);
  if (!res.ok) return fail(res.code, res.error);
  return ok({ account: res.value });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  const res = await backend.removeAccount(agent, id);
  if (!res.ok) return fail(res.code, res.error);
  return ok({ ok: true, ...res.value });
}
