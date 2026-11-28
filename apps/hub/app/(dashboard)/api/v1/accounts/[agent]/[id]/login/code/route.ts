// POST /api/v1/accounts/:agent/:id/login/code `{ code, session? }` — hand the code
//   the browser showed (or the secret the agent asked for) to the sign-in waiting
//   for it. Answers the session once the code is taken (`pushing` / `done`),
//   refused (`awaiting-code` with `lastError`: paste a fresh one) or failed. The
//   code is never logged or echoed back.
import { backendOrNull } from '../../../../../lib/backend';
import { fail, ok } from '../../../../../lib/envelope';
import { readJson } from '../../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agent: string; id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const { agent, id } = await ctx.params;
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  try {
    const r = await backend.submitAccountLoginCode(agent, id, body.value);
    return r.ok ? ok(r.value) : fail(r.code, r.error);
  } catch (e) {
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}
