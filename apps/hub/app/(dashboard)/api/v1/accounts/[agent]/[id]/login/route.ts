// The hub-driven sign-in of one account (docs/credentials-tui-plan.md, Phase 2).
// POST   /api/v1/accounts/:agent/:id/login  `{ mode?: 'add' | 'renew', replace? }` — start the
//   agent's own login on the hub's machine; answers the session once it shows a
//   URL (or still `starting` after ~20 s: poll GET). A new name adds the account,
//   an existing login is renewed; one sign-in per account (a second start answers
//   the one in flight).
// GET    …/login[?session=<id>]  the newest sign-in of the account.
// DELETE …/login[?session=<id>]  cancel the one in flight (with a session: only that one).
// The view never carries a secret; the code goes in the body of `…/login/code`.
import { backendOrNull } from '../../../../lib/backend';
import { fail, ok } from '../../../../lib/envelope';
import { readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agent: string; id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  // An empty body is a plain start.
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const r = await backend.startAccountLogin(agent, id, body.value);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  const session = new URL(req.url).searchParams.get('session') ?? undefined;
  try {
    const r = await backend.getAccountLogin(agent, id, session);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  try {
    const session = new URL(req.url).searchParams.get('session') ?? undefined;
    const r = await backend.cancelAccountLogin(agent, id, session);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
